import { ModelError, type ContentBlock, type Message, type ModelRequest, type ModelResponse, type StopReason, type Usage } from "@harness/harness";
import type { ModelInfo } from "./models.ts";

/** Marks blocks this provider produced, so only they are sent back to it. */
export const PROVIDER_ID = "claude";

type Json = Record<string, unknown>;

export type WireOptions = {
  thinkingDisplay: "summarized" | "omitted";
  defaultEffort: string;
  fallbacks: boolean;
  strictHistory: boolean;
};

function toWireBlock(block: ContentBlock): Json | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
    case "tool_result": {
      // A result with pictures is sent as a list: the text, then each picture the loop has filled in.
      const images = (block.images ?? []).filter((image) => image.data !== undefined);
      const content = images.length
        ? [
            { type: "text", text: block.content },
            ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
          ]
        : block.content;
      return { type: "tool_result", tool_use_id: block.toolCallId, content, ...(block.isError ? { is_error: true } : {}) };
    }
    case "image":
      // A picture at the top of a user message, sent only by tool-less calls such as the critic.
      return block.data === undefined ? undefined : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
    case "opaque":
      // Thinking blocks and the like go back exactly as they arrived. Another provider's are not ours to send.
      return block.provider === PROVIDER_ID ? (block.data as Json) : undefined;
  }
}

function toWireMessages(messages: readonly Message[]): Json[] {
  const out: Json[] = [];
  for (const message of messages) {
    const content = message.content.map(toWireBlock).filter((b): b is Json => b !== undefined);
    if (content.length) out.push({ role: message.role, content });
  }
  return out;
}

/**
 * The request body for `POST /v1/messages`. Everything that would change the bytes of an earlier request is
 * kept out: the system prompt and tools arrive fixed and sorted, and nothing here depends on the clock.
 */
export function toWireRequest(request: ModelRequest, info: ModelInfo, options: WireOptions): { body: Json; betas: string[] } {
  const betas: string[] = [];
  const body: Json = { model: request.model, max_tokens: request.maxOutputTokens, stream: true };
  // One breakpoint on the fixed prefix, and automatic caching for the growing tail of the conversation.
  if (request.system) body.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      // Large inputs stream as they are written. The server then no longer checks them: the loop validates
      // every input against the tool's schema before running anything.
      eager_input_streaming: true,
    }));
  }
  body.messages = toWireMessages(request.messages);
  body.cache_control = { type: "ephemeral" };
  if (info.adaptiveThinking) {
    const thinking: Json = { type: "adaptive", display: options.thinkingDisplay };
    if (options.strictHistory) {
      // Makes the API reject a request whose earlier turns changed, so a history edit fails loudly in tests.
      thinking.block_binding = { prefix_mismatch_behavior: "error" };
      betas.push("thinking-binding-controls-2026-08-01");
    }
    body.thinking = thinking;
    body.output_config = { effort: request.effort ?? options.defaultEffort };
  }
  if (options.fallbacks && info.fallbacks) {
    body.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  return { body, betas };
}

const STOP: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_output",
  pause_turn: "paused",
  refusal: "refusal",
};

type Block = { block: Json; json: string };

/** Builds the final message from the stream's events. One instance per call. */
export class MessageAssembler {
  private id: string | undefined;
  private model: string | undefined;
  private readonly blocks = new Map<number, Block>();
  private stopReason: string | undefined;
  private stopDetails: Json | undefined;
  private usage: Json = {};
  private done = false;

