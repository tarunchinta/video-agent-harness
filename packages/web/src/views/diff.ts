/** A line diff (longest common subsequence), for showing how a script changed between revisions. */

export type DiffLine = { op: "same" | "add" | "del"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replaceAll("\r\n", "\n").split("\n");
  const b = after.replaceAll("\r\n", "\n").split("\n");
  // Scripts are short; a full table is fine. Past this size, show the new text as it is.
  if (a.length * b.length > 4_000_000) return b.map((text) => ({ op: "same", text }));
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ op: "del", text: a[i++]! });
    else out.push({ op: "add", text: b[j++]! });
  }
  while (i < n) out.push({ op: "del", text: a[i++]! });
  while (j < m) out.push({ op: "add", text: b[j++]! });
  return out;
}
