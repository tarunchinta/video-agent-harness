import type { HarnessEvent } from "@harness/harness";
import { compactedText, stageLabel, toolFamily, toolTitle, type ToolFamily } from "./describe.ts";

/**
 * The loop, as a ledger and a timeline: each step is one model response and the tool calls it asked for.
 * Retries are attempts inside a step. Stages and reviews are bands across the time axis. Pure, like every view.
 */

export type SpanKind = "model" | "tool" | "extract" | "stage" | "review" | "sandbox";
export type Outcome = "ok" | "failed" | "open";

export type TraceSpan = {
  id: string;
  kind: SpanKind;
  label: string;
  /** Tool name, model id, stage name or review name. */
  name: string;
  family?: ToolFamily;
  startSeq: number;
  endSeq?: number;
  start: number;
  end?: number;
  outcome: Outcome;
  error?: string;
  step?: number;
  attempt?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  costMicroUsd?: number;
  firstTokenMs?: number;
  stopReason?: string;
  agentId?: string;
  parentId?: string;
  /** The starting event and the closing one, for the inspector. */
  events: HarnessEvent[];
};

export type TraceStep = {
  step: number;
  /** Every attempt at this step's model call, the last one being the answer. */
  attempts: TraceSpan[];
  tools: TraceSpan[];
  stage?: string;
  stopReason?: string;
  start: number;
  end?: number;
  costMicroUsd: number;
  tokens: number;
  /** A note the harness added to the conversation before this step (a round, a warning). */
  notes: { kind?: string; text: string }[];
  /** The turn this step belongs to. A turn ends when the model stops without asking for tools. */
  turn: number;
};

export type Trajectory = {
  steps: TraceStep[];
  spans: TraceSpan[];
  stages: TraceSpan[];
  reviews: TraceSpan[];
  start: number;
  end: number;
  totals: { steps: number; modelCalls: number; retries: number; toolCalls: number; failedTools: number; turns: number; rounds: number; costMicroUsd: number; tokensIn: number; tokensOut: number; extractCalls: number };
};

type Payload = Record<string, unknown>;
const p = (e: HarnessEvent) => e.payload as Payload;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const t = (e: HarnessEvent) => new Date(e.occurredAt).getTime();

