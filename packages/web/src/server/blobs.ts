import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Blob storage, as the web server and the worker see it: named byte strings, written whole and read by range.
 * It is how the two halves share files when they do not share a disk (`harness web --remote` in the cloud,
 * `harness worker` on the desktop). Keys are `/`-separated paths such as `runs/<run id>/uploads/<name>`; a store
 * never lists, so everything that needs a listing writes one as a blob of its own.
 *
 * The vendor stores live in their own packages (`@harness/blob-azure`). `DirectoryBlobs` keeps blobs in a
 * folder, for tests and for two machines that mount one share.
 */
export interface BlobStore {
  /** Writes a blob whole, replacing any blob with that key. Nothing is kept if it throws. */
  put(key: string, body: AsyncIterable<Uint8Array>, options?: { contentType?: string }): Promise<void>;
  /** The blob's size and when it was written, or nothing if there is no such blob. */
  head(key: string): Promise<BlobInfo | undefined>;
  /** The blob's bytes from `start` to `end` inclusive (all of it without a range), or nothing if there is no such blob. */
  get(key: string, range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array> | undefined>;
}

export type BlobInfo = { bytes: number; modifiedAt: string };

/** A key segment the stores accept: a plain name, nothing that climbs out of its folder. */
export const isBlobSegment = (segment: string) => Boolean(segment) && segment !== "." && segment !== ".." && !/[\\/\0]/.test(segment);

export function assertBlobKey(key: string): void {
  if (!key.split("/").every(isBlobSegment)) throw new Error("That blob key is not valid.");
}

/** Reads a whole blob as text, or nothing if there is no such blob. For small blobs such as a listing. */
export async function readBlobText(blobs: BlobStore, key: string): Promise<string | undefined> {
  const body = await blobs.get(key);
  if (!body) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Writes a string as a whole blob. */
export function putBlobText(blobs: BlobStore, key: string, text: string, contentType = "application/json"): Promise<void> {
  return blobs.put(key, (async function* () {
    yield Buffer.from(text, "utf8");
  })(), { contentType });
}

/** Blobs as files under one folder, on this machine or on a share both halves mount. */
export class DirectoryBlobs implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertBlobKey(key);
    const path = resolve(this.root, ...key.split("/"));
    if (!path.startsWith(this.root + sep)) throw new Error("That blob key is not valid.");
    return path;
  }

  async put(key: string, body: AsyncIterable<Uint8Array>, _options?: { contentType?: string }): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written beside the blob and moved into place, so a reader never sees half of one.
    const partial = join(dirname(path), `.${crypto.randomUUID()}.partial`);
    try {
      await pipeline(Readable.from(body), createWriteStream(partial));
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }

  async head(key: string): Promise<BlobInfo | undefined> {
    const info = await stat(this.path(key)).catch(() => undefined);
    return info?.isFile() ? { bytes: info.size, modifiedAt: info.mtime.toISOString() } : undefined;
  }

  async get(key: string, range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array> | undefined> {
    const path = this.path(key);
    if (!(await stat(path).catch(() => undefined))?.isFile()) return undefined;
    return createReadStream(path, range ? { start: range.start, end: range.end } : {});
  }
}
