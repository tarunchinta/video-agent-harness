import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, fileTools, payloadOf, ToolError, type ModelRequest, type ToolDefinition } from "../src/index.ts";
import { respond, resultsIn, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

const finish = respond([toolCall("finish", { summary: "ok" })]);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one response's tool calls, then finishes. Returns what the model was shown for each call. */
async function runCalls(calls: Array<[string, unknown]>, tools: ToolDefinition[], engine: Parameters<typeof setup>[1] = {}) {
  const made = setup([respond(calls.map(([name, input], i) => toolCall(name, input, `c${i}`))), finish], {
    ...engine,
    engine: { tools: [...fileTools, ...tools], ...engine.engine },
  });
  const runId = await newRun(made.store);
  const outcome = await made.engine.run(runId);
  const events = await made.store.read(runId);
  expectWellFormed(events, { terminal: true });
  const shown = [...resultsIn(made.provider.requests[1]!).values()];
  return { ...made, runId, outcome, events, shown };
}

describe("tool dispatch", () => {
  it("turns every kind of failure into a result the model can act on", async () => {
    const tools = [
      defineTool({ name: "needs_number", description: "Takes a number.", input: z.object({ n: z.number() }), execute: async ({ n }) => `got ${n}` }),
      defineTool({ name: "refuses", description: "Always refuses.", input: z.object({}), execute: async () => { throw new ToolError("The file is locked.", "Close it and try again."); } }),
      defineTool({ name: "breaks", description: "Always breaks.", input: z.object({}), execute: async () => { throw new Error("secret stack detail"); } }),
      defineTool({ name: "hangs", description: "Never returns.", input: z.object({}), timeoutMs: 30, execute: () => new Promise<string>(() => {}) }),
      defineTool({ name: "off", description: "Turned off.", input: z.object({}), execute: async () => "should not run" }),
    ] as ToolDefinition[];
    const { shown, events, outcome } = await runCalls(
      [["needs_number", { n: "seven" }], ["refuses", {}], ["breaks", {}], ["hangs", {}], ["off", {}], ["no_such_tool", {}], ["read_file", { path: "../outside.txt" }]],
      tools,
      { engine: { toolPolicy: { off: "deny" } } },
    );
    expect(outcome.status).toBe("succeeded");
    expect(shown.every((r) => r.isError)).toBe(true);
    expect(shown.map((r) => r.content)).toEqual([
      expect.stringContaining("The input for needs_number is not valid (n:"),
      "The file is locked. Close it and try again.",
      "breaks failed unexpectedly.",
      "hangs did not finish within 0 seconds.",
      'The tool "off" is turned off for this run.',
      expect.stringContaining('There is no tool named "no_such_tool". The tools are: breaks, finish'),
      expect.stringContaining("is outside the working directory"),
    ]);
    const kinds = ofType(events, "tool.call.failed").map((e) => payloadOf(e, "tool.call.failed").error.kind);
    expect(kinds).toEqual(["invalid_input", "tool_error", "internal", "timeout", "denied", "unknown_tool", "tool_error"]);
    // The detail of an unexpected failure is kept in the log and kept away from the model.
    const internal = ofType(events, "tool.call.failed").map((e) => payloadOf(e, "tool.call.failed").error)[2]!;
    expect(internal.detail).toBe("secret stack detail");
    expect(JSON.stringify(shown)).not.toContain("secret");
  });

  it("overlaps parallel-safe calls, runs the rest alone, and returns results in the model's order", async () => {
    let active = 0;
    let peak = 0;
    const seenByExclusive: number[] = [];
    const slow = (name: string, parallelSafe: boolean) =>
      defineTool({
        name,
        description: "Waits a moment.",
        input: z.object({ id: z.string() }),
        parallelSafe,
        execute: async ({ id }) => {
          if (!parallelSafe) seenByExclusive.push(active);
          active += 1;
          peak = Math.max(peak, active);
          await pause(parallelSafe ? 40 - Number(id) * 10 : 5);
          active -= 1;
          return `done ${id}`;
        },
      }) as ToolDefinition;
    const { shown } = await runCalls(
      [["look", { id: "0" }], ["look", { id: "1" }], ["look", { id: "2" }], ["change", { id: "3" }], ["look", { id: "4" }]],
      [slow("look", true), slow("change", false)],
    );
    expect(peak).toBe(3);
    expect(seenByExclusive).toEqual([0]);
    // The later calls finished first, but the model reads them in the order it asked.
    expect(shown.map((r) => r.content)).toEqual(["done 0", "done 1", "done 2", "done 3", "done 4"]);
  });

  it("caps how many calls overlap", async () => {
    let active = 0;
    let peak = 0;
    const look = defineTool({
      name: "look",
      description: "Waits a moment.",
      input: z.object({ id: z.number() }),
      parallelSafe: true,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await pause(10);
        active -= 1;
        return "ok";
      },
    }) as ToolDefinition;
    await runCalls(Array.from({ length: 7 }, (_, id) => ["look", { id }] as [string, unknown]), [look], { engine: { maxParallelToolCalls: 2 } });
    expect(peak).toBe(2);
  });

  it("keeps a large result out of the conversation and leaves the full text where the model can read it", async () => {
    const full = `START${"x".repeat(50_000)}END`;
    const big = defineTool({ name: "big", description: "Returns a lot.", input: z.object({}), execute: async () => full }) as ToolDefinition;
    const { shown, events, workDir, provider } = await runCalls([["big", {}]], [big], { engine: { maxInlineChars: 1000 } });
    const seen = shown[0]!.content;
    expect(seen.length).toBeLessThan(1300);
    expect(seen.startsWith("START")).toBe(true);
    expect(seen.endsWith("END")).toBe(true);
    expect(seen).toContain("Left out 49,008 characters from the middle. The full result is at tool-results/c0.txt.");
    const completed = payloadOf(ofType(events, "tool.call.completed")[0]!, "tool.call.completed");
    expect(completed).toMatchObject({ truncated: true, output_path: "tool-results/c0.txt" });
    expect(readFileSync(join(workDir, "tool-results", "c0.txt"), "utf8")).toBe(full);
    // What the model was shown is what the log holds: the preview is never rewritten later.
    expect(completed.output).toBe(seen);
    expect(provider.requests).toHaveLength(2);
  });

  it("lets read_file page through a file instead of cutting it", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const script = (request: ModelRequest, call: number) =>
      call === 0
        ? respond([toolCall("write_file", { path: "notes/long.txt", content: lines }, "w")])
        : call === 1
          ? respond([toolCall("read_file", { path: "notes/long.txt", offset: 10, limit: 3 }, "r"), toolCall("list_files", { path: "notes" }, "l")])
          : respond([toolCall("finish", { summary: resultsIn(request).get("r")!.content })]);
    const { store, engine, workDir } = setup(script, { engine: { maxInlineChars: 10 } });
    const runId = await newRun(store);
    const outcome = await engine.run(runId);
    expect((outcome.result as { summary: string }).summary).toBe("line 10\nline 11\nline 12\n\n(Lines 10 to 12 of 30. Read on with offset 13.)");
    expect(existsSync(join(workDir, "tool-results", "r.txt"))).toBe(false);
    const listed = ofType(await store.read(runId), "tool.call.completed").map((e) => payloadOf(e, "tool.call.completed")).find((p) => p.tool_call_id === "l")!;
    expect(listed.output_path).toBe("tool-results/l.txt");
  });

  it("checks a tool's result against its declared shape", async () => {
    const wrong = defineTool({
      name: "wrong",
      description: "Returns the wrong shape.",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      execute: async () => ({ count: "three" }) as unknown as { count: number },
    }) as ToolDefinition;
    const { shown } = await runCalls([["wrong", {}]], [wrong]);
    expect(shown[0]).toMatchObject({ isError: true, content: "wrong returned a result that does not match its declared shape." });
  });

  it("rejects tool definitions that could not be held to the rules", () => {
    const base = { description: "x", input: z.object({}), execute: async () => "x" };
    expect(() => defineTool({ ...base, name: "Bad-Name" })).toThrow(/snake_case/);
    expect(() => defineTool({ ...base, name: "fetch_page", untrusted: true })).toThrow(/output schema/);
    expect(() => setup([], { engine: { tools: [defineTool({ ...base, name: "finish" }) as ToolDefinition] } })).toThrow(/Two tools are named "finish"/);
  });
});