  /** Feeds one event. Returns text to show live, if the event carried any. */
  accept(event: Json): string | undefined {
    switch (event.type) {
      case "message_start": {
        const message = (event.message ?? {}) as Json;
        this.id = message.id as string | undefined;
        this.model = message.model as string | undefined;
        this.usage = { ...((message.usage ?? {}) as Json) };
        return undefined;
      }
      case "content_block_start":
        this.blocks.set(event.index as number, { block: { ...(event.content_block as Json) }, json: "" });
        return undefined;
      case "content_block_delta": {
        const entry = this.blocks.get(event.index as number);
        const delta = (event.delta ?? {}) as Json;
        if (!entry) return undefined;
        if (delta.type === "text_delta") {
          entry.block.text = `${(entry.block.text as string | undefined) ?? ""}${delta.text as string}`;
          return delta.text as string;
        }
        if (delta.type === "input_json_delta") entry.json += delta.partial_json as string;
        else if (delta.type === "thinking_delta") entry.block.thinking = `${(entry.block.thinking as string | undefined) ?? ""}${delta.thinking as string}`;
        else if (delta.type === "signature_delta") entry.block.signature = `${(entry.block.signature as string | undefined) ?? ""}${delta.signature as string}`;
        else if (delta.type === "citations_delta") entry.block.citations = [...((entry.block.citations as unknown[] | undefined) ?? []), delta.citation];
        return undefined;
      }
      case "message_delta": {
        const delta = (event.delta ?? {}) as Json;
        if (delta.stop_reason) this.stopReason = delta.stop_reason as string;
        if (delta.stop_details) this.stopDetails = delta.stop_details as Json;
        for (const [key, value] of Object.entries((event.usage ?? {}) as Json)) if (value !== null && value !== undefined) this.usage[key] = value;
        return undefined;
      }
      case "message_stop":
        this.done = true;
        return undefined;
      case "error": {
        const error = (event.error ?? {}) as { type?: string; message?: string };
        throw errorFromType(error.type, error.message ?? "The stream reported an error.");
      }
      default:
        // `ping`, and anything added later.
        return undefined;
    }
  }

  finish(): ModelResponse {
    if (!this.done) throw new ModelError("transport", "The connection closed before the response was complete.");
    if (this.stopReason === "model_context_window_exceeded") {
      throw new ModelError("context_overflow", "The conversation no longer fits in the model's context window.");
    }
    const content: ContentBlock[] = [];
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      const { block, json } = this.blocks.get(index)!;
      if (block.type === "text") {
        if (block.text) content.push({ type: "text", text: block.text as string });
      } else if (block.type === "tool_use") {
        content.push({ type: "tool_call", id: block.id as string, name: block.name as string, input: parseToolInput(json, block.input) });
      } else {
        content.push({ type: "opaque", provider: PROVIDER_ID, data: block });
      }
    }
    const number = (key: string) => (typeof this.usage[key] === "number" ? (this.usage[key] as number) : undefined);
    const usage: Usage = {
      inputTokens: number("input_tokens") ?? 0,
      outputTokens: number("output_tokens") ?? 0,
      ...(number("cache_read_input_tokens") !== undefined ? { cacheReadTokens: number("cache_read_input_tokens") } : {}),
      ...(number("cache_creation_input_tokens") !== undefined ? { cacheWriteTokens: number("cache_creation_input_tokens") } : {}),
    };
    const stopReason = STOP[this.stopReason ?? ""] ?? "end_turn";
    return {
      ...(this.id ? { responseId: this.id } : {}),
      ...(this.model ? { model: this.model } : {}),
      stopReason,
      content,
      usage,
      ...(stopReason === "refusal"
        ? {
            refusal: {
              ...(typeof this.stopDetails?.category === "string" ? { category: this.stopDetails.category } : {}),
              ...(typeof this.stopDetails?.explanation === "string" ? { explanation: this.stopDetails.explanation } : {}),
            },
          }
        : {}),
    };
  }
}

/**
 * A tool's input arrives as fragments of JSON text. If they do not add up to an object, the loop is handed the
 * raw text under `INVALID_JSON`: it fails the tool's schema, and the model is told to send the call again.
 */
function parseToolInput(json: string, initial: unknown): unknown {
  if (!json.trim()) return initial && typeof initial === "object" ? initial : {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  return { INVALID_JSON: json };
}

/** Maps the API's error type names onto the loop's error kinds. */
export function errorFromType(type: string | undefined, message: string, retryAfterMs?: number): ModelError {
  switch (type) {
    case "rate_limit_error":
      return new ModelError("rate_limited", message, retryAfterMs);
    case "overloaded_error":
    case "api_error":
      return new ModelError("upstream", message, retryAfterMs);
    case "timeout_error":
      return new ModelError("timeout", message);
    case "authentication_error":
    case "permission_error":
    case "billing_error":
      return new ModelError("auth", message);
    default:
      return new ModelError("invalid_request", message);
  }
}
