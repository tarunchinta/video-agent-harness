import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool, foldRun, JsonlEventStore, MemoryEventStore, ModelError, payloadOf, requestCancel,
  type HarnessEvent, type ModelRequest, type NewEvent, type ToolDefinition,
} from "../src/index.ts";
import { respond, text, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

let n = 0;
const point = (runSpan: string): NewEvent => {
  n += 1;
  return { eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, type: "budget.updated", actor: "creator", spanId: runSpan, occurredAt: new Date(0).toISOString(), payload: { limits: {} } };
};

describe("the JSON-lines store with more than one writer", () => {
  it("never gives two writers the same seq, however their appends interleave", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-lock-"));
    // Two processes are two store objects over the same folder: nothing is shared between them in memory.
    const a = new JsonlEventStore(root);
    const b = new JsonlEventStore(root);
    const runId = await newRun(a);
    const runSpan = (await a.read(runId))[0]!.spanId;

    // Each writer appends at the head it last saw, re-reading when the head moved, as the engine and creator do.
    const writer = async (store: JsonlEventStore, count: number) => {
      for (let i = 0; i < count; i += 1) {
        for (;;) {
          const head = (await store.read(runId)).length;
          try {
            await store.append(runId, head, [point(runSpan)]);
            break;
          } catch (err) {
            if ((err as Error).name !== "HeadMovedError") throw err;
          }
        }
      }
    };
    await Promise.all([writer(a, 25), writer(b, 25), writer(a, 25), writer(b, 25)]);

    const events = await new JsonlEventStore(root).read(runId);
    expect(events).toHaveLength(101);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
    });
  });

  it("refuses a worker that lost its lease before touching the file, torn line and all", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const store = new JsonlEventStore(root);
    const runId = await newRun(store);
    const runSpan = (await store.read(runId))[0]!.spanId;
    const old = await store.acquireLease(runId, "old-worker");
    await store.releaseLease(runId, "old-worker", old.epoch);
    await store.acquireLease(runId, "new-worker");
    // A crash left half a line at the end.
    writeFileSync(join(store.runDir(runId), "events.jsonl"), '{"half":', { flag: "a" });
    await expect(store.append(runId, 1, [point(runSpan)], old.epoch)).rejects.toThrow("Another worker has taken over");
    // The fragment is still there for the live worker to clear.
    const fresh = new JsonlEventStore(root);
    expect(await fresh.read(runId)).toHaveLength(1);
  });

  it("reads only what was added since the last read", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const writer = new JsonlEventStore(root);
    const reader = new JsonlEventStore(root);
    const runId = await newRun(writer);
    const runSpan = (await writer.read(runId))[0]!.spanId;
    expect(await reader.read(runId)).toHaveLength(1);
    await writer.append(runId, 1, [point(runSpan), point(runSpan)]);
    const later = await reader.read(runId, 1);
    expect(later.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe("cancelling a run whose worker is gone", () => {
  it("closes the run at once instead of waiting for a step that will never come", async () => {
    const store = new MemoryEventStore();
    const block = defineTool({
      name: "hang",
      description: "Never returns.",
      input: z.object({}),
      execute: () => new Promise<never>(() => {}),
    }) as ToolDefinition;
    const { engine } = setup([respond([toolCall("hang", {})])], { store, engine: { tools: [block] } });
    const runId = await newRun(store);
    // Start the run, then abandon it mid-tool: the process is gone and its lease runs out.
    void engine.run(runId);
    for (let i = 0; i < 50 && !(await store.read(runId)).some((e) => e.type === "tool.call.started"); i += 1) await new Promise((r) => setTimeout(r, 5));
    store.expireLease(runId);
    expect(foldRun(await store.read(runId)).status).toBe("running");

    const state = await requestCancel(store, runId);
    expect(state.status).toBe("cancelled");
    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(ofType(events, "run.cancel_requested")).toHaveLength(1);
  });

  it("only asks a run that a live worker is driving", async () => {
    const store = new MemoryEventStore();
    const runId = await newRun(store);
    await store.acquireLease(runId, "busy-worker");
    const events = await store.read(runId);
    await store.append(runId, 1, [
      { eventId: "00000000-0000-4000-8000-0000000000a1", type: "run.started", actor: "engine", spanId: events[0]!.spanId, occurredAt: new Date(0).toISOString(), payload: { worker: "busy-worker", epoch: 1 } },
    ]);
    const state = await requestCancel(store, runId);
    expect(state.status).toBe("running");
    expect(state.cancelRequested).toBe(true);
  });
});

describe("responses cut off while making a tool call", () => {
  it("count toward the limit on cut-off responses, so a model that keeps getting cut off cannot loop", async () => {
    // Every answer is a different half-written file, so the repeat guard would never catch it.
    const cutOff = (_request: ModelRequest, call: number) =>
      respond([toolCall("write_file", { path: `part-${call}.txt`, content: "x".repeat(call + 1) })], { stopReason: "max_output" });
    const { store, engine, provider } = setup(cutOff);
    const runId = await newRun(store);
    const outcome = await engine.run(runId);
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.kind).toBe("max_output");
    expect(provider.requests).toHaveLength(3);
    expectWellFormed(await store.read(runId), { terminal: true });
  });
});

describe("tool-less calls during an outage", () => {
  const reader = defineTool({
    name: "read_page",
    description: "Reads a page written by a stranger.",
    input: z.object({}),
    output: z.object({ facts: z.array(z.string()) }),
    untrusted: true,
    execute: (_input, exec) => exec.extract({ instructions: "List the facts.", untrusted: "The sky is blue.", schema: z.object({ facts: z.array(z.string()) }) }),
  }) as ToolDefinition;

  it("are retried with backoff, like the agent's own calls", async () => {
    let toolless = 0;
    const script = (request: ModelRequest) => {
      if (!request.tools.length) {
        toolless += 1;
        return toolless <= 2 ? new ModelError("rate_limited", "Slow down.", 1_500) : respond([text('{"facts":["The sky is blue."]}')]);
      }
      const answered = request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
      return answered ? respond([toolCall("finish", { summary: "Read it." })]) : respond([toolCall("read_page", {})]);
    };
    const { store, engine, sleeps } = setup(script, { engine: { tools: [reader] } });
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(toolless).toBe(3);
    expect(sleeps).toEqual([1_500, 1_500]);
    const events = await store.read(runId);
    const failed = ofType(events, "model.call.failed").filter((e: HarnessEvent) => e.agentId === "main/extract");
    expect(failed.map((e) => payloadOf(e, "model.call.failed").retry_in_ms)).toEqual([1_500, 1_500]);
    expect(ofType(events, "tool.call.completed").some((e) => payloadOf(e, "tool.call.completed").output.includes("The sky is blue."))).toBe(true);
  });
});

describe("a critic call", () => {
  it("shows the pictures by hash in the log and with their bytes on the way out", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    );
    const critic = defineTool({
      name: "critique",
      description: "Asks a critic.",
      input: z.object({}),
      execute: async (_input, exec) => {
        writeFileSync(join(exec.workDir, "sheet.png"), png);
        return exec.judge({ instructions: "Score it.", material: "Captions: hello.", schema: z.object({ score: z.number() }), images: ["sheet.png"] });
      },
    }) as ToolDefinition;
    const seen: ModelRequest[] = [];
    const script = (request: ModelRequest) => {
      if (!request.tools.length) {
        seen.push(request);
        return respond([text('{"score": 4}')]);
      }
      const answered = request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));
      return answered ? respond([toolCall("finish", { summary: "Reviewed." })]) : respond([toolCall("critique", {})]);
    };
    const { store, engine } = setup(script, { engine: { tools: [critic] } });
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    const image = seen[0]!.messages[0]!.content.find((b) => b.type === "image");
    expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
    expect((image as { data?: string }).data).toBe(png.toString("base64"));
    const events = await store.read(runId);
    const started = ofType(events, "model.call.started").find((e) => e.agentId === "main/critic")!;
    expect(payloadOf(started, "model.call.started").purpose).toBe("critique");
    expect(JSON.stringify(started.payload)).not.toContain(png.toString("base64"));
    // A critic's answer is the run's own work being judged, so it is not marked untrusted.
    expect(ofType(events, "model.call.completed").find((e) => e.agentId === "main/critic")!.untrusted).toBe(false);
  });
});
