import { describe, expect, it } from "vitest";
import { splitUtf8 } from "../src/index.ts";

describe("splitting typed text for NOTIFY", () => {
  it("keeps every piece under the byte limit without cutting a character", () => {
    const text = `ab${"é".repeat(5)}🎬c`;
    const parts = splitUtf8(text, 4);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(4);
    expect(parts).toContain("🎬");
  });

  it("sends nothing for no text", () => {
    expect(splitUtf8("", 10)).toEqual([]);
  });
});
