import { payloadOf, type HarnessEvent } from "./events/envelope.ts";
import { foldRun, type RunStatus } from "./events/reducer.ts";

export type SpanRow = {
  seq: number;
  kind: "model" | "tool" | "stage";
  /** Model id, tool name, or the stage and its revision. */
  name: string;
  outcome: "ok" | "failed" | "open";
  /** Error kind when the span failed. */
  error?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costMicroUsd?: number;
};

export type RunSummary = {
  runId: string;
  title: string;
  status: RunStatus;
  reason?: string;
  failure?: { kind: string; message: string };
  events: number;
  modelCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  activeMs: number;
  /** When the provider's price table was last checked, if it said. */
  pricesCheckedOn?: string;
  /** Set when that was long enough before the run that its cost figures may be off. */
  pricesStale?: boolean;
  rows: SpanRow[];
};

/** A price table this much older than the run it priced is worth checking again. */
export const PRICES_STALE_DAYS = 90;

/** What a run did and what it cost, read from its log alone. */
export function summarizeRun(events: readonly HarnessEvent[]): RunSummary {
  const state = foldRun(events);
  const closers = new Map<string, HarnessEvent>();
  for (const e of events) if (e.type.endsWith(".completed") || e.type.endsWith(".failed")) closers.set(e.spanId, e);

  const rows: SpanRow[] = [];
  for (const e of events) {
    if (e.type === "stage.started") {
      const p = payloadOf(e, "stage.started");
      const end = closers.get(e.spanId);
      rows.push({
        seq: e.seq,
        kind: "stage",
        name: p.revision > 1 ? `${p.stage}, revision ${p.revision} (${p.trigger})` : p.stage,
        outcome: !end ? "open" : end.type.endsWith(".failed") ? "failed" : "ok",
        ...(end ? { durationMs: Math.max(0, new Date(end.occurredAt).getTime() - new Date(e.occurredAt).getTime()) } : {}),
      });
      continue;
    }
    if (e.type !== "model.call.started" && e.type !== "tool.call.started") continue;
    const end = closers.get(e.spanId);
    const failed = end?.type.endsWith(".failed");
    rows.push({
      seq: e.seq,
      kind: e.type === "model.call.started" ? "model" : "tool",
      name: e.type === "model.call.started" ? payloadOf(e, "model.call.started").model : payloadOf(e, "tool.call.started").tool,
      outcome: !end ? "open" : failed ? "failed" : "ok",
      ...(failed ? { error: (end!.payload.error as { kind?: string } | undefined)?.kind } : {}),
      ...(end ? { durationMs: Math.max(0, new Date(end.occurredAt).getTime() - new Date(e.occurredAt).getTime()) } : {}),
      ...(end?.tokensIn !== undefined ? { tokensIn: end.tokensIn } : {}),
      ...(end?.tokensOut !== undefined ? { tokensOut: end.tokensOut } : {}),
      ...(end?.costMicroUsd !== undefined ? { costMicroUsd: end.costMicroUsd } : {}),
    });
  }
  return {
    runId: state.runId,
    title: state.title,
    status: state.status,
    ...(state.statusReason ? { reason: state.statusReason } : {}),
    ...(state.failure ? { failure: state.failure } : {}),
    events: events.length,
    modelCalls: rows.filter((r) => r.kind === "model").length,
    toolCalls: rows.filter((r) => r.kind === "tool").length,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    costMicroUsd: state.costMicroUsd,
    activeMs: state.activeMs,
    ...pricing(events),
    rows,
  };
}

function pricing(events: readonly HarnessEvent[]): Pick<RunSummary, "pricesCheckedOn" | "pricesStale"> {
  const started = events.find((e) => e.type === "agent.started");
  const checked = (started?.payload as { prices_checked_on?: unknown } | undefined)?.prices_checked_on;
  if (typeof checked !== "string" || Number.isNaN(Date.parse(checked))) return {};
  const ageDays = (Date.parse(started!.occurredAt) - Date.parse(checked)) / 86_400_000;
  return { pricesCheckedOn: checked, ...(ageDays > PRICES_STALE_DAYS ? { pricesStale: true } : {}) };
}
