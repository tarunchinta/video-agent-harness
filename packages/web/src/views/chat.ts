import type { HarnessEvent } from "@harness/harness";
import { compactedText, decisionPhrase, gateName, stageLabel, toolFamily, toolTitle, type ToolFamily } from "./describe.ts";

/**
 * The run as a conversation: the brief, what the agent said, the tools it called (grouped by the step that
 * asked for them), the stages, and the reviews with your answers. A pure fold over the log.
 */

export type ImageRef = { sha256: string; mediaType: string; bytes: number };

export type ToolCallView = {
  callId: string;
  tool: string;
  title: string;
  family: ToolFamily;
  input: unknown;
  /** `waiting` is a call that opened a review and is waiting for your answer. */
  status: "queued" | "running" | "ok" | "failed" | "waiting";
  output?: string;
  error?: { kind: string; message: string };
  images: ImageRef[];
  durationMs?: number;
  truncated: boolean;
  outputPath?: string;
  startedSeq?: number;
  endSeq?: number;
  /** Tool-less model calls the tool made to read untrusted text, such as a fetched page. */
  extractCalls: number;
  /** The review this call opened, and how it was answered. */
  gate?: string;
};

export type ChatItem =
  | { kind: "brief"; key: string; seq: number; at: string; title: string; task: string; model: string; project?: string }
  | { kind: "assistant"; key: string; seq: number; at: string; text: string; step?: number }
  | { kind: "thinking"; key: string; seq: number; text: string }
  | { kind: "tools"; key: string; seq: number; step?: number; calls: ToolCallView[] }
  | { kind: "stage"; key: string; seq: number; at: string; stage: string; revision: number; trigger: string; label: string }
  | {
      kind: "review";
      key: string;
      seq: number;
      at: string;
      gate: string;
      files: string[];
      note?: string;
      words?: number;
      estimatedSeconds?: number;
      revision?: number;
      sha256?: string;
      bytes?: number;
      /** Set once you answered it. */
      decision?: { decision: string; notes: string[]; seq: number; at: string };
    }
  | { kind: "decision"; key: string; seq: number; at: string; gate: string; decision: string; notes: string[]; text: string }
  | { kind: "note"; key: string; seq: number; at: string; text: string; tone: "info" | "warn" | "error"; detail?: string };

type Payload = Record<string, unknown>;
const p = (e: HarnessEvent) => e.payload as Payload;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/** Readable text inside a provider's opaque block (a thinking summary), if it has any. */
function opaqueText(block: Payload): string | undefined {
  const data = block.data as Payload | undefined;
  const candidates = [block.text, block.thinking, block.summary, data?.thinking, data?.summary, data?.text];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim();
  return undefined;
}

