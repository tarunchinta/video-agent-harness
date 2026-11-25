import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { foldRun, type HarnessEvent, type RunStore } from "@harness/harness";
import { REEL_PIPELINE } from "@harness/reel";
import { BlobUploads, DirectoryUploads, projectOf, type BlobStore, type UploadStore } from "@harness/web";
import { workDirOf } from "./host.ts";
import { copyNotes, placeVoiceover, UsageError } from "./pipeline.ts";

/**
 * What the creator hands a run that the worker has to put on its own disk: a project's notes when a reel
 * starts, and the voiceover that comes with approving its script. When the web server and the worker are one
 * process (`harness web` on its own) the server does this itself. When they are not (`harness web --remote`
 * in the cloud, `harness worker` on the desktop) the server only records what was chosen, and the worker
 * acts on it here before it drives the run.
 */

/** Recorded by the remote web server when a reel's script is approved. */
export const VOICEOVER_EVENT = "x.web.voiceover";

export type VoiceoverChoice = { choice: "upload"; name: string; extension: string } | { choice: "none" };

/** The last voiceover choice the creator recorded for a run, with the event that holds it. */
export function lastVoiceover(events: readonly HarnessEvent[]): { eventId: string; choice: VoiceoverChoice } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === VOICEOVER_EVENT) return { eventId: e.eventId, choice: e.payload as VoiceoverChoice };
  }
  return undefined;
}

/**
 * Where uploads are kept, for the web server and the worker alike. Both must be given the same store: the
 * server saves the creator's recording here and the worker copies it into the run. With blob storage
 * (`blobsFor`) that works across machines; without it, uploads sit in each run's folder, which only works when
 * both halves share a disk.
 */
export function uploadsFor(store: RunStore, blobs?: BlobStore): UploadStore {
  return blobs ? new BlobUploads(blobs) : new DirectoryUploads((runId) => store.runDir(runId));
}

/** What the worker has already handed a run, kept next to its log so a second pickup does not repeat it. */
type Done = { notes?: boolean; voiceover?: string };

const donePath = (store: RunStore, runId: string) => join(store.runDir(runId), "handover.json");

async function readDone(store: RunStore, runId: string): Promise<Done> {
  try {
    return JSON.parse(await readFile(donePath(store, runId), "utf8")) as Done;
  } catch {
    return {};
  }
}

/**
 * Puts on disk what the creator chose for a run since the worker last had it. Returns what it did, as
 * sentences for the worker's output.
 */
export async function handOver(store: RunStore, runId: string, options: { uploads: UploadStore; projectsDir: string }): Promise<string[]> {
  const events = await store.read(runId);
  const { config } = foldRun(events);
  if (config.pipeline !== REEL_PIPELINE) return [];
  const done = await readDone(store, runId);
  const workDir = workDirOf(store, runId);
  const said: string[] = [];

  // Notes, once, before the agent first starts. A run made by `harness reel` or a local `harness web` has them already.
  const project = projectOf(events.slice(0, 1));
  if (!done.notes && project && !events.some((e) => e.type === "run.started") && !existsSync(join(workDir, "notes"))) {
    try {
      await copyNotes(join(options.projectsDir, project), workDir);
      said.push(`Copied the notes of project ${project}.`);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      said.push(`Project ${project} has no notes on this machine, so the run starts without them.`);
    }
    done.notes = true;
  }

  const voiceover = lastVoiceover(events);
  if (voiceover && voiceover.eventId !== done.voiceover) {
    const { choice } = voiceover;
    if (choice.choice === "upload") {
      if (!(await options.uploads.has(runId, choice.name))) throw new Error(`The voiceover ${choice.name} is not in the upload store.`);
      await placeVoiceover(workDir, { extension: choice.extension, copyTo: (destination) => options.uploads.copyTo(runId, choice.name, destination) });
      said.push(`Handed over the voiceover ${choice.name}.`);
    } else {
      await placeVoiceover(workDir, "none");
      said.push("Cleared the voiceover; the reel goes without a voice.");
    }
    done.voiceover = voiceover.eventId;
  }

  if (said.length) {
    await mkdir(store.runDir(runId), { recursive: true });
    await writeFile(donePath(store, runId), JSON.stringify(done));
  }
  return said;
}
