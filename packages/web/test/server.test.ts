import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRun, defineTool, Engine, fileTools, foldRun, JsonlEventStore, MemoryEventStore, type HarnessEvent, type RunStore,
} from "@harness/harness";
import { respond, ScriptedProvider, text, toolCall } from "@harness/harness/testing";
import { ApiClient, parseFrame, type Frame } from "../src/api/index.ts";
import { BlobRunFiles, DirectoryBlobs, RunMirror, startWebServer, type RunHost, type WebServer } from "../src/index.ts";

/**
 * The server end to end, with a scripted model and no network beyond localhost: a run is started, followed
 * on the stream, stopped at a review, answered with a recording, and finished. Then the guards.
 */

const handIn = defineTool({
  name: "hand_in",
  description: "Hand the draft in for review.",
  input: z.object({}),
  async execute(_input, exec) {
    return exec.gate("script", { files: ["draft.md"], note: "First go." });
  },
});

/** Logs in memory and nowhere on disk, with changes pushed by hand: a stand-in for the Postgres store. */
class MemoryRunStore extends MemoryEventStore implements RunStore {
  readonly listeners = new Set<(runId: string) => void>();
  constructor(private readonly root: string) {
    super();
  }
  runDir(runId: string): string {
    return join(this.root, runId);
  }
  async watch(onChange: (runId: string) => void): Promise<() => Promise<void>> {
    this.listeners.add(onChange);
    return async () => void this.listeners.delete(onChange);
  }
  readonly typing = new Set<(runId: string, delta: string) => void>();
  async publishText(runId: string, delta: string): Promise<void> {
    for (const hear of this.typing) hear(runId, delta);
  }
  async watchText(onText: (runId: string, delta: string) => void): Promise<() => Promise<void>> {
    this.typing.add(onText);
    return async () => void this.typing.delete(onText);
  }
}

function setup(makeStore: (runsDir: string) => RunStore = (runsDir) => new JsonlEventStore(runsDir)) {
  const root = mkdtempSync(join(tmpdir(), "harness-web-"));
  const runsDir = join(root, "runs");
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "demo-project"), { recursive: true });
  writeFileSync(join(projectsDir, "demo-project", "notes.md"), "# Demo project\n\nNotes.\n");
  const store = makeStore(runsDir);
  const voiceovers: string[] = [];
  const provider = new ScriptedProvider((req) => {
    const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
    if (results === 0) return respond([text("Writing the draft."), toolCall("write_file", { path: "draft.md", content: "# Draft\n\nA line." })]);
    if (results === 1) return respond([toolCall("hand_in", {})]);
    return respond([toolCall("finish", { summary: "Done." })]);
  });
  const host: RunHost = {
    store,
    runsDir,
    projectsDir,
    cwd: root,
    defaultModel: "demo-model",
    models: ["demo-model"],
    createReel: async () => {
      throw new Error("not in this test");
    },
    createTask: (input) =>
      createRun(store, { task: input.task, model: "demo-model", system: "Be brief.", limits: input.limits, ...(input.project ? { project: input.project } : {}) }),
    drive: (runId, hooks) =>
      new Engine({
        store,
        provider,
        tools: [...fileTools, handIn],
        workDir: (id) => join(store.runDir(id), "work"),
        onEvent: hooks.onEvent,
        onText: hooks.onText,
      }).run(runId, { signal: hooks.signal }),
    voiceover: async (runId, choice) => {
      voiceovers.push(choice.kind === "upload" ? readFileSync(join(store.runDir(runId), "uploads", choice.name), "utf8") : choice.kind);
      return "The recording is in.";
    },
  };
  return { root, store, host, voiceovers };
}

let server: WebServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Collects frames from the stream until `until` says stop. */
function follow(url: string, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    let buffer = "";
    const req = request(url, { headers: { host: new URL(url).host } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          const frame = data ? parseFrame(data.slice(6)) : undefined;
          if (frame) frames.push(frame);
          if (until(frames)) {
            req.destroy();
            return resolve(frames);
          }
          at = buffer.indexOf("\n\n");
        }
      });
    });
    req.on("error", (err) => (err.message.includes("aborted") || (err as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(err)));
    req.end();
    setTimeout(() => reject(new Error(`Stream stopped with ${frames.length} frames.`)), 10_000).unref();
  });
}

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting.");
};

