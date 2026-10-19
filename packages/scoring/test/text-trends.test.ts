import { describe, expect, it } from "vitest";
import { canonicalUrl, contentWords, jaccard, spokenHook, transcriptFingerprint } from "../src/index.ts";

describe("text helpers", () => {
  it("extracts stemmed content words without stop words, URLs or numbers", () => {
    expect(contentWords("Hiring contractors? 3 mistakes https://example.com/x when you are hiring #permits")).toEqual([
      "hir", "contractor", "mistak", "permit",
    ]);
    expect(contentWords(null)).toEqual([]);
  });
  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["a"], ["a"])).toBe(1);
  });
  it("fingerprints transcripts so trial variants collide", () => {
    const a = transcriptFingerprint("[music] Here's the ONE permit mistake that costs you a month!");
    const b = transcriptFingerprint("Here's the one permit mistake that costs you a month ♪la la♪");
    expect(a).toBe(b);
    expect(transcriptFingerprint("")).toBe("");
    expect(transcriptFingerprint("x".repeat(500)).length).toBe(220);
  });
  it("extracts the spoken hook", () => {
    expect(spokenHook("Okay. Stop pouring footings before the inspection. Here is why. It matters.")).toBe(
      "Okay. Stop pouring footings before the inspection.",
    );
    expect(spokenHook("one two three four five six", 3)).toBe("one two three");
    expect(spokenHook(undefined)).toBe("");
  });
  it("canonicalises URLs", () => {
    expect(canonicalUrl("https://WWW.Example.com/a/b/?utm_source=x&id=3#frag")).toBe("example.com/a/b?id=3");
    expect(canonicalUrl("not a url ")).toBe("not a url");
  });
});
