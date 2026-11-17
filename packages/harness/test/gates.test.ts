import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideGate, defineTool, gateApproved, payloadOf, type ModelRequest, type ToolDefinition } from "../src/index.ts";
import { respond, resultsIn, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

function gated() {
  const renders: string[] = [];
  const tools = [
    defineTool({
      name: "request_review",
      description: "Ask the creator to review the script. Stops the run until they answer.",
      input: z.object({ script: z.string() }),
      execute: (input, exec) => exec.gate("script", { script_chars: input.script.length }),
    }),
    defineTool({
      name: "render",
      description: "Render the cut.",
      input: z.object({ take: z.number() }),
      requires: [gateApproved("script")],
      execute: async ({ take }) => {
        renders.push(`take ${take}`);
        return `Rendered take ${take}.`;
      },
    }),
  ] as ToolDefinition[];

  /** Tries to render first, asks for review when blocked, renders once approved. */
  const script = (request: ModelRequest) => {
    const results = [...resultsIn(request).values()];
    if (results.some((r) => r.name === "render" && !r.isError)) return respond([toolCall("finish", { summary: "Rendered." })]);
    const review = results.filter((r) => r.name === "request_review").at(-1);
    if (!review || review.content.includes("changes_requested")) {
      return results.length === 0 ? respond([toolCall("render", { take: 1 })]) : respond([toolCall("request_review", { script: "draft" }), toolCall("render", { take: 2 })]);
    }
    return respond([toolCall("render", { take: 3 })]);
  };
  return { ...setup(script, { engine: { tools } }), renders };
}

describe("review gates", () => {
  it("blocks a gated tool until the creator approves, whatever the model tries", async () => {
    const { store, engine, renders, provider } = gated();
    const runId = await newRun(store);

    const waiting = await engine.run(runId);
    expect(waiting).toEqual({ runId, status: "waiting_gate", gate: "script" });
    expect(renders).toEqual([]);
    let events = await store.read(runId);
    expect(payloadOf(ofType(events, "tool.call.failed")[0]!, "tool.call.failed").error).toMatchObject({
      kind: "precondition",
      message: 'This needs the "script" review to be approved first. Ask for that review, then try again.',
    });
    expect(payloadOf(ofType(events, "gate.opened")[0]!, "gate.opened")).toMatchObject({ gate: "script", script_chars: 5 });

    // A waiting run does nothing and writes nothing until the gate is decided.
    const before = events.length;
    expect((await engine.run(runId)).status).toBe("waiting_gate");
    expect(await store.read(runId)).toHaveLength(before);
    expect(provider.requests).toHaveLength(2);

    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["Good to go."] });
    const done = await engine.run(runId);
    expect(done.status).toBe("succeeded");
    expect(renders).toEqual(["take 3"]);

    events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(payloadOf(ofType(events, "run.resumed")[0]!, "run.resumed").reason).toBe("gate");
    // The creator's answer is the result of the call that asked, and the call queued behind it never ran.
    const shown = [...resultsIn(provider.requests[2]!).values()];
    expect(JSON.parse(shown.find((r) => r.name === "request_review")!.content)).toEqual({ gate: "script", decision: "approved", notes: ["Good to go."] });
    expect(shown.find((r) => r.name === "render" && r.input && (r.input as { take: number }).take === 2)).toMatchObject({
      isError: true,
      content: "The tool call was not started. Call it again if it is still needed.",
    });
  });

  it("sends the creator's notes back when changes are requested, and stays closed", async () => {
    const { store, engine, renders } = gated();
    const runId = await newRun(store);
    await engine.run(runId);
    await decideGate(store, runId, { gate: "script", decision: "changes_requested", notes: ["Shorten the hook."] });
    // The model asks again after the notes; the gate is open again and nothing was rendered.
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "script" });
    expect(renders).toEqual([]);
    expect(ofType(await store.read(runId), "gate.opened")).toHaveLength(2);
  });

  it("ends the run when the creator rejects", async () => {
    const { store, engine, renders } = gated();
    const runId = await newRun(store);
    await engine.run(runId);
    const state = await decideGate(store, runId, { gate: "script", decision: "rejected" });
    expect(state.status).toBe("cancelled");
    expect(await engine.run(runId)).toMatchObject({ status: "cancelled", failure: { kind: "cancelled", message: 'The "script" review was rejected.' } });
    expect(renders).toEqual([]);
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("only accepts an answer to the gate that is open", async () => {
    const { store, engine } = gated();
    const runId = await newRun(store);
    await expect(decideGate(store, runId, { gate: "script", decision: "approved" })).rejects.toThrow(/not waiting on a review/);
    await engine.run(runId);
    await expect(decideGate(store, runId, { gate: "final_cut", decision: "approved" })).rejects.toThrow(/waiting on the "script" review/);
  });
});
