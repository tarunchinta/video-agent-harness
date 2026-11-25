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
  /** The conversation was made smaller since the latest model response, and how. */
  compactedSinceStep?: "trim" | "summary";
  /** Tool results already cleared to save space, by tool call id. */
  cleared: Set<string>;
};

/** What a picture is assumed to cost until the provider reports the real prompt size: about 1,700 tokens. */
export const IMAGE_CHARS = 6_000;

/** How much of a cleared tool result stays in the conversation, so the model still knows what it was. */
export const CLEARED_HEAD_CHARS = 300;

/** What a cleared tool result reads as. A pure function of the original text and where it was saved. */
export function clearedResult(content: string, path: string): string {
  const head = content.length > CLEARED_HEAD_CHARS ? `${content.slice(0, CLEARED_HEAD_CHARS)}…` : content;
  return `${head}\n\n(This result was cleared to save space. Its full text is at ${path}. Use read_file to read it again if it is needed.)`;
}

/** What the conversation after the task reads as once it has been summarised. */
export function summaryMessage(summary: string): string {
  return (
    "Earlier turns of this conversation were summarised to save space. The summary below is what you knew and had done. " +
    "Files you wrote are still in the working directory. Carry on from here.\n\n" +
    summary
  );
}

/**
 * The conversation as plain text, for a summary. Each tool call and result is cut to a preview and pictures
 * are named, not shown, so the summarising call fits where the conversation no longer does. If the whole is
 * still over `maxChars`, the start and the end are kept and the middle is left out.
 */
