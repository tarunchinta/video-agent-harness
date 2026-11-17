import { payloadOf, type HarnessEvent } from "./events/envelope.ts";
import type { ContentBlock, Message, ModelRequest, ToolCallBlock, ToolResultBlock, ToolSpec, Usage } from "./model/types.ts";
import { canonicalJson, sha256 } from "./util.ts";

/** One agent's conversation and progress, computed from its events. */
export type AgentContext = {
  agentId: string;
  /** The agent's span, set once `agent.started` is seen. */
  spanId?: string;
  model: string;
  system: string;
  toolSpecs: ToolSpec[];
  messages: Message[];
  /** Last event this context includes. */
  throughSeq: number;
  /** Tool calls the model asked for that have no result yet, in the model's order. */
  unanswered: ToolCallBlock[];
  /** `tool.call.started` events whose span is still open, by tool call id. */
  openToolCalls: Map<string, HarnessEvent>;
  /** `model.call.started` events whose span is still open. */
  openModelCalls: HarnessEvent[];
  /** The agent's span has closed. */
  finished: boolean;
  /** The model stopped without asking for tools, and nothing has been said to it since. */
  turnEnded: boolean;
  /** Stop reason of the latest model response. */
  lastStop?: string;
  /** Model responses so far. */
  steps: number;
  /** Turns the harness opened because the objective was not met. */
  rounds: number;
  lastUsage?: Usage;
  /** Text added to the conversation since `lastUsage` was measured, in characters. */
  charsSinceUsage: number;
  /** Kinds of harness notes already sent, so each warning is sent once. */
  noteKinds: Set<string>;
  /** Pictures in the conversation so far. */
  images: number;
};

/** What a picture is assumed to cost until the provider reports the real prompt size: about 1,700 tokens. */
const IMAGE_CHARS = 6_000;

export class ContextTrustError extends Error {
  constructor(seq: number) {
    super(`Event ${seq} carries untrusted content and cannot enter the context of an agent that has tools.`);
    this.name = "ContextTrustError";
  }
}

/**
 * Builds what an agent's model sees from the log. Three kinds of event produce messages: the task on
 * `agent.started`, `context.message`, and the model's own responses with the results of the tools it called.
 * Everything else is a record. The result is a pure function of the events, so the same log always gives the
 * same request.
 */
export function deriveContext(events: readonly HarnessEvent[], agentId: string): AgentContext {
  const ctx: AgentContext = {
    agentId,
    model: "",
    system: "",
    toolSpecs: [],
    messages: [],
    throughSeq: 0,
    unanswered: [],
    openToolCalls: new Map(),
    openModelCalls: [],
    finished: false,
    turnEnded: false,
    steps: 0,
    rounds: 0,
    charsSinceUsage: 0,
    noteKinds: new Set(),
    images: 0,
  };
  // Results of one response's tool calls go back together, in the order the model asked, in a single message.
  let pending: { calls: ToolCallBlock[]; results: Map<string, ToolResultBlock> } | undefined;
  let queued: Message[] = [];

  const settle = (id: string, result: ToolResultBlock) => {
    ctx.openToolCalls.delete(id);
    if (!pending || !pending.calls.some((c) => c.id === id)) return;
    pending.results.set(id, result);
    ctx.charsSinceUsage += result.content.length + (result.images?.length ?? 0) * IMAGE_CHARS;
    ctx.images += result.images?.length ?? 0;
    if (pending.results.size < pending.calls.length) return;
    ctx.messages.push({ role: "user", content: pending.calls.map((c) => pending!.results.get(c.id)!) });
    ctx.messages.push(...queued);
    pending = undefined;
    queued = [];
  };

  for (const e of events) {
    if (e.agentId !== agentId) continue;
    ctx.throughSeq = e.seq;
    switch (e.type) {
      case "agent.started": {
        const p = payloadOf(e, "agent.started");
        ctx.spanId = e.spanId;
        ctx.model = p.model;
        ctx.system = p.system_prompt;
        ctx.toolSpecs = p.tool_specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
        ctx.messages.push({ role: "user", content: [{ type: "text", text: p.task }] });
        break;
      }
      case "agent.completed":
      case "agent.failed":
        ctx.finished = true;
        break;
      case "context.message": {
        const p = payloadOf(e, "context.message");
        const message: Message = { role: "user", content: [{ type: "text", text: p.content }] };
        // Never between a tool call and its result: hold the note until the results are in.
        if (pending) queued.push(message);
        else ctx.messages.push(message);
        ctx.turnEnded = false;
        ctx.charsSinceUsage += p.content.length;
        if (p.kind) ctx.noteKinds.add(p.kind);
        if (p.kind === "round") ctx.rounds += 1;
        break;
      }
      case "model.call.started":
        ctx.openModelCalls.push(e);
        break;
      case "model.call.failed":
        ctx.openModelCalls = ctx.openModelCalls.filter((s) => s.spanId !== e.spanId);
        break;
      case "model.call.completed": {
        const p = payloadOf(e, "model.call.completed");
        ctx.openModelCalls = ctx.openModelCalls.filter((s) => s.spanId !== e.spanId);
        const content = p.content as unknown as ContentBlock[];
        const calls = content.filter((b): b is ToolCallBlock => b.type === "tool_call");
        // A response with no content still happened and was billed, but it is not a message.
        if (content.length) ctx.messages.push({ role: "assistant", content });
        if (calls.length) pending = { calls, results: new Map() };
        ctx.steps += 1;
        ctx.lastStop = p.stop_reason;
        ctx.turnEnded = calls.length === 0;
        ctx.lastUsage = {
          inputTokens: p.usage.input_tokens,
          outputTokens: p.usage.output_tokens,
          cacheReadTokens: p.usage.cache_read_tokens,
          cacheWriteTokens: p.usage.cache_write_tokens,
        };
        ctx.charsSinceUsage = 0;
        break;
      }
      case "tool.call.started":
        ctx.openToolCalls.set(payloadOf(e, "tool.call.started").tool_call_id, e);
        break;
      case "tool.call.completed": {
        if (e.untrusted) throw new ContextTrustError(e.seq);
        const p = payloadOf(e, "tool.call.completed");
        const images = p.images?.map((i) => ({ type: "image" as const, mediaType: i.media_type, sha256: i.sha256 }));
        settle(p.tool_call_id, { type: "tool_result", toolCallId: p.tool_call_id, content: p.output, ...(images?.length ? { images } : {}) });
        break;
      }
      case "tool.call.failed": {
        const p = payloadOf(e, "tool.call.failed");
        settle(p.tool_call_id, { type: "tool_result", toolCallId: p.tool_call_id, content: p.error.message, isError: true });
        break;
      }
      default:
        break;
    }
  }
  if (pending) ctx.unanswered = pending.calls.filter((c) => !pending!.results.has(c.id));
  return ctx;
}

export function buildRequest(ctx: AgentContext, maxOutputTokens: number, effort: string | undefined): ModelRequest {
  return {
    model: ctx.model,
    system: ctx.system,
    tools: [...ctx.toolSpecs].sort((a, b) => a.name.localeCompare(b.name)),
    messages: ctx.messages,
    maxOutputTokens,
    ...(effort ? { effort } : {}),
  };
}

/** Stored on `model.call.started` so a rebuild from the log can be checked against what was sent. */
export const requestHash = (request: ModelRequest): string => sha256(canonicalJson(request));
