import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type FileEntry, fileEntrySchema } from "../api/contract.ts";
import { type BlobStore, isBlobSegment, putBlobText, readBlobText } from "./blobs.ts";
import { confined, contentTypeOf, diskFile, listFiles, type ServedFile } from "./files.ts";

/**
 * The files a run made, as the web server reads them: its working folder (`work`: scripts, renders, research)
 * and the pictures the agent looked at (`artifacts`, named by their SHA-256). On one machine they are read from
 * the run's folder. When the web server runs apart from the worker, the worker mirrors them to blob storage
 * (`RunMirror`) and the server reads them from there (`BlobRunFiles`).
 */
export type RunFiles = {
  /** The run's working folder, as a list. */
  list(runId: string): Promise<FileEntry[]>;
  /** One file, or nothing if there is no such file or the path would leave its folder. */
  open(runId: string, scope: "work" | "artifacts", path: string): Promise<ServedFile | undefined>;
};

/** Run files in each run's folder on this machine. */
export class DiskRunFiles implements RunFiles {
  constructor(private readonly runDir: (runId: string) => string) {}

  list(runId: string): Promise<FileEntry[]> {
    return listFiles(join(this.runDir(runId), "work"), "run");
  }

  async open(runId: string, scope: "work" | "artifacts", path: string): Promise<ServedFile | undefined> {
    const real = await confined(join(this.runDir(runId), scope), path);
    return real ? diskFile(real) : undefined;
  }
}

/** The listing the worker writes next to a run's mirrored files. */
const manifestSchema = z.object({ files: z.array(fileEntrySchema), writtenAt: z.string() });

const ARTIFACT_NAME = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

const manifestKey = (runId: string) => `runs/${runId}/files.json`;
const workKey = (runId: string, path: string) => `runs/${runId}/work/${path}`;
const artifactKey = (runId: string, name: string) => `runs/${runId}/artifacts/${name}`;

/** Run files the worker mirrored to blob storage. Only what the worker listed is served. */
export class BlobRunFiles implements RunFiles {
  constructor(private readonly blobs: BlobStore) {}

  private async manifest(runId: string): Promise<FileEntry[]> {
    if (!isBlobSegment(runId)) return [];
    const text = await readBlobText(this.blobs, manifestKey(runId));
    if (!text) return [];
    try {
      return manifestSchema.parse(JSON.parse(text)).files;
    } catch {
      return [];
    }
  }

  list(runId: string): Promise<FileEntry[]> {
    return this.manifest(runId);
  }

  async open(runId: string, scope: "work" | "artifacts", path: string): Promise<ServedFile | undefined> {
    if (!isBlobSegment(runId)) return undefined;
    let key: string;
    if (scope === "artifacts") {
      if (!ARTIFACT_NAME.test(path)) return undefined;
      key = artifactKey(runId, path);
    } else {
      // The listing is the allow-list: a key that is not on it is never read, whatever its path.
      if (!(await this.manifest(runId)).some((f) => f.path === path)) return undefined;
      key = workKey(runId, path);
    }
    const info = await this.blobs.head(key);
    if (!info) return undefined;
    const { blobs } = this;
    return {
      name: path.split("/").pop() ?? path,
      bytes: info.bytes,
      modifiedAt: info.modifiedAt,
      async read(range) {
        const body = await blobs.get(key, range);
        if (!body) throw new Error("The file went away while it was being read.");
        return body;
      },
    };
  }
}

/** What has been mirrored for one run: a signature per path, kept next to the run's log. */
type Mirrored = { work: Record<string, string>; artifacts: string[]; manifest?: string };

const UPLOADS_AT_ONCE = 4;

/**
 * Copies a run's files to blob storage, for a web server elsewhere to show. Only files that changed since the
 * last copy go up (by size and modification time), and what went up is remembered in `<run folder>/mirror.json`
 * so a restarted worker does not send everything again. The listing goes up last, so the server never lists a
 * file that is not there yet.
 *
 * Calls for one run are queued, never run side by side. `soon` coalesces the bursts of events a run writes;
 * `now` is for the end of a drive, when everything must be up before the worker moves on.
 */
