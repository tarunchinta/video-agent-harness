import { ModelError, type ContentBlock, type ModelCapabilities, type ModelProvider, type ModelRequest, type ModelResponse, type ModelStreamEvent, type StopReason, type Usage } from "../model/types.ts";

export type Scripted = ModelResponse | ModelError;
export type ScriptStep = Scripted | ((request: ModelRequest, call: number) => Scripted);

/**
 * A model that answers from a script: a list of responses in order, or a function of the request. Every loop
 * test uses it, so tests need no network and no key, and a run is the same every time.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  /** Every request received, in order, as it was sent. */
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly script: ScriptStep[] | ((request: ModelRequest, call: number) => Scripted),
    private readonly caps: ModelCapabilities = { contextWindow: 200_000, maxOutputTokens: 16_000 },
  ) {}

  capabilities(): ModelCapabilities {
    return this.caps;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const call = this.requests.length;
    this.requests.push(structuredClone(request));
    if (signal.aborted) throw new ModelError("aborted", "The call was cancelled.");
    const step = typeof this.script === "function" ? this.script : this.script[call];
    if (step === undefined) throw new Error(`The script has no answer for model call ${call + 1}.`);
    const answer = typeof step === "function" ? step(request, call) : step;
    if (answer instanceof ModelError) throw answer;
    for (const block of answer.content) if (block.type === "text") yield { type: "text_delta", text: block.text };
    yield { type: "response", response: structuredClone(answer) };
  }

  /** $3 per million input tokens and $15 per million output tokens, so cost tests have round numbers. */
  priceMicroUsd(_model: string, usage: Usage): number {
    return (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) * 3 + usage.outputTokens * 15;
  }
}

let nextCallId = 0;

export const text = (value: string): ContentBlock => ({ type: "text", text: value });

export const toolCall = (name: string, input: unknown, id?: string): ContentBlock => ({ type: "tool_call", id: id ?? `call_${(nextCallId += 1)}`, name, input });

/** A response. The stop reason defaults to `tool_use` when there are tool calls, `end_turn` otherwise. */
export function respond(content: ContentBlock[], options: { stopReason?: StopReason; usage?: Usage } = {}): ModelResponse {
  return {
    stopReason: options.stopReason ?? (content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn"),
    content,
    usage: options.usage ?? { inputTokens: 100, outputTokens: 20 },
  };
}

/** The successful results in a request's conversation, by the tool call that produced them. */
export function resultsIn(request: ModelRequest): Map<string, { name: string; input: unknown; content: string; isError: boolean }> {
  const calls = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, { name: string; input: unknown; content: string; isError: boolean }>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") calls.set(block.id, { name: block.name, input: block.input });
      if (block.type === "tool_result") {
        const call = calls.get(block.toolCallId);
        if (call) results.set(block.toolCallId, { ...call, content: block.content, isError: Boolean(block.isError) });
      }
    }
  }
  return results;
}
