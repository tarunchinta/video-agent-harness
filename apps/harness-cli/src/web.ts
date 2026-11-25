import { readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createRun, recordCreatorEvent, type RunStore } from "@harness/harness";
import { BlobRunFiles, startWebServer, type RunHost, type WebServer } from "@harness/web";
import { blobsFor } from "./blobs.ts";
import { lastVoiceover, uploadsFor, VOICEOVER_EVENT, type VoiceoverChoice } from "./handover.ts";
import { availableModels, defaultModel, driveRun, workDirOf, type HostIo } from "./host.ts";
import {
  DEFAULT_RE_EDITS, NO_VOICEOVER_NOTE, placeVoiceover, reelRun, takeVoiceover, UsageError, voiceoverExtension, voiceoverFileName, voiceoverNote,
} from "./pipeline.ts";

/**
 * `harness web`: the web server, given what it needs to create and drive runs. The same pieces as the terminal
 * commands (the reel brief check, the provider, the voiceover hand-over), so a run started in the browser is
 * the same run `harness resume` can pick up, and the other way round.
 *
 * With `--remote` it is the half that runs in the cloud: it writes what the creator asks for to the store and
 * drives nothing. `harness worker` on the desktop picks the runs up and does the rest (see handover.ts).
 */

const DEFAULT_SYSTEM =
  "You are an agent working in a directory of files. Use the tools to do the task you are given. " +
  "When the task is complete, call finish with a short summary of what you did.";

async function hasNotes(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.some((n) => [".md", ".txt"].includes(extname(n).toLowerCase()));
}

export function webHost(store: RunStore, io: HostIo & { cwd: string }, runsDir: string, options: { remote?: boolean } = {}): RunHost {
  const projectsDir = resolve(io.cwd, io.env.HARNESS_PROJECTS_DIR ?? "projects");
  const remote = options.remote === true;
  const blobs = blobsFor(io.env, io.cwd, io.fetch);
  const uploads = uploadsFor(store, blobs);
  const record = (runId: string, choice: VoiceoverChoice) => recordCreatorEvent(store, runId, VOICEOVER_EVENT, choice);
  return {
    store,
    runsDir,
    projectsDir,
    cwd: io.cwd,
    defaultModel: defaultModel(io.env),
    // The cloud side holds no model keys, so it is told which models the worker can use.
    models: remote && io.env.HARNESS_MODELS ? [...new Set([defaultModel(io.env), ...io.env.HARNESS_MODELS.split(",").map((m) => m.trim()).filter(Boolean)])] : availableModels(io.env),
    uploads,
    // Apart from the worker, run files are the copies it puts in blob storage. Without blob storage they are
    // read from this machine's run folders, which only have them when both halves share a disk.
    ...(remote && blobs ? { files: new BlobRunFiles(blobs) } : {}),
    async createReel(input) {
      const notes = input.notesDir && (await hasNotes(input.notesDir)) ? input.notesDir : undefined;
      const reel = await reelRun(
        { topic: input.topic, seconds: String(input.seconds), source: input.sources, network: input.network, ...(notes ? { notes } : {}) },
        io.cwd,
      );
      const runId = await createRun(store, {
        ...reel.input,
        model: input.model ?? defaultModel(io.env),
        limits: { max_re_edits: DEFAULT_RE_EDITS, ...input.limits },
        ...(input.project ? { project: input.project } : {}),
      });
      // Remotely, the worker copies the project's notes from its own projects folder when it first picks the run up.
      if (!remote) await reel.prepare(workDirOf(store, runId));
      return runId;
    },
    async createTask(input) {
      return createRun(store, {
        task: input.task,
        model: input.model ?? defaultModel(io.env),
        system: DEFAULT_SYSTEM,
        maxOutputTokens: 64_000,
        compaction: true,
        limits: input.limits,
        ...(input.sandbox ? { sandboxNetwork: "none" as const } : {}),
        ...(input.project ? { project: input.project } : {}),
      });
    },
    ...(remote ? {} : { drive: (runId: string, hooks: Parameters<NonNullable<RunHost["drive"]>>[1]) => driveRun(store, runId, io, hooks) }),
    async voiceover(runId, choice) {
      if (!remote) {
        if (choice.kind === "upload") {
          const { name } = choice;
          return placeVoiceover(workDirOf(store, runId), { extension: voiceoverExtension(name), copyTo: (destination) => uploads.copyTo(runId, name, destination) });
        }
        return takeVoiceover(workDirOf(store, runId), choice.kind === "none" ? { "no-voiceover": true } : {}, io.cwd);
      }
      if (choice.kind === "upload") {
        const extension = voiceoverExtension(choice.name);
        await record(runId, { choice: "upload", name: choice.name, extension });
        return voiceoverNote(voiceoverFileName(extension));
      }
      if (choice.kind === "none") {
        await record(runId, { choice: "none" });
        return NO_VOICEOVER_NOTE;
      }
      // Keeping one needs a recording this side knows about: one uploaded here earlier.
      const kept = lastVoiceover(await store.read(runId))?.choice;
      if (kept?.choice === "upload") return voiceoverNote(voiceoverFileName(kept.extension));
      throw new UsageError("There is no recording for this reel yet. Upload your reading of the script, or choose to go without a voice.");
    },
    isUserError: (err) => err instanceof UsageError,
  };
}

export async function serveWeb(options: {
  store: RunStore;
  io: HostIo & { cwd: string; signal?: AbortSignal };
  runsDir: string;
  port: number;
  /** Drive nothing here; a worker elsewhere picks the runs up from the store. */
  remote?: boolean;
  bind?: string;
  allowedHosts?: string[];
  requireHeader?: string;
  line: (text: string) => void;
  /** Called once the server is up, for tests. */
  started?: (server: WebServer) => void;
}): Promise<number> {
  const { io, line } = options;
  let server: WebServer;
  try {
    server = await startWebServer({
      host: webHost(options.store, io, options.runsDir, { remote: options.remote === true }),
      port: options.port,
      dev: io.env.HARNESS_WEB_DEV === "1",
      ...(options.bind ? { bind: options.bind } : {}),
      ...(options.allowedHosts?.length ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.requireHeader ? { requireHeader: options.requireHeader } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new UsageError(`Port ${options.port} is in use. Pick another with --port.`);
    throw err;
  }
  line(`The harness is open at ${server.url}`);
  if (options.remote) line("Nothing is driven here. Runs move when `harness worker` is running against the same store.");
  else line("Runs started here keep going while this window is open. Ctrl-C stops them after their current step; resume them later from the page or the terminal.");
  options.started?.(server);
  await new Promise<void>((done) => {
    if (!io.signal) return done();
    if (io.signal.aborted) return done();
    io.signal.addEventListener("abort", () => done(), { once: true });
  });
  await server.close();
  line("Stopped the web server.");
  return 0;
}
