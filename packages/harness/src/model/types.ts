/**
 * What the loop needs from a model, in its own vocabulary. No vendor type appears here: a provider package
 * translates to and from its SDK, and the loop never imports one.
 */

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown };
/**
 * A picture shown to the model with a tool result. The log and the conversation name it by hash; `data`
 * (base64) is filled in from the run's artifacts folder only on the request handed to a provider.
 */
export type ImageBlock = { type: "image"; mediaType: string; sha256: string; data?: string };
export type ToolResultBlock = { type: "tool_result"; toolCallId: string; content: string; isError?: boolean; images?: ImageBlock[] };
/**
 * Anything provider-specific that must go back unchanged, such as a thinking block and its signature. The loop
 * stores and replays these without reading them.
 */
export type OpaqueBlock = { type: "opaque"; provider: string; data: unknown };
/**
 * Message content. An `image` block at the top level of a user message is used only by tool-less calls (a critic
 * looking at frames); pictures in the agent's own conversation always arrive inside a tool result.
 */
export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | OpaqueBlock | ImageBlock;

export type Message = { role: "user" | "assistant"; content: ContentBlock[] };

export type ToolSpec = { name: string; description: string; inputSchema: unknown };

export type ModelRequest = {
  model: string;
  /** Fixed for the life of the agent. */
  system: string;
  /** Fixed for the life of the agent, sorted by name. */
  tools: ToolSpec[];
  /** Append-only. */
  messages: Message[];
  maxOutputTokens: number;
  effort?: string;
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

export type StopReason = "end_turn" | "tool_use" | "max_output" | "paused" | "refusal";

export type ModelResponse = {
  responseId?: string;
  /** The model that answered, when the provider reports it. It can differ from the one asked for. */
  model?: string;
  stopReason: StopReason;
  content: ContentBlock[];
  usage: Usage;
  /** Set with `stopReason: "refusal"` when the provider says why. */
  refusal?: { category?: string; explanation?: string };
};

/** Live output while a call is in flight, then exactly one `response`. Deltas are never stored. */
export type ModelStreamEvent = { type: "text_delta"; text: string } | { type: "response"; response: ModelResponse };

export type ModelCapabilities = { contextWindow: number; maxOutputTokens: number };

export interface ModelProvider {
  readonly id: string;
  capabilities(model: string): ModelCapabilities;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Cost of one call in millionths of a US dollar. */
  priceMicroUsd(model: string, usage: Usage): number;
  /**
   * When the price table was last checked against the published prices, as YYYY-MM-DD. A budget in dollars
   * is only as good as the table, so the date goes on the run's record and `inspect` warns when it is old.
   */
  readonly pricesCheckedOn?: string;
}

export type ModelErrorKind =
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "transport"
  | "empty_response"
  | "auth"
  | "invalid_request"
  | "context_overflow"
  | "aborted";

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set(["rate_limited", "upstream", "timeout", "transport", "empty_response"]);

/** The only error a provider throws. `kind` is stable; the loop decides what to retry from it. */
export class ModelError extends Error {
  readonly retryable: boolean;
  constructor(public readonly kind: ModelErrorKind, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "ModelError";
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Prompt size of a request as the provider counted it: everything that was sent, cached or not. */
export const promptTokens = (u: Usage): number => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
