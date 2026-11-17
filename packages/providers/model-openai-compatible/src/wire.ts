import { ModelError, type ContentBlock, type Message, type ModelRequest, type ModelResponse, type StopReason, type Usage } from "@harness/harness";
import type { ModelInfo } from "./models.ts";

/** Marks blocks this provider produced, so only they are sent back to it. */
export const PROVIDER_ID = "openai-compatible";

type Json = Record<string, unknown>;

export type WireOptions = {
  /** Send the model's reasoning back on later turns, for servers that ask for it during tool calls. */
  sendReasoning: boolean;
};

function assistantMessage(content: readonly ContentBlock[], options: WireOptions): Json | undefined {
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const toolCalls = content.flatMap((b) =>
    b.type === "tool_call" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
  );
  const reasoning = content.flatMap((b) =>
    b.type === "opaque" && b.provider === PROVIDER_ID && typeof (b.data as Json).reasoning_content === "string" ? [(b.data as Json).reasoning_content as string] : [],
  );
  if (!text && !toolCalls.length) return undefined;
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(options.sendReasoning && reasoning.length ? { reasoning_content: reasoning.join("") } : {}),
  };
}

/**
 * One user turn of the loop becomes several chat messages: every tool result as its own `tool` message, first,
 * so they follow the assistant message that asked for them; then any text; then pictures from tool results,
 * which a `tool` message cannot carry.
 */
function userMessages(content: readonly ContentBlock[]): Json[] {
  const out: Json[] = [];
  const pictures: Json[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    out.push({ role: "tool", tool_call_id: block.toolCallId, content: block.isError ? `Error: ${block.content}` : block.content });
    for (const image of block.images ?? []) {
      if (image.data === undefined) continue;
      pictures.push({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
    }
  }
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  if (text) out.push({ role: "user", content: text });
  if (pictures.length) out.push({ role: "user", content: [{ type: "text", text: "Pictures from the tool results above." }, ...pictures] });
  return out;
}

function toWireMessages(system: string, messages: readonly Message[], options: WireOptions): Json[] {
  const out: Json[] = system ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const wire = assistantMessage(message.content, options);
      if (wire) out.push(wire);
    } else {
      out.push(...userMessages(message.content));
    }
  }
  return out;
}

/**
 * The request body for `POST /chat/completions`. The system prompt and tools arrive fixed and sorted, and
 * nothing here depends on the clock, so a server that caches prompt prefixes can reuse them.
 */
export function toWireRequest(request: ModelRequest, info: ModelInfo, options: WireOptions): Json {
  const body: Json = {
    model: request.model,
    max_tokens: Math.min(request.maxOutputTokens, info.maxOutputTokens),
    stream: true,
    stream_options: { include_usage: true },
    messages: toWireMessages(request.system, request.messages, options),
  };
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }
  return body;
}

const STOP: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_output",
  content_filter: "refusal",
};

type ToolCall = { id: string; name: string; json: string };

/** Builds the final message from the stream's chunks. One instance per call. */
export class ChunkAssembler {
  private id: string | undefined;
  private model: string | undefined;
  private text = "";
  private reasoning = "";
  private readonly toolCalls = new Map<number, ToolCall>();
  private finishReason: string | undefined;
  private usage: Json | undefined;

  /** Feeds one chunk. Returns text to show live, if the chunk carried any. */
  accept(chunk: Json): string | undefined {
    if (chunk.error) {
      const error = chunk.error as { code?: unknown; type?: unknown; message?: string };
      throw errorFromCode(String(error.code ?? error.type ?? ""), error.message ?? "The stream reported an error.");
    }
    if (typeof chunk.id === "string" && chunk.id) this.id ??= chunk.id;
    if (typeof chunk.model === "string" && chunk.model) this.model ??= chunk.model;
    if (chunk.usage && typeof chunk.usage === "object") this.usage = chunk.usage as Json;
    let shown = "";
    for (const choice of (chunk.choices ?? []) as Json[]) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta = (choice.delta ?? {}) as Json;
      if (typeof delta.content === "string" && delta.content) {
        this.text += delta.content;
        shown += delta.content;
      }
      if (typeof delta.reasoning_content === "string") this.reasoning += delta.reasoning_content;
      for (const call of (delta.tool_calls ?? []) as Json[]) {
        const index = typeof call.index === "number" ? call.index : this.toolCalls.size;
        const entry = this.toolCalls.get(index) ?? { id: "", name: "", json: "" };
        const fn = (call.function ?? {}) as Json;
        if (typeof call.id === "string" && call.id) entry.id = call.id;
        if (typeof fn.name === "string" && fn.name) entry.name += fn.name;
        if (typeof fn.arguments === "string") entry.json += fn.arguments;
        this.toolCalls.set(index, entry);
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    return shown || undefined;
  }

  finish(): ModelResponse {
    if (!this.finishReason) throw new ModelError("transport", "The connection closed before the response was complete.");
    const content: ContentBlock[] = [];
    if (this.reasoning) content.push({ type: "opaque", provider: PROVIDER_ID, data: { reasoning_content: this.reasoning } });
    if (this.text) content.push({ type: "text", text: this.text });
    for (const index of [...this.toolCalls.keys()].sort((a, b) => a - b)) {
      const call = this.toolCalls.get(index)!;
      content.push({ type: "tool_call", id: call.id || `call_${index}`, name: call.name, input: parseToolInput(call.json) });
    }
    const number = (value: unknown) => (typeof value === "number" ? value : undefined);
    const prompt = number(this.usage?.prompt_tokens) ?? 0;
    const cached = number((this.usage?.prompt_tokens_details as Json | undefined)?.cached_tokens);
    const usage: Usage = {
      inputTokens: prompt - (cached ?? 0),
      outputTokens: number(this.usage?.completion_tokens) ?? 0,
      ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    };
    // Some servers report `stop` even when the answer is a tool call.
    const stopReason = content.some((b) => b.type === "tool_call") && this.finishReason !== "length" ? "tool_use" : (STOP[this.finishReason] ?? "end_turn");
    return {
      ...(this.id ? { responseId: this.id } : {}),
      ...(this.model ? { model: this.model } : {}),
      stopReason,
      content,
      usage,
      ...(stopReason === "refusal" ? { refusal: { category: this.finishReason } } : {}),
    };
  }
}

/**
 * A tool's input arrives as fragments of JSON text. If they do not add up to an object, the loop is handed the
 * raw text under `INVALID_JSON`: it fails the tool's schema, and the model is told to send the call again.
 */
function parseToolInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  return { INVALID_JSON: json };
}

/** Maps the API's error codes onto the loop's error kinds. */
export function errorFromCode(code: string | undefined, message: string, retryAfterMs?: number): ModelError {
  switch (code) {
    case "rate_limit_exceeded":
    case "429":
      return new ModelError("rate_limited", message, retryAfterMs);
    case "server_error":
    case "internal_error":
    case "service_unavailable":
      return new ModelError("upstream", message, retryAfterMs);
    case "timeout":
      return new ModelError("timeout", message);
    case "invalid_api_key":
    case "PermissionDenied":
    case "401":
    case "403":
      return new ModelError("auth", message);
    case "context_length_exceeded":
      return new ModelError("context_overflow", message);
    default:
      return new ModelError("invalid_request", message);
  }
}
