import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventValidationError, foldRun, HeadMovedError, JsonlEventStore, LeaseHeldError, MemoryEventStore, StaleEpochError,
  type EventStore, type NewEvent,
} from "../src/index.ts";
import { newRun } from "./helpers.ts";

let n = 0;
const event = (type: string, payload: Record<string, unknown>, spanId = `span-${(n += 1)}`): NewEvent => ({
  eventId: `event-${(n += 1)}`,
  type,
  occurredAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  actor: "engine",
  spanId,
  payload,
});
const note = (text: string) => event("context.message", { origin: "engine", content: text });

const stores: Array<[string, () => EventStore]> = [
  ["memory", () => new MemoryEventStore()],
  ["jsonl", () => new JsonlEventStore(mkdtempSync(join(tmpdir(), "harness-store-")))],
];

describe.each(stores)("%s event store", (_name, make) => {
  it("numbers events without gaps and reads by cursor", async () => {
    const store = make();
    const runId = await newRun(store);
    const first = await store.append(runId, 1, [note("a"), note("b")]);
    expect(first.map((e) => e.seq)).toEqual([2, 3]);
    await store.append(runId, 3, [note("c")]);
    expect((await store.read(runId)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await store.read(runId, 2)).map((e) => e.seq)).toEqual([3, 4]);
  });

  it("refuses an append that names the wrong head", async () => {
    const store = make();
    const runId = await newRun(store);
    await store.append(runId, 1, [note("a")]);
    await expect(store.append(runId, 1, [note("late")])).rejects.toBeInstanceOf(HeadMovedError);
    expect(await store.read(runId)).toHaveLength(2);
  });

  it("lets a span open once and close once", async () => {
    const store = make();
    const runId = await newRun(store);
    await store.append(runId, 1, [event("run.started", { worker: "w", epoch: 1 }, "run-span")]);
    await expect(store.append(runId, 2, [event("run.started", { worker: "w", epoch: 1 }, "run-span")])).rejects.toThrow(/already open/);
    await store.append(runId, 2, [event("run.completed", {}, "run-span")]);
    await expect(store.append(runId, 3, [event("run.failed", { error: { kind: "x", message: "y" } }, "run-span")])).rejects.toThrow(/already closed/);
  });

  it("validates payloads and keeps plugin types apart", async () => {
    const store = make();
    const runId = await newRun(store);
    await expect(store.append(runId, 1, [event("run.paused", {})])).rejects.toBeInstanceOf(EventValidationError);
    await expect(store.append(runId, 1, [event("made.up", {})])).rejects.toBeInstanceOf(EventValidationError);
    await expect(store.append(runId, 1, [event("context.message", { origin: "engine", content: "x".repeat(300_000) })])).rejects.toThrow(/over 262144 bytes/);
    // A plugin's own type is stored as it is and cannot change the run's state.
    await store.append(runId, 1, [event("x.demo.anything", { status: "succeeded" })]);
    expect(foldRun(await store.read(runId)).status).toBe("created");
  });

  it("gives one worker at a time the right to drive a run", async () => {
    const store = make();
    const runId = await newRun(store);
    const a = await store.acquireLease(runId, "a");
    await expect(store.acquireLease(runId, "b")).rejects.toBeInstanceOf(LeaseHeldError);
    await store.releaseLease(runId, "a", a.epoch);
    const b = await store.acquireLease(runId, "b");
    expect(b.epoch).toBeGreaterThan(a.epoch);
    // The old worker's writes are refused once another has taken over.
    await expect(store.append(runId, 1, [note("stale")], a.epoch)).rejects.toBeInstanceOf(StaleEpochError);
    await store.append(runId, 1, [note("current")], b.epoch);
  });
});

describe("worker lease", () => {
  it("runs out after a minute unless the worker keeps it alive", async () => {
    let now = 1_000_000;
    const made: EventStore[] = [new MemoryEventStore(() => now), new JsonlEventStore(mkdtempSync(join(tmpdir(), "harness-store-")), () => now)];
    for (const store of made) {
      now = 1_000_000;
      const runId = await newRun(store);
      const a = await store.acquireLease(runId, "a");
      now += 50_000;
      await store.renewLease(runId, "a", a.epoch);
      now += 50_000;
      // 100 seconds after it was taken, but only 50 since it was renewed.
      await expect(store.acquireLease(runId, "b")).rejects.toBeInstanceOf(LeaseHeldError);
      now += 20_000;
      expect((await store.acquireLease(runId, "b")).epoch).toBe(a.epoch + 1);
      // The worker that lost the run cannot renew its way back in.
      await store.renewLease(runId, "a", a.epoch);
      now += 61_000;
      await store.acquireLease(runId, "c");
    }
  });
});

describe("jsonl event store", () => {
  it("drops a half-written last line and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-store-"));
    const store = new JsonlEventStore(root);
    const runId = await newRun(store);
    await store.append(runId, 1, [note("kept")]);
    appendFileSync(join(store.runDir(runId), "events.jsonl"), '{"seq":3,"type":"context.mess');
    const reopened = new JsonlEventStore(root);
    expect((await reopened.read(runId)).map((e) => e.seq)).toEqual([1, 2]);
    // The next append lands on a clean line, not glued to the fragment.
    await reopened.append(runId, 2, [note("after the crash")]);
    expect((await new JsonlEventStore(root).read(runId)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
