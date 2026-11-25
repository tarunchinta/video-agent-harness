import type { ModelCapabilities, Usage } from "@harness/harness";

/** Prices in US dollars per million tokens, and what each model accepts. */
export type ModelInfo = ModelCapabilities & {
  input: number;
  output: number;
  cacheRead: number;
  /** A five-minute cache write. */
  cacheWrite: number;
  /** Prompts longer than `overTokens` are charged at these rates instead. */
  longPrompt?: { overTokens: number; input: number; output: number };
  /** Takes `thinking: {type: "adaptive"}` and `output_config.effort`. */
  adaptiveThinking: boolean;
  /** Accepts the server-side `fallbacks` parameter for refusals. */
  fallbacks: boolean;
};

const current = { contextWindow: 1_000_000, maxOutputTokens: 128_000, adaptiveThinking: true };

/** When the table below was last checked against the published prices. Update it whenever a price changes. */
export const PRICES_CHECKED_ON = "2026-11-16";

/**
 * The models this provider knows. A price list goes stale: check it against the published prices before
 * trusting a budget, and pass `models` to the provider to add or correct an entry.
 */
export const MODELS: Readonly<Record<string, ModelInfo>> = {
  "claude-fable-5-2": { ...current, input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, fallbacks: true },
  "claude-fable-5-1": { ...current, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, fallbacks: true },
  "claude-opus-5-5": { ...current, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, fallbacks: true },
  "claude-opus-5": { ...current, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fallbacks: true },
  "claude-opus-4-8": { ...current, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fallbacks: false },
  "claude-sonnet-5-5": { ...current, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, fallbacks: true },
  "claude-sonnet-5": { ...current, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, fallbacks: false },
  "claude-haiku-5-5": {
    ...current,
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5 },
    fallbacks: false,
  },
};

/** Cost of one call in millionths of a dollar. Dollars per million tokens is the same number as micro-dollars per token. */
export function priceMicroUsd(info: ModelInfo, usage: Usage): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const prompt = usage.inputTokens + cacheRead + cacheWrite;
  const long = info.longPrompt && prompt > info.longPrompt.overTokens ? info.longPrompt : undefined;
  const scale = long ? long.input / info.input : 1;
  return (
    usage.inputTokens * (long?.input ?? info.input) +
    usage.outputTokens * (long?.output ?? info.output) +
    cacheRead * info.cacheRead * scale +
    cacheWrite * info.cacheWrite * scale
  );
}
