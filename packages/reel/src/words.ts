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

/** Where a recording first departs from the narration it was read from, if it does. */
export function firstDifference(words: readonly Word[], narration: string): { at: number; written: string; said: string } | undefined {
  const written = narrationWords(narration);
  const n = Math.max(written.length, words.length);
  for (let i = 0; i < n; i += 1) {
    if (normWord(written[i] ?? "") === normWord(words[i]?.w ?? "")) continue;
    const around = (list: string[]) => list.slice(Math.max(0, i - 2), i + 4).join(" ");
    return { at: i, written: around(written), said: around(words.map((word) => word.w)) };
  }
  return undefined;
}
