import { describe, expect, it } from "vitest";
import { AzureBlobStore, API_VERSION } from "../src/index.ts";

/**
 * The store against a stand-in for the Blob service: an in-memory container that answers the five calls the
 * store makes (Put Blob, Put Block, Put Block List, Get Blob Properties, Get Blob) the way the REST API does.
 * No network.
 */

const CONTAINER = "https://demo.blob.core.example/harness";
const SAS = "sv=2023-11-03&sp=rcw&sig=placeholder-signature";

type Seen = { method: string; path: string; query: URLSearchParams; headers: Headers };

function fakeService(options: { failFirst?: number; status?: number } = {}) {
  const blobs = new Map<string, { bytes: Buffer; type: string; modified: Date }>();
  const blocks = new Map<string, Map<string, Buffer>>();
  const seen: Seen[] = [];
  let failures = options.failFirst ?? 0;
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname.replace(/^\/harness\//, ""));
    seen.push({ method, path, query: url.searchParams, headers });
    if (url.searchParams.get("sig") !== "placeholder-signature" || headers.get("x-ms-version") !== API_VERSION) return new Response(null, { status: 403 });
    if (failures > 0) {
      failures -= 1;
      return new Response(null, { status: options.status ?? 503, headers: { "x-ms-error-code": "ServerBusy" } });
    }
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const comp = url.searchParams.get("comp");
    if (method === "PUT" && comp === "block") {
      const id = url.searchParams.get("blockid")!;
      if (!blocks.has(path)) blocks.set(path, new Map());
      blocks.get(path)!.set(id, body);
      return new Response(null, { status: 201 });
    }
    if (method === "PUT" && comp === "blocklist") {
      const ids = [...body.toString("utf8").matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((m) => m[1]!);
      const staged = blocks.get(path) ?? new Map();
      if (ids.some((id) => !staged.has(id))) return new Response(null, { status: 400, headers: { "x-ms-error-code": "InvalidBlockList" } });
      blobs.set(path, { bytes: Buffer.concat(ids.map((id) => staged.get(id)!)), type: headers.get("x-ms-blob-content-type") ?? "", modified: new Date() });
      blocks.delete(path);
      return new Response(null, { status: 201 });
    }
    if (method === "PUT") {
      if (headers.get("x-ms-blob-type") !== "BlockBlob") return new Response(null, { status: 400 });
      blobs.set(path, { bytes: body, type: headers.get("x-ms-blob-content-type") ?? "", modified: new Date() });
      return new Response(null, { status: 201 });
    }
    const blob = blobs.get(path);
    if (!blob) return new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } });
    const info = { "content-length": String(blob.bytes.length), "last-modified": blob.modified.toUTCString() };
    if (method === "HEAD") return new Response(null, { status: 200, headers: info });
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("x-ms-range") ?? "");
    if (range) return new Response(blob.bytes.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 });
    return new Response(blob.bytes, { status: 200, headers: info });
  }) as typeof fetch;
  return { fetch, blobs, seen };
}

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

async function text(body: AsyncIterable<Uint8Array> | undefined): Promise<string | undefined> {
  if (!body) return undefined;
  const out: Buffer[] = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out).toString("utf8");
}

describe("Azure blob store", () => {
  it("saves a small file in one call and reads it back whole and by range", async () => {
    const service = fakeService();
    const store = new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: service.fetch });
    await store.put("runs/run-1/uploads/recording 1.m4a", chunks("pretend ", "audio"), { contentType: "audio/mp4" });
    expect(service.seen.filter((s) => s.method === "PUT")).toHaveLength(1);
    expect(service.blobs.get("runs/run-1/uploads/recording 1.m4a")?.type).toBe("audio/mp4");
    expect(await store.head("runs/run-1/uploads/recording 1.m4a")).toMatchObject({ bytes: 13 });
    expect(await text(await store.get("runs/run-1/uploads/recording 1.m4a"))).toBe("pretend audio");
    expect(await text(await store.get("runs/run-1/uploads/recording 1.m4a", { start: 8, end: 12 }))).toBe("audio");
  });

  it("sends a large file a block at a time and commits the blocks in order", async () => {
    const service = fakeService();
    const store = new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: service.fetch, blockBytes: 4 });
    await store.put("runs/run-1/work/renders/cut.mp4", chunks("abcdefgh", "ij", "klmno"));
    const calls = service.seen.filter((s) => s.method === "PUT").map((s) => s.query.get("comp"));
    expect(calls).toEqual(["block", "block", "block", "block", "blocklist"]);
    expect(service.blobs.get("runs/run-1/work/renders/cut.mp4")?.bytes.toString()).toBe("abcdefghijklmno");
    const ids = service.seen.filter((s) => s.query.get("comp") === "block").map((s) => s.query.get("blockid")!);
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
  });

  it("says nothing is there for a missing blob", async () => {
    const store = new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: fakeService().fetch });
    expect(await store.head("runs/run-1/files.json")).toBeUndefined();
    expect(await store.get("runs/run-1/files.json")).toBeUndefined();
  });

  it("tries again when the service is busy, and gives up without showing the token", async () => {
    const busyOnce = fakeService({ failFirst: 1 });
    await new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: busyOnce.fetch }).put("a/b", chunks("x"));
    expect(busyOnce.blobs.get("a/b")?.bytes.toString()).toBe("x");

    const refused = fakeService({ failFirst: 5, status: 403 });
    const err = await new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: refused.fetch }).put("a/b", chunks("x")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Blob storage answered 403 ServerBusy to save a file.");
    expect((err as Error).message).not.toContain("placeholder-signature");
    expect(refused.seen).toHaveLength(1);

    const offline = (async () => {
      throw new TypeError(`fetch failed for ${CONTAINER}?${SAS}`);
    }) as typeof fetch;
    const lost = await new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: offline }).head("a/b").catch((e: Error) => e);
    expect((lost as Error).message).not.toContain("placeholder-signature");
  });

  it("refuses keys that climb out of their folder and URLs it cannot trust", async () => {
    const store = new AzureBlobStore({ containerUrl: `${CONTAINER}?${SAS}`, fetch: fakeService().fetch });
    await expect(store.head("runs/../secrets")).rejects.toThrow("not valid");
    expect(() => new AzureBlobStore({ containerUrl: "http://demo.blob.core.example/harness?sig=x" })).toThrow("https");
    expect(() => new AzureBlobStore({ containerUrl: `${CONTAINER}` })).toThrow("SAS token");
    expect(() => new AzureBlobStore({ containerUrl: "http://127.0.0.1:10000/devstoreaccount1/harness?sig=x" })).not.toThrow();
  });
});