export function transcriptText(messages: readonly Message[], maxChars: number, perBlockChars = 1_500): string {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString("en-US")} more characters)` : text);
  const parts: string[] = [];
  for (const m of messages) {
    const lines: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") lines.push(cut(b.text, m.role === "user" ? perBlockChars * 4 : perBlockChars * 2));
      else if (b.type === "tool_call") lines.push(`[called ${b.name}] ${cut(JSON.stringify(b.input), perBlockChars)}`);
      else if (b.type === "tool_result") {
        const pictures = b.images?.length ? ` (with ${b.images.length} ${b.images.length === 1 ? "picture" : "pictures"})` : "";
        lines.push(`[${b.isError ? "error" : "result"}${pictures}] ${cut(b.content, perBlockChars)}`);
      } else if (b.type === "image") lines.push("[a picture]");
    }
    if (lines.length) parts.push(`## ${m.role === "user" ? "User and tool results" : "Agent"}\n${lines.join("\n")}`);
  }
  const text = parts.join("\n\n");
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n(… ${(text.length - half * 2).toLocaleString("en-US")} characters of the middle of the conversation left out …)\n\n${text.slice(text.length - half)}`;
}

/** A rough size of the whole request in characters, for when the provider has not measured it. */
export function estimateRequestChars(ctx: Pick<AgentContext, "messages" | "system" | "toolSpecs" | "images">): number {
  return JSON.stringify(ctx.messages).length + ctx.system.length + JSON.stringify(ctx.toolSpecs).length + ctx.images * IMAGE_CHARS;
}

export class ContextTrustError extends Error {
  constructor(seq: number) {
    super(`Event ${seq} carries untrusted content and cannot enter the context of an agent that has tools.`);
    this.name = "ContextTrustError";
  }
}

/**
 * Builds what an agent's model sees from the log, one event at a time. Three kinds of event produce messages: the
 * task on `agent.started`, `context.message`, and the model's own responses with the results of the tools it
 * called. Everything else is a record. The result is a pure function of the events, so the same log always gives
 * the same request. The engine keeps one of these per run and feeds it each event as it is written, so a step
 * costs the events since the last one, not the whole log.
 */
export class ContextBuilder {
  private readonly ctx: AgentContext;
  // Results of one response's tool calls go back together, in the order the model asked, in a single message.
  private pending: { calls: ToolCallBlock[]; results: Map<string, ToolResultBlock> } | undefined;
  private queued: Message[] = [];
  private task: Message | undefined;

  constructor(readonly agentId: string) {
    this.ctx = {
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
      cleared: new Set(),
    };
  }

  /**
   * Applies a `context.compacted` event. Messages are replaced, never changed in place, because snapshots
   * already handed out share them. The provider's last measurement no longer describes the conversation, so it
   * is dropped and the next projection is an estimate until the model answers again.
   */
  private compact(e: HarnessEvent): void {
    const { ctx } = this;
    if (this.pending) throw new Error(`Event ${e.seq} compacts the conversation while tool calls are waiting for results.`);
    const p = payloadOf(e, "context.compacted");
    if (p.mode === "summary") {
      const task = this.task?.content ?? [];
      ctx.messages = [{ role: "user", content: [...task, { type: "text", text: summaryMessage(p.summary) }] }];
      ctx.images = 0;
      ctx.compactedSinceStep = "summary";
    } else {
      const paths = new Map(p.cleared.map((c) => [c.tool_call_id, c.path]));
      let last = -1;
      let removed = 0;
      ctx.messages = ctx.messages.map((m, i) => {
        if (m.role !== "user" || !m.content.some((b) => b.type === "tool_result" && paths.has(b.toolCallId))) return m;
        last = i;
        return {
          ...m,
          content: m.content.map((b) => {
            if (b.type !== "tool_result" || !paths.has(b.toolCallId)) return b;
            const pictures = b.images?.length ?? 0;
            const content = clearedResult(b.content, paths.get(b.toolCallId)!);
            ctx.images -= pictures;
            ctx.cleared.add(b.toolCallId);
            removed += b.content.length - content.length + pictures * IMAGE_CHARS;
            const { images: _dropped, ...rest } = b;
            return { ...rest, content };
          }),
        };
      });
      // Provider blocks such as thinking are tied to the exact history before them, which has just changed.
      ctx.messages = ctx.messages.map((m, i) => {
        if (i > last || m.role !== "assistant" || !m.content.some((b) => b.type === "opaque")) return m;
        const content = m.content.filter((b) => b.type !== "opaque");
        removed += JSON.stringify(m.content).length - JSON.stringify(content).length;
        return { ...m, content: content.length ? content : [{ type: "text", text: "(Earlier reasoning cleared.)" }] };
      });
      ctx.compactedSinceStep ??= "trim";
      // The provider's last measurement still anchors the projection; what was cleared is taken off it.
      ctx.charsSinceUsage -= removed;
      return;
    }
    ctx.lastUsage = undefined;
    ctx.charsSinceUsage = 0;
  }

  private settle(id: string, result: ToolResultBlock): void {
    const { ctx } = this;
    ctx.openToolCalls.delete(id);
    const pending = this.pending;
    if (!pending?.calls.some((c) => c.id === id)) return;
    pending.results.set(id, result);
    ctx.charsSinceUsage += result.content.length + (result.images?.length ?? 0) * IMAGE_CHARS;
    ctx.images += result.images?.length ?? 0;
    if (pending.results.size < pending.calls.length) return;
    ctx.messages.push({ role: "user", content: pending.calls.map((c) => pending.results.get(c.id)!) });
    ctx.messages.push(...this.queued);
    this.pending = undefined;
    this.queued = [];
  }

  add(e: HarnessEvent): void {
    if (e.agentId !== this.agentId) return;
    const { ctx } = this;
    ctx.throughSeq = e.seq;
    switch (e.type) {
      case "agent.started": {
        const p = payloadOf(e, "agent.started");
        ctx.spanId = e.spanId;
        ctx.model = p.model;
        ctx.system = p.system_prompt;
        ctx.toolSpecs = p.tool_specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
        this.task = { role: "user", content: [{ type: "text", text: p.task }] };
        ctx.messages.push(this.task);
        break;
      }
      case "context.compacted":
        this.compact(e);
        break;
      case "agent.completed":
      case "agent.failed":
        ctx.finished = true;
        break;
      case "context.message": {
        const p = payloadOf(e, "context.message");
        const message: Message = { role: "user", content: [{ type: "text", text: p.content }] };
        // Never between a tool call and its result: hold the note until the results are in.
        if (this.pending) this.queued.push(message);
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
        if (calls.length) this.pending = { calls, results: new Map() };
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
        ctx.compactedSinceStep = undefined;
        break;
      }
      case "tool.call.started":
        ctx.openToolCalls.set(payloadOf(e, "tool.call.started").tool_call_id, e);
        break;
      case "tool.call.completed": {
        if (e.untrusted) throw new ContextTrustError(e.seq);
        const p = payloadOf(e, "tool.call.completed");
        const images = p.images?.map((i) => ({ type: "image" as const, mediaType: i.media_type, sha256: i.sha256 }));
        this.settle(p.tool_call_id, { type: "tool_result", toolCallId: p.tool_call_id, content: p.output, ...(images?.length ? { images } : {}) });
        break;
      }
      case "tool.call.failed": {
        const p = payloadOf(e, "tool.call.failed");
        this.settle(p.tool_call_id, { type: "tool_result", toolCallId: p.tool_call_id, content: p.error.message, isError: true });
        break;
      }
      default:
        break;
    }
  }

  /** The live context, for reading counts without a copy. Never hand it out or change it. */
  peek(): Readonly<AgentContext> {
    return this.ctx;
  }

  /**
   * The context as of the last event added. The copy is shallow: messages already in the conversation never
   * change, so sharing them is safe, while later events cannot reach into a snapshot that was handed out.
   */
  snapshot(): AgentContext {
    const { ctx, pending } = this;
    return {
      ...ctx,
      messages: [...ctx.messages],
      openToolCalls: new Map(ctx.openToolCalls),
      openModelCalls: [...ctx.openModelCalls],
      noteKinds: new Set(ctx.noteKinds),
      cleared: new Set(ctx.cleared),
      unanswered: pending ? pending.calls.filter((c) => !pending.results.has(c.id)) : [],
    };
  }
}

/** The context of one agent, folded from a whole log. */
export function deriveContext(events: readonly HarnessEvent[], agentId: string): AgentContext {
  const builder = new ContextBuilder(agentId);
  for (const e of events) builder.add(e);
  return builder.snapshot();
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
