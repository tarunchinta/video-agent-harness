import { readFileSync } from "node:fs";
import { z } from "zod";
import { UsageError } from "./pipeline.ts";

/**
 * Corrected prices, from the file named by `HARNESS_PRICES`. The price tables in the provider packages go
 * stale; this lets a creator fix them without changing code, and says when they were checked:
 *
 * {
 *   "checked_on": "2026-12-01",
 *   "models": {
 *     "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 },
 *     "my-deployment": { "contextWindow": 128000, "maxOutputTokens": 32000, "input": 1, "output": 4, "cacheRead": 0.1 }
 *   }
 * }
 *
 * Prices are US dollars per million tokens. A model already in a provider's table needs only the prices that
 * changed; a new one also needs its context window and output limit.
 */

const entry = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  })
  .strict();

const fileSchema = z
  .object({
    checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date written as YYYY-MM-DD"),
    models: z.record(z.string().min(1), entry),
  })
  .strict();

export type PriceOverrides = z.infer<typeof fileSchema>;

export function priceOverrides(env: Record<string, string | undefined>): PriceOverrides | undefined {
  const path = env.HARNESS_PRICES;
  if (!path) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`HARNESS_PRICES names ${path}, which could not be read as JSON: ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ");
    throw new UsageError(`The prices in ${path} are not valid (${problems}).`);
  }
  return parsed.data;
}

/**
 * The provider's table with the overrides laid over it. A model the table does not know is added only when the
 * override says everything the provider needs about it, so a typo cannot quietly price a model at zero.
 */
export function mergePrices<T extends { contextWindow: number; maxOutputTokens: number; input: number; output: number; cacheRead: number }>(
  table: Readonly<Record<string, T>>,
  overrides: PriceOverrides | undefined,
  fill: (known: Required<z.infer<typeof entry>>) => T,
): Record<string, T> | undefined {
  if (!overrides) return undefined;
  const merged: Record<string, T> = {};
  for (const [model, change] of Object.entries(overrides.models)) {
    const known = table[model];
    if (known) {
      merged[model] = { ...known, ...change };
      continue;
    }
    const { contextWindow, maxOutputTokens, input, output, cacheRead } = change;
    if (contextWindow === undefined || maxOutputTokens === undefined || input === undefined || output === undefined || cacheRead === undefined) {
      continue;
    }
    merged[model] = fill({ contextWindow, maxOutputTokens, input, output, cacheRead, cacheWrite: change.cacheWrite ?? input * 1.25 });
  }
  return merged;
}
