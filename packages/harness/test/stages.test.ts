import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decideGate, defineTool, foldRun, gateApproved, inStage, payloadOf, requestCancel, summarizeRun,
  type ModelRequest, type ToolDefinition,
} from "../src/index.ts";
import { respond, resultsIn, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

/** The smallest pipeline with stages: a tool that starts one, a render that ends a revision, and a review. */
function pipeline() {
  const renders: number[] = [];
  const tools = [
    defineTool({
      name: "start",
      description: "Start a stage.",
      input: z.object({ stage: z.string() }),
      execute: async ({ stage }, exec) => exec.enterStage(stage, { reviewGate: stage === "edit" ? "final_cut" : undefined }),
      render: (_input, v) => `${v.stage} ${v.revision} ${v.trigger}`,
    }),
    defineTool({
      name: "render",
      description: "Render the cut. Ends the revision.",
      input: z.object({}),
      requires: [inStage("edit")],
      execute: async (_input, exec) => {
        const revision = exec.run().stage!.revision;
        renders.push(revision);
        await exec.completeStage();
        return `cut ${revision}`;
      },
    }),
    defineTool({
      name: "submit",
      description: "Hand the cut in.",
      input: z.object({}),
      execute: (_input, exec) => exec.gate("final_cut"),
    }),
  ] as ToolDefinition[];
  return { tools, renders };
}

const stages = (events: Awaited<ReturnType<ReturnType<typeof setup>["store"]["read"]>>) =>
  ofType(events, "stage.started").map((e) => {
    const p = payloadOf(e, "stage.started");
    return `${p.stage} ${p.revision} ${p.trigger}`;
  });

describe("stages", () => {
  it("records each stage as a span, and works out why a stage was started again", async () => {
    const { tools, renders } = pipeline();
    const script = [
      respond([toolCall("start", { stage: "research" })]),
      respond([toolCall("start", { stage: "edit" })]),
      respond([toolCall("render", {})]),
      // Not happy with its own render: a revision on its own judgement.
      respond([toolCall("start", { stage: "edit" })]),
      respond([toolCall("render", {})]),
      respond([toolCall("submit", {})]),
      // The creator asked for changes: the next revision is theirs.
      respond([toolCall("start", { stage: "edit" })]),
      respond([toolCall("render", {})]),
      respond([toolCall("submit", {})]),
      respond([toolCall("finish", { summary: "Approved." })]),
    ];
    const { store, engine } = setup(script, { engine: { tools, finishRequires: [gateApproved("final_cut")] } });
    const runId = await newRun(store, { limits: { max_re_edits: 1 } });

    expect((await engine.run(runId)).status).toBe("waiting_gate");
    expect(foldRun(await store.read(runId))).toMatchObject({ stage: undefined, reEdits: 1 });
    await decideGate(store, runId, { gate: "final_cut", decision: "changes_requested", notes: ["Slow the opening."] });
    expect((await engine.run(runId)).status).toBe("waiting_gate");
    await decideGate(store, runId, { gate: "final_cut", decision: "approved" });
    expect((await engine.run(runId)).status).toBe("succeeded");

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(stages(events)).toEqual(["research 1 plan", "edit 1 plan", "edit 2 critique", "edit 3 creator"]);
    expect(renders).toEqual([1, 2, 3]);
    // Only the revision the agent chose itself counts against the limit.
    expect(foldRun(events)).toMatchObject({ reEdits: 1, stageRevisions: { research: 1, edit: 3 } });
    // Starting a stage closes the one before it in the same write.
    const research = ofType(events, "stage.started")[0]!;
    const closed = events.find((e) => e.type === "stage.completed" && e.spanId === research.spanId)!;
    expect(events[closed.seq]!.type).toBe("stage.started");

    const rows = summarizeRun(events).rows.filter((r) => r.kind === "stage");
    expect(rows.map((r) => [r.name, r.outcome])).toEqual([
      ["research", "ok"],
      ["edit", "ok"],
      ["edit, revision 2 (critique)", "ok"],
      ["edit, revision 3 (creator)", "ok"],
    ]);
  });

  it("refuses another revision of the edit once the run has used its re-edits", async () => {
    const { tools, renders } = pipeline();
    const agent = (request: ModelRequest) => {
      const results = [...resultsIn(request).values()];
      if (results.some((r) => r.isError && r.content.includes("limit"))) return respond([toolCall("finish", { summary: "Handing in the cut as it is." })]);
      const last = results.at(-1);
      return !last || last.name === "render" ? respond([toolCall("start", { stage: "edit" })]) : respond([toolCall("render", {})]);
    };
    const { store, engine, provider } = setup(agent, { engine: { tools } });
    const runId = await newRun(store, { limits: { max_re_edits: 2 } });
    expect((await engine.run(runId)).status).toBe("succeeded");

    expect(renders).toEqual([1, 2, 3]);
    const refused = [...resultsIn(provider.requests.at(-1)!).values()].at(-1)!;
    expect(refused).toMatchObject({
      isError: true,
      content: "The cut has been revised 2 times on your own judgement, which is the limit for this run. Hand in the current cut for review instead of revising it again.",
    });
    const events = await store.read(runId);
    expect(stages(events)).toEqual(["edit 1 plan", "edit 2 critique", "edit 3 critique"]);
    expectWellFormed(events, { terminal: true });
  });

  it("blocks a stage's tools until the stage is open, and finish until its review is approved", async () => {
    const { tools, renders } = pipeline();
    const script = [
      respond([toolCall("render", {})]),
      respond([toolCall("finish", { summary: "Skipping the review." })]),
      respond([toolCall("start", { stage: "edit" })]),
      respond([toolCall("render", {})]),
      respond([toolCall("submit", {})]),
    ];
    const { store, engine, provider } = setup(script, { engine: { tools, finishRequires: [gateApproved("final_cut")] } });
    const runId = await newRun(store);
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });

    const results = [...resultsIn(provider.requests.at(-1)!).values()];
    expect(results[0]).toMatchObject({ name: "render", isError: true, content: "This belongs to the edit stage, which is not open. Start it first." });
    expect(results[1]).toMatchObject({ name: "finish", isError: true, content: expect.stringContaining('needs the "final_cut" review to be approved') });
    expect(renders).toEqual([1]);
  });

  it("closes an open stage when the run ends for any reason", async () => {
    const { tools } = pipeline();
    const done = setup([respond([toolCall("start", { stage: "research" })]), respond([toolCall("finish", { summary: "Done." })])], { engine: { tools } });
    const finished = await newRun(done.store);
    await done.engine.run(finished);
    const ended = await done.store.read(finished);
    expectWellFormed(ended, { terminal: true });
    expect(ofType(ended, "stage.completed")).toHaveLength(1);

    const stopped = setup([respond([toolCall("start", { stage: "edit" })]), respond([toolCall("render", {})]), respond([toolCall("start", { stage: "edit" })]), respond([toolCall("submit", {})])], {
      engine: { tools },
    });
    const cancelled = await newRun(stopped.store);
    expect((await stopped.engine.run(cancelled)).status).toBe("waiting_gate");
    expect((await requestCancel(stopped.store, cancelled)).status).toBe("cancelled");
    const events = await stopped.store.read(cancelled);
    expectWellFormed(events, { terminal: true });
    expect(payloadOf(ofType(events, "stage.failed")[0]!, "stage.failed")).toMatchObject({ stage: "edit", error: { kind: "cancelled" } });
  });
});