export function buildTrajectory(events: readonly HarnessEvent[]): Trajectory {
  const open = new Map<string, TraceSpan>();
  const spans: TraceSpan[] = [];
  const steps = new Map<number, TraceStep>();
  const callStep = new Map<string, number>();
  let stage: string | undefined;
  let turn = 1;
  let pendingNotes: TraceStep["notes"] = [];
  let lastStep: TraceStep | undefined;
  let rounds = 0;

  const begin = (e: HarnessEvent, span: Omit<TraceSpan, "id" | "startSeq" | "start" | "outcome" | "events">) => {
    const s: TraceSpan = { id: e.spanId, startSeq: e.seq, start: t(e), outcome: "open", events: [e], ...span };
    open.set(e.spanId, s);
    spans.push(s);
    return s;
  };
  const close = (e: HarnessEvent) => {
    const s = open.get(e.spanId);
    if (!s) return undefined;
    open.delete(e.spanId);
    s.end = t(e);
    s.endSeq = e.seq;
    s.events.push(e);
    s.outcome = e.type.endsWith(".failed") ? "failed" : "ok";
    if (s.outcome === "failed") s.error = str((p(e).error as Payload | undefined)?.kind) ?? "error";
    s.tokensIn = e.tokensIn ?? s.tokensIn;
    s.tokensOut = e.tokensOut ?? s.tokensOut;
    s.costMicroUsd = e.costMicroUsd ?? s.costMicroUsd;
    return s;
  };

  for (const e of events) {
    const payload = p(e);
    switch (e.type) {
      case "stage.started": {
        stage = str(payload.stage);
        begin(e, { kind: "stage", name: stage ?? "stage", label: stageLabel(stage ?? "stage", num(payload.revision) ?? 1, str(payload.trigger)) });
        break;
      }
      case "stage.completed":
      case "stage.failed":
        close(e);
        stage = undefined;
        break;
      case "sandbox.started":
        begin(e, { kind: "sandbox", name: str(payload.image) ?? "sandbox", label: "Sandbox up" });
        break;
      case "sandbox.completed":
        close(e);
        break;
      case "gate.opened": {
        const gate = str(payload.gate) ?? "review";
        // A review's span is the wait for you, closed by your decision.
        const s: TraceSpan = { id: `gate-${e.seq}`, kind: "review", name: gate, label: `Waiting for your review of the ${gate === "final_cut" ? "final cut" : gate}`, startSeq: e.seq, start: t(e), outcome: "open", events: [e] };
        spans.push(s);
        open.set(`gate:${gate}`, s);
        break;
      }
      case "gate.decided": {
        const gate = str(payload.gate) ?? "review";
        const s = open.get(`gate:${gate}`);
        if (s) {
          open.delete(`gate:${gate}`);
          s.end = t(e);
          s.endSeq = e.seq;
          s.events.push(e);
          s.outcome = str(payload.decision) === "rejected" ? "failed" : "ok";
          s.label = `Your review of the ${gate === "final_cut" ? "final cut" : gate}: ${(str(payload.decision) ?? "").replaceAll("_", " ")}`;
        }
        break;
      }
      case "context.message": {
        if (e.agentId && e.agentId !== "main") break;
        const kind = str(payload.kind);
        if (kind?.startsWith("round")) rounds += 1;
        pendingNotes.push({ ...(kind ? { kind } : {}), text: str(payload.content) ?? "" });
        break;
      }
      case "context.compacted": {
        if (e.agentId && e.agentId !== "main") break;
        pendingNotes.push({ kind: "compacted", text: compactedText(payload) });
        break;
      }
      case "model.call.started": {
        const extract = e.agentId !== "main";
        const stepNo = num(payload.step);
        const s = begin(e, {
          kind: extract ? "extract" : "model",
          name: str(payload.model) ?? "model",
          label: extract
            ? str(payload.purpose) === "compact"
              ? "Summarised the conversation to save space"
              : str(payload.purpose) === "critique"
                ? "Reviewed the work with no tools"
                : "Read untrusted text with no tools"
            : `Model call${(num(payload.attempt) ?? 1) > 1 ? `, attempt ${num(payload.attempt)}` : ""}`,
          ...(stepNo !== undefined ? { step: stepNo } : {}),
          attempt: num(payload.attempt) ?? 1,
          ...(e.agentId ? { agentId: e.agentId } : {}),
          ...(e.parentSpanId ? { parentId: e.parentSpanId } : {}),
        });
        if (!extract && stepNo !== undefined) {
          let st = steps.get(stepNo);
          if (!st) {
            st = { step: stepNo, attempts: [], tools: [], ...(stage ? { stage } : {}), start: s.start, costMicroUsd: 0, tokens: 0, notes: pendingNotes, turn };
            pendingNotes = [];
            steps.set(stepNo, st);
          }
          st.attempts.push(s);
          lastStep = st;
        }
        break;
      }
      case "model.call.completed": {
        const s = close(e);
        if (!s) break;
        const usage = (payload.usage ?? {}) as Payload;
        s.stopReason = str(payload.stop_reason);
        s.firstTokenMs = num(payload.first_token_ms);
        s.cacheRead = num(usage.cache_read_tokens);
        if (s.kind !== "model" || s.step === undefined) break;
        const st = steps.get(s.step);
        if (st) {
          st.stopReason = s.stopReason;
          const content = Array.isArray(payload.content) ? (payload.content as Payload[]) : [];
          for (const b of content) if (b.type === "tool_call" && typeof b.id === "string") callStep.set(b.id, s.step);
          if (s.stopReason === "end_turn") turn += 1;
        }
        break;
      }
      case "model.call.failed":
        close(e);
        break;
      case "tool.call.started": {
        const tool = str(payload.tool) ?? "tool";
        const callId = str(payload.tool_call_id) ?? "";
        const stepNo = callStep.get(callId) ?? lastStep?.step;
        const s = begin(e, { kind: "tool", name: tool, family: toolFamily(tool), label: toolTitle(tool, payload.input), ...(stepNo !== undefined ? { step: stepNo } : {}), ...(e.agentId ? { agentId: e.agentId } : {}) });
        if (stepNo !== undefined) steps.get(stepNo)?.tools.push(s);
        break;
      }
      case "tool.call.completed":
      case "tool.call.failed":
        close(e);
        break;
      default:
        break;
    }
  }

  const start = events.length ? t(events[0]!) : 0;
  const end = events.length ? t(events[events.length - 1]!) : 0;
  const stepList = [...steps.values()].sort((a, b) => a.step - b.step);
  for (const st of stepList) {
    const all = [...st.attempts, ...st.tools];
    const ends = all.map((s) => s.end ?? s.start);
    st.end = Math.max(st.start, ...ends);
    st.costMicroUsd = all.reduce((sum, s) => sum + (s.costMicroUsd ?? 0), 0);
    st.tokens = all.reduce((sum, s) => sum + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);
  }
  const model = spans.filter((s) => s.kind === "model");
  const tools = spans.filter((s) => s.kind === "tool");
  return {
    steps: stepList,
    spans,
    stages: spans.filter((s) => s.kind === "stage"),
    reviews: spans.filter((s) => s.kind === "review"),
    start,
    end,
    totals: {
      steps: stepList.length,
      modelCalls: model.length,
      retries: model.filter((s) => (s.attempt ?? 1) > 1).length,
      toolCalls: tools.length,
      failedTools: tools.filter((s) => s.outcome === "failed").length,
      turns: stepList.length ? stepList[stepList.length - 1]!.turn : 0,
      rounds,
      costMicroUsd: events.reduce((sum, e) => sum + (e.costMicroUsd ?? 0), 0),
      tokensIn: events.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0),
      tokensOut: events.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0),
      extractCalls: spans.filter((s) => s.kind === "extract").length,
    },
  };
}