export function buildChat(events: readonly HarnessEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, ToolCallView>();
  const bySpan = new Map<string, ToolCallView>();
  const spanCalls = new Map<string, ToolCallView>();
  const reviews = new Map<string, Extract<ChatItem, { kind: "review" }>>();
  let lastReview: Extract<ChatItem, { kind: "review" }> | undefined;
  let step: number | undefined;

  const callFor = (callId: string, tool: string, input: unknown): ToolCallView => {
    let call = calls.get(callId);
    if (!call) {
      call = { callId, tool, title: toolTitle(tool, input), family: toolFamily(tool), input, status: "queued", images: [], truncated: false, extractCalls: 0 };
      calls.set(callId, call);
    }
    return call;
  };

  for (const e of events) {
    const payload = p(e);
    switch (e.type) {
      case "run.created": {
        const brief = (payload.brief ?? {}) as Payload;
        const config = (payload.config ?? {}) as Payload;
        items.push({
          kind: "brief",
          key: `brief-${e.seq}`,
          seq: e.seq,
          at: e.occurredAt,
          title: str(payload.title) ?? "Untitled run",
          task: str(brief.task) ?? "",
          model: str(config.model) ?? "",
          ...(str(brief.project) ? { project: str(brief.project)! } : {}),
        });
        break;
      }
      case "model.call.started":
        if (e.agentId === "main") step = num(payload.step) ?? step;
        else if (e.parentSpanId) {
          const owner = spanCalls.get(e.parentSpanId);
          if (owner) owner.extractCalls += 1;
        }
        break;
      case "model.call.completed": {
        if (e.agentId !== "main") break;
        const content = Array.isArray(payload.content) ? (payload.content as Payload[]) : [];
        for (const block of content) {
          if (block.type === "opaque") {
            const text = opaqueText(block);
            if (text) items.push({ kind: "thinking", key: `think-${e.seq}-${items.length}`, seq: e.seq, text });
          }
        }
        const text = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => (b.text as string).trim())
          .filter(Boolean)
          .join("\n\n");
        if (text) items.push({ kind: "assistant", key: `say-${e.seq}`, seq: e.seq, at: e.occurredAt, text, ...(step !== undefined ? { step } : {}) });
        const asked = content.filter((b) => b.type === "tool_call" && typeof b.id === "string");
        if (asked.length) {
          items.push({
            kind: "tools",
            key: `tools-${e.seq}`,
            seq: e.seq,
            ...(step !== undefined ? { step } : {}),
            calls: asked.map((b) => callFor(b.id as string, str(b.name) ?? "tool", b.input)),
          });
        }
        break;
      }
      case "model.call.failed": {
        if (e.agentId !== "main") break;
        const error = (payload.error ?? {}) as Payload;
        const kind = str(error.kind);
        if (kind === "cancelled" || kind === "interrupted") break;
        const wait = num(payload.retry_in_ms);
        items.push({
          kind: "note",
          key: `mfail-${e.seq}`,
          seq: e.seq,
          at: e.occurredAt,
          tone: wait !== undefined ? "warn" : "error",
          text: `The model call did not go through${wait !== undefined ? `; trying again in ${Math.max(1, Math.round(wait / 1000))} s` : ""}.`,
          ...(str(error.message) ? { detail: str(error.message)! } : {}),
        });
        break;
      }
      case "tool.call.started": {
        const call = callFor(str(payload.tool_call_id) ?? e.spanId, str(payload.tool) ?? "tool", payload.input);
        call.status = "running";
        call.startedSeq = e.seq;
        call.input = payload.input;
        call.title = toolTitle(call.tool, payload.input);
        bySpan.set(e.spanId, call);
        spanCalls.set(e.spanId, call);
        break;
      }
      case "tool.call.completed": {
        const call = calls.get(str(payload.tool_call_id) ?? "") ?? bySpan.get(e.spanId);
        if (!call) break;
        call.status = "ok";
        call.output = str(payload.output) ?? "";
        call.truncated = payload.truncated === true;
        if (str(payload.output_path)) call.outputPath = str(payload.output_path)!;
        const duration = num(payload.duration_ms);
        if (duration !== undefined) call.durationMs = duration;
        call.endSeq = e.seq;
        if (Array.isArray(payload.images)) {
          call.images = (payload.images as Payload[])
            .filter((i) => typeof i.sha256 === "string")
            .map((i) => ({ sha256: i.sha256 as string, mediaType: str(i.media_type) ?? "image/jpeg", bytes: num(i.bytes) ?? 0 }));
        }
        break;
      }
      case "tool.call.failed": {
        const call = calls.get(str(payload.tool_call_id) ?? "") ?? bySpan.get(e.spanId);
        if (!call) break;
        const error = (payload.error ?? {}) as Payload;
        call.status = "failed";
        call.error = { kind: str(error.kind) ?? "error", message: str(error.message) ?? "The call failed." };
        call.endSeq = e.seq;
        break;
      }
      case "stage.started": {
        const stage = str(payload.stage) ?? "stage";
        const revision = num(payload.revision) ?? 1;
        const trigger = str(payload.trigger) ?? "plan";
        items.push({ kind: "stage", key: `stage-${e.seq}`, seq: e.seq, at: e.occurredAt, stage, revision, trigger, label: stageLabel(stage, revision, trigger) });
        break;
      }
      case "gate.opened": {
        const gate = str(payload.gate) ?? "review";
        const review: Extract<ChatItem, { kind: "review" }> = {
          kind: "review",
          key: `gate-${e.seq}`,
          seq: e.seq,
          at: e.occurredAt,
          gate,
          files: Array.isArray(payload.files) ? payload.files.filter((f): f is string => typeof f === "string") : [],
          ...(str(payload.note) ? { note: str(payload.note)! } : {}),
          ...(num(payload.words) !== undefined ? { words: num(payload.words)! } : {}),
          ...(num(payload.estimated_seconds) !== undefined ? { estimatedSeconds: num(payload.estimated_seconds)! } : {}),
          ...(num(payload.revision) !== undefined ? { revision: num(payload.revision)! } : {}),
          ...(str(payload.sha256) ? { sha256: str(payload.sha256)! } : {}),
          ...(num(payload.bytes) !== undefined ? { bytes: num(payload.bytes)! } : {}),
        };
        const callId = str(payload.tool_call_id);
        if (callId) {
          const call = calls.get(callId);
          if (call) {
            call.status = "waiting";
            call.gate = gate;
          }
        }
        reviews.set(gate, review);
        lastReview = review;
        items.push(review);
        break;
      }
      case "gate.decided": {
        const gate = str(payload.gate) ?? "review";
        const decision = str(payload.decision) ?? "approved";
        const notes = Array.isArray(payload.notes) ? (payload.notes as Payload[]).map((n) => str(n.text)).filter((t): t is string => Boolean(t)) : [];
        const review = reviews.get(gate) ?? lastReview;
        if (review && !review.decision) review.decision = { decision, notes, seq: e.seq, at: e.occurredAt };
        items.push({ kind: "decision", key: `dec-${e.seq}`, seq: e.seq, at: e.occurredAt, gate, decision, notes, text: `You ${decisionPhrase(decision)} the ${gateName(gate)}.` });
        break;
      }
      case "context.message": {
        if (str(payload.origin) !== "engine") break;
        items.push({ kind: "note", key: `ctx-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "info", text: `The harness told the agent: ${str(payload.content) ?? ""}` });
        break;
      }
      case "context.compacted": {
        if (e.agentId && e.agentId !== "main") break;
        items.push({ kind: "note", key: `compact-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "info", text: compactedText(payload) });
        break;
      }
      case "budget.exceeded": {
        const dimension = (str(payload.dimension) ?? "budget").replaceAll("_", " ");
        items.push({ kind: "note", key: `budget-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "warn", text: `Reached the ${dimension} limit.` });
        break;
      }
      case "run.paused": {
        const reason = str(payload.reason) ?? "";
        const detail = str(payload.detail);
        const text =
          reason === "creator" ? "Paused, as you asked." : reason.startsWith("budget:") ? "Paused at a limit. Raise it to carry on." : reason === "error:sandbox" ? "Paused: the sandbox could not be started." : reason.startsWith("error:") ? "Paused: the model could not be reached." : "Paused.";
        items.push({ kind: "note", key: `pause-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "warn", text, ...(detail ? { detail } : {}) });
        break;
      }
      case "run.resumed": {
        const reason = str(payload.reason);
        const why = reason === "crash" ? "after it was interrupted" : reason === "gate" ? "after your review" : "after the pause";
        items.push({ kind: "note", key: `resume-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "info", text: `Picked the run back up ${why}.` });
        break;
      }
      case "run.completed":
        items.push({ kind: "note", key: `done-${e.seq}`, seq: e.seq, at: e.occurredAt, tone: "info", text: "The run is done." });
        break;
      case "run.failed": {
        const error = (payload.error ?? {}) as Payload;
        const cancelled = str(error.kind) === "cancelled";
        items.push({
          kind: "note",
          key: `fail-${e.seq}`,
          seq: e.seq,
          at: e.occurredAt,
          tone: cancelled ? "warn" : "error",
          text: cancelled ? `Cancelled. ${str(error.message) ?? ""}`.trim() : `Stopped: ${str(error.message) ?? "the run failed."}`,
        });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** The finished result the agent handed to `finish`, if the run has one. */
export function finishResult(events: readonly HarnessEvent[]): { summary?: string; film?: string } | undefined {
  const done = events.findLast((e) => e.type === "agent.completed" && e.agentId === "main");
  const result = done ? ((done.payload as Payload).result as Payload | null) : undefined;
  if (!result || typeof result !== "object") return undefined;
  return { ...(str(result.summary) ? { summary: str(result.summary)! } : {}), ...(str(result.film) ? { film: str(result.film)! } : {}) };
}
