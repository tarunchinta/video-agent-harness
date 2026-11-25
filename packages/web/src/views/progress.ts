import type { HarnessEvent, RunState } from "@harness/harness";

/** Where a reel is in its four stages and two reviews, and how much of each limit it has used. */

export type StepState = "todo" | "active" | "waiting" | "done" | "failed";
export type ProgressStep = { id: string; label: string; state: StepState; revisions: number; kind: "stage" | "review" };

const REEL: { id: string; label: string; kind: "stage" | "review" }[] = [
  { id: "research", label: "Research", kind: "stage" },
  { id: "script", label: "Script", kind: "stage" },
  { id: "gate:script", label: "Your review", kind: "review" },
  { id: "assets", label: "Voiceover", kind: "stage" },
  { id: "edit", label: "Edit", kind: "stage" },
  { id: "gate:final_cut", label: "Final review", kind: "review" },
];

export function reelProgress(events: readonly HarnessEvent[], state: RunState): ProgressStep[] {
  const started = new Map<string, number>();
  const finished = new Set<string>();
  for (const e of events) {
    const stage = (e.payload as { stage?: unknown }).stage;
    if (typeof stage !== "string") continue;
    if (e.type === "stage.started") started.set(stage, Math.max(started.get(stage) ?? 0, Number((e.payload as { revision?: unknown }).revision ?? 1)));
    if (e.type === "stage.completed") finished.add(stage);
  }
  const ended = state.status === "succeeded" || state.status === "failed" || state.status === "cancelled";
  return REEL.map((step) => {
    if (step.kind === "review") {
      const gate = step.id.slice(5);
      const decision = state.gates[gate];
      const s: StepState =
        decision === "approved" ? "done" : decision === "open" ? "waiting" : decision === "rejected" ? "failed" : "todo";
      const revisions = events.filter((e) => e.type === "gate.opened" && (e.payload as { gate?: unknown }).gate === gate).length;
      return { ...step, state: s, revisions };
    }
    const revisions = started.get(step.id) ?? 0;
    const active = state.stage?.name === step.id;
    let s: StepState = active ? (ended ? "failed" : "active") : revisions ? "done" : "todo";
    if (!active && revisions && !finished.has(step.id)) s = state.status === "succeeded" ? "done" : "failed";
    return { ...step, state: s, revisions };
  });
}

export type Meter = { id: string; label: string; used: number; limit?: number; text: string; ratio?: number };

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);
const ratio = (used: number, limit?: number) => (limit ? Math.min(1, used / limit) : undefined);

/** Usage against the run's limits. `steps` comes from the log because the state does not count them. */
export function meters(state: RunState, events: readonly HarnessEvent[], now: number): Meter[] {
  const steps = new Set(
    events.filter((e) => e.type === "model.call.started" && e.agentId === "main").map((e) => (e.payload as { step?: unknown }).step),
  ).size;
  const active = state.activeMs + (state.runningSince ? Math.max(0, now - new Date(state.runningSince).getTime()) : 0);
  const tokens = state.tokensIn + state.tokensOut;
  const l = state.limits;
  const list: Meter[] = [
    { id: "cost", label: "Cost", used: state.costMicroUsd, ...(l.max_cost_micro_usd ? { limit: l.max_cost_micro_usd } : {}), text: `${usd(state.costMicroUsd)}${l.max_cost_micro_usd ? ` of ${usd(l.max_cost_micro_usd)}` : ""}` },
    { id: "tokens", label: "Tokens", used: tokens, ...(l.max_tokens ? { limit: l.max_tokens } : {}), text: `${tokens.toLocaleString("en-US")}${l.max_tokens ? ` of ${l.max_tokens.toLocaleString("en-US")}` : ""}` },
    { id: "time", label: "Working time", used: active, ...(l.max_active_ms ? { limit: l.max_active_ms } : {}), text: `${mins(active)}${l.max_active_ms ? ` of ${mins(l.max_active_ms)}` : ""}` },
    { id: "steps", label: "Steps", used: steps, ...(l.max_steps ? { limit: l.max_steps } : {}), text: `${steps}${l.max_steps ? ` of ${l.max_steps}` : ""}` },
  ];
  if (state.config.pipeline === "reel" || l.max_re_edits !== undefined) {
    list.push({ id: "re_edits", label: "Own revisions", used: state.reEdits, ...(l.max_re_edits !== undefined ? { limit: l.max_re_edits } : {}), text: `${state.reEdits}${l.max_re_edits !== undefined ? ` of ${l.max_re_edits}` : ""}` });
  }
  return list.map((m) => ({ ...m, ...(ratio(m.used, m.limit) !== undefined ? { ratio: ratio(m.used, m.limit)! } : {}) }));
}
