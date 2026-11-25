import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobRunFiles, BlobUploads, DirectoryBlobs, readBlobText, RunMirror, type BlobStore } from "../src/index.ts";

/**
 * Blob storage as the two halves share it: uploads saved by the web server and copied out by the worker, and
 * run files the worker mirrors and the server reads back. The folder store stands in for a vendor's.
 */

const RUN = "6f1c1f9e-0000-4000-8000-000000000001";
const PICTURE = `${"a".repeat(64)}.png`;

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

async function text(body: AsyncIterable<Uint8Array> | undefined): Promise<string | undefined> {
  if (!body) return undefined;
  const out: Buffer[] = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out).toString("utf8");
}

/** A folder store that counts what is written to it. */
class CountingBlobs extends DirectoryBlobs {
  readonly puts: string[] = [];
  override put(key: string, body: AsyncIterable<Uint8Array>, options?: { contentType?: string }): Promise<void> {
    this.puts.push(key);
    return super.put(key, body, options);
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-blobs-"));
  const blobs = new CountingBlobs(join(root, "blobs"));
  const runDir = (runId: string) => join(root, "runs", runId);
  return { root, blobs, runDir };
}

describe("blob storage in a folder", () => {
  it("writes whole blobs, reads them by range, and refuses keys that climb out", async () => {
    const { blobs } = setup();
    await blobs.put("runs/x/a.txt", chunks("hello ", "world"));
    expect(await blobs.head("runs/x/a.txt")).toMatchObject({ bytes: 11 });
    expect(await text(await blobs.get("runs/x/a.txt"))).toBe("hello world");
    expect(await text(await blobs.get("runs/x/a.txt", { start: 6, end: 10 }))).toBe("world");
    expect(await blobs.head("runs/x/missing")).toBeUndefined();
    expect(await blobs.get("runs/x/missing")).toBeUndefined();
    await expect(blobs.head("runs/../../etc")).rejects.toThrow("not valid");
    await expect(blobs.put("runs\\x", chunks("x"))).rejects.toThrow("not valid");
  });

  it("keeps nothing when the body fails part way", async () => {
    const { blobs } = setup();
    const failing = (async function* () {
      yield Buffer.from("half");
      throw new Error("The browser went away.");
    })();
    await expect(blobs.put("runs/x/b.m4a", failing)).rejects.toThrow("went away");
    expect(await blobs.head("runs/x/b.m4a")).toBeUndefined();
  });
});

describe("uploads in blob storage", () => {
  it("saves on one side and copies out on the other, by run and name", async () => {
    const { root, blobs } = setup();
    const server = new BlobUploads(blobs);
    const worker = new BlobUploads(new DirectoryBlobs(join(root, "blobs")));
    await server.save(RUN, "recording-1.m4a", chunks("pretend audio"));
    expect(blobs.puts).toEqual([`runs/${RUN}/uploads/recording-1.m4a`]);
    expect(await worker.has(RUN, "recording-1.m4a")).toBe(true);
    expect(await worker.has(RUN, "recording-2.m4a")).toBe(false);
    expect(await worker.has(RUN, "../recording-1.m4a")).toBe(false);
    const destination = join(root, "voiceover.m4a");
    await worker.copyTo(RUN, "recording-1.m4a", destination);
    expect(readFileSync(destination, "utf8")).toBe("pretend audio");
    await expect(worker.copyTo(RUN, "recording-2.m4a", join(root, "other.m4a"))).rejects.toThrow("not in blob storage");
    expect(existsSync(join(root, "other.m4a.partial"))).toBe(false);
  });
});

describe("mirroring run files", () => {
  function runWithFiles(runDir: (runId: string) => string) {
    const dir = runDir(RUN);
    mkdirSync(join(dir, "work", "script"), { recursive: true });
    mkdirSync(join(dir, "work", "renders"), { recursive: true });
    mkdirSync(join(dir, "work", "film", "kit"), { recursive: true });
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "work", "script", "draft.md"), "# Draft\n");
    writeFileSync(join(dir, "work", "renders", "cut-1.mp4"), "pretend video");
    writeFileSync(join(dir, "work", "film", "kit", "kit.js"), "rewritten every use");
    writeFileSync(join(dir, "artifacts", PICTURE), "pretend picture");
    writeFileSync(join(dir, "artifacts", "notes.txt"), "not a picture the agent saw");
    return dir;
  }

