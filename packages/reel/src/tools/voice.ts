import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, inStage, ToolError } from "@harness/harness";
import { FILM_DIR, installKit, kitResult, SANDBOX_FILM_DIR } from "../kit.ts";
import { firstDifference, LEAD_IN, shiftWords, standInWords, wordsSchema, wordsScript, type Word } from "../words.ts";

/** Where the creator's recording is put, and the kinds of file it can be. */
export const INPUTS_DIR = "inputs";
export const VOICEOVER_NAME = "voiceover";
export const VOICEOVER_EXTENSIONS = [".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".webm"];
const NARRATION_PATH = "script/narration.txt";

async function findRecording(workDir: string): Promise<string | undefined> {
  const names = await readdir(join(workDir, INPUTS_DIR)).catch(() => [] as string[]);
  return names.find((name) => name.toLowerCase().startsWith(`${VOICEOVER_NAME}.`) && VOICEOVER_EXTENSIONS.includes(extname(name).toLowerCase()));
}

type Prepared = { source: "recording" | "stand-in"; words: number; seconds: number; transcript: string; difference?: { written: string; said: string } };

/**
 * Turns the creator's recording into word times the film is cut to. With no recording it makes stand-in times
 * from the narration, so a film can still be laid out and rendered without a voice.
 */
export const prepareVoiceoverTool = defineTool({
  name: "prepare_voiceover",
  description:
    "Time every word of the creator's voiceover, so the film can be cut to it. Uses the recording the creator gave when they approved the script. " +
    "If they gave none, it makes stand-in timing from the narration and the film is rendered without a voice. " +
    "Writes film/words.json (each word with its start and end in seconds) and reports what was actually said.",
  input: z.object({
    vocabulary: z.array(z.string().min(1).max(60)).max(40).default([]).describe("Names and unusual terms in the narration, spelled as they should appear."),
  }),
  sandboxed: true,
  requires: [gateApproved("script"), inStage("assets")],
  timeoutMs: 20 * 60_000,
  async execute(input, exec): Promise<Prepared> {
    await installKit(exec.workDir);
    const film = join(exec.workDir, FILM_DIR);
    const narration = await readFile(join(exec.workDir, NARRATION_PATH), "utf8").catch(() => {
      throw new ToolError(`There is no narration at ${NARRATION_PATH}.`);
    });
    const save = async (words: Word[]) => {
      await writeFile(join(film, "words.json"), `${JSON.stringify(words, null, 1)}\n`, "utf8");
      await writeFile(join(film, "words.js"), wordsScript(words), "utf8");
    };

    const recording = await findRecording(exec.workDir);
    if (!recording) {
      const words = standInWords(narration);
      await rm(join(film, "vo.m4a"), { force: true });
      await save(words);
      return { source: "stand-in", words: words.length, seconds: words.at(-1)!.e, transcript: "" };
    }

    const sandbox = await exec.sandbox();
    const source = `/work/${INPUTS_DIR}/${recording}`;
    const vocabulary = input.vocabulary.join(", ");
    const aligned = await sandbox.exec(["python", "kit/align.py", source, "words.raw.json", ...(vocabulary ? ["--vocabulary", vocabulary] : [])], {
      cwd: SANDBOX_FILM_DIR,
      timeoutMs: 15 * 60_000,
      signal: exec.signal,
    });
    kitResult(aligned, "Timing the voiceover");
    const raw = wordsSchema.safeParse(JSON.parse(await readFile(join(film, "words.raw.json"), "utf8")));
    if (!raw.success) throw new ToolError("The word timings came back in a shape that cannot be used.", "Try again.");

    // Cut the silence before the first word, so the film starts when the voice does.
    const lead = Math.max(0, raw.data[0]!.s - LEAD_IN);
    const encoded = await sandbox.exec(
      ["ffmpeg", "-v", "error", "-y", "-ss", lead.toFixed(3), "-i", source, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "vo.m4a"],
      { cwd: SANDBOX_FILM_DIR, timeoutMs: 5 * 60_000, signal: exec.signal },
    );
    if (encoded.exitCode !== 0) throw new ToolError(`The recording could not be read as audio.${encoded.stderr ? `\n${encoded.stderr.slice(-600)}` : ""}`);
    const words = shiftWords(raw.data, lead);
    await save(words);
    await rm(join(film, "words.raw.json"), { force: true });
    const difference = firstDifference(words, narration);
    return {
      source: "recording",
      words: words.length,
      seconds: words.at(-1)!.e,
      transcript: words.map((word) => word.w).join(" "),
      ...(difference ? { difference: { written: difference.written, said: difference.said } } : {}),
    };
  },
  render(_input, value) {
    if (value.source === "stand-in") {
      return (
        `There is no recording, so the timing is a stand-in made from the narration: ${value.words} words over ${value.seconds.toFixed(1)} seconds. ` +
        "The film will have captions and no voice. Timings are in film/words.json."
      );
    }
    const differs = value.difference
      ? `The recording does not match the narration word for word. The first difference: the narration has "${value.difference.written}" where the recording says "${value.difference.said}". ` +
        "Cues and caption lines must use the recording's words."
      : "The recording matches the narration word for word.";
    return `Timed ${value.words} words over ${value.seconds.toFixed(1)} seconds from the creator's recording. Timings are in film/words.json.\n${differs}\n\nWhat was said:\n${value.transcript}`;
  },
});
