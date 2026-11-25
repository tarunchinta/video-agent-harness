import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  createRun, Engine, MemoryEventStore, payloadOf,
  type CreateRunInput, type EngineOptions, type EventStore, type HarnessEvent, type ModelCapabilities, type ModelRequest,
} from "../src/index.ts";
import { ScriptedProvider, type Scripted, type ScriptStep } from "../src/testing/index.ts";

export const SYSTEM = "You are a test agent.";

export type SetupOptions = {
  store?: EventStore;
  caps?: ModelCapabilities;
  engine?: Partial<EngineOptions>;
  workDir?: string;
};

export function setup(script: ScriptStep[] | ((request: ModelRequest, call: number) => Scripted), options: SetupOptions = {}) {
  const store = options.store ?? new MemoryEventStore();
  const provider = new ScriptedProvider(script, options.caps);
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), "harness-test-"));
  const sleeps: number[] = [];
  const engine = new Engine({
    store,
    provider,
    workDir: () => workDir,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    worker: "test-worker",
    ...options.engine,
  });
  return { store, provider, engine, workDir, sleeps };
}

export function newRun(store: EventStore, input: Partial<CreateRunInput> = {}): Promise<string> {
  return createRun(store, { task: "Write a note and read it back.", model: "test-model", system: SYSTEM, ...input });
}

export const ofType = (events: HarnessEvent[], type: string) => events.filter((e) => e.type === type);

/** The rules every log must keep, whatever happened during the run. */
export function expectWellFormed(events: HarnessEvent[], options: { terminal: boolean }): void {
  events.forEach((e, i) => {
    expect(e.seq).toBe(i + 1);
  });
  const closed = new Map<string, number>();
  for (const e of events) if (e.type.endsWith(".completed") || e.type.endsWith(".failed")) closed.set(e.spanId, (closed.get(e.spanId) ?? 0) + 1);
  for (const count of closed.values()) expect(count).toBe(1);
  for (const e of events) {
    if (!e.type.endsWith(".started")) continue;
    const isRunOrAgent = e.type === "run.started" || e.type === "agent.started";
    if (isRunOrAgent && !options.terminal) continue;
    expect(closed.has(e.spanId), `${e.type} at seq ${e.seq} was never closed`).toBe(true);
  }
  // Every tool call the model made has exactly one result.
  const asked = new Set<string>();
  for (const e of ofType(events, "model.call.completed")) {
    if (e.agentId !== "main") continue;
    for (const block of payloadOf(e, "model.call.completed").content) if (block.type === "tool_call") asked.add(block.id as string);
  }
  const started = ofType(events, "tool.call.started").map((e) => payloadOf(e, "tool.call.started").tool_call_id);
  for (const id of started) expect(asked.has(id), `tool call ${id} was never asked for`).toBe(true);
  expect(new Set(started).size).toBe(started.length);
}