describe("web server", () => {
  it("starts a run, streams it live, stops at the review and finishes after your answer", async () => {
    const { host, store, voiceovers } = setup();
    server = await startWebServer({ host, port: 0, pollMs: 50 });
    const api = new ApiClient(server.url, fetch);

    const { runId } = await api.call("runs.createTask", { task: "Write a draft and hand it in.", project: "demo-project" });
    const streamed = await follow(`${server.url}/api/stream?run=${runId}`, (frames) =>
      frames.some((f) => f.type === "events" && f.events.some((e) => e.type === "gate.opened")),
    );
    const events = streamed.flatMap((f) => (f.type === "events" ? f.events : []));
    expect(events.map((e) => e.type)).toContain("tool.call.started");
    // Everything streamed is the log itself, in order, with no gaps.
    const seqs = [...new Set(events.map((e: HarnessEvent) => e.seq))].sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    await server.hub.settled(runId);
    const waiting = await api.call("runs.get", { runId });
    expect(waiting.card).toMatchObject({ status: "waiting_gate", pendingGate: "script", project: "demo-project", driver: "none" });
    expect(waiting.state.pendingGate).toBe("script");

    // Files the run wrote, and nothing outside its folder.
    const draft = await fetch(`${server.url}/files/runs/${runId}/draft.md`);
    expect(await draft.text()).toBe("# Draft\n\nA line.");
    expect(draft.headers.get("content-security-policy")).toContain("sandbox");
    expect((await fetch(`${server.url}/files/runs/${runId}/..%2Fevents.jsonl`)).status).toBe(404);
    expect((await api.call("runs.files", { runId })).files.map((f) => f.path)).toEqual(["draft.md"]);

    // A voiceover goes only with approving a reel's script; this is a plain run.
    const upload = await api.upload(runId, new Blob(["pretend audio"]), "take.m4a");
    await expect(api.call("runs.decide", { runId, gate: "script", decision: "approved", voiceover: { kind: "upload", name: upload } })).rejects.toThrow(/reel's script/);
    expect(voiceovers).toEqual([]);

    await expect(api.call("runs.decide", { runId, gate: "final_cut", decision: "approved" })).rejects.toThrow(/waiting on the script review/);
    await api.call("runs.decide", { runId, gate: "script", decision: "approved", notes: "Looks right." });
    await waitFor(async () => !server!.hub.isDriving(runId));
    await server.hub.settled(runId);
    const done = foldRun(await store.read(runId));
    expect(done.status).toBe("succeeded");
    const decided = (await store.read(runId)).find((e) => e.type === "gate.decided")!;
    expect(decided.payload).toMatchObject({ decision: "approved", notes: [{ text: "Looks right." }] });
  });

  it("files a run under a project in its own log, and lists projects from their folders", async () => {
    const { host, store } = setup();
    server = await startWebServer({ host, port: 0, pollMs: 50 });
    const api = new ApiClient(server.url, fetch);
    const runId = await createRun(store, { task: "Nothing to do.", model: "demo-model", system: "s" });
    await server.hub.poll();

    const created = await api.call("projects.create", { name: "Second Project!" });
    expect(created.project).toMatchObject({ slug: "second-project", title: "Second Project!", hasNotes: true });
    const filed = await api.call("runs.file", { runId, project: "second-project" });
    expect(filed.card.project).toBe("second-project");
    expect((await store.read(runId)).at(-1)).toMatchObject({ type: "x.web.filed", actor: "creator", payload: { project: "second-project" } });
    await expect(api.call("runs.file", { runId, project: "no-such-project" })).rejects.toThrow(/no project/);
    const projects = await api.call("projects.list", {});
    expect(projects.projects.map((p) => p.slug).sort()).toEqual(["demo-project", "second-project"]);
  });

  it("follows runs through the store alone, and takes changes the store pushes without waiting to list", async () => {
    const { host, store } = setup((runsDir) => new MemoryRunStore(runsDir));
    const memory = store as MemoryRunStore;
    // A listing an hour apart: anything sooner came from the store's push or from a call.
    server = await startWebServer({ host, port: 0, pollMs: 3_600_000 });
    const api = new ApiClient(server.url, fetch);

    // A run another worker created and is driving: the listing finds it, and who holds it.
    const runId = await createRun(store, { task: "Driven elsewhere.", model: "demo-model", system: "s" });
    const lease = await store.acquireLease(runId, "a terminal");
    expect((await api.call("runs.list", {})).runs).toMatchObject([{ runId, driver: "elsewhere", events: 1 }]);

    const state = foldRun(await store.read(runId));
    await store.append(runId, state.lastSeq, [
      { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), type: "context.message", actor: "engine", spanId: state.runSpanId, payload: { origin: "engine", content: "hello" } },
    ]);
    expect(server.hub.cards()[0]?.events).toBe(1);
    for (const notify of memory.listeners) notify(runId);
    await waitFor(async () => server!.hub.cards()[0]?.events === 2);
    expect((await api.call("runs.get", { runId })).events.map((e) => e.seq)).toEqual([1, 2]);

    await store.releaseLease(runId, "a terminal", lease.epoch);
    expect((await api.call("runs.list", {})).runs).toMatchObject([{ runId, driver: "none" }]);

    await server.close();
    server = undefined;
    expect(memory.listeners.size).toBe(0);
  });

  it("shows typing from a worker elsewhere, sent through the store", async () => {
    const { host, store } = setup((runsDir) => new MemoryRunStore(runsDir));
    const memory = store as MemoryRunStore;
    const { drive: _drive, ...writesOnly } = host;
    server = await startWebServer({ host: writesOnly, port: 0, pollMs: 3_600_000 });
    const runId = await createRun(store, { task: "Driven elsewhere.", model: "demo-model", system: "s" });
    await server.hub.refresh(runId);
    const typed = follow(`${server.url}/api/stream?run=${runId}`, (frames) => frames.filter((f) => f.type === "text").length >= 2);
    await waitFor(async () => memory.typing.size === 1);
    // Give the stream a moment to subscribe: typed text is not kept for late listeners.
    await new Promise((r) => setTimeout(r, 200));
    await store.publishText!(runId, "Writing ");
    await store.publishText!("another-run", "not this one");
    await store.publishText!(runId, "the draft.");
    const frames = await typed;
    expect(frames.flatMap((f) => (f.type === "text" ? [f.delta] : []))).toEqual(["Writing ", "the draft."]);
    await server.close();
    server = undefined;
    expect(memory.typing.size).toBe(0);
  });

  it("reads run files from blob storage when the worker is elsewhere, and waits for one not mirrored yet", async () => {
    const { host, store, root } = setup();
    const blobs = new DirectoryBlobs(join(root, "blobs"));
    const { drive: _drive, ...writesOnly } = host;
    server = await startWebServer({ host: { ...writesOnly, files: new BlobRunFiles(blobs) }, port: 0, pollMs: 50, mirrorWaitMs: 5_000 });
    const api = new ApiClient(server.url, fetch);
    const { runId } = await api.call("runs.createTask", { task: "Picked up by a worker." });

    // The worker's machine: a run folder the server never looks at, mirrored to the shared blobs.
    const workerRuns = join(root, "worker-runs");
    const work = join(workerRuns, runId, "work");
    mkdirSync(join(work, "renders"), { recursive: true });
    writeFileSync(join(work, "draft.md"), "# Draft\n");
    const mirror = new RunMirror(blobs, (id) => join(workerRuns, id));
    await mirror.now(runId);
    expect((await api.call("runs.files", { runId })).files.map((f) => f.path)).toEqual(["draft.md"]);

    const draft = await fetch(`${server.url}/files/runs/${runId}/draft.md`, { headers: { range: "bytes=2-" } });
    expect(draft.status).toBe(206);
    expect(draft.headers.get("content-security-policy")).toContain("sandbox");
    expect(await draft.text()).toBe("Draft\n");

    // The event naming a render can arrive before the render is mirrored: the request waits for it.
    const late = fetch(`${server.url}/files/runs/${runId}/renders/cut-1.mp4`);
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(work, "renders", "cut-1.mp4"), "pretend video");
    await mirror.now(runId);
    const cut = await late;
    expect(cut.status).toBe(200);
    expect(cut.headers.get("content-type")).toBe("video/mp4");
    expect(await cut.text()).toBe("pretend video");

    // Files on the server's own disk are not served in place of the mirror.
    mkdirSync(join(store.runDir(runId), "work"), { recursive: true });
    writeFileSync(join(store.runDir(runId), "work", "local.md"), "only here");
    const started = Date.now();
    expect((await fetch(`${server.url}/files/runs/${runId}/local.md`)).status).toBe(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
  }, 20_000);

  it("only writes when it drives nothing, and leaves the run waiting for a worker", async () => {
    const { host, store } = setup();
    const { drive: _drive, ...writesOnly } = host;
    server = await startWebServer({ host: writesOnly, port: 0, pollMs: 50 });
    const api = new ApiClient(server.url, fetch);
    const { runId } = await api.call("runs.createTask", { task: "Picked up by a worker." });
    expect(server.hub.isDriving(runId)).toBe(false);
    expect((await api.call("runs.get", { runId })).card).toMatchObject({ status: "created", driver: "none" });
    expect(await store.listRuns()).toEqual([{ runId, lastSeq: 1, status: "created" }]);
  });

  it("answers the names it is given, and only requests a sign-in proxy let through", async () => {
    const { host } = setup();
    server = await startWebServer({ host, port: 0, pollMs: 50, allowedHosts: ["harness.example.net"], requireHeader: "X-MS-Client-Principal-Id" });
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${server!.url}/`, { headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status({ host: "harness.example.net", "x-ms-client-principal-id": "someone" })).toBe(200);
    expect(await status({ host: "harness.example.net" })).toBe(401);
    expect(await status({ host: "other.example.net", "x-ms-client-principal-id": "someone" })).toBe(421);
  });

  it("answers only this machine, and only calls that carry the client header", async () => {
    const { host } = setup();
    server = await startWebServer({ host, port: 0, pollMs: 50 });
    const status = (path: string, headers: Record<string, string>, method = "GET") =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${server!.url}${path}`, { method, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(method === "POST" ? "{}" : undefined);
      });
    expect(await status("/", { host: "rebound.example:80" })).toBe(421);
    expect(await status("/", { host: `localhost:${server.port}` })).toBe(200);
    const noHeader = await fetch(`${server.url}/api/runs.list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await noHeader.json()).toMatchObject({ ok: false, error: { code: "bad-request" } });
    const badInput = await fetch(`${server.url}/api/runs.createTask`, { method: "POST", headers: { "content-type": "application/json", "x-harness-client": "1" }, body: JSON.stringify({ task: "" }) });
    expect(await badInput.json()).toMatchObject({ ok: false, error: { code: "bad-request" } });
    const page = await fetch(`${server.url}/`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const js = await fetch(`${server.url}/app.js`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(10_000);
  });
});
