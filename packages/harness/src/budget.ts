import type { Limits } from "./events/envelope.ts";

export type BudgetDimension = "tokens" | "cost" | "time" | "steps";

export type BudgetUsage = { tokens: number; costMicroUsd: number; activeMs: number; steps: number };

export type BudgetCheck = {
  /** The first limit that is used up, if any. */
  exceeded?: { dimension: BudgetDimension; used: number; limit: number };
  /** Limits that are at least 80% used and not yet exceeded. */
  near: Array<{ dimension: BudgetDimension; used: number; limit: number }>;
};

export const WARN_RATIO = 0.8;

/**
 * The budget rule, as a pure function of totals and limits so it can be tested without a run. A limit that is
 * not set never trips. The loop calls this before every model call and every tool call.
 */
export function evaluateBudget(usage: BudgetUsage, limits: Limits): BudgetCheck {
  const rows: Array<[BudgetDimension, number, number | undefined]> = [
    ["tokens", usage.tokens, limits.max_tokens],
    ["cost", usage.costMicroUsd, limits.max_cost_micro_usd],
    ["time", usage.activeMs, limits.max_active_ms],
    ["steps", usage.steps, limits.max_steps],
  ];
  const check: BudgetCheck = { near: [] };
  for (const [dimension, used, limit] of rows) {
    if (limit === undefined) continue;
    if (used >= limit) check.exceeded ??= { dimension, used, limit };
    else if (used >= limit * WARN_RATIO) check.near.push({ dimension, used, limit });
  }
  return check;
}

const UNITS: Record<BudgetDimension, (n: number) => string> = {
  tokens: (n) => `${n.toLocaleString("en-US")} tokens`,
  cost: (n) => `$${(n / 1_000_000).toFixed(2)}`,
  time: (n) => `${Math.round(n / 60_000)} min`,
  steps: (n) => `${n} steps`,
};

/** "$4.10 of $5.00", for notes to the model and messages to the creator. */
export function describeBudget(dimension: BudgetDimension, used: number, limit: number): string {
  return `${UNITS[dimension](used)} of ${UNITS[dimension](limit)}`;
}
