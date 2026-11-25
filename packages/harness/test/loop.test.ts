import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRequest, defineTool, deriveContext, fileTools, foldRun, ModelError, payloadOf, requestCancel, requestHash, requestPause, requestResume,
  summarizeRun, updateBudget, type ModelRequest, type ToolDefinition,
} from "../src/index.ts";
import { respond, resultsIn, text, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup, SYSTEM } from "./helpers.ts";

/** A model that writes a note, reads it back and finishes, deciding each move from the results it has. */
const noteAgent = (request: ModelRequest) => {
  const done = [...resultsIn(request).values()].filter((r) => !r.isError).map((r) => r.name);
  if (!done.includes("write_file")) return respond([text("Writing the note."), toolCall("write_file", { path: "note.txt", content: "hello" })]);
  if (!done.includes("read_file")) return respond([toolCall("read_file", { path: "note.txt" })]);
  return respond([toolCall("finish", { summary: "Wrote note.txt and read it back." })]);
};

const notes = (events: Awaited<ReturnType<typeof read>>, kind: string) =>
  ofType(events, "context.message").filter((e) => payloadOf(e, "context.message").kind === kind);
const read = (store: ReturnType<typeof setup>["store"], runId: string) => store.read(runId);

describe("a run from start to finish", () => {
  it("writes a file, reads it back and finishes", async () => {
    const { store, engine, provider, workDir } = setup(noteAgent);
    const runId = await newRun(store);
    const outcome = await engine.run(runId);

    expect(outcome).toEqual({ runId, status: "succeeded", result: { summary: "Wrote note.txt and read it back." } });
    expect(readFileSync(join(workDir, "note.txt"), "utf8")).toBe("hello");
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]!.system).toBe(SYSTEM);
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(["finish", "list_files", "read_file", "write_file"]);

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(events.map((e) => e.type)).toEqual([
      "run.created", "run.started", "agent.started",
      "model.call.started", "model.call.completed", "tool.call.started", "tool.call.completed",
      "model.call.started", "model.call.completed", "tool.call.started", "tool.call.completed",
      "model.call.started", "model.call.completed", "tool.call.started", "tool.call.completed",
      "agent.completed", "run.completed",
    ]);
    // 3 calls at 100 tokens in and 20 out, priced at $3 and $15 per million.
    const state = foldRun(events);
    expect([state.tokensIn, state.tokensOut, state.costMicroUsd]).toEqual([300, 60, 1800]);
    expect(summarizeRun(events)).toMatchObject({ status: "succeeded", modelCalls: 3, toolCalls: 3, costMicroUsd: 1800 });
  });

  it("only ever appends to the conversation", async () => {
    const { store, engine, provider } = setup(noteAgent);
    await engine.run(await newRun(store));
    for (let i = 1; i < provider.requests.length; i += 1) {
      const earlier = provider.requests[i - 1]!;
      const later = provider.requests[i]!;
      expect(later.system).toBe(earlier.system);
      expect(later.tools).toEqual(earlier.tools);
      expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages);
      expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
    }
  });

  it("can rebuild every model request from the log alone", async () => {
    const { store, engine, provider } = setup(noteAgent);
    const runId = await newRun(store);
    await engine.run(runId);
    const events = await store.read(runId);
    const config = foldRun(events).config;
    const calls = ofType(events, "model.call.started");
    expect(calls).toHaveLength(3);
    calls.forEach((call, i) => {
      const p = payloadOf(call, "model.call.started");
      const rebuilt = buildRequest(deriveContext(events.slice(0, p.context_through_seq), "main"), config.max_output_tokens, config.effort);
      expect(requestHash(rebuilt)).toBe(p.request_sha256);
      expect(rebuilt).toEqual(provider.requests[i]);
    });
  });

  it("does nothing to a run that is already over", async () => {
    const { store, engine } = setup(noteAgent);
    const runId = await newRun(store);
    await engine.run(runId);
    const before = (await store.read(runId)).length;
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(await store.read(runId)).toHaveLength(before);
  });
});

