import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import {
  decideGate, foldRun, HARNESS_VERSION, HeadMovedError, isTerminal, requestCancel, requestPause, requestResume, RunNotFoundError, updateBudget,
  type HarnessEvent,
} from "@harness/harness";
import { CLIENT_HEADER, methods, UPLOAD_LIMIT_BYTES, type ApiError, type Frame, type MethodName, type OutputOf, type ParsedInputOf } from "../api/contract.ts";
import { bundleClient, PAGE, type Bundle } from "./bundle.ts";
import { confined, sendFile, sendServed } from "./files.ts";
import type { RunHost } from "./host.ts";
import { Hub } from "./hub.ts";
import { createProject, isProjectSlug, listProjects, readProject } from "./projects.ts";
import { DiskRunFiles } from "./run-files.ts";
import { DirectoryUploads } from "./uploads.ts";

/**
 * The web server. One process, bound to this machine unless told otherwise. It serves the client, answers calls, streams what
 * changed, and serves run and project files. Every write it makes goes through the same creator functions the
 * terminal uses, so a decision made here is the same event as one made with `harness resume`.
 */

export type WebServerOptions = {
  host: RunHost;
  port?: number;
  /** The address to listen on. `127.0.0.1` unless set; a container behind an ingress needs `0.0.0.0`. */
  bind?: string;
  /** Host names (with `:port` if the browser sends one) answered besides `localhost` and `127.0.0.1`. */
  allowedHosts?: string[];
  /**
   * A header every request must carry, set by a sign-in proxy in front of the server (Microsoft Entra
   * authentication on Container Apps or App Service sets `x-ms-client-principal-id`). Requests without it are
   * refused, so a proxy that is switched off does not leave the server open.
   */
  requireHeader?: string;
  /** How long to wait for a run file a worker elsewhere has not mirrored yet. For tests. */
  mirrorWaitMs?: number;
  /** Rebuild the client on every page load. */
  dev?: boolean;
  /** How often run folders are checked for changes made by other processes. */
  pollMs?: number;
};

export type WebServer = { url: string; port: number; hub: Hub; close: () => Promise<void> };