/**
 * Maps time onto a line where long idle stretches (waiting for a review, a paused run) are squeezed to a
 * fixed width, so the work stays readable. Returns positions from 0 to 1 and the breaks to draw.
 */
export function timeScale(spans: readonly { start: number; end?: number }[], from: number, to: number, idleMs = 30_000) {
  type Segment = { start: number; end: number };
  const busy: Segment[] = spans
    .map((s) => ({ start: s.start, end: Math.max(s.start, s.end ?? to) }))
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const s of busy) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + idleMs) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  // Squeezed gaps count as this much time each.
  const gapWeight = idleMs;
  const pieces: { start: number; end: number; weight: number; gap: boolean }[] = [];
  let cursor = from;
  for (const m of merged) {
    if (m.start > cursor) pieces.push({ start: cursor, end: m.start, weight: m.start - cursor > idleMs ? gapWeight : m.start - cursor, gap: m.start - cursor > idleMs });
    pieces.push({ start: Math.max(cursor, m.start), end: m.end, weight: Math.max(0, m.end - Math.max(cursor, m.start)), gap: false });
    cursor = Math.max(cursor, m.end);
  }
  if (to > cursor) pieces.push({ start: cursor, end: to, weight: to - cursor > idleMs ? gapWeight : to - cursor, gap: to - cursor > idleMs });
  const total = pieces.reduce((sum, piece) => sum + piece.weight, 0) || 1;
  const offsets: number[] = [];
  let acc = 0;
  for (const piece of pieces) {
    offsets.push(acc);
    acc += piece.weight;
  }
  const at = (time: number): number => {
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      if (time <= piece.end || i === pieces.length - 1) {
        const span = piece.end - piece.start || 1;
        const within = Math.min(1, Math.max(0, (time - piece.start) / span));
        return (offsets[i]! + within * piece.weight) / total;
      }
    }
    return 1;
  };
  const breaks = pieces
    .map((piece, i) => ({ piece, i }))
    .filter(({ piece }) => piece.gap)
    .map(({ piece, i }) => ({ x: offsets[i]! / total, width: piece.weight / total, ms: piece.end - piece.start }));
  return { at, breaks };
}
