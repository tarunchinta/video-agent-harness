import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BlobStore, isBlobSegment } from "./blobs.ts";

/**
 * Where the creator's uploads (voiceover recordings) are kept between the browser sending them and a worker
 * handing them to a run. Uploads are named by run and by the name the server gave them, so the web server and
 * the worker find the same file without sharing a disk. The folder version keeps them under each run's own
 * folder, which is enough when both run on one machine; a deployment where they do not plugs in a shared store
 * (blob storage) with the same shape.
 */
export type UploadStore = {
  /** Saves an upload. `body` is already within the size limit. Nothing is kept if it throws. */
  save(runId: string, name: string, body: AsyncIterable<Uint8Array>): Promise<void>;
  has(runId: string, name: string): Promise<boolean>;
  /** Copies an upload to a local file, for the run that needs it. */
  copyTo(runId: string, name: string, destination: string): Promise<void>;
};

/** A plain file name, as the server gives uploads: no folders, nothing that could leave the run's uploads. */
export const isUploadName = (name: string) => Boolean(name) && basename(name) === name && name !== "." && name !== "..";

/** Uploads in `<run folder>/uploads/<name>`, on this machine. */
export class DirectoryUploads implements UploadStore {
  constructor(private readonly runDir: (runId: string) => string) {}

  private path(runId: string, name: string): string {
    if (!isUploadName(name)) throw new Error("That upload name is not valid.");
    return join(this.runDir(runId), "uploads", name);
  }

  async save(runId: string, name: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.path(runId, name);
    await mkdir(join(this.runDir(runId), "uploads"), { recursive: true });
    try {
      await pipeline(body, createWriteStream(path));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
  }

  async has(runId: string, name: string): Promise<boolean> {
    if (!isUploadName(name)) return false;
    return Boolean((await stat(this.path(runId, name)).catch(() => undefined))?.isFile());
  }

  async copyTo(runId: string, name: string, destination: string): Promise<void> {
    await copyFile(this.path(runId, name), destination);
  }
}

/**
 * Uploads in blob storage, at `runs/<run id>/uploads/<name>`: the store for a web server and a worker on two
 * machines. Both are given the same `BlobStore`.
 */
export class BlobUploads implements UploadStore {
  constructor(private readonly blobs: BlobStore) {}

  private key(runId: string, name: string): string {
    if (!isUploadName(name) || !isBlobSegment(runId)) throw new Error("That upload name is not valid.");
    return `runs/${runId}/uploads/${name}`;
  }

  save(runId: string, name: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    return this.blobs.put(this.key(runId, name), body);
  }

  async has(runId: string, name: string): Promise<boolean> {
    if (!isUploadName(name) || !isBlobSegment(runId)) return false;
    return (await this.blobs.head(this.key(runId, name))) !== undefined;
  }

  async copyTo(runId: string, name: string, destination: string): Promise<void> {
    const body = await this.blobs.get(this.key(runId, name));
    if (!body) throw new Error(`The upload ${name} is not in blob storage.`);
    const partial = `${destination}.partial`;
    try {
      await pipeline(Readable.from(body), createWriteStream(partial));
      await rename(partial, destination);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }
}
