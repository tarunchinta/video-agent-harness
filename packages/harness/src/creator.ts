import { limitsSchema, payloadOf, type GateDecisionKind, type HarnessEvent, type Limits } from "./events/envelope.ts";
import { foldRun, isTerminal, type RunState } from "./events/reducer.ts";
import { HeadMovedError, type EventStore } from "./events/store.ts";
import type { EventDraft } from "./tools/dispatch.ts";
import { randomIds, systemClock, type Clock, type IdSource } from "./util.ts";

/** What the person running the harness can write to a run. These never need the worker lease. */

export const HARNESS_VERSION = "0.1.0";
export const MAIN_AGENT = "main";

export type Deps = { clock?: Clock; ids?: IdSource };

export type CreateRunInput = {
  runId?: string;
  title?: string;
  /** What the agent is asked to do. */
  task: string;
  model: string;
  system: string;
  maxOutputTokens?: number;
  effort?: string;
  limits?: Limits;
  /** Names the set of tools and prompts the run uses, so a later worker builds the same ones. */
  pipeline?: string;
  /** Gives the run a sandbox, with this much network. */
  sandboxNetwork?: "none" | "public";
};

export async function createRun(store: EventStore, input: CreateRunInput, deps: Deps = {}): Promise<string> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? randomIds;
  const runId = input.runId ?? ids.uuid();
  await store.createRun(runId, [
    {
      eventId: ids.uuid(),
      occurredAt: clock.now().toISOString(),
      type: "run.created",
      actor: "creator",
      spanId: ids.uuid(),
      payload: {
        title: input.title ?? input.task.slice(0, 80),
        brief: { task: input.task },
        config: {
          model: input.model,
          system: input.system,
          max_output_tokens: input.maxOutputTokens ?? 16_000,
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.pipeline ? { pipeline: input.pipeline } : {}),
          ...(input.sandboxNetwork ? { sandbox_network: input.sandboxNetwork } : {}),
        },
        limits: limitsSchema.parse(input.limits ?? {}),
        harness_version: HARNESS_VERSION,
      },
    },
  ]);
  return runId;
}

/** Appends at the head of a run, re-reading and trying again if another writer got there first. */
async function write(
  store: EventStore,
  runId: string,
  deps: Deps,
  build: (state: RunState, events: HarnessEvent[]) => EventDraft[],
): Promise<RunState> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? randomIds;
  for (let attempt = 0; ; attempt += 1) {
    const events = await store.read(runId);
    const state = foldRun(events);
    const drafts = build(state, events);
    if (!drafts.length) return state;
    const batch = drafts.map((d) => ({ eventId: ids.uuid(), occurredAt: clock.now().toISOString(), ...d }));
    try {
      return foldRun([...events, ...(await store.append(runId, state.lastSeq, batch))]);
    } catch (err) {
      if (!(err instanceof HeadMovedError) || attempt >= 5) throw err;
    }
  }
}

/**
 * Closing events for every span that is still open, innermost first, ending with the run itself. Used when a run
 * ends for good, so no span is left dangling in the log.
 */
