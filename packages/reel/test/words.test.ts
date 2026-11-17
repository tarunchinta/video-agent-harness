import { describe, expect, it } from "vitest";
import { firstDifference, narrationWords, normWord, standInWords, wordsSchema } from "../src/index.ts";

describe("word timings", () => {
  it("compares words the way the film page does: letters and digits only", () => {
    expect(normWord("Cornyn's")).toBe("cornyns");
    expect(normWord("400,000")).toBe("400000");
    expect(normWord("—")).toBe("");
    expect(narrationWords("Texas might turn blue — in November,\nbecause 400,000 left.")).toEqual(["Texas", "might", "turn", "blue", "in", "November,", "because", "400,000", "left."]);
  });

  it("makes stand-in timing that never overlaps and breathes at punctuation", () => {
    const words = standInWords("One idea, said plainly. Then the next.");
    expect(wordsSchema.safeParse(words).success).toBe(true);
    expect(words.map((w) => w.w)).toEqual(["One", "idea,", "said", "plainly.", "Then", "the", "next."]);
    expect(words[0]!.s).toBe(0.25);
    for (let i = 1; i < words.length; i += 1) expect(words[i]!.s).toBeGreaterThan(words[i - 1]!.e);
    const gap = (i: number) => words[i + 1]!.s - words[i]!.e;
    // After a comma, a breath; after a full stop, a longer one; between plain words, almost none.
    expect(gap(1)).toBeGreaterThan(gap(0));
    expect(gap(3)).toBeGreaterThan(gap(1));
  });

  it("finds where a recording leaves the narration, and says nothing when it does not", () => {
    const said = (text: string) => standInWords(text);
    expect(firstDifference(said("He stays home. Paxton wins."), "He stays home.\nPaxton wins.")).toBeUndefined();
    expect(firstDifference(said("midterms draw fewer votes so"), "midterms draw fewer voters so")).toEqual({
      at: 3,
      written: "draw fewer voters so",
      said: "draw fewer votes so",
    });
    expect(firstDifference(said("one two"), "one two three")).toMatchObject({ at: 2, written: "one two three", said: "one two" });
  });
});
