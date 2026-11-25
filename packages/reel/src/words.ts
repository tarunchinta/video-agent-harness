import { z } from "zod";

/** One spoken word and when it is said, in seconds from the start of the film. */
export const wordSchema = z.object({ w: z.string().min(1).max(80), s: z.number().nonnegative(), e: z.number().nonnegative() });
export const wordsSchema = z.array(wordSchema).min(1).max(5000);
export type Word = z.infer<typeof wordSchema>;

/** How the film page compares words: lower case, letters and digits only. Kept the same as `Film.norm` in the kit. */
export const normWord = (word: string): string => word.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

/** The words of a narration as they are written, leaving out anything that is only punctuation. */
export const narrationWords = (text: string): string[] => text.split(/\s+/).filter((token) => normWord(token));

/** Seconds of lead-in before the first word. */
export const LEAD_IN = 0.25;

/**
 * Word times made up from the text alone, for a film with no recording yet: an even reading pace, with a
 * breath after commas and a longer one after the end of a sentence. Good enough to lay a film out; a real
 * recording replaces it.
 */
export function standInWords(narration: string): Word[] {
  const words: Word[] = [];
  let t = LEAD_IN;
  for (const token of narrationWords(narration)) {
    const length = Math.min(0.75, 0.16 + 0.045 * normWord(token).length);
    words.push({ w: token, s: round(t), e: round(t + length) });
    t += length + 0.05;
    if (/[.!?…]["')\]]?$/.test(token) || /[—–]$/.test(token)) t += 0.38;
    else if (/[,;:]["')\]]?$/.test(token)) t += 0.18;
  }
  return words;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export const shiftWords = (words: readonly Word[], by: number): Word[] =>
  words.map((word) => ({ w: word.w, s: round(Math.max(0, word.s - by)), e: round(Math.max(0, word.e - by)) }));

/** `words.js`, which the film page loads before anything else. */
export const wordsScript = (words: readonly Word[]): string => `window.WORDS = ${JSON.stringify(words)};\n`;

export type Difference = { written: string; said: string };

/**
 * Every place a recording departs from the narration it was read from: the words as written and the words as
 * heard, each with one word of context on either side. Empty when they match word for word.
 */
export function differences(words: readonly Word[], narration: string): Difference[] {
  const written = narrationWords(narration);
  const said = words.map((word) => word.w);
  const a = written.map(normWord);
  const b = said.map(normWord);
  // Longest common subsequence, filled from the end so the walk below can go forwards.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Difference[] = [];
  const around = (list: string[], from: number, to: number) => list.slice(Math.max(0, from - 1), to + 1).join(" ");
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const fromI = i;
    const fromJ = j;
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i += 1;
      else j += 1;
    }
    out.push({ written: around(written, fromI, i), said: around(said, fromJ, j) });
  }
  return out;
}

export type Correction = { heard: string; write: string };

/**
 * Puts right what the timing tool misheard: every place the words `heard` occur, in that order, they are
 * replaced with `write`. The time the heard words took is shared out among the written ones by length.
 * Returns the corrected words and the corrections that matched nothing.
 */
export function applyCorrections(words: readonly Word[], corrections: readonly Correction[]): { words: Word[]; unused: Correction[] } {
  let current = words.map((word) => ({ ...word }));
  const unused: Correction[] = [];
  for (const correction of corrections) {
    const heard = narrationWords(correction.heard).map(normWord);
    const write = narrationWords(correction.write);
    if (!heard.length || !write.length) {
      unused.push(correction);
      continue;
    }
    const next: Word[] = [];
    let hit = false;
    for (let i = 0; i < current.length; ) {
      if (heard.every((token, k) => normWord(current[i + k]?.w ?? "") === token)) {
        const start = current[i]!.s;
        const end = current[i + heard.length - 1]!.e;
        const total = write.reduce((sum, token) => sum + token.length, 0);
        let t = start;
        for (const token of write) {
          const length = ((end - start) * token.length) / total;
          next.push({ w: token, s: round(t), e: round(t + length) });
          t += length;
        }
        i += heard.length;
        hit = true;
      } else {
        next.push(current[i]!);
        i += 1;
      }
    }
    if (!hit) unused.push(correction);
    current = next;
  }
  return { words: current, unused };
}
