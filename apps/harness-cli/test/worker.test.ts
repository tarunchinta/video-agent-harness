import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRun, decideGate, defineTool, Engine, fileTools, foldRun, JsonlEventStore, type RunOutcome,
} from "@harness/harness";
import { respond, ScriptedProvider, text, toolCall } from "@harness/harness/testing";
import { REEL_PIPELINE } from "@harness/reel";
import { BlobRunFiles, BlobUploads, DirectoryBlobs } from "@harness/web";
import { blobsFor, TextRelay } from "../src/blobs.ts";
import { handOver, uploadsFor, VOICEOVER_EVENT } from "../src/handover.ts";
import { UsageError } from "../src/pipeline.ts";
import { webHost } from "../src/web.ts";
import { sharedDrive, Worker } from "../src/worker.ts";

/**
 * The desktop half of a split setup: the worker finds what the store says is waiting and drives it, and the
 * remote web server only writes. Logs are JSON-lines files here; the worker sees them only through the store,
 * the same as Postgres.
 */

const handIn = defineTool({
  name: "hand_in",
  description: "Hand the draft in for review.",
  input: z.object({}),
  async execute(_input, exec) {
    return exec.gate("script", { files: ["draft.md"], note: "First go." });
  },
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-worker-"));
  const store = new JsonlEventStore(join(root, "runs"));
  const lines: string[] = [];
  return { root, store, lines, line: (text: string) => lines.push(text) };
}

/** A real engine with a scripted model: write a draft, stop for the script review, then finish. */
function engineDrive(store: JsonlEventStore) {
  const provider = new ScriptedProvider((req) => {
    const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
    if (results === 0) return respond([toolCall("write_file", { path: "draft.md", content: "# Draft" })]);
    if (results === 1) return respond([toolCall("hand_in", {})]);
    return respond([toolCall("finish", { summary: "Done." })]);
  });
  const driven: string[] = [];
  const drive = (runId: string, signal: AbortSignal) => {
    driven.push(runId);
    return new Engine({ store, provider, tools: [...fileTools, handIn], workDir: (id) => join(store.runDir(id), "work"), sleep: async () => {} }).run(runId, { signal });
  };
  return { drive, driven };
}

const newRun = (store: JsonlEventStore, extra: { pipeline?: string; project?: string } = {}) =>
  createRun(store, { task: "Write a draft and hand it in.", model: "demo-model", system: "Be brief.", ...extra });

describe("harness worker", () => {
  it("drives what is waiting, leaves what waits on you, and carries on once you answer", async () => {
    const { store, line } = setup();
    const { drive, driven } = engineDrive(store);
    const worker = new Worker({ store, drive, line });
    const runId = await newRun(store);

    await worker.scan();
    await worker.idle();
    expect(foldRun(await store.read(runId)).status).toBe("waiting_gate");
    expect(driven).toEqual([runId]);

    // Waiting on a review: nothing to do until the creator answers, from wherever they are.
    await worker.scan();
    await worker.idle();
    expect(driven).toEqual([runId]);

    await decideGate(store, runId, { gate: "script", decision: "approved" });
    await worker.scan();
    await worker.idle();
    expect(foldRun(await store.read(runId)).status).toBe("succeeded");
    expect(driven).toEqual([runId, runId]);
  });

  it("leaves a run another worker or a terminal is driving", async () => {
    const { store, line } = setup();
    const { drive, driven } = engineDrive(store);
    const runId = await newRun(store);
    await store.acquireLease(runId, "a terminal");
    const worker = new Worker({ store, drive, line });
    await worker.scan();
    await worker.idle();
    expect(driven).toEqual([]);
  });

  it("drives only as many runs at once as it is allowed", async () => {
    const { store, line } = setup();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    const drive = async (runId: string): Promise<RunOutcome> => {
      started.push(runId);
      await held;
      return { runId, status: "paused" };
    };
    const worker = new Worker({ store, drive, line, concurrency: 1 });
    await newRun(store);
    await newRun(store);
    await worker.scan();
    expect(worker.driving()).toHaveLength(1);
    expect(started).toHaveLength(1);
    release();
    await worker.stop();
  });

  it("waits longer each time a run fails to start, and tries again", async () => {
    const { store, lines, line } = setup();
    let now = 1_000_000;
    let calls = 0;
    const drive = async (): Promise<RunOutcome> => {
      calls += 1;
      throw new UsageError("Set ANTHROPIC_API_KEY to your Anthropic API key first.");
    };
    const worker = new Worker({ store, drive, line, now: () => now });
    const runId = await newRun(store);

    await worker.scan();
    await worker.idle();
    expect(calls).toBe(1);
    expect(lines.at(-1)).toBe(`${runId}: could not run it: Set ANTHROPIC_API_KEY to your Anthropic API key first. Trying again in 30 seconds.`);

    now += 29_000;
    await worker.scan();
    await worker.idle();
    expect(calls).toBe(1);

    now += 2_000;
    await worker.scan();
    await worker.idle();
    expect(calls).toBe(2);
    expect(lines.at(-1)).toMatch(/Trying again in 60 seconds\.$/);
  });
});

describe("the hand-over between a remote web server and the worker", () => {
  function remote() {
    const { root, store } = setup();
    const projectsDir = join(root, "projects");
    mkdirSync(join(projectsDir, "demo"), { recursive: true });
    writeFileSync(join(projectsDir, "demo", "notes.md"), "# Notes\n");
    const host = webHost(store, { env: { HARNESS_MODELS: "claude-sonnet-5-5, DeepSeek-V4.1-Flash" }, cwd: root }, join(root, "runs"), { remote: true });
    const uploads = uploadsFor(store);
    const workDir = (runId: string) => join(store.runDir(runId), "work");
    return { root, store, host, uploads, projectsDir, workDir };
  }

  async function upload(uploads: ReturnType<typeof uploadsFor>, runId: string, name: string, content: string) {
    await uploads.save(runId, name, (async function* () {
      yield Buffer.from(content);
    })());
  }

  it("drives nothing, and offers the models the worker can use", () => {
    const { host } = remote();
    expect(host.drive).toBeUndefined();
    expect(host.models).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "DeepSeek-V4.1-Flash"]);
  });

  it("records the voiceover in the log, and the worker puts it and the project's notes in the run once", async () => {
    const { store, host, uploads, projectsDir, workDir } = remote();
    const runId = await newRun(store, { pipeline: REEL_PIPELINE, project: "demo" });
    await upload(uploads, runId, "recording-1.m4a", "pretend audio");

    expect(await host.voiceover(runId, { kind: "upload", name: "recording-1.m4a" })).toBe("The voiceover recording is at inputs/voiceover.m4a.");
    expect((await store.read(runId)).at(-1)).toMatchObject({ type: VOICEOVER_EVENT, actor: "creator", payload: { choice: "upload", name: "recording-1.m4a", extension: ".m4a" } });
    // The cloud side never touches the run's working folder.
    expect(existsSync(workDir(runId))).toBe(false);

    expect(await handOver(store, runId, { uploads, projectsDir })).toEqual(["Copied the notes of project demo.", "Handed over the voiceover recording-1.m4a."]);
    expect(readFileSync(join(workDir(runId), "notes", "notes.md"), "utf8")).toBe("# Notes\n");
    expect(readFileSync(join(workDir(runId), "inputs", "voiceover.m4a"), "utf8")).toBe("pretend audio");
    // A second pickup has nothing new to hand over.
    expect(await handOver(store, runId, { uploads, projectsDir })).toEqual([]);

    // Keeping the recording needs no new file; going without a voice clears it on the next pickup.
    expect(await host.voiceover(runId, { kind: "keep" })).toBe("The voiceover recording is at inputs/voiceover.m4a.");
    await host.voiceover(runId, { kind: "none" });
    expect(await handOver(store, runId, { uploads, projectsDir })).toEqual(["Cleared the voiceover; the reel goes without a voice."]);
    expect(existsSync(join(workDir(runId), "inputs", "voiceover.m4a"))).toBe(false);
  });

  it("refuses to keep a recording it never received, and a file a reel cannot use", async () => {
    const { store, host, uploads } = remote();
    const runId = await newRun(store, { pipeline: REEL_PIPELINE });
    await expect(host.voiceover(runId, { kind: "keep" })).rejects.toThrow(/no recording for this reel yet/);
    await upload(uploads, runId, "recording-2.txt", "not audio");
    await expect(host.voiceover(runId, { kind: "upload", name: "recording-2.txt" })).rejects.toBeInstanceOf(UsageError);
    expect((await store.read(runId)).some((e) => e.type === VOICEOVER_EVENT)).toBe(false);
  });

  it("hands a recording over through blob storage, with nothing in the run's own folder", async () => {
    const { root, store } = setup();
    const env = { HARNESS_BLOB_DIR: "shared-blobs" };
    const host = webHost(store, { env, cwd: root }, join(root, "runs"), { remote: true });
    expect(host.uploads).toBeInstanceOf(BlobUploads);
    expect(host.files).toBeInstanceOf(BlobRunFiles);
    const runId = await newRun(store, { pipeline: REEL_PIPELINE });
    await upload(host.uploads!, runId, "recording-3.m4a", "pretend audio");
    expect(existsSync(join(store.runDir(runId), "uploads"))).toBe(false);
    expect(existsSync(join(root, "shared-blobs", "runs", runId, "uploads", "recording-3.m4a"))).toBe(true);
    await host.voiceover(runId, { kind: "upload", name: "recording-3.m4a" });

    // The worker is given the same setting and finds the recording there.
    const uploads = uploadsFor(store, blobsFor(env, root));
    expect(await handOver(store, runId, { uploads, projectsDir: join(root, "projects") })).toEqual(["Handed over the voiceover recording-3.m4a."]);
    expect(readFileSync(join(store.runDir(runId), "work", "inputs", "voiceover.m4a"), "utf8")).toBe("pretend audio");
  });

  it("reads run files from this machine when there is no blob storage, or when it drives runs itself", () => {
    const { root, store } = setup();
    expect(webHost(store, { env: {}, cwd: root }, join(root, "runs"), { remote: true }).files).toBeUndefined();
    expect(webHost(store, { env: { HARNESS_BLOB_DIR: "b" }, cwd: root }, join(root, "runs")).files).toBeUndefined();
    expect(() => blobsFor({ HARNESS_BLOB_URL: "https://demo.blob.core.example/harness" }, root)).toThrow(UsageError);
  });

  it("hands nothing to a run that is not a reel", async () => {
    const { store, uploads, projectsDir } = remote();
    const runId = await newRun(store, { project: "demo" });
    expect(await handOver(store, runId, { uploads, projectsDir })).toEqual([]);
  });
});

