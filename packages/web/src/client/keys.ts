/**
 * Stable React keys for lists of text that have no ids (narration lines, notes, diff lines, table cells): the
 * text itself, with a count for repeats. Two equal lines stay distinct, and a key never depends on position alone.
 */
export function withKeys<T>(items: readonly T[], text: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = text(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, item };
  });
}
