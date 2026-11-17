import type { ModelCapabilities, Usage } from "@harness/harness";

/** Prices in US dollars per million tokens, and what each model accepts. */
export type ModelInfo = ModelCapabilities & {
  input: number;
  output: number;
  cacheRead: number;
};

/**
 * The models this provider knows, by deployment name. The DeepSeek entry is an estimate, not a published price
 * list: check it against your resource's pricing before trusting a budget, and pass `models` to the provider to
 * add or correct an entry.
 */
export const MODELS: Readonly<Record<string, ModelInfo>> = {
  "DeepSeek-V4.1-Flash": { contextWindow: 128_000, maxOutputTokens: 32_000, input: 1, output: 4, cacheRead: 0.1 },
};

/** Cost of one call in millionths of a dollar. Dollars per million tokens is the same number as micro-dollars per token. */
export function priceMicroUsd(info: ModelInfo, usage: Usage): number {
  return usage.inputTokens * info.input + usage.outputTokens * info.output + (usage.cacheReadTokens ?? 0) * info.cacheRead;
}
