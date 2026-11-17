import { createHash, randomUUID } from "node:crypto";

/** The loop reads time and makes ids only through these, so a test can make a run fully deterministic. */
export type Clock = { now(): Date };
export type IdSource = { uuid(): string };
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const systemClock: Clock = { now: () => new Date() };
export const randomIds: IdSource = { uuid: () => randomUUID() };

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** JSON with object keys sorted, so equal values always produce equal text (and equal hashes). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Rough token count for text the provider has not priced yet. Deliberately on the high side. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3.5);