describe("typed text sent through the store", () => {
  it("gathers deltas into a few sends per run, in order, and drops a send that fails", async () => {
    const sent: [string, string][] = [];
    let fail = false;
    const relay = new TextRelay(
      {
        publishText: async (runId: string, delta: string) => {
          if (fail) throw new Error("The database is restarting.");
          sent.push([runId, delta]);
        },
      },
      20,
    );
    for (const piece of ["Writ", "ing ", "the ", "draft."]) relay.push("run-a", piece);
    relay.push("run-b", "Other run.");
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual([
      ["run-a", "Writing the draft."],
      ["run-b", "Other run."],
    ]);
    fail = true;
    relay.push("run-a", " Lost.");
    await relay.flush();
    fail = false;
    relay.push("run-a", " Next.");
    await relay.flush();
    expect(sent.at(-1)).toEqual(["run-a", " Next."]);
  });

  it("does nothing for a store that cannot pass text on", async () => {
    const relay = new TextRelay({});
    relay.push("run-a", "Nobody hears this.");
    await relay.flush();
  });
});

describe("a drive a web server elsewhere can follow", () => {
  it("puts the draft in blob storage before the review is shown, and sends the typing through the store", async () => {
    const { root, store, line, lines } = setup();
    const typed: string[] = [];
    const relaying = Object.assign(store, { publishText: async (_runId: string, delta: string) => void typed.push(delta) });
    const provider = new ScriptedProvider((req) => {
      const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
      if (results === 0) return respond([text("Writing the draft."), toolCall("write_file", { path: "draft.md", content: "# Draft" })]);
      return respond([toolCall("hand_in", {})]);
    });
    const blobs = new DirectoryBlobs(join(root, "blobs"));
    const shared = sharedDrive({
      store: relaying,
      blobs,
      line,
      drive: (runId, hooks) =>
        new Engine({
          store,
          provider,
          tools: [...fileTools, handIn],
          workDir: (id) => join(store.runDir(id), "work"),
          sleep: async () => {},
          ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
          ...(hooks.onText ? { onText: hooks.onText } : {}),
        }).run(runId, { signal: hooks.signal }),
    });
    const runId = await newRun(store);
    const outcome = await shared.drive(runId, new AbortController().signal);
    expect(outcome.status).toBe("waiting_gate");
    expect((await new BlobRunFiles(blobs).list(runId)).map((f) => f.path)).toEqual(["draft.md"]);
    expect(typed.join("")).toContain("Writing the draft.");
    expect(lines).toEqual([]);
  });

  it("says once that files could not be copied, and never fails the run for it", async () => {
    const { store, line, lines } = setup();
    const broken = {
      put: async () => {
        throw new Error("The container is gone.");
      },
      head: async () => undefined,
      get: async () => undefined,
    };
    const shared = sharedDrive({ store, blobs: broken, line, drive: async (runId): Promise<RunOutcome> => ({ runId, status: "succeeded" }) });
    const runId = await newRun(store);
    mkdirSync(join(store.runDir(runId), "work"), { recursive: true });
    writeFileSync(join(store.runDir(runId), "work", "draft.md"), "# Draft");
    expect((await shared.drive(runId, new AbortController().signal)).status).toBe("succeeded");
    expect((await shared.drive(runId, new AbortController().signal)).status).toBe("succeeded");
    expect(lines).toEqual([`${runId}: could not copy its files to blob storage: The container is gone. Trying again with the next change.`]);
  });
});