describe("model failures", () => {
  it("retries a failed call, waiting as the provider asks, and records each attempt before the wait", async () => {
    const { store, engine, sleeps } = setup([
      new ModelError("rate_limited", "Too many requests.", 1500),
      new ModelError("upstream", "Server error."),
      respond([toolCall("finish", { summary: "ok" })]),
    ]);
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(sleeps).toEqual([1500, 1000]);
    const failed = ofType(await store.read(runId), "model.call.failed").map((e) => payloadOf(e, "model.call.failed"));
    expect(failed.map((p) => [p.error.kind, p.attempt, p.retry_in_ms])).toEqual([["rate_limited", 1, 1500], ["upstream", 2, 1000]]);
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("pauses the run when an outage outlasts the retries, and picks up again later", async () => {
    let outage = true;
    const { store, engine } = setup(() => (outage ? new ModelError("upstream", "Server error.") : respond([toolCall("finish", { summary: "ok" })])), {
      engine: { retry: { maxRetries: 2 } },
    });
    const runId = await newRun(store);
    expect(await engine.run(runId)).toMatchObject({ status: "paused", reason: "error:upstream" });
    expect(ofType(await store.read(runId), "model.call.failed")).toHaveLength(3);

    outage = false;
    await requestResume(store, runId);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(payloadOf(ofType(await store.read(runId), "run.resumed")[0]!, "run.resumed").reason).toBe("unpaused");
  });

  it("fails the run on an error that retrying cannot fix", async () => {
    const { store, engine, sleeps } = setup([new ModelError("auth", "The API key was rejected.")]);
    const runId = await newRun(store);
    expect(await engine.run(runId)).toMatchObject({ status: "failed", failure: { kind: "auth", message: "The API key was rejected." } });
    expect(sleeps).toEqual([]);
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("counts an empty response as a billed failure and tries again", async () => {
    const { store, engine } = setup([respond([]), respond([toolCall("finish", { summary: "ok" })])]);
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    const events = await store.read(runId);
    expect(payloadOf(ofType(events, "model.call.failed")[0]!, "model.call.failed").error.kind).toBe("empty_response");
    expect(foldRun(events).tokensIn).toBe(200);
  });

  it("ends the run when the model declines", async () => {
    const { store, engine } = setup([respond([], { stopReason: "refusal" })]);
    expect(await engine.run(await newRun(store))).toMatchObject({ status: "failed", failure: { kind: "refusal" } });
  });

  it("does not run the tool calls of a response that was cut off", async () => {
    let executed = 0;
    const probe = defineTool({ name: "probe", description: "Counts calls.", input: z.object({}), execute: async () => `ran ${(executed += 1)}` });
    const { store, engine, provider } = setup(
      [respond([toolCall("probe", {})], { stopReason: "max_output" }), respond([text("partial")], { stopReason: "max_output" }), respond([toolCall("finish", { summary: "ok" })])],
      { engine: { tools: [probe] as ToolDefinition[] } },
    );
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(executed).toBe(0);
    const events = await store.read(runId);
    expect(payloadOf(ofType(events, "tool.call.failed")[0]!, "tool.call.failed").error.kind).toBe("truncated");
    expect(notes(events, "max_output")).toHaveLength(1);
    expect(JSON.stringify(provider.requests[2]!.messages.at(-1))).toContain("cut off at the output limit");
  });
});

describe("limits held in code", () => {
  const writer = (_request: ModelRequest, call: number) =>
    call < 6 ? respond([toolCall("write_file", { path: `file-${call}.txt`, content: "x" })]) : respond([toolCall("finish", { summary: "ok" })]);

  it("warns the model near a limit, pauses at it, and continues when the limit is raised", async () => {
    const { store, engine, provider } = setup(writer);
    const runId = await newRun(store, { limits: { max_tokens: 300 } });
    const paused = await engine.run(runId);
    expect(paused).toMatchObject({ status: "paused", reason: "budget:tokens" });

    let events = await store.read(runId);
    expect(notes(events, "budget_warning:tokens")).toHaveLength(1);
    expect(payloadOf(ofType(events, "budget.exceeded")[0]!, "budget.exceeded")).toMatchObject({ dimension: "tokens", used: 360, limit: 300 });
    // The call made over the limit was refused, not run.
    expect(payloadOf(ofType(events, "tool.call.failed")[0]!, "tool.call.failed").error.kind).toBe("budget");
    expect(provider.requests).toHaveLength(3);
    // A paused run stays paused until someone says otherwise.
    expect((await engine.run(runId)).status).toBe("paused");

    await updateBudget(store, runId, { max_tokens: 5000 });
    await requestResume(store, runId);
    expect((await engine.run(runId)).status).toBe("succeeded");
    events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(foldRun(events).tokensIn + foldRun(events).tokensOut).toBeLessThanOrEqual(5000);
  });

  it("pauses at the step limit", async () => {
    const { store, engine, provider } = setup(writer);
    const runId = await newRun(store, { limits: { max_steps: 2 } });
    expect(await engine.run(runId)).toMatchObject({ status: "paused", reason: "budget:steps" });
    expect(provider.requests).toHaveLength(2);
    // Both responses' tools ran: the step limit stops the next model call, not work already asked for.
    expect(ofType(await store.read(runId), "tool.call.completed")).toHaveLength(2);
  });

  it("sends a model that stops early back to work, up to the round limit", async () => {
    const { store, engine, provider } = setup([respond([text("All done, I think.")]), respond([toolCall("finish", { summary: "ok" })])]);
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect(notes(await store.read(runId), "round")).toHaveLength(1);
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain("continuation 1 of 3");

    const stubborn = setup(() => respond([text("Done.")]));
    const second = await newRun(stubborn.store, { limits: { max_rounds: 2 } });
    expect(await stubborn.engine.run(second)).toMatchObject({ status: "failed", failure: { kind: "round_limit" } });
    expect(stubborn.provider.requests).toHaveLength(3);
    expectWellFormed(await stubborn.store.read(second), { terminal: true });
  });

  it("stops a model that keeps making the same call", async () => {
    const { store, engine, provider } = setup(() => respond([toolCall("list_files", { path: "." })]));
    const runId = await newRun(store);
    expect(await engine.run(runId)).toMatchObject({ status: "failed", failure: { kind: "stuck" } });
    expect(provider.requests).toHaveLength(6);
    expect(notes(await store.read(runId), "repeat_warning")).toHaveLength(1);
  });

  it("warns as the context fills and stops before a request that cannot fit", async () => {
    const caps = { contextWindow: 1000, maxOutputTokens: 100 };
    const sized = (inputTokens: number) => respond([toolCall("list_files", { path: `${inputTokens}` })], { usage: { inputTokens, outputTokens: 10 } });
    const { store, engine, provider } = setup([sized(100), sized(750), sized(950)], { caps });
    const runId = await newRun(store, { maxOutputTokens: 100 });
    expect(await engine.run(runId)).toMatchObject({ status: "failed", failure: { kind: "context_exhausted" } });
    expect(provider.requests).toHaveLength(3);
    expect(notes(await store.read(runId), "context_warning")).toHaveLength(1);
  });

  it("keeps room for the answer the model can give, not for a longer one the run asked for", async () => {
    // The run asks for 600 tokens of output, but this model stops at 100: the window holds 900 of conversation, not 400.
    const caps = { contextWindow: 1000, maxOutputTokens: 100 };
    const sized = (inputTokens: number) => respond([toolCall("list_files", { path: `${inputTokens}` })], { usage: { inputTokens, outputTokens: 10 } });
    const { store, engine, provider } = setup([sized(100), sized(500), respond([toolCall("finish", { summary: "Done." })])], { caps });
    const runId = await newRun(store, { maxOutputTokens: 600 });
    expect(await engine.run(runId)).toMatchObject({ status: "succeeded" });
    expect(provider.requests).toHaveLength(3);
    expect(notes(await store.read(runId), "context_warning")).toHaveLength(0);
  });
});

describe("stopping a run from outside", () => {
  const tools = (act: (runId: string) => unknown): ToolDefinition[] => [
    ...fileTools,
    defineTool({ name: "trigger", description: "Does something from outside the run.", input: z.object({}), execute: async (_input, exec) => { await act(exec.runId); return "ok"; } }) as ToolDefinition,
  ];
  const script = (_request: ModelRequest, call: number) => (call === 0 ? respond([toolCall("trigger", {})]) : respond([toolCall("finish", { summary: "ok" })]));

  it("pauses on an abort signal and can be resumed", async () => {
    const controller = new AbortController();
    const { store, engine } = setup(script, { engine: { tools: tools(() => controller.abort()) } });
    const runId = await newRun(store);
    expect(await engine.run(runId, { signal: controller.signal })).toMatchObject({ status: "paused", reason: "creator" });
    await requestResume(store, runId);
    expect((await engine.run(runId)).status).toBe("succeeded");
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("notices a pause request written while it is working", async () => {
    const holder: { store?: ReturnType<typeof setup>["store"] } = {};
    const made = setup(script, { engine: { tools: tools((runId) => requestPause(holder.store!, runId)) } });
    holder.store = made.store;
    const runId = await newRun(made.store);
    expect(await made.engine.run(runId)).toMatchObject({ status: "paused", reason: "creator" });
    expectWellFormed(await made.store.read(runId), { terminal: false });
  });

  it("ends the run on a cancel request", async () => {
    const holder: { store?: ReturnType<typeof setup>["store"] } = {};
    const made = setup(script, { engine: { tools: tools((runId) => requestCancel(holder.store!, runId)) } });
    holder.store = made.store;
    const runId = await newRun(made.store);
    expect(await made.engine.run(runId)).toMatchObject({ status: "cancelled", failure: { kind: "cancelled" } });
    expectWellFormed(await made.store.read(runId), { terminal: true });
    // Cancelling a run nobody is driving closes it in the same write.
    const idle = await newRun(made.store);
    expect((await requestCancel(made.store, idle)).status).toBe("cancelled");
  });
});
