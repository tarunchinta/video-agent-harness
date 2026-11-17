import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
  fileTools, foldRun, payloadOf, runCommandTool, viewImageTool,
  type CreateRunInput, type EngineOptions, type HarnessEvent, type SandboxFactory, type ToolDefinition,
} from "@harness/harness";
import { INPUTS_DIR, REEL_PIPELINE, REEL_SYSTEM, reelPipeline, reelTask, VOICEOVER_EXTENSIONS, VOICEOVER_NAME, type WebFetchDeps } from "@harness/reel";
import { DockerSandbox } from "@harness/sandbox-docker";

/**
 * What a run was started as decides its tools and whether it has a sandbox. This file turns the run's own
 * record of that into engine options, so every worker that picks a run up builds the same ones. It also holds
 * what the creator hands a reel from the command line: notes, sources and the voiceover.
 */

/** A problem with what was typed. The message is shown with the usage text. */
export class UsageError extends Error {}

/** How many times a reel's agent may revise a rendered cut on its own judgement, unless the run says otherwise. */
export const DEFAULT_RE_EDITS = 2;

export type Network = "none" | "public";

export function networkFrom(value: string | undefined): Network | undefined {
  if (value === undefined) return undefined;
  if (value !== "none" && value !== "public") throw new UsageError(`--network is "none" or "public", not "${value}".`);
  return value;
}

/** The Docker sandbox for a run. Its commands reach nothing but the run's folders, plus the public web if asked. */
const dockerSandbox = (network: Network): SandboxFactory => async ({ runId, workDir, artifactsDir }) => {
  await mkdir(artifactsDir, { recursive: true });
  return DockerSandbox.start({ runId, workDir, artifactsDir, network });
};

export type PipelineDeps = {
  /** Replaces the Docker sandbox, for tests. */
  sandbox?: SandboxFactory;
  /** Replaces how the research tool reaches the web, for tests. */
  web?: WebFetchDeps;
};

/** The tools, finish rules and sandbox for a run, read from how it was created. Empty for a plain run. */
export function pipelineFor(events: readonly HarnessEvent[], deps: PipelineDeps = {}): Pick<EngineOptions, "tools" | "finishSchema" | "finishRequires" | "sandbox"> {
  const { config } = foldRun(events);
  const sandbox = config.sandbox_network ? { sandbox: deps.sandbox ?? dockerSandbox(config.sandbox_network) } : {};
  if (config.pipeline === REEL_PIPELINE) return { ...reelPipeline(deps.web ? { web: deps.web } : {}), ...sandbox };
  if (config.sandbox_network) return { tools: [...fileTools, viewImageTool, runCommandTool] as ToolDefinition[], ...sandbox };
  return {};
}

export const isReel = (events: readonly HarnessEvent[]): boolean => foldRun(events).config.pipeline === REEL_PIPELINE;

const NOTE_EXTENSIONS = [".md", ".txt"];
const MAX_NOTE_FILES = 30;
const MAX_NOTE_BYTES = 200_000;

/** The creator's own notes: one file, or the .md and .txt files of a folder. */
async function notesFrom(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new UsageError(`There is nothing at ${path} to use as notes.`);
  const files = info.isDirectory() ? (await readdir(path)).sort().map((name) => join(path, name)) : [path];
  const notes: string[] = [];
  for (const file of files) {
    if (!NOTE_EXTENSIONS.includes(extname(file).toLowerCase())) continue;
    const size = (await stat(file)).size;
    if (size > 0 && size <= MAX_NOTE_BYTES) notes.push(file);
  }
  if (!notes.length) throw new UsageError(`${path} holds no .md or .txt notes.`);
  return notes.slice(0, MAX_NOTE_FILES);
}

export type ReelFlags = { topic?: string; seconds?: string; source?: string[]; notes?: string; network?: string };

/**
 * Checks what was typed for `harness reel` and returns the run to create, plus a step that copies the
 * creator's notes into the new run's working directory.
 */
