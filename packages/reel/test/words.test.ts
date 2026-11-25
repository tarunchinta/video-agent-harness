import { describe, expect, it } from "vitest";
import { applyCorrections, differences, narrationWords, normWord, standInWords, wordsSchema } from "../src/index.ts";

describe("word timings", () => {
  it("compares words the way the film page does: letters and digits only", () => {
    expect(normWord("Marlow's")).toBe("marlows");
    expect(normWord("400,000")).toBe("400000");
    expect(normWord("—")).toBe("");
    expect(narrationWords("The branch might close — in November,\nbecause 400,000 left.")).toEqual(["The", "branch", "might", "close", "in", "November,", "because", "400,000", "left."]);
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

  it("finds every place a recording leaves the narration, and says nothing when it does not", () => {
    const said = (text: string) => standInWords(text);
    expect(differences(said("She stays home. Marlow wins."), "She stays home.\nMarlow wins.")).toEqual([]);
    expect(differences(said("weekends draw fewer visits so"), "weekends draw fewer visitors so")).toEqual([{ written: "fewer visitors so", said: "fewer visits so" }]);
    // A number read aloud, a misheard name and a dropped last word, each reported with a word of context.
    expect(differences(said("because 400,000 readers left. Can Marlow wins"), "because four hundred thousand readers left. Ken Marlow wins big")).toEqual([
      { written: "because four hundred thousand readers", said: "because 400,000 readers" },
      { written: "left. Ken Marlow", said: "left. Can Marlow" },
      { written: "wins big", said: "wins" },
    ]);
  });

  it("puts a mis-hearing right everywhere it occurs, keeping the time the words took", () => {
    const heard = [
      { w: "Can", s: 1, e: 1.3 },
      { w: "Marlow", s: 1.3, e: 1.9 },
      { w: "wins.", s: 2, e: 2.4 },
      { w: "four", s: 3, e: 3.2 },
      { w: "hundred", s: 3.2, e: 3.6 },
      { w: "Can", s: 4, e: 4.2 },
      { w: "Marlow.", s: 4.2, e: 4.8 },
    ];
    const { words, unused } = applyCorrections(heard, [
      { heard: "can marlow", write: "Ken Marlow" },
      { heard: "four hundred", write: "400" },
      { heard: "Marlo", write: "Marlow" },
    ]);
    expect(words.map((w) => w.w)).toEqual(["Ken", "Marlow", "wins.", "400", "Ken", "Marlow"]);
    expect(words[0]).toEqual({ w: "Ken", s: 1, e: 1.3 });
    expect(words[1]).toEqual({ w: "Marlow", s: 1.3, e: 1.9 });
    // Two words became one: it takes the whole of their time.
    expect(words[3]).toEqual({ w: "400", s: 3, e: 3.6 });
    expect(unused).toEqual([{ heard: "Marlo", write: "Marlow" }]);
    expect(wordsSchema.safeParse(words).success).toBe(true);
  });
});
