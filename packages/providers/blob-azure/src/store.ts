import { Readable } from "node:stream";
import { assertBlobKey, type BlobInfo, type BlobStore } from "@harness/web";

export type AzureBlobOptions = {
  /**
   * The container's URL with a SAS token, such as `https://<account>.blob.core.windows.net/<container>?sv=…&sig=…`.
   * The web server's token needs read, create and write; so does the worker's. A path-style URL (the Azurite
   * emulator's `http://127.0.0.1:10000/<account>/<container>?…`) works too. It is a secret: it never appears in an
   * error message.
   */
  containerUrl: string;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Bytes per block when a blob is sent in parts. 8 MiB unless set. */
  blockBytes?: number;
};

/** The REST API version every request names. */
export const API_VERSION = "2023-11-03";
const DEFAULT_BLOCK = 8 * 1024 * 1024;
const ATTEMPTS = 3;

/**
 * Azure Blob Storage with plain HTTP, as block blobs in one container. A small blob is one `Put Blob`; a larger
 * one is sent a block at a time (`Put Block`) and committed with `Put Block List`, so memory stays at one block
 * whatever the size of a render. Blocks that are never committed are dropped by the service, so a send that
 * fails leaves the old blob, or none, in place. Every request is idempotent and is tried up to three times on a
 * network error, a 5xx or a 429.
 */
export class AzureBlobStore implements BlobStore {
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly sas: string;
  private readonly blockBytes: number;

  constructor(options: AzureBlobOptions) {
    let url: URL;
    try {
      url = new URL(options.containerUrl);
    } catch {
      throw new Error("The blob container URL is not a URL.");
    }
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("The blob container URL must use https.");
    if (!url.search) throw new Error("The blob container URL needs a SAS token after the ?.");
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.sas = url.search.slice(1);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.blockBytes = Math.max(1, options.blockBytes ?? DEFAULT_BLOCK);
  }

  private url(key: string, query = ""): string {
    assertBlobKey(key);
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}?${query ? `${query}&` : ""}${this.sas}`;
  }

  private async call(what: string, url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array }, ok: number[]): Promise<Response> {
    const headers = { "x-ms-version": API_VERSION, ...init.headers };
    let last = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(url, { method: init.method, headers, ...(init.body ? { body: init.body } : {}) });
      } catch (err) {
        // The message of a failed fetch can carry the URL, and with it the token. Only its kind is kept.
        last = `could not be reached (${(err as Error).name})`;
        if (attempt < ATTEMPTS) await pause(attempt);
        continue;
      }
      if (ok.includes(response.status)) return response;
      await response.body?.cancel().catch(() => {});
      last = `answered ${response.status}${response.headers.get("x-ms-error-code") ? ` ${response.headers.get("x-ms-error-code")}` : ""}`;
      if (response.status !== 429 && response.status < 500) break;
      if (attempt < ATTEMPTS) await pause(attempt);
    }
    throw new Error(`Blob storage ${last} to ${what}.`);
  }

  async put(key: string, body: AsyncIterable<Uint8Array>, options: { contentType?: string } = {}): Promise<void> {
    const type = options.contentType ?? "application/octet-stream";
    const blocks: string[] = [];
    let buffered: Buffer[] = [];
    let size = 0;
    const sendBlock = async (bytes: Buffer) => {
      // Every id in a blob must be the same length.
      const id = Buffer.from(`block-${String(blocks.length).padStart(6, "0")}`).toString("base64");
      await this.call("send part of a file", this.url(key, `comp=block&blockid=${encodeURIComponent(id)}`), { method: "PUT", body: bytes }, [201]);
      blocks.push(id);
    };
    for await (const chunk of body) {
      buffered.push(Buffer.from(chunk));
      size += chunk.byteLength;
      while (size >= this.blockBytes) {
        const all = Buffer.concat(buffered);
        await sendBlock(all.subarray(0, this.blockBytes));
        const rest = all.subarray(this.blockBytes);
        buffered = rest.length ? [rest] : [];
        size = rest.length;
      }
    }
    const tail = Buffer.concat(buffered);
    if (!blocks.length) {
      await this.call("save a file", this.url(key), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": type }, body: tail }, [201]);
      return;
    }
    if (tail.length) await sendBlock(tail);
    const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blocks.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`;
    await this.call(
      "finish saving a file",
      this.url(key, "comp=blocklist"),
      { method: "PUT", headers: { "content-type": "application/xml", "x-ms-blob-content-type": type }, body: Buffer.from(list) },
      [201],
    );
  }

  async head(key: string): Promise<BlobInfo | undefined> {
    const response = await this.call("look up a file", this.url(key), { method: "HEAD" }, [200, 404]);
    if (response.status === 404) return undefined;
    const modified = response.headers.get("last-modified");
    return {
      bytes: Number(response.headers.get("content-length") ?? 0),
      modifiedAt: (modified ? new Date(modified) : new Date()).toISOString(),
    };
  }

  async get(key: string, range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array> | undefined> {
    const response = await this.call(
      "read a file",
      this.url(key),
      { method: "GET", ...(range ? { headers: { "x-ms-range": `bytes=${range.start}-${range.end}` } } : {}) },
      [200, 206, 404],
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.body) return (async function* () {})();
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  }
}

const pause = (attempt: number) => new Promise((done) => setTimeout(done, 250 * 2 ** (attempt - 1)));
