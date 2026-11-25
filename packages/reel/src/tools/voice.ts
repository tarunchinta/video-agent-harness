import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, inStage, ToolError, type ToolExec } from "@harness/harness";
import { FILM_DIR, installKit, kitResult, SANDBOX_FILM_DIR } from "../kit.ts";
import { applyCorrections, differences, LEAD_IN, shiftWords, standInWords, wordsSchema, wordsScript, type Correction, type Difference, type Word } from "../words.ts";

/** Where the creator's recording is put, and the kinds of file it can be. */
export const INPUTS_DIR = "inputs";
export const VOICEOVER_NAME = "voiceover";
export const VOICEOVER_EXTENSIONS = [".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".webm"];
const NARRATION_PATH = "script/narration.txt";
/** What the recording was heard to say, kept so a correction does not time the whole recording again. */
const HEARD_FILE = "words.heard.json";
const MAX_DIFFERENCES = 12;

const heardSchema = z.object({ recording: z.string(), words: wordsSchema });

async function findRecording(workDir: string): Promise<string | undefined> {
  const names = await readdir(join(workDir, INPUTS_DIR)).catch(() => [] as string[]);
  return names.find((name) => name.toLowerCase().startsWith(`${VOICEOVER_NAME}.`) && VOICEOVER_EXTENSIONS.includes(extname(name).toLowerCase()));
}

/** Times the recording in the sandbox, cuts its lead-in and writes the voice track the film is mixed with. */
async function hear(exec: ToolExec, film: string, recording: string, vocabulary: string[]): Promise<Word[]> {
  const sandbox = await exec.sandbox();
  const source = `/work/${INPUTS_DIR}/${recording}`;
  const hint = vocabulary.join(", ");
  const aligned = await sandbox.exec(["python", "kit/align.py", source, "words.raw.json", ...(hint ? ["--vocabulary", hint] : [])], {
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
  await rm(join(film, "words.raw.json"), { force: true });
  return shiftWords(raw.data, lead);
}

type Prepared = {
  source: "recording" | "stand-in";
  words: number;
  seconds: number;
  transcript: string;
  differences: Difference[];
  moreDifferences: number;
  unused: Correction[];
};

/**
 * Turns the creator's recording into word times the film is cut to. With no recording it makes stand-in times
 * from the narration, so a film can still be laid out and rendered without a voice.
 */
export const prepareVoiceoverTool = defineTool({
  name: "prepare_voiceover",
  description:
    "Time every word of the creator's voiceover, so the film can be cut to it. Uses the recording the creator gave when they approved the script. " +
    "If they gave none, it makes stand-in timing from the narration and the film is rendered without a voice. " +
    "Writes film/words.json (each word with its start and end in seconds) and reports what was said and where that differs from the narration. " +
    "The timing tool can mishear a name or a term: call this again with `corrections` to put those right. Do not correct what the creator really said differently.",
  input: z.object({
    vocabulary: z.array(z.string().min(1).max(60)).max(40).default([]).describe("Names and unusual terms in the narration, spelled as they should appear."),
    corrections: z
      .array(z.object({ heard: z.string().min(1).max(120).describe("The words as the report gave them."), write: z.string().min(1).max(120).describe("What was actually said.") }))
      .max(40)
      .default([])
      .describe('Mis-hearings to put right, for example { heard: "Jon Smyth", write: "John Smith" }.'),
  }),
  sandboxed: true,
  requires: [gateApproved("script"), inStage("assets", "edit")],
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
      await rm(join(film, HEARD_FILE), { force: true });
      await save(words);
      return { source: "stand-in", words: words.length, seconds: words.at(-1)!.e, transcript: "", differences: [], moreDifferences: 0, unused: [] };
    }

    // The same recording is timed once. A later call, with corrections, starts from what was heard then.
    const fingerprint = createHash("sha256").update(await readFile(join(exec.workDir, INPUTS_DIR, recording))).digest("hex");
    const kept = heardSchema.safeParse(await readFile(join(film, HEARD_FILE), "utf8").then(JSON.parse, () => undefined));
    let heard: Word[];
    if (kept.success && kept.data.recording === fingerprint) heard = kept.data.words;
    else {
      heard = await hear(exec, film, recording, input.vocabulary);
      await writeFile(join(film, HEARD_FILE), JSON.stringify({ recording: fingerprint, words: heard }), "utf8");
    }

    const corrected = applyCorrections(heard, input.corrections);
    await save(corrected.words);
    const all = differences(corrected.words, narration);
    return {
      source: "recording",
      words: corrected.words.length,
      seconds: corrected.words.at(-1)!.e,
      transcript: corrected.words.map((word) => word.w).join(" "),
      differences: all.slice(0, MAX_DIFFERENCES),
      moreDifferences: Math.max(0, all.length - MAX_DIFFERENCES),
      unused: corrected.unused,
    };
  },
  render(_input, value) {
    if (value.source === "stand-in") {
      return (
        `There is no recording, so the timing is a stand-in made from the narration: ${value.words} words over ${value.seconds.toFixed(1)} seconds. ` +
        "The film will have captions and no voice. Timings are in film/words.json."
      );
    }
    const parts = [`Timed ${value.words} words over ${value.seconds.toFixed(1)} seconds from the creator's recording. Timings are in film/words.json.`];
    if (value.unused.length) {
      parts.push(`These corrections matched nothing and were not applied: ${value.unused.map((c) => `"${c.heard}"`).join(", ")}. Copy the words exactly as the report gives them.`);
    }
    if (!value.differences.length) parts.push("What was heard matches the narration word for word.");
    else {
      const rows = value.differences.map((d) => `- written: "${d.written}"  heard: "${d.said}"`);
      const more = value.moreDifferences ? `\n(and ${value.moreDifferences} more)` : "";
      parts.push(
        `Where what was heard differs from the narration:\n${rows.join("\n")}${more}\n` +
          "A number written out in the narration and heard as digits is fine: use the heard form in cues and captions. " +
          "If a name or a term was misheard, call prepare_voiceover again with corrections. " +
          "If the creator really said something else, leave it: cues and captions follow what was said.",
      );
    }
    parts.push(`What was heard:\n${value.transcript}`);
    return parts.join("\n\n");
  },
});