export class RunMirror {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly runDir: (runId: string) => string,
    private readonly options: { delayMs?: number; onError?: (runId: string, err: unknown) => void } = {},
  ) {}

  /** Mirrors the run a moment from now, once, however many times this is called in the meantime. */
  soon(runId: string): void {
    if (this.timers.has(runId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.now(runId).catch((err) => this.options.onError?.(runId, err));
    }, this.options.delayMs ?? 3_000);
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  /** Mirrors the run now, after any copy already under way. */
  now(runId: string): Promise<void> {
    const pending = this.timers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(runId);
    }
    const next = (this.queues.get(runId) ?? Promise.resolve()).catch(() => undefined).then(() => this.copy(runId));
    this.queues.set(runId, next);
    void next.finally(() => this.queues.get(runId) === next && this.queues.delete(runId)).catch(() => undefined);
    return next;
  }

  /** Waits for every copy queued or under way. For tests and shutdown. */
  async idle(): Promise<void> {
    for (const runId of [...this.timers.keys()]) void this.now(runId).catch((err) => this.options.onError?.(runId, err));
    await Promise.allSettled([...this.queues.values()]);
  }

  private async copy(runId: string): Promise<void> {
    if (!isBlobSegment(runId)) throw new Error("That is not a run id.");
    const dir = this.runDir(runId);
    const statePath = join(dir, "mirror.json");
    const done: Mirrored = await readFile(statePath, "utf8")
      .then((t) => JSON.parse(t) as Mirrored)
      .catch(() => ({ work: {}, artifacts: [] }));
    let changed = false;

    const work = await listFiles(join(dir, "work"), "run");
    const sends: (() => Promise<void>)[] = [];
    for (const file of work) {
      const signature = `${file.bytes}:${file.modifiedAt}`;
      if (done.work[file.path] === signature) continue;
      sends.push(async () => {
        if (await this.send(workKey(runId, file.path), join(dir, "work", ...file.path.split("/")))) {
          done.work[file.path] = signature;
          changed = true;
        }
      });
    }
    const pictures = (await readdir(join(dir, "artifacts")).catch(() => [] as string[])).filter((n) => ARTIFACT_NAME.test(n));
    const sent = new Set(done.artifacts);
    for (const name of pictures) {
      if (sent.has(name)) continue;
      sends.push(async () => {
        if (await this.send(artifactKey(runId, name), join(dir, "artifacts", name))) {
          done.artifacts.push(name);
          changed = true;
        }
      });
    }
    const save = async () => {
      if (!changed) return;
      await mkdir(dir, { recursive: true });
      await writeFile(statePath, JSON.stringify(done));
    };
    try {
      await inBatches(sends, UPLOADS_AT_ONCE);
    } catch (err) {
      // Keep what did go up, so the next copy only sends the rest.
      await save();
      throw err;
    }

    // Files that are gone locally drop off the listing; their blobs stay until the run is cleaned up.
    const listed = new Set(work.map((f) => f.path));
    for (const path of Object.keys(done.work)) {
      if (!listed.has(path)) {
        delete done.work[path];
        changed = true;
      }
    }
    const files = work.filter((f) => done.work[f.path] === `${f.bytes}:${f.modifiedAt}`);
    const manifest = JSON.stringify(files);
    if (manifest !== done.manifest) {
      await putBlobText(this.blobs, manifestKey(runId), JSON.stringify({ files, writtenAt: new Date().toISOString() }));
      done.manifest = manifest;
      changed = true;
    }
    await save();
  }

  /** Sends one file. False if it went away before it could be read. */
  private async send(key: string, path: string): Promise<boolean> {
    if (!(await stat(path).catch(() => undefined))?.isFile()) return false;
    await this.blobs.put(key, createReadStream(path), { contentType: contentTypeOf(path) });
    return true;
  }
}

/** Runs every task, `width` at a time, then throws the first failure, if any. A failure stops nothing else. */
async function inBatches(tasks: (() => Promise<void>)[], width: number): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const lane = async () => {
    while (next < tasks.length) await tasks[next++]!().catch((err: unknown) => void failures.push(err));
  };
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, lane));
  if (failures.length) throw failures[0];
}