class Failure extends Error {
  constructor(readonly code: ApiError["code"], message: string) {
    super(message);
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Failure("bad-request", "That request is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** How recently a run must have moved for a missing file to be waited for, how long, and how often to look. */
const MIRROR_RECENT_MS = 2 * 60_000;
const MIRROR_WAIT_MS = 30_000;
const MIRROR_POLL_MS = 750;

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const { host } = options;
  const hub = new Hub(host, options.pollMs ?? 1000);
  await hub.poll();
  hub.start();
  let bundle: Bundle | undefined = options.dev ? undefined : await bundleClient();
  const getBundle = async () => (options.dev ? (bundle = await bundleClient({ dev: true })) : (bundle ??= await bundleClient()));

  const allowedHosts = new Set<string>((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const requireHeader = options.requireHeader?.toLowerCase();
  const uploads = host.uploads ?? new DirectoryUploads((runId) => host.store.runDir(runId));
  const runFiles = host.files ?? new DiskRunFiles((runId) => host.store.runDir(runId));

  const card = async (runId: string) => {
    const cached = await hub.get(runId);
    if (!cached) throw new Failure("not-found", "There is no such run.");
    return cached.card;
  };
  const stateOf = async (runId: string) => {
    const cached = await hub.get(runId);
    if (!cached) throw new Failure("not-found", "There is no such run.");
    return cached;
  };
  const project = async (slug: string | undefined) => {
    if (slug === undefined) return undefined;
    const found = await readProject(host.projectsDir, slug);
    if (!found) throw new Failure("not-found", `There is no project called ${slug}.`);
    return found;
  };

  const handlers: { [M in MethodName]: (input: ParsedInputOf<M>) => Promise<OutputOf<M>> } = {
    "host.describe": async () => ({
      cwd: host.cwd,
      runsDir: host.runsDir,
      projectsDir: host.projectsDir,
      defaultModel: host.defaultModel,
      models: host.models,
      version: HARNESS_VERSION,
    }),
    "runs.list": async () => {
      await hub.poll();
      return { runs: hub.cards() };
    },
    "runs.get": async ({ runId }) => {
      const cached = await stateOf(runId);
      return { card: cached.card, state: cached.state, events: cached.events };
    },
    "runs.createReel": async (input) => {
      const found = await project(input.project);
      const runId = await host.createReel({ ...input, ...(found?.hasNotes ? { notesDir: join(host.projectsDir, found.slug) } : {}) });
      await hub.refresh(runId);
      hub.drive(runId);
      return { runId };
    },
    "runs.createTask": async (input) => {
      await project(input.project);
      const runId = await host.createTask(input);
      await hub.refresh(runId);
      hub.drive(runId);
      return { runId };
    },
    "runs.decide": async ({ runId, gate, decision, notes, voiceover }) => {
      const { state, card: current } = await stateOf(runId);
      if (current.driver === "elsewhere") throw new Failure("conflict", "This run is being worked on somewhere else. Answer it there, or wait for it to stop.");
      if (state.pendingGate !== gate) {
        throw new Failure("conflict", state.pendingGate ? `The run is waiting on the ${state.pendingGate.replace("_", " ")} review, not this one.` : "The run is not waiting for a review any more.");
      }
      // Approving a reel's script is also when the creator hands over their reading of it, as in the terminal.
      const scriptApproval = decision === "approved" && gate === "script" && state.config.pipeline === "reel";
      if (voiceover && !scriptApproval) throw new Failure("bad-request", "A voiceover goes with approving a reel's script.");
      const written = notes.trim() ? [notes.trim()] : [];
      if (scriptApproval) {
        const choice = voiceover ?? { kind: "keep" as const };
        if (choice.kind === "upload" && !(await uploads.has(runId, choice.name))) {
          throw new Failure("not-found", "That upload is not on the server any more. Send the file again.");
        }
        written.push(await host.voiceover(runId, choice));
      }
      await decideGate(host.store, runId, { gate, decision, notes: written });
      if (decision !== "rejected") {
        await requestResume(host.store, runId);
        hub.drive(runId);
      }
      return { card: await card(runId) };
    },
    "runs.resume": async ({ runId, limits }) => {
      const { state, card: current } = await stateOf(runId);
      if (isTerminal(state.status)) throw new Failure("conflict", "This run is over. Start a new one instead.");
      if (state.status === "waiting_gate") throw new Failure("conflict", "This run is waiting for your review. Answer the review to carry on.");
      if (current.driver === "elsewhere") throw new Failure("conflict", "This run is being worked on somewhere else.");
      if (Object.keys(limits).length) await updateBudget(host.store, runId, limits);
      await requestResume(host.store, runId);
      hub.drive(runId);
      return { card: await card(runId) };
    },
    "runs.pause": async ({ runId }) => {
      await requestPause(host.store, runId, "Asked from the web UI.");
      return { card: await card(runId) };
    },
    "runs.cancel": async ({ runId }) => {
      await requestCancel(host.store, runId, "Cancelled from the web UI.");
      return { card: await card(runId) };
    },
    "runs.file": async ({ runId, project: slug }) => {
      if (slug !== null) await project(slug);
      await appendCreatorEvent(runId, "x.web.filed", { project: slug });
      return { card: await card(runId) };
    },
    "runs.files": async ({ runId }) => {
      await stateOf(runId);
      return { files: await runFiles.list(runId) };
    },
    "projects.list": async () => ({ projects: await listProjects(host.projectsDir) }),
    "projects.create": async ({ name }) => {
      const created = await createProject(host.projectsDir, name);
      hub.broadcast({ type: "projects", projects: await listProjects(host.projectsDir) });
      return { project: created };
    },
  };

  /** A plugin event from the creator, for things the reducer never needs (such as which project a run is in). */
  async function appendCreatorEvent(runId: string, type: `x.web.${string}`, payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const events = await host.store.read(runId);
      const state = foldRun(events);
      try {
        await host.store.append(runId, state.lastSeq, [
          { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), type, actor: "creator", spanId: state.runSpanId, payload },
        ]);
        await hub.refresh(runId);
        return;
      } catch (err) {
        if (!(err instanceof HeadMovedError) || attempt >= 5) throw err;
      }
    }
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const runId = url.searchParams.get("run") ?? "";
    const name = url.searchParams.get("name") ?? "";
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Failure("bad-request", "That is not a run id.");
    await stateOf(runId);
    const extension = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
    if (!extension) throw new Failure("bad-request", "The file needs an extension, such as .m4a or .wav.");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > UPLOAD_LIMIT_BYTES) throw new Failure("bad-request", "That file is too large to upload.");
    const saved = `recording-${Date.now()}${extension}`;
    let size = 0;
    await uploads.save(
      runId,
      saved,
      (async function* () {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > UPLOAD_LIMIT_BYTES) throw new Failure("bad-request", "That file is too large to upload.");
          yield chunk as Buffer;
        }
      })(),
    );
    json(res, 200, { ok: true, value: { name: saved, bytes: size } });
  }

  function handleStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const runId = url.searchParams.get("run") ?? undefined;
    const after = Number(url.searchParams.get("after") ?? 0);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (frame: Frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write(": connected\n\n");
    const unsubscribe = hub.subscribe({ ...(runId ? { runId } : {}), send });
    send({ type: "runs", runs: hub.cards() });
    if (runId) {
      void hub.get(runId).then((cached) => {
        if (!cached) return;
        const missed = cached.events.filter((e: HarnessEvent) => e.seq > (Number.isFinite(after) ? after : 0));
        if (missed.length) send({ type: "events", runId, events: missed, state: cached.state });
      });
    }
    const beat = setInterval(() => res.write(": still here\n\n"), 15_000);
    beat.unref?.();
    const end = () => {
      clearInterval(beat);
      unsubscribe();
    };
    req.on("close", end);
    res.on("error", end);
  }

  /**
   * A run file, from wherever run files are kept. A worker elsewhere mirrors a file a moment after the event
   * that names it, so a file missing from a run that moved in the last couple of minutes is waited for, briefly,
   * before the answer is that it is not there.
   */
  async function openRunFile(runId: string, scope: "work" | "artifacts", path: string, req: IncomingMessage) {
    const found = await runFiles.open(runId, scope, path);
    if (found || !host.files) return found;
    const last = (await hub.get(runId))?.events.at(-1);
    if (!last || Date.now() - Date.parse(last.occurredAt) > MIRROR_RECENT_MS) return undefined;
    const until = Date.now() + (options.mirrorWaitMs ?? MIRROR_WAIT_MS);
    while (Date.now() < until && !req.destroyed) {
      await new Promise((r) => setTimeout(r, MIRROR_POLL_MS));
      const late = await runFiles.open(runId, scope, path);
      if (late) return late;
    }
    return undefined;
  }

  async function handleFiles(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const [scope, owner, ...rest] = parts.map((p) => decodeURIComponent(p));
    const isRun = owner !== undefined && /^[a-zA-Z0-9-]{1,80}$/.test(owner);
    if ((scope === "runs" || scope === "artifacts") && isRun && rest.length) {
      return sendServed(req, res, await openRunFile(owner, scope === "runs" ? "work" : "artifacts", rest.join("/"), req));
    }
    let root: string | undefined;
    if (scope === "projects" && owner && isProjectSlug(owner)) root = join(host.projectsDir, owner);
    const path = root && rest.length ? await confined(root, rest.join("/")) : undefined;
    if (!path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("There is no file there.");
      return;
    }
    await sendFile(req, res, path);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        // Only this machine, by name: refuses pages that point another hostname at this port (DNS rebinding).
        if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
          res.writeHead(421, { "content-type": "text/plain; charset=utf-8" }).end("This server only answers on the names it was given.");
          return;
        }
        if (requireHeader && !req.headers[requireHeader]) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("Sign in first.");
          return;
        }
        const path = url.pathname;
        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
          res.end(PAGE);
          return;
        }
        if (req.method === "GET" && (path === "/app.js" || path === "/app.css")) {
          const b = await getBundle();
          res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(path.endsWith(".js") ? b.js : b.css);
          return;
        }
        if (req.method === "GET" && path === "/api/stream") return handleStream(req, res, url);
        if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/files/")) return await handleFiles(req, res, path.slice(7).split("/"));
        if (req.method === "POST" && path.startsWith("/api/")) {
          // A page on another site cannot send this header without a CORS preflight, which is never answered.
          if (req.headers[CLIENT_HEADER] !== "1") throw new Failure("bad-request", "Calls need the client header.");
          if (path === "/api/upload") return await handleUpload(req, res, url);
          if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Failure("bad-request", "Calls are sent as JSON.");
          const name = path.slice(5) as MethodName;
          const method = methods[name];
          if (!method) throw new Failure("not-found", `There is no ${name} call.`);
          const raw = await readBody(req, 1_000_000);
          let body: unknown;
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            throw new Failure("bad-request", "The call's body is not JSON.");
          }
          const parsed = method.input.safeParse(body);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new Failure("bad-request", issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "The call's input is not valid.");
          }
          const handler = handlers[name] as (input: unknown) => Promise<unknown>;
          json(res, 200, { ok: true, value: await handler(parsed.data) });
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof Failure) return json(res, 200, { ok: false, error: { code: err.code, message: err.message } });
        if (err instanceof RunNotFoundError) return json(res, 200, { ok: false, error: { code: "not-found", message: "There is no such run." } });
        if (host.isUserError?.(err)) return json(res, 200, { ok: false, error: { code: "bad-request", message: (err as Error).message } });
        json(res, 200, { ok: false, error: { code: "failed", message: `Something went wrong: ${(err as Error).message}` } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4321, options.bind ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  for (const name of ["localhost", "127.0.0.1"]) allowedHosts.add(`${name}:${port}`);

  return {
    url: `http://localhost:${port}`,
    port,
    hub,
    close: async () => {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