export function closeAll(events: readonly HarnessEvent[], kind: string, message: string): EventDraft[] {
  const closed = new Set(events.filter((e) => e.type.endsWith(".completed") || e.type.endsWith(".failed")).map((e) => e.spanId));
  const open = events.filter((e) => e.type.endsWith(".started") && !closed.has(e.spanId));
  const error = { kind, message };
  const drafts: EventDraft[] = [];
  const base = (e: HarnessEvent) => ({ actor: "engine" as const, agentId: e.agentId, spanId: e.spanId, parentSpanId: e.parentSpanId });
  for (const e of open) {
    if (e.type === "tool.call.started") {
      drafts.push({ ...base(e), type: "tool.call.failed", payload: { tool_call_id: payloadOf(e, "tool.call.started").tool_call_id, error } });
    } else if (e.type === "model.call.started") {
      drafts.push({ ...base(e), type: "model.call.failed", payload: { error: { ...error, retryable: false }, attempt: payloadOf(e, "model.call.started").attempt } });
    }
  }
  for (const e of open) {
    if (e.type === "stage.started") drafts.push({ ...base(e), type: "stage.failed", payload: { stage: payloadOf(e, "stage.started").stage, error } });
    // A sandbox still on record as up is gone by the time anyone closes the run from outside.
    if (e.type === "sandbox.started") drafts.push({ ...base(e), type: "sandbox.completed", payload: { exit_reason: "interrupted" } });
  }
  for (const e of open) if (e.type === "agent.started") drafts.push({ ...base(e), type: "agent.failed", payload: { error } });
  const run = events[0]!;
  const last = events[events.length - 1]!;
  // `run.failed` ends the run whether or not it ever started.
  drafts.push({ type: "run.failed", actor: "engine", spanId: run.spanId, payload: { error: { ...error, seq: last.seq } } });
  return drafts;
}

export type GateInput = { gate: string; decision: GateDecisionKind; notes?: string[] };

/** Answers the open review gate. A rejection ends the run in the same batch. */
export function decideGate(store: EventStore, runId: string, input: GateInput, deps: Deps = {}): Promise<RunState> {
  return write(store, runId, deps, (state, events) => {
    if (state.pendingGate !== input.gate) {
      throw new Error(state.pendingGate ? `Run ${runId} is waiting on the "${state.pendingGate}" review, not "${input.gate}".` : `Run ${runId} is not waiting on a review.`);
    }
    const decided: EventDraft = {
      type: "gate.decided",
      actor: "creator",
      spanId: state.runSpanId,
      payload: { gate: input.gate, decision: input.decision, notes: (input.notes ?? []).map((text) => ({ text })) },
    };
    if (input.decision !== "rejected") return [decided];
    return [decided, ...closeAll(events, "cancelled", `The "${input.gate}" review was rejected.`)];
  });
}

/** Raises or changes limits. A run paused on a budget also needs `requestResume`. */
export function updateBudget(store: EventStore, runId: string, limits: Limits, deps: Deps = {}): Promise<RunState> {
  return write(store, runId, deps, (state) => [
    { type: "budget.updated", actor: "creator", spanId: state.runSpanId, payload: { limits: limitsSchema.parse(limits) } },
  ]);
}

/** Lets a paused run be picked up again. */
export function requestResume(store: EventStore, runId: string, note?: string, deps: Deps = {}): Promise<RunState> {
  return write(store, runId, deps, (state) => {
    if (state.status !== "paused") return [];
    return [{ type: "run.resume_requested", actor: "creator", spanId: state.runSpanId, payload: note ? { note } : {} }];
  });
}

/** Asks a running run to stop at its next step. It can be resumed later. */
export function requestPause(store: EventStore, runId: string, note?: string, deps: Deps = {}): Promise<RunState> {
  return write(store, runId, deps, (state) => {
    if (state.status !== "running" || state.pauseRequested) return [];
    return [{ type: "run.pause_requested", actor: "creator", spanId: state.runSpanId, payload: note ? { note } : {} }];
  });
}

/**
 * Ends a run for good. A run that a worker is driving stops at its next step; one that is waiting, paused or
 * not yet started is closed here, in the same batch as the request.
 */
export function requestCancel(store: EventStore, runId: string, note?: string, deps: Deps = {}): Promise<RunState> {
  return write(store, runId, deps, (state, events) => {
    if (isTerminal(state.status) || state.cancelRequested) return [];
    const request: EventDraft = { type: "run.cancel_requested", actor: "creator", spanId: state.runSpanId, payload: note ? { note } : {} };
    if (state.status === "running") return [request];
    return [request, ...closeAll(events, "cancelled", "The run was cancelled.")];
  });
}
