import { payloadOf, type GateDecisionKind, type HarnessEvent, type Limits } from "./envelope.ts";

export type RunStatus = "created" | "running" | "waiting_gate" | "paused" | "succeeded" | "failed" | "cancelled";

/**
 * Where a run is, computed from its log. Mirrors the `runs` row in the database (status, budgets, clock), plus
 * what the loop needs to decide its next move. Nothing here is stored anywhere else: fold the log, get the state.
 */
export type RunState = {
  runId: string;
  status: RunStatus;
  statusReason?: string;
  pendingGate?: string;
  lastSeq: number;
  title: string;
  config: { model: string; system: string; max_output_tokens: number; effort?: string; pipeline?: string; sandbox_network?: "none" | "public" };
  task: string;
  limits: Limits;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  /** Time spent running, in closed intervals. Waiting at a gate or paused does not count. */
  activeMs: number;
  /** Start of the open running interval, if a worker is driving the run. */
  runningSince?: string;
  lastEventAt: string;
  failure?: { kind: string; message: string };
  /** Latest decision per gate, or "open" while it waits. */
  gates: Record<string, GateDecisionKind | "open">;
  pauseRequested: boolean;
  cancelRequested: boolean;
  runSpanId: string;
  /** The stage being worked on, while its span is open. */
  stage?: { name: string; revision: number; spanId: string };
  /** Latest revision started for each stage. */
  stageRevisions: Record<string, number>;
  /** Revisions of the edit that were started to act on a critique. Counted against `max_re_edits`. */
  reEdits: number;
};

export const isTerminal = (status: RunStatus) => status === "succeeded" || status === "failed" || status === "cancelled";

const ms = (iso: string) => new Date(iso).getTime();

function closeInterval(state: RunState, at: string): void {
  if (!state.runningSince) return;
  state.activeMs += Math.max(0, ms(at) - ms(state.runningSince));
  state.runningSince = undefined;
}

/** `(state, event) -> state`. Pure: no clock, no I/O. Unknown and plugin event types only advance `lastSeq`. */
export function reduce(prev: RunState | undefined, event: HarnessEvent): RunState {
  if (!prev) {
    if (event.type !== "run.created") throw new Error(`A run's log must start with run.created, not ${event.type}.`);
    const p = payloadOf(event, "run.created");
    return {
      runId: event.runId,
      status: "created",
      lastSeq: event.seq,
      title: p.title,
      config: p.config,
      task: p.brief.task,
      limits: p.limits,
      tokensIn: 0,
      tokensOut: 0,
      costMicroUsd: 0,
      activeMs: 0,
      lastEventAt: event.occurredAt,
      gates: {},
      pauseRequested: false,
      cancelRequested: false,
      runSpanId: event.spanId,
      stageRevisions: {},
      reEdits: 0,
    };
  }
  if (event.seq !== prev.lastSeq + 1) throw new Error(`Run ${prev.runId}: expected seq ${prev.lastSeq + 1}, got ${event.seq}.`);

  const state: RunState = { ...prev, gates: { ...prev.gates }, stageRevisions: { ...prev.stageRevisions }, lastSeq: event.seq };
  state.tokensIn += event.tokensIn ?? 0;
  state.tokensOut += event.tokensOut ?? 0;
  state.costMicroUsd += event.costMicroUsd ?? 0;

  switch (event.type) {
    case "run.started":
      state.status = "running";
      state.runningSince = event.occurredAt;
      break;
    case "run.resumed":
      // After a crash the open interval has no end: close it at the last event before the resume.
      closeInterval(state, prev.lastEventAt);
      state.status = "running";
      state.statusReason = undefined;
      state.runningSince = event.occurredAt;
      break;
    case "stage.started": {
      const p = payloadOf(event, "stage.started");
      state.stage = { name: p.stage, revision: p.revision, spanId: event.spanId };
      state.stageRevisions[p.stage] = p.revision;
      if (p.stage === "edit" && p.trigger === "critique") state.reEdits += 1;
      break;
    }
    case "stage.completed":
    case "stage.failed":
      if (state.stage?.spanId === event.spanId) state.stage = undefined;
      break;
    case "gate.opened": {
      const gate = payloadOf(event, "gate.opened").gate;
      state.status = "waiting_gate";
      state.pendingGate = gate;
      state.gates[gate] = "open";
      closeInterval(state, event.occurredAt);
      break;
    }
    case "gate.decided": {
      const p = payloadOf(event, "gate.decided");
      state.gates[p.gate] = p.decision;
      state.pendingGate = undefined;
      if (p.decision === "rejected") state.statusReason = "gate_rejected";
      else state.status = "running";
      break;
    }
    case "run.pause_requested":
      state.pauseRequested = true;
      break;
    case "run.cancel_requested":
      state.cancelRequested = true;
      break;
    case "run.paused":
      state.status = "paused";
      state.statusReason = payloadOf(event, "run.paused").reason;
      state.pauseRequested = false;
      closeInterval(state, event.occurredAt);
      break;
    case "run.resume_requested":
      if (state.status === "paused") {
        state.status = "running";
        state.statusReason = undefined;
      }
      break;
    case "budget.updated":
      state.limits = { ...state.limits, ...payloadOf(event, "budget.updated").limits };
      break;
    case "run.completed":
      state.status = "succeeded";
      closeInterval(state, event.occurredAt);
      break;
    case "run.failed": {
      const error = payloadOf(event, "run.failed").error;
      state.status = error.kind === "cancelled" ? "cancelled" : "failed";
      state.failure = { kind: error.kind, message: error.message };
      state.pendingGate = undefined;
      closeInterval(state, event.occurredAt);
      break;
    }
    default:
      break;
  }
  state.lastEventAt = event.occurredAt;
  return state;
}

export function foldRun(events: readonly HarnessEvent[]): RunState {
  let state: RunState | undefined;
  for (const e of events) state = reduce(state, e);
  if (!state) throw new Error("A run needs at least its run.created event.");
  return state;
}

/** Running time so far, including the interval that is still open. */
export function activeMsAt(state: RunState, now: Date): number {
  return state.activeMs + (state.runningSince ? Math.max(0, now.getTime() - ms(state.runningSince)) : 0);
}
