import { resolve } from "node:path";
import { AzureBlobStore } from "@harness/blob-azure";
import type { RunStore } from "@harness/harness";
import { DirectoryBlobs, type BlobStore } from "@harness/web";
import { UsageError } from "./pipeline.ts";

/**
 * The blob storage a web server and a worker on two machines share, from the environment. Both halves are
 * given the same setting:
 *
 * - `HARNESS_BLOB_URL`: an Azure Blob container URL with a SAS token (read, create, write).
 * - `HARNESS_BLOB_DIR`: a folder, such as a share both machines mount.
 *
 * Neither set means none: uploads stay in each run's folder and run files are read from the run's folder,
 * which only works when the web server and the worker share a disk.
 */
export function blobsFor(env: Record<string, string | undefined>, cwd: string, fetch?: typeof globalThis.fetch): BlobStore | undefined {
  if (env.HARNESS_BLOB_URL) {
    try {
      return new AzureBlobStore({ containerUrl: env.HARNESS_BLOB_URL, ...(fetch ? { fetch } : {}) });
    } catch (err) {
      throw new UsageError(`HARNESS_BLOB_URL is not usable: ${(err as Error).message}`);
    }
  }
  if (env.HARNESS_BLOB_DIR) return new DirectoryBlobs(resolve(cwd, env.HARNESS_BLOB_DIR));
  return undefined;
}

/**
 * Sends model text as it is typed through the store, for a web server elsewhere. Deltas arrive a few
 * characters at a time; they are gathered for a moment and sent together, so a long answer is a few dozen
 * notifications, not thousands. Losing some is harmless (the finished text comes with its event), so a send
 * that fails is dropped.
 */
export class TextRelay {
  private readonly pending = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly store: Pick<RunStore, "publishText">, private readonly everyMs = 150) {}

  push(runId: string, delta: string): void {
    if (!this.store.publishText || !delta) return;
    this.pending.set(runId, (this.pending.get(runId) ?? "") + delta);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.everyMs);
      this.timer.unref?.();
    }
  }

  /** Sends what is gathered, after any send under way, so text keeps its order. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    const publish = this.store.publishText?.bind(this.store);
    if (!publish) return this.sending;
    this.sending = this.sending.then(async () => {
      for (const [runId, text] of batch) await publish(runId, text).catch(() => undefined);
    });
    return this.sending;
  }
}