  it("sends what changed, lists it last, and the server reads only what is listed", async () => {
    const { blobs, runDir } = setup();
    const dir = runWithFiles(runDir);
    const mirror = new RunMirror(blobs, runDir);
    await mirror.now(RUN);
    expect(blobs.puts.sort()).toEqual(
      [`runs/${RUN}/artifacts/${PICTURE}`, `runs/${RUN}/files.json`, `runs/${RUN}/work/renders/cut-1.mp4`, `runs/${RUN}/work/script/draft.md`].sort(),
    );

    const files = new BlobRunFiles(blobs);
    expect((await files.list(RUN)).map((f) => [f.path, f.kind])).toEqual([
      ["renders/cut-1.mp4", "video"],
      ["script/draft.md", "script"],
    ]);
    const cut = await files.open(RUN, "work", "renders/cut-1.mp4");
    expect(cut).toMatchObject({ name: "cut-1.mp4", bytes: 13 });
    expect(await text(await cut!.read({ start: 8, end: 12 }))).toBe("video");
    expect(await text(await (await files.open(RUN, "artifacts", PICTURE))!.read())).toBe("pretend picture");
    // Not listed, or not a picture's name: never read, even if a blob sits there.
    await blobs.put(`runs/${RUN}/work/secret.txt`, chunks("x"));
    expect(await files.open(RUN, "work", "secret.txt")).toBeUndefined();
    expect(await files.open(RUN, "work", "film/kit/kit.js")).toBeUndefined();
    expect(await files.open(RUN, "artifacts", "notes.txt")).toBeUndefined();
    expect(await files.open(RUN, "work", "../files.json")).toBeUndefined();
    expect(await files.list("no-such-run")).toEqual([]);

    // Nothing changed: nothing sent. A changed file and a new one go up, a deleted one drops off the list.
    blobs.puts.length = 0;
    await mirror.now(RUN);
    expect(blobs.puts).toEqual([]);
    writeFileSync(join(dir, "work", "script", "draft.md"), "# Draft, take two\n");
    writeFileSync(join(dir, "work", "script", "narration.txt"), "Hello.");
    rmSync(join(dir, "work", "renders", "cut-1.mp4"));
    await mirror.now(RUN);
    expect(blobs.puts.sort()).toEqual([`runs/${RUN}/files.json`, `runs/${RUN}/work/script/draft.md`, `runs/${RUN}/work/script/narration.txt`]);
    expect((await files.list(RUN)).map((f) => f.path)).toEqual(["script/draft.md", "script/narration.txt"]);
    expect(await text(await (await files.open(RUN, "work", "script/draft.md"))!.read())).toBe("# Draft, take two\n");

    // A restarted worker remembers what went up.
    blobs.puts.length = 0;
    await new RunMirror(blobs, runDir).now(RUN);
    expect(blobs.puts).toEqual([]);
  });

  it("coalesces a burst into one copy, and keeps what went up when a send fails", async () => {
    const { blobs, runDir } = setup();
    runWithFiles(runDir);
    let fail = true;
    const flaky: BlobStore = {
      put: (key, body, options) => (fail && key.endsWith(".mp4") ? Promise.reject(new Error("The service is busy.")) : blobs.put(key, body, options)),
      head: (key) => blobs.head(key),
      get: (key, range) => blobs.get(key, range),
    };
    const errors: string[] = [];
    const mirror = new RunMirror(flaky, runDir, { delayMs: 10, onError: (_run, err) => errors.push((err as Error).message) });
    for (let i = 0; i < 5; i += 1) mirror.soon(RUN);
    await new Promise((r) => setTimeout(r, 30));
    await mirror.idle();
    expect(errors).toEqual(["The service is busy."]);
    expect(await readBlobText(blobs, `runs/${RUN}/files.json`)).toBeUndefined();

    fail = false;
    blobs.puts.length = 0;
    await mirror.now(RUN);
    expect(blobs.puts.sort()).toEqual([`runs/${RUN}/files.json`, `runs/${RUN}/work/renders/cut-1.mp4`]);
  });
});
