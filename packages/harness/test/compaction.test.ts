import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRequest, COMPACT_SYSTEM, decideGate, defineTool, deriveContext, fileTools, foldRun, MemoryEventStore, ModelError, payloadOf, requestHash, transcriptText,
  type ContentBlock, type EventStore, type HarnessEvent, type ModelRequest, type NewEvent, type ToolDefinition,
} from "../src/index.ts";
import { FaultyStore, respond, resultsIn, text, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

/** A small window, so a few large results fill it: the loop warns at 16,000 tokens and stops at 19,000. */
const caps = { contextWindow: 20_000, maxOutputTokens: 1_000 };
const engineOptions = { contextHeadroomTokens: 1_000 };

/** What a provider would measure: about one token per 3.5 characters of the request. */
const measured = (request: ModelRequest) => Math.ceil(JSON.stringify(request).length / 3.5);

const isCompactor = (request: ModelRequest) => request.system === COMPACT_SYSTEM;
const summaryAnswer = (summary: string) => respond([text(JSON.stringify({ summary }))], { usage: { inputTokens: 500, outputTokens: 100 } });

const thinking = (n: number): ContentBlock => ({ type: "opaque", provider: "scripted", data: { thought: n } });

/** A tool whose every result is about 9,000 characters, about 2,600 tokens. */
const blobTool = defineTool({
  name: "fetch_blob",
  description: "Returns a large block of text.",
  input: z.object({ n: z.number() }),
  readOnly: true,
  execute: async ({ n }) => `blob ${n}: ${"lorem ipsum ".repeat(750)}`,
}) as ToolDefinition;

const compactions = (events: HarnessEvent[]) => ofType(events, "context.compacted").map((e) => payloadOf(e, "context.compacted"));

function expectRebuildable(events: HarnessEvent[], requests: ModelRequest[]): void {
  const config = foldRun(events).config;
  const calls = ofType(events, "model.call.started").filter((e) => e.agentId === "main");
  const agentRequests = requests.filter((r) => !isCompactor(r));
  expect(calls).toHaveLength(agentRequests.length);
  calls.forEach((call, i) => {
    const p = payloadOf(call, "model.call.started");
    const rebuilt = buildRequest(deriveContext(events.slice(0, p.context_through_seq), "main"), config.max_output_tokens, config.effort);
    expect(requestHash(rebuilt)).toBe(p.request_sha256);
    expect(rebuilt).toEqual(agentRequests[i]);
  });
}

describe("compaction", () => {
  /** Fetches nine blobs, one per step, then finishes. Every response carries a thinking block. */
  const blobAgent = (request: ModelRequest) => {
    if (isCompactor(request)) return summaryAnswer("Fetched some blobs.");
    const fetched = [...resultsIn(request).values()].filter((r) => r.name === "fetch_blob").length;
    const usage = { inputTokens: measured(request), outputTokens: 20 };
    if (fetched >= 9) return respond([toolCall("finish", { summary: "Fetched nine blobs." })], { usage });
    return respond([thinking(fetched), toolCall("fetch_blob", { n: fetched + 1 })], { usage });
  };

  it("clears old large results first, keeps the full text on disk, and carries on", async () => {
    const { store, engine, provider, workDir } = setup(blobAgent, { caps, engine: { ...engineOptions, tools: [...fileTools, blobTool] } });
    const runId = await newRun(store, { maxOutputTokens: 1_000, compaction: true });
    expect(await engine.run(runId)).toMatchObject({ status: "succeeded" });

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    const done = compactions(events);
    expect(done.length).toBeGreaterThan(0);
    expect(done.every((c) => c.mode === "trim")).toBe(true);
    expect(provider.requests.some(isCompactor)).toBe(false);
    expect(ofType(events, "context.message").filter((e) => payloadOf(e, "context.message").kind === "context_warning")).toHaveLength(0);

    const first = done[0]!;
    if (first.mode !== "trim") throw new Error("expected a trim");
    expect(first.tokens_after).toBeLessThan(first.tokens_before);
    const { tool_call_id: id, path } = first.cleared[0]!;
    expect(readFileSync(join(workDir, path), "utf8")).toMatch(/^blob 1: lorem ipsum/);

    // After the trim, the cleared result is a short pointer, and the thinking before it is gone.
    const last = provider.requests.at(-1)!;
    const blocks = last.messages.flatMap((m) => m.content);
    const cleared = blocks.find((b) => b.type === "tool_result" && b.toolCallId === id);
    expect(cleared?.type === "tool_result" && cleared.content).toContain(`full text is at ${path}`);
    expect(cleared?.type === "tool_result" && cleared.content.length).toBeLessThan(600);
    const firstAssistant = last.messages.find((m) => m.role === "assistant")!;
    expect(firstAssistant.content.some((b) => b.type === "opaque")).toBe(false);
    // The newest steps are left as they were, thinking included.
    const lastAssistant = last.messages.findLast((m) => m.role === "assistant")!;
    expect(lastAssistant.content.some((b) => b.type === "opaque")).toBe(true);
    const lastResult = last.messages.at(-1)!.content[0]!;
    expect(lastResult.type === "tool_result" && lastResult.content).toMatch(/^blob 9: /);

    expectRebuildable(events, provider.requests);
  });

  it("leaves a run created without compaction as it was: it warns, then stops", async () => {
    const { store, engine, provider } = setup(blobAgent, { caps, engine: { ...engineOptions, tools: [...fileTools, blobTool] } });
    const runId = await newRun(store, { maxOutputTokens: 1_000 });
    expect(await engine.run(runId)).toMatchObject({ status: "failed", failure: { kind: "context_exhausted" } });
    const events = await store.read(runId);
    expect(compactions(events)).toHaveLength(0);
    expect(provider.requests.some(isCompactor)).toBe(false);
  });

  it("summarises when clearing is not enough, and keeps the creator's notes word for word", async () => {
    const tools = [
      ...fileTools,
      defineTool({
        name: "request_review",
        description: "Ask the creator to review the draft.",
        input: z.object({}),
        execute: (_input, exec) => exec.gate("script", { files: ["script/script.md"] }),
      }),
    ] as ToolDefinition[];
    // Results are small, so there is nothing worth clearing; the model reports a nearly full window after the review.
    const script = (request: ModelRequest) => {
      if (isCompactor(request)) return summaryAnswer("Drafted the script and asked for a review. The creator wants changes.");
      if (JSON.stringify(request.messages).includes("were summarised to save space")) return respond([toolCall("finish", { summary: "Done after the summary." })]);
      const reviewed = [...resultsIn(request).values()].some((r) => r.name === "request_review");
      if (!reviewed) return respond([toolCall("request_review", {})]);
      return respond([toolCall("list_files", { path: "." })], { usage: { inputTokens: 17_500, outputTokens: 20 } });
    };
    const { store, engine, provider } = setup(script, { caps, engine: { ...engineOptions, tools } });
    const runId = await newRun(store, { maxOutputTokens: 1_000, compaction: true });
    expect((await engine.run(runId)).status).toBe("waiting_gate");
    await decideGate(store, runId, { gate: "script", decision: "changes_requested", notes: ['Make the hook "shorter".'] });
    expect(await engine.run(runId)).toMatchObject({ status: "succeeded" });

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    const done = compactions(events);
    expect(done.map((c) => c.mode)).toEqual(["summary"]);
    const summary = done[0]!;
    if (summary.mode !== "summary") throw new Error("expected a summary");
    expect(summary.summary).toContain("The creator wants changes.");
    expect(summary.summary).toContain(`The creator's note on "script" (changes requested): ${JSON.stringify('Make the hook "shorter".')}`);
    expect(summary.summary).toContain("Last handed in for review: script/script.md.");

    // The summarising call had no tools and is logged under its own agent, with its cost in the run's totals.
    const compactor = provider.requests.find(isCompactor)!;
    expect(compactor.tools).toEqual([]);
    const calls = ofType(events, "model.call.started").filter((e) => e.agentId === "main/compactor");
    expect(calls.map((e) => payloadOf(e, "model.call.started").purpose)).toEqual(["compact"]);
    expect(ofType(events, "model.call.completed").find((e) => e.agentId === "main/compactor")?.untrusted).toBe(false);

    // The next request is the task and the summary, and nothing else.
    const after = provider.requests.filter((r) => !isCompactor(r)).at(-1)!;
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.content.map((b) => (b.type === "text" ? b.text.slice(0, 30) : b.type))).toEqual([
      "Write a note and read it back.",
      "Earlier turns of this conversa",
    ]);
    expectRebuildable(events, provider.requests);
  });

  it("summarises once and tries again when the provider finds a request too long", async () => {
    let overflowed = 0;
    const script = (request: ModelRequest) => {
      if (isCompactor(request)) return summaryAnswer("Listed the files once.");
      if (JSON.stringify(request.messages).includes("were summarised to save space")) return respond([toolCall("finish", { summary: "ok" })]);
      if (request.messages.length > 1) {
        overflowed += 1;
        return new ModelError("context_overflow", "The prompt is too long.");
      }
      return respond([toolCall("list_files", { path: "." })]);
    };
    const { store, engine, provider } = setup(script, { caps, engine: engineOptions });
    const runId = await newRun(store, { maxOutputTokens: 1_000, compaction: true });
    expect(await engine.run(runId)).toMatchObject({ status: "succeeded" });
    expect(overflowed).toBe(1);
    expect(provider.requests.filter(isCompactor)).toHaveLength(1);
    expect(compactions(await store.read(runId)).map((c) => c.mode)).toEqual(["summary"]);
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("fails as before when the request is still too long after a summary", async () => {
    const script = (request: ModelRequest) => {
      if (isCompactor(request)) return summaryAnswer("Listed the files once.");
      if (request.messages.length > 1 || JSON.stringify(request.messages).includes("summarised")) return new ModelError("context_overflow", "The prompt is too long.");
      return respond([toolCall("list_files", { path: "." })]);
    };
    const { store, engine, provider } = setup(script, { caps, engine: engineOptions });
    const runId = await newRun(store, { maxOutputTokens: 1_000, compaction: true });
    expect(await engine.run(runId)).toMatchObject({ status: "failed", failure: { kind: "context_exhausted" } });
    expect(provider.requests.filter(isCompactor)).toHaveLength(1);
  });

  it("falls back to the warning when the summary cannot be made", async () => {
    const sized = (request: ModelRequest) =>
      isCompactor(request)
        ? respond([text("not json")])
        : respond([toolCall("list_files", { path: `${request.messages.length}` })], { usage: { inputTokens: 17_000, outputTokens: 10 } });
    const { store, engine } = setup(sized, { caps, engine: engineOptions });
    const runId = await newRun(store, { maxOutputTokens: 1_000, compaction: true, limits: { max_steps: 3 } });
    await engine.run(runId);
    const events = await store.read(runId);
    expect(compactions(events)).toHaveLength(0);
    expect(ofType(events, "context.message").some((e) => payloadOf(e, "context.message").kind === "context_warning")).toBe(true);
  });
});

describe("compaction and crashes", () => {
  /** Overflows once the conversation holds a result, then finishes after the summary. */
  const overflowing = (request: ModelRequest) => {
    if (isCompactor(request)) return summaryAnswer("Listed the files once.");
    if (JSON.stringify(request.messages).includes("were summarised to save space")) return respond([toolCall("finish", { summary: "ok" })]);
    if (request.messages.length > 1) return new ModelError("context_overflow", "The prompt is too long.");
    return respond([toolCall("list_files", { path: "." })]);
  };
  const blobs = (request: ModelRequest) => {
    if (isCompactor(request)) return summaryAnswer("Fetched some blobs.");
    const fetched = [...resultsIn(request).values()].filter((r) => r.name === "fetch_blob").length;
    const usage = { inputTokens: measured(request), outputTokens: 20 };
    if (fetched >= 8) return respond([toolCall("finish", { summary: "Fetched." })], { usage });
    return respond([thinking(fetched), toolCall("fetch_blob", { n: fetched + 1 })], { usage });
  };

  for (const [name, agent, tools] of [
    ["a trim", blobs, [...fileTools, blobTool]],
    ["a summary", overflowing, fileTools],
  ] as const) {
    it(`finishes a run with ${name} after a crash at any write`, async () => {
      const counting = new CountingStore(new MemoryEventStore());
      const baseline = setup(agent, { store: counting, caps, engine: { ...engineOptions, tools: [...tools] } });
      const first = await newRun(counting, { maxOutputTokens: 1_000, compaction: true });
      expect((await baseline.engine.run(first)).status).toBe("succeeded");
      expect(compactions(await counting.read(first)).length).toBeGreaterThan(0);

      for (let dieAfter = 0; dieAfter < counting.appends; dieAfter += 1) {
        const memory = new MemoryEventStore();
        const workDir = mkdtempSync(join(tmpdir(), "harness-compact-crash-"));
        const runId = await newRun(memory, { maxOutputTokens: 1_000, compaction: true });
        const doomed = setup(agent, { store: new FaultyStore(memory, dieAfter), caps, engine: { ...engineOptions, tools: [...tools] }, workDir });
        await expect(doomed.engine.run(runId), `crash after ${dieAfter} writes`).rejects.toThrow("The process is gone.");
        memory.expireLease(runId);
        const next = setup(agent, { store: memory, caps, engine: { ...engineOptions, tools: [...tools] }, workDir });
        expect((await next.engine.run(runId)).status, `resume after ${dieAfter} writes`).toBe("succeeded");
        const events = await memory.read(runId);
        expectWellFormed(events, { terminal: true });
        // Nothing compacts while a call is waiting: every compaction follows a step whose results are all in.
        for (const e of ofType(events, "context.compacted")) {
          const before = deriveContext(events.slice(0, e.seq - 1), "main");
          expect(before.unanswered, `compaction at seq ${e.seq}`).toEqual([]);
        }
      }
    });
  }
});

class CountingStore implements EventStore {
  appends = 0;
  constructor(private readonly inner: EventStore) {}
  createRun = (runId: string, events: NewEvent[]) => this.inner.createRun(runId, events);
  append(runId: string, expected: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    this.appends += 1;
    return this.inner.append(runId, expected, events, epoch);
  }
  read = (runId: string, afterSeq?: number) => this.inner.read(runId, afterSeq);
  acquireLease = (runId: string, worker: string) => this.inner.acquireLease(runId, worker);
  renewLease = (runId: string, worker: string, epoch: number) => this.inner.renewLease(runId, worker, epoch);
  releaseLease = (runId: string, worker: string, epoch: number) => this.inner.releaseLease(runId, worker, epoch);
  leaseHeld = (runId: string) => this.inner.leaseHeld(runId);
}

describe("transcriptText", () => {
  it("cuts each block to a preview and leaves out the middle when the whole is too long", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "The task." }] },
      { role: "assistant" as const, content: [thinking(1), { type: "tool_call" as const, id: "c1", name: "read_file", input: { path: "a.txt" } }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolCallId: "c1", content: "y".repeat(5_000) }] },
    ];
    const short = transcriptText(messages, 100_000);
    expect(short).toContain("[called read_file]");
    expect(short).toContain("3,500 more characters");
    expect(short).not.toContain("thought");
    const cut = transcriptText(messages, 400);
    expect(cut.length).toBeLessThan(600);
    expect(cut).toContain("The task.");
    expect(cut).toContain("left out");
  });
});
