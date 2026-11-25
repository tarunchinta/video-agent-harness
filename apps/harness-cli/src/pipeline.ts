import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
  fileTools, foldRun, payloadOf, runCommandTool, viewImageTool,
  type CreateRunInput, type EngineOptions, type HarnessEvent, type SandboxFactory, type ToolDefinition,
} from "@harness/harness";
import {
  INPUTS_DIR, MAX_WORDS, MIN_WORDS, narrationWords, REEL_PIPELINE, REEL_SYSTEM, reelPipeline, reelTask, VOICEOVER_EXTENSIONS, VOICEOVER_NAME, WORDS_PER_SECOND,
  type WebFetchDeps,
} from "@harness/reel";
import type { SearchProvider } from "@harness/harness";
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
  /** Starts sandboxes with a given network, from the plugin that provides the sandbox seam. */
  sandboxDriver?: (settings: { network: Network }) => SandboxFactory;
  /** Web search for research. Without one, the run has no `web_search` tool. */
  search?: SearchProvider;
  /** Replaces how the research tool reaches the web, for tests. */
  web?: WebFetchDeps;
};

/** The tools, finish rules and sandbox for a run, read from how it was created. Empty for a plain run. */
export function pipelineFor(events: readonly HarnessEvent[], deps: PipelineDeps = {}): Pick<EngineOptions, "tools" | "finishSchema" | "finishRequires" | "sandbox"> {
  const { config } = foldRun(events);
  const network = config.sandbox_network;
  const sandbox = network ? { sandbox: deps.sandbox ?? deps.sandboxDriver?.({ network }) ?? dockerSandbox(network) } : {};
  if (config.pipeline === REEL_PIPELINE) {
    // The critic is on only for runs created with it, so a run made before the critic resumes with the rules it began with.
    const reel = reelPipeline({
      ...(deps.web ? { web: deps.web } : {}),
      ...(deps.search ? { search: deps.search } : {}),
      critic: config.critic === true,
      ...(config.narration !== undefined ? { narration: config.narration } : {}),
    });
    return { ...reel, ...sandbox };
  }
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

export type ReelFlags = { topic?: string; seconds?: string; source?: string[]; notes?: string; network?: string; script?: string; voiceover?: string };

const SCRIPT_EXTENSIONS = [".txt", ".md"];

/** The creator's own narration: the words they read, from a .txt or .md file. */
async function narrationFrom(path: string): Promise<string> {
  if (!SCRIPT_EXTENSIONS.includes(extname(path).toLowerCase())) throw new UsageError(`--script takes a .txt or .md file of the words you read, not ${basename(path)}.`);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new UsageError(`There is no script at ${path}.`);
  if (info.size > MAX_NOTE_BYTES) throw new UsageError(`${basename(path)} is too large to be a reel's narration.`);
  const text = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n").trim();
  const words = narrationWords(text).length;
  if (words < MIN_WORDS) throw new UsageError(`The script has ${words} words. A reel needs at least ${MIN_WORDS}.`);
  if (words > MAX_WORDS) throw new UsageError(`The script has ${words} words, which is over three minutes of speech. Cut it to ${MAX_WORDS} or fewer.`);
  return text;
}

/** A reel's title when only a script was given: its first line, cut at a word. */
function titleOf(narration: string): string {
  const first = narration.split("\n")[0]!.trim();
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80)}…`;
}

/**
 * Checks what was typed for `harness reel` and returns the run to create, plus a step that copies the
 * creator's notes into the new run's working directory.
 */
export async function reelRun(flags: ReelFlags, cwd: string): Promise<{ input: Omit<CreateRunInput, "model">; prepare: (workDir: string) => Promise<void> }> {
  if (!flags.topic?.trim() && !flags.script) throw new UsageError('"harness reel" needs --topic "what the reel is about", or --script <the words you read>.');
  if (flags.voiceover !== undefined && !flags.script) {
    throw new UsageError("--voiceover goes with --script when you start a reel. Otherwise give your recording when you approve the script.");
  }
  const narration = flags.script ? await narrationFrom(resolve(cwd, flags.script)) : undefined;
  const recording = flags.voiceover !== undefined ? resolve(cwd, flags.voiceover) : undefined;
  if (recording !== undefined) {
    voiceoverExtension(recording);
    if (!(await stat(recording).catch(() => undefined))?.isFile()) throw new UsageError(`There is no recording at ${recording}.`);
  }
  const estimated = narration ? Math.min(180, Math.max(10, Math.round(narrationWords(narration).length / WORDS_PER_SECOND))) : 60;
  const seconds = flags.seconds === undefined ? estimated : Number(flags.seconds);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 180) throw new UsageError(`--seconds is a length between 10 and 180, not "${flags.seconds}".`);
  const sources = flags.source ?? [];
  for (const url of sources) {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new UsageError(`--source needs a web address, not "${url}".`);
  }
  const notes = flags.notes ? await notesFrom(resolve(cwd, flags.notes)) : [];
  const topic = flags.topic?.trim() || titleOf(narration!);
  return {
    input: {
      title: topic.slice(0, 80),
      task: reelTask({ topic, seconds, sources, hasNotes: notes.length > 0, ...(narration ? { narration } : {}) }),
      system: REEL_SYSTEM,
      maxOutputTokens: 64_000,
      pipeline: REEL_PIPELINE,
      sandboxNetwork: networkFrom(flags.network) ?? "none",
      critic: true,
      compaction: true,
      ...(narration ? { narration } : {}),
    },
    prepare: async (workDir) => {
      await copyNoteFiles(notes, workDir);
      // Given now, the recording is kept for the script review, so approving needs no --voiceover.
      if (recording) await placeVoiceover(workDir, { extension: voiceoverExtension(recording), copyTo: (destination) => copyFile(recording, destination) });
    },
  };
}

async function copyNoteFiles(files: string[], workDir: string): Promise<void> {
  if (!files.length) return;
  await mkdir(join(workDir, "notes"), { recursive: true });
  for (const file of files) await copyFile(file, join(workDir, "notes", basename(file)));
}

/** Copies the creator's notes (one file, or the .md and .txt files of a folder) into a run's `notes/`. */
export async function copyNotes(path: string, workDir: string): Promise<void> {
  await copyNoteFiles(await notesFrom(path), workDir);
}

async function existingRecording(inputs: string): Promise<string | undefined> {
  const names = await readdir(inputs).catch(() => [] as string[]);
  return names.find((name) => name.toLowerCase().startsWith(`${VOICEOVER_NAME}.`));
}

export const NO_VOICEOVER_NOTE = "There is no voiceover recording. Use stand-in timing; the film will have captions and no voice.";

/** The sentence the agent is told with the script approval when its recording is `inputs/<fileName>`. */
export const voiceoverNote = (fileName: string) => `The voiceover recording is at ${INPUTS_DIR}/${fileName}.`;

/** The name a recording with this extension gets in the run's inputs. */
export const voiceoverFileName = (extension: string) => `${VOICEOVER_NAME}${extension}`;

/** The recording's extension, lower case, if it is a kind of file a reel can use. */
export function voiceoverExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  if (!VOICEOVER_EXTENSIONS.includes(extension)) {
    throw new UsageError(`The recording has to be one of these kinds of file: ${VOICEOVER_EXTENSIONS.map((e) => e.slice(1)).join(", ")}.`);
  }
  return extension;
}

/** A recording to hand to a reel, from wherever it is kept. */
export type Recording = { extension: string; copyTo: (destination: string) => Promise<void> };

/** Puts a recording where the run looks for it, or clears it, and returns the sentence the agent is told. */
export async function placeVoiceover(workDir: string, recording: Recording | "none"): Promise<string> {
  const inputs = join(workDir, INPUTS_DIR);
  for (let name = await existingRecording(inputs); name; name = await existingRecording(inputs)) await rm(join(inputs, name), { force: true });
  if (recording === "none") return NO_VOICEOVER_NOTE;
  await mkdir(inputs, { recursive: true });
  const fileName = voiceoverFileName(recording.extension);
  await recording.copyTo(join(inputs, fileName));
  return voiceoverNote(fileName);
}

/**
 * Approving a reel's script is also when the creator hands over their reading of it. Puts the recording where
 * the run looks for it and returns the sentence the agent is told with the approval.
 */
export async function takeVoiceover(workDir: string, flags: { voiceover?: string; "no-voiceover"?: boolean }, cwd: string): Promise<string> {
  if (flags["no-voiceover"]) return placeVoiceover(workDir, "none");
  if (flags.voiceover) {
    const source = resolve(cwd, flags.voiceover);
    if (!(await stat(source).catch(() => undefined))?.isFile()) throw new UsageError(`There is no recording at ${source}.`);
    return placeVoiceover(workDir, { extension: voiceoverExtension(source), copyTo: (destination) => copyFile(source, destination) });
  }
  const kept = await existingRecording(join(workDir, INPUTS_DIR));
  if (kept) return voiceoverNote(kept);
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