export async function reelRun(flags: ReelFlags, cwd: string): Promise<{ input: Omit<CreateRunInput, "model">; prepare: (workDir: string) => Promise<void> }> {
  if (!flags.topic?.trim()) throw new UsageError('"harness reel" needs --topic "what the reel is about".');
  const seconds = flags.seconds === undefined ? 60 : Number(flags.seconds);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 180) throw new UsageError(`--seconds is a length between 10 and 180, not "${flags.seconds}".`);
  const sources = flags.source ?? [];
  for (const url of sources) {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new UsageError(`--source needs a web address, not "${url}".`);
  }
  const notes = flags.notes ? await notesFrom(resolve(cwd, flags.notes)) : [];
  return {
    input: {
      title: flags.topic.trim().slice(0, 80),
      task: reelTask({ topic: flags.topic, seconds, sources, hasNotes: notes.length > 0 }),
      system: REEL_SYSTEM,
      maxOutputTokens: 64_000,
      pipeline: REEL_PIPELINE,
      sandboxNetwork: networkFrom(flags.network) ?? "none",
    },
    prepare: async (workDir) => {
      if (!notes.length) return;
      await mkdir(join(workDir, "notes"), { recursive: true });
      for (const file of notes) await copyFile(file, join(workDir, "notes", basename(file)));
    },
  };
}

async function existingRecording(inputs: string): Promise<string | undefined> {
  const names = await readdir(inputs).catch(() => [] as string[]);
  return names.find((name) => name.toLowerCase().startsWith(`${VOICEOVER_NAME}.`));
}

/**
 * Approving a reel's script is also when the creator hands over their reading of it. Puts the recording where
 * the run looks for it and returns the sentence the agent is told with the approval.
 */
export async function takeVoiceover(workDir: string, flags: { voiceover?: string; "no-voiceover"?: boolean }, cwd: string): Promise<string> {
  const inputs = join(workDir, INPUTS_DIR);
  const clear = async () => {
    for (let name = await existingRecording(inputs); name; name = await existingRecording(inputs)) await rm(join(inputs, name), { force: true });
  };
  if (flags["no-voiceover"]) {
    await clear();
    return "There is no voiceover recording. Use stand-in timing; the film will have captions and no voice.";
  }
  if (flags.voiceover) {
    const source = resolve(cwd, flags.voiceover);
    const extension = extname(source).toLowerCase();
    if (!(await stat(source).catch(() => undefined))?.isFile()) throw new UsageError(`There is no recording at ${source}.`);
    if (!VOICEOVER_EXTENSIONS.includes(extension)) {
      throw new UsageError(`The recording has to be one of these kinds of file: ${VOICEOVER_EXTENSIONS.map((e) => e.slice(1)).join(", ")}.`);
    }
    await clear();
    await mkdir(inputs, { recursive: true });
    await copyFile(source, join(inputs, `${VOICEOVER_NAME}${extension}`));
    return `The voiceover recording is at ${INPUTS_DIR}/${VOICEOVER_NAME}${extension}.`;
  }
  const kept = await existingRecording(inputs);
  if (kept) return `The voiceover recording is at ${INPUTS_DIR}/${kept}.`;
  throw new UsageError("Approving the script needs your recording of the narration: add --voiceover <file>. To render without a voice, add --no-voiceover.");
}

/** What the last word on a run needs from its log besides the outcome. */
export type OutcomeDetail = {
  reel?: boolean;
  /** Files waiting to be looked at, as full paths. */
  files?: string[];
  /** What the agent said when it handed the work in. */
  note?: string;
  estimatedSeconds?: number;
  /** Why the run paused, when the loop recorded more than a reason code. */
  pauseDetail?: string;
  /** Where the finished film is. */
  film?: string;
};

export function detailOf(events: readonly HarnessEvent[], workDir: string): OutcomeDetail {
  const state = foldRun(events);
  const detail: OutcomeDetail = { reel: state.config.pipeline === REEL_PIPELINE };
  const opened = events.findLast((e) => e.type === "gate.opened");
  if (opened && state.pendingGate) {
    const payload = payloadOf(opened, "gate.opened") as { files?: unknown; note?: unknown; estimated_seconds?: unknown };
    if (Array.isArray(payload.files)) detail.files = payload.files.filter((f): f is string => typeof f === "string").map((f) => resolve(workDir, f));
    if (typeof payload.note === "string") detail.note = payload.note;
    if (typeof payload.estimated_seconds === "number") detail.estimatedSeconds = payload.estimated_seconds;
  }
  const paused = events.findLast((e) => e.type === "run.paused");
  const why = paused ? (payloadOf(paused, "run.paused") as { detail?: unknown }).detail : undefined;
  if (typeof why === "string") detail.pauseDetail = why;
  const done = events.findLast((e) => e.type === "agent.completed");
  const film = done ? (payloadOf(done, "agent.completed").result as { film?: unknown } | null)?.film : undefined;
  if (detail.reel && typeof film === "string") detail.film = resolve(workDir, film);
  return detail;
}
