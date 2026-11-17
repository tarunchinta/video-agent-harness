import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, inStage, resolveInside, ToolError } from "@harness/harness";
import { narrationWords } from "../words.ts";

/** Reading pace used to guess a film's length from its narration, in words per second. */
export const WORDS_PER_SECOND = 2.6;
const MIN_WORDS = 25;
const MAX_WORDS = 520;
const MAX_LINE_WORDS = 14;

async function readText(workDir: string, path: string, what: string): Promise<string> {
  try {
    return await readFile(resolveInside(workDir, path), "utf8");
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`There is no ${what} at "${path}".`, "Write it first.");
  }
}

/**
 * Gate 1. Hands the script to the creator and stops the run until they answer. The answer comes back as this
 * call's result: approved, changes requested (with their notes), or the run ends if they reject it.
 */
export const submitScriptTool = defineTool({
  name: "submit_script",
  description:
    "Hand the script to the creator for review. The run stops until they answer, and their answer is this call's result: approved, or changes requested with their notes. " +
    "Nothing after the script (voiceover, film) can start until it is approved. If they ask for changes, start the script stage again, revise and hand it in again.",
  input: z.object({
    script_path: z.string().default("script/script.md").describe("The script: hook, beats, what is on screen, sources."),
    narration_path: z.string().default("script/narration.txt").describe("Only the spoken words, one caption-sized line per line."),
  }),
  requires: [inStage("script")],
  async execute(input, exec) {
    const script = await readText(exec.workDir, input.script_path, "script");
    const narration = await readText(exec.workDir, input.narration_path, "narration");
    if (script.trim().length < 200) throw new ToolError("The script is too short to review.", "Write the hook, every beat and its sources.");
    const words = narrationWords(narration).length;
    if (words < MIN_WORDS) throw new ToolError(`The narration has ${words} words. A reel needs at least ${MIN_WORDS}.`);
    if (words > MAX_WORDS) throw new ToolError(`The narration has ${words} words, which is over three minutes of speech.`, `Cut it to ${MAX_WORDS} words or fewer.`);
    const long = narration.split("\n").map((line) => line.trim()).filter((line) => narrationWords(line).length > MAX_LINE_WORDS);
    if (long.length) {
      throw new ToolError(
        `${long.length} ${long.length === 1 ? "line" : "lines"} of the narration ${long.length === 1 ? "is" : "are"} too long to be one caption, starting with: "${long[0]!.slice(0, 80)}".`,
        `Break the narration into lines of ${MAX_LINE_WORDS} words or fewer.`,
      );
    }
    return exec.gate(
      "script",
      { files: [input.script_path, input.narration_path], words, estimated_seconds: Math.round(words / WORDS_PER_SECOND) },
      { completeStage: true },
    );
  },
});
