import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, fileTools, MemoryEventStore, payloadOf, type EventStore, type HarnessEvent, type ModelRequest, type NewEvent, type ToolDefinition } from "../src/index.ts";
import { FaultyStore, respond, resultsIn, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

/** Sends an email (not safe to repeat), writes a note, reads it back, finishes. Decides from the results it has. */
const agent = (request: ModelRequest) => {
  const results = [...resultsIn(request).values()];
  const ok = (name: string) => results.some((r) => r.name === name && !r.isError);
  if (!ok("send_email")) {
    // After an interruption the outcome is unknown, so a careful model checks before sending again.
    const unknown = results.some((r) => r.name === "send_email" && r.content.includes("outcome is unknown"));
    if (unknown && !ok("check_outbox")) return respond([toolCall("check_outbox", {})]);
    const already = results.some((r) => r.name === "check_outbox" && r.content === "sent");
    if (!already) return respond([toolCall("send_email", { to: "reader@demo.example" })]);
  }
  if (!ok("write_file")) return respond([toolCall("write_file", { path: "note.txt", content: "hello" }), toolCall("list_files", { path: "." })]);
  if (!ok("read_file")) return respond([toolCall("read_file", { path: "note.txt" })]);
  return respond([toolCall("finish", { summary: "done" })]);
};

function world() {
  const outbox: string[] = [];
  const tools = [
    ...fileTools,
    defineTool({ name: "send_email", description: "Send an email.", input: z.object({ to: z.string() }), execute: async ({ to }) => { outbox.push(to); return "sent"; } }),
    defineTool({ name: "check_outbox", description: "See whether the email went out.", input: z.object({}), readOnly: true, execute: async () => (outbox.length ? "sent" : "empty") }),
  ] as ToolDefinition[];
  return { outbox, tools };
}

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
}

describe("resume after a crash", () => {
  it("finishes the run after a crash at any point, and never sends the email twice", async () => {
    // How many writes does an uninterrupted run make?
    const clean = world();
    const counting = new CountingStore(new MemoryEventStore());
    const baseline = setup(agent, { store: counting, engine: { tools: clean.tools } });
    expect((await baseline.engine.run(await newRun(counting))).status).toBe("succeeded");
    expect(clean.outbox).toEqual(["reader@demo.example"]);
    const total = counting.appends;
    expect(total).toBeGreaterThan(12);

    for (let dieAfter = 0; dieAfter < total; dieAfter += 1) {
      const { outbox, tools } = world();
      const memory = new MemoryEventStore();
      const workDir = mkdtempSync(join(tmpdir(), "harness-crash-"));
      const runId = await newRun(memory);

      const doomed = setup(agent, { store: new FaultyStore(memory, dieAfter), engine: { tools }, workDir });
      await expect(doomed.engine.run(runId), `crash after ${dieAfter} writes`).rejects.toThrow("The process is gone.");

      // A dead worker never releases its lease; it runs out on its own.
      memory.expireLease(runId);
      const next = setup(agent, { store: memory, engine: { tools }, workDir });
      const outcome = await next.engine.run(runId);
      expect(outcome.status, `resume after ${dieAfter} writes`).toBe("succeeded");

      const events = await memory.read(runId);
      expectWellFormed(events, { terminal: true });
      expect(outbox, `emails after a crash at write ${dieAfter}`).toEqual(["reader@demo.example"]);
      expect(readFileSync(join(workDir, "note.txt"), "utf8")).toBe("hello");
      if (dieAfter > 0) expect(payloadOf(ofType(events, "run.resumed")[0]!, "run.resumed").reason).toBe("crash");
    }
  });

  it("tells the model what happened to each call that was in flight", async () => {
    const { tools, outbox } = world();
    const memory = new MemoryEventStore();
    const runId = await newRun(memory);
    // Writes: start, model started, model completed, send_email started. The crash lands on its result.
    const doomed = setup(agent, { store: new FaultyStore(memory, 4), engine: { tools } });
    await expect(doomed.engine.run(runId)).rejects.toThrow();
    expect(outbox).toEqual(["reader@demo.example"]);

    memory.expireLease(runId);
    const next = setup(agent, { store: memory, engine: { tools } });
    await next.engine.run(runId);
    const events = await memory.read(runId);
    const interrupted = ofType(events, "tool.call.failed").map((e) => payloadOf(e, "tool.call.failed").error).find((e) => e.kind === "interrupted")!;
    expect(interrupted.message).toBe(
      "The tool call was interrupted before a result was recorded, so its outcome is unknown. It may already have had an effect: check the current state before calling it again.",
    );
    const resumed = payloadOf(ofType(events, "run.resumed")[0]!, "run.resumed");
    expect(resumed.interrupted_spans).toHaveLength(1);
    // The model checked, saw the email had gone, and did not send it again.
    expect(ofType(events, "tool.call.started").map((e) => payloadOf(e, "tool.call.started").tool)).toEqual([
      "send_email", "check_outbox", "write_file", "list_files", "read_file", "finish",
    ]);
  });

  it("says a read-only call is safe to repeat, and that a call which never started can be made again", async () => {
    const { tools } = world();
    const script = (request: ModelRequest) => {
      const results = [...resultsIn(request).values()];
      if (results.some((r) => !r.isError)) return respond([toolCall("finish", { summary: "done" })]);
      return respond([toolCall("check_outbox", {}, `a${results.length}`), toolCall("send_email", { to: "reader@demo.example" }, `b${results.length}`)]);
    };
    const memory = new MemoryEventStore();
    const runId = await newRun(memory);
    await expect(setup(script, { store: new FaultyStore(memory, 4), engine: { tools } }).engine.run(runId)).rejects.toThrow();
    memory.expireLease(runId);
    const next = setup(script, { store: memory, engine: { tools } });
    expect((await next.engine.run(runId)).status).toBe("succeeded");
    const shown = [...resultsIn(next.provider.requests[0]!).values()];
    expect(shown.map((r) => r.content)).toEqual([
      "The tool call was interrupted before a result was recorded, so its outcome is unknown. This tool is safe to call again.",
      "The tool call was not started. Call it again if it is still needed.",
    ]);
  });
});
