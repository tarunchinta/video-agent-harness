import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decideGate, defineTool, fileTools, MemoryEventStore, payloadOf, requestResume, runCommandTool,
  type ModelRequest, type ToolDefinition,
} from "../src/index.ts";
import { FakeSandboxes, FaultyStore, respond, resultsIn, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

const tools = [...fileTools, runCommandTool] as ToolDefinition[];

/** A sandbox whose only program is `python`, which writes a number to out.txt the way a real script would. */
const sandboxes = () =>
  new FakeSandboxes((call, run) => {
    if (call.command[0] !== "python") return { exitCode: 127, stderr: `${call.command[0]}: not found` };
    writeFileSync(join(run.workDir, "out.txt"), "42\n");
    return { stdout: "wrote out.txt\n" };
  });

describe("the sandbox", () => {
  it("starts on first use, runs commands in the run's folder and is removed when the run ends", async () => {
    const box = sandboxes();
    const script = [
      respond([toolCall("write_file", { path: "calc.py", content: "print(42)" })]),
      respond([toolCall("run_command", { command: ["python", "calc.py"] }), toolCall("run_command", { command: ["ruby", "x.rb"], cwd: "lib" })]),
      respond([toolCall("finish", { summary: "Ran it." })]),
    ];
    const { store, engine, workDir, provider } = setup(script, { engine: { tools, sandbox: box.factory } });
    const runId = await newRun(store);
    expect((await engine.run(runId)).status).toBe("succeeded");

    expect(box.started).toBe(1);
    expect(box.stopped).toBe(1);
    expect(box.commands).toEqual([
      { command: ["python", "calc.py"], cwd: "/work" },
      { command: ["ruby", "x.rb"], cwd: "/work/lib" },
    ]);
    expect(readFileSync(join(workDir, "out.txt"), "utf8")).toBe("42\n");

    const results = [...resultsIn(provider.requests[2]!).values()].filter((r) => r.name === "run_command");
    expect(results[0]!.content).toBe("Exit code 0 in 0.0 s.\n\nstdout:\nwrote out.txt");
    expect(results[1]!.content).toBe("Exit code 127 in 0.0 s.\n\nstderr:\nruby: not found");

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(payloadOf(ofType(events, "sandbox.started")[0]!, "sandbox.started")).toMatchObject({ image: "fake-sandbox:test", container_id: "fake-1" });
    expect(payloadOf(ofType(events, "sandbox.completed")[0]!, "sandbox.completed").exit_reason).toBe("completed");
    // The sandbox is gone before the run is recorded as over.
    expect(events.findIndex((e) => e.type === "sandbox.completed")).toBeLessThan(events.findIndex((e) => e.type === "run.completed"));
    expect(ofType(events, "tool.call.started").filter((e) => payloadOf(e, "tool.call.started").sandboxed)).toHaveLength(2);
  });

  it("is not started by a run that never asks for it", async () => {
    const box = sandboxes();
    const { store, engine } = setup([respond([toolCall("finish", { summary: "Nothing to run." })])], { engine: { tools, sandbox: box.factory } });
    const runId = await newRun(store);
    await engine.run(runId);
    expect(box.started).toBe(0);
    expect(ofType(await store.read(runId), "sandbox.started")).toHaveLength(0);
  });

  it("refuses to leave the working directory", async () => {
    const box = sandboxes();
    const script = [respond([toolCall("run_command", { command: ["python", "x.py"], cwd: "../../etc" })]), respond([toolCall("finish", { summary: "Stopped." })])];
    const { store, engine, provider } = setup(script, { engine: { tools, sandbox: box.factory } });
    await engine.run(await newRun(store));
    expect([...resultsIn(provider.requests[1]!).values()][0]).toMatchObject({ isError: true, content: expect.stringContaining("outside the working directory") });
    expect(box.commands).toEqual([]);
  });

  it("is removed while the run waits for a review, and a fresh one starts afterwards", async () => {
    const box = sandboxes();
    const gated = [
      ...tools,
      defineTool({ name: "ask", description: "Ask for a review.", input: z.object({}), execute: (_input, exec) => exec.gate("script") }),
    ] as ToolDefinition[];
    const agent = (request: ModelRequest) => {
      const results = [...resultsIn(request).values()];
      const ran = results.filter((r) => r.name === "run_command" && !r.isError).length;
      const asked = results.some((r) => r.name === "ask");
      if (ran === 0) return respond([toolCall("run_command", { command: ["python", "a.py"] })]);
      if (!asked) return respond([toolCall("ask", {})]);
      if (ran === 1) return respond([toolCall("run_command", { command: ["python", "b.py"] })]);
      return respond([toolCall("finish", { summary: "Done." })]);
    };
    const { store, engine } = setup(agent, { engine: { tools: gated, sandbox: box.factory } });
    const runId = await newRun(store);

    expect((await engine.run(runId)).status).toBe("waiting_gate");
    expect([box.started, box.stopped]).toEqual([1, 1]);
    let events = await store.read(runId);
    expect(payloadOf(ofType(events, "sandbox.completed")[0]!, "sandbox.completed").exit_reason).toBe("gate");
    expect(events.findIndex((e) => e.type === "sandbox.completed")).toBeLessThan(events.findIndex((e) => e.type === "gate.opened"));

    await decideGate(store, runId, { gate: "script", decision: "approved" });
    expect((await engine.run(runId)).status).toBe("succeeded");
    expect([box.started, box.stopped]).toEqual([2, 2]);
    events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(ofType(events, "sandbox.started").map((e) => payloadOf(e, "sandbox.started").container_id)).toEqual(["fake-1", "fake-2"]);
  });

  it("pauses the run when the sandbox cannot be started, and carries on once it can", async () => {
    const box = sandboxes();
    box.failWith = "the Docker daemon did not answer";
    const agent = (request: ModelRequest) => {
      const ok = [...resultsIn(request).values()].some((r) => r.name === "run_command" && !r.isError);
      return ok ? respond([toolCall("finish", { summary: "Ran it." })]) : respond([toolCall("run_command", { command: ["python", "a.py"] })]);
    };
    const { store, engine, provider } = setup(agent, { engine: { tools, sandbox: box.factory } });
    const runId = await newRun(store);

    expect(await engine.run(runId)).toMatchObject({ status: "paused", reason: "error:sandbox" });
    expect(provider.requests).toHaveLength(1);
    const paused = ofType(await store.read(runId), "run.paused")[0]!;
    expect(paused.payload).toMatchObject({ reason: "error:sandbox", detail: "the Docker daemon did not answer" });

    box.failWith = undefined;
    await requestResume(store, runId);
    expect((await engine.run(runId)).status).toBe("succeeded");
    // The model was told the first call did not work, and decided to make it again.
    expect([...resultsIn(provider.requests[1]!).values()][0]).toMatchObject({ isError: true, content: "The sandbox could not be started: the Docker daemon did not answer" });
    expectWellFormed(await store.read(runId), { terminal: true });
  });

  it("refuses sandbox tools in a run that has no sandbox", async () => {
    const script = [respond([toolCall("run_command", { command: ["python", "a.py"] })]), respond([toolCall("finish", { summary: "Could not run it." })])];
    const { store, engine, provider } = setup(script, { engine: { tools } });
    expect((await engine.run(await newRun(store))).status).toBe("succeeded");
    expect([...resultsIn(provider.requests[1]!).values()][0]).toMatchObject({ isError: true, content: "This run has no sandbox, so nothing can be run in one." });
  });

  it("closes the record of a sandbox whose worker died, and removes the container either way", async () => {
    const agent = (request: ModelRequest) => {
      const ran = [...resultsIn(request).values()].filter((r) => r.name === "run_command" && !r.isError).length;
      return ran >= 2 ? respond([toolCall("finish", { summary: "Done." })]) : respond([toolCall("run_command", { command: ["python", `${ran}.py`] })]);
    };
    const memory = new MemoryEventStore();
    const workDir = mkdtempSync(join(tmpdir(), "harness-sandbox-crash-"));
    const runId = await newRun(memory);
    const first = sandboxes();
    // Dies once the sandbox is up and on record, before the run gets any further.
    const doomed = setup(agent, { store: new FaultyStore(memory, 6), engine: { tools, sandbox: first.factory }, workDir });
    await expect(doomed.engine.run(runId)).rejects.toThrow("The process is gone.");
    expect(ofType(await memory.read(runId), "sandbox.started")).toHaveLength(1);
    expect(ofType(await memory.read(runId), "sandbox.completed")).toHaveLength(0);
    // The worker's own exit path removes the container even though it can no longer write.
    expect([first.started, first.stopped]).toEqual([1, 1]);

    memory.expireLease(runId);
    const second = sandboxes();
    const next = setup(agent, { store: memory, engine: { tools, sandbox: second.factory }, workDir });
    expect((await next.engine.run(runId)).status).toBe("succeeded");
    const events = await memory.read(runId);
    expectWellFormed(events, { terminal: true });
    expect(ofType(events, "sandbox.completed").map((e) => payloadOf(e, "sandbox.completed").exit_reason)).toEqual(["interrupted", "completed"]);
  });
});
