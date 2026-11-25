import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, ToolError, type ToolExec } from "@harness/harness";
import { FILM_DIR, installKit, kitResult, SANDBOX_FILM_DIR } from "../kit.ts";
import { CUTS_DIR, cutPath } from "./render.ts";

/**
 * The critic. It watches the cut the way a viewer gets it: the file, measured in the sandbox, and a timeline of
 * frames taken from the file with the words spoken over each. Two kinds of judgement come out of it:
 *
 * - Checks in code, which can fail a cut on their own: black picture, a frozen picture, a late hook, a film that
 *   runs on past its words or ends before them, sound that clips, the wrong frame size.
 * - A rubric scored by a separate model call that has no tools and none of this conversation: hook, pacing,
 *   sync, legibility and grounding, each from 1 to 5, with notes at the second they apply to.
 *
 * Whether the cut passes is decided here, in code, from both: no failing check, no score under 3, and an average
 * of at least 3.5. The model's scores are evidence; the rule is not the model's to bend.
 */

export const reviewPath = (revision: number) => `${CUTS_DIR}/review-${revision}.json`;

export const RUBRIC = ["hook", "pacing", "sync", "legibility", "grounding"] as const;
export type RubricKey = (typeof RUBRIC)[number];

const PASS_MIN = 3;
const PASS_MEAN = 3.5;

const span = z.object({ start: z.number(), end: z.number() });
const measuredSchema = z.object({
  duration: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  audio: z.boolean(),
  black: z.array(span).max(200),
  freezes: z.array(span).max(200),
  silences: z.array(span).max(200),
  loudness: z.object({ integrated_lufs: z.number().nullable(), true_peak_db: z.number().nullable() }).nullable(),
  first_word: z.number().nullable(),
  last_word: z.number().nullable(),
  frames: z.array(z.object({ n: z.number(), t: z.number(), words: z.string() })).max(40),
  sheet: z.string(),
});
type Measured = z.infer<typeof measuredSchema>;

const scoreSchema = z.object({ score: z.number().int().min(1).max(5), why: z.string().max(240) });
const judgedSchema = z.object({
  scores: z.object({ hook: scoreSchema, pacing: scoreSchema, sync: scoreSchema, legibility: scoreSchema, grounding: scoreSchema }),
  notes: z.array(z.object({ at: z.number().min(0).max(600), issue: z.string().max(240) })).max(10),
  summary: z.string().max(400),
});

export type Check = { ok: boolean; severity: "fail" | "note"; what: string };

/** The checks code makes on the measurements alone. Exported so the rules can be read and tested on their own. */
export function checkCut(m: Measured, voice: boolean): Check[] {
  const out: Check[] = [];
  const fail = (what: string) => out.push({ ok: false, severity: "fail", what });
  const note = (what: string) => out.push({ ok: false, severity: "note", what });
  if (m.width !== undefined && m.height !== undefined && (m.width !== 1080 || m.height !== 1920)) {
    fail(`The frame is ${m.width} by ${m.height}; a reel is 1080 by 1920.`);
  }
  for (const b of m.black) {
    if (b.end - b.start >= 0.5 && b.start < m.duration - 0.6) fail(`The picture is black from ${b.start.toFixed(1)} to ${b.end.toFixed(1)} s.`);
  }
  for (const f of m.freezes) {
    const length = f.end - f.start;
    if (length >= 4) fail(`Nothing on screen moves from ${f.start.toFixed(1)} to ${f.end.toFixed(1)} s (${length.toFixed(1)} s).`);
    else note(`The picture holds still from ${f.start.toFixed(1)} to ${f.end.toFixed(1)} s.`);
  }
  if (m.first_word !== null && m.first_word > 1.0) fail(`The first word is not heard until ${m.first_word.toFixed(1)} s; the hook has to land in the first second.`);
  if (m.last_word !== null) {
    if (m.duration < m.last_word - 0.1) fail(`The film ends at ${m.duration.toFixed(1)} s, before the last word at ${m.last_word.toFixed(1)} s.`);
    else if (m.duration - m.last_word > 2.5) fail(`The film runs on for ${(m.duration - m.last_word).toFixed(1)} s after the last word.`);
  }
  if (voice && m.loudness) {
    const { integrated_lufs: lufs, true_peak_db: peak } = m.loudness;
    if (peak !== null && peak > -1) fail(`The sound peaks at ${peak.toFixed(1)} dB, so it will clip; keep it under -1 dB.`);
    if (lufs !== null && (lufs < -18 || lufs > -10)) note(`The sound is at ${lufs.toFixed(1)} LUFS; phones expect about -14.`);
    if (m.last_word !== null && m.first_word !== null) {
      for (const s of m.silences) {
        if (s.start > m.first_word && s.end < m.last_word && s.end - s.start > 1.5) note(`The voice goes quiet from ${s.start.toFixed(1)} to ${s.end.toFixed(1)} s.`);
      }
    }
  }
  return out;
}

export type Review = {
  revision: number;
  cut: string;
  passed: boolean;
  checks: Check[];
  scores: Record<RubricKey, { score: number; why: string }>;
  mean: number;
  notes: { at: number; issue: string }[];
  summary: string;
};

/** Whether a cut passes, from the checks and the scores. The only place the rule lives. */
export function passes(checks: Check[], scores: Record<RubricKey, { score: number }>): { passed: boolean; mean: number } {
  const values = RUBRIC.map((k) => scores[k].score);
  const mean = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
  const passed = checks.every((c) => c.severity !== "fail") && values.every((v) => v >= PASS_MIN) && mean >= PASS_MEAN;
  return { passed, mean };
}

/** The review of a revision, if one was made. */
export async function readReview(workDir: string, revision: number): Promise<Review | undefined> {
  try {
    return JSON.parse(await readFile(join(workDir, reviewPath(revision)), "utf8")) as Review;
  } catch {
    return undefined;
  }
}

const excerpt = async (workDir: string, path: string, max: number) => {
  const text = await readFile(join(workDir, path), "utf8").catch(() => "");
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
};

const RUBRIC_TEXT = `Score each from 1 (fails) to 5 (excellent):
- hook: do the first two seconds give a viewer a reason to stay? Is the most surprising true thing said plainly, with a strong picture?
- pacing: does something on screen change every two or three seconds, without rushing past what matters?
- sync: does each picture change on the word that names it? Do captions match what is being said at that moment?
- legibility: can every caption, label and number be read on a phone at a glance? Nothing cut off, overlapping, too small, or in the top 220 or bottom 300 pixels?
- grounding: is every figure on screen and in the narration supported by the research notes, with nothing invented?
Then list specific problems at the second they happen (at most ten), and sum up in one or two sentences what most needs fixing.`;

async function measure(exec: ToolExec, cut: string): Promise<Measured> {
  await installKit(exec.workDir);
  const sandbox = await exec.sandbox();
  const result = await sandbox.exec(["node", "kit/review.mjs", `../${cut}`], { cwd: SANDBOX_FILM_DIR, timeoutMs: 10 * 60_000, signal: exec.signal });
  const parsed = measuredSchema.safeParse(kitResult(result, "Measuring the cut"));
  if (!parsed.success) throw new ToolError("The cut was measured, but the report cannot be used.", "Try the review again.");
  return parsed.data;
}

export const reviewCutTool = defineTool({
  name: "review_cut",
  description:
    "Have the critic watch the cut you last rendered. It measures the file (black or frozen picture, a late hook, the ending, the sound) and scores it against the rubric: " +
    "hook, pacing, sync, legibility and grounding, with notes at the second each problem happens. Code decides whether it passes. " +
    "Call it after render_film and before submit_cut. If it does not pass, start the edit stage again, fix what it found, render and review again.",
  input: z.object({}),
  sandboxed: true,
  idempotent: true,
  requires: [gateApproved("script")],
  timeoutMs: 15 * 60_000,
  async execute(_input, exec) {
    const view = exec.run();
    const revision = view.stageRevisions.edit;
    if (!revision) throw new ToolError("No cut has been rendered yet.", "Start the edit stage, build the film and call render_film.");
    if (view.stage?.name === "edit") throw new ToolError("A revision of the edit is open and has not been rendered.", "Call render_film first, then review that cut.");
    const cut = cutPath(revision);
    if (!(await stat(join(exec.workDir, cut)).catch(() => undefined))?.isFile()) {
      throw new ToolError(`The rendered cut is missing from ${cut}.`, "Start the edit stage and render it again.");
    }
    const voice = await stat(join(exec.workDir, FILM_DIR, "vo.m4a")).then(() => true, () => false);
    const measured = await measure(exec, cut);
    const checks = checkCut(measured, voice);

    const timeline = measured.frames.map((f) => `${f.n}. ${f.t.toFixed(1)} s: ${f.words || "(no words)"}`).join("\n");
    const facts = [
      `Length: ${measured.duration.toFixed(1)} s, ${measured.width ?? "?"} by ${measured.height ?? "?"}, ${voice ? "with the creator's voice" : "with no voice (captions only)"}.`,
      ...checks.map((c) => `${c.severity === "fail" ? "Fails a check" : "Note"}: ${c.what}`),
    ].join("\n");
    const material = [
      "## The narration",
      await excerpt(exec.workDir, "script/narration.txt", 4_000),
      "## The script, beat by beat",
      await excerpt(exec.workDir, "script/script.md", 6_000),
      "## The research notes the figures must come from",
      await excerpt(exec.workDir, "research/notes.md", 6_000),
      "## What was measured in the file",
      facts,
      "## The timeline sheet",
      "The picture shows frames taken from the finished file, numbered in order, each labelled with its time and the words being spoken then:",
      timeline,
    ].join("\n\n");
    const judged = await exec.judge({
      instructions: `You are the critic for a short vertical video, a reel. Judge the cut from the timeline sheet and the material below.\n\n${RUBRIC_TEXT}`,
      material,
      schema: judgedSchema,
      images: [`${FILM_DIR}/${measured.sheet}`],
    });
    const { passed, mean } = passes(checks, judged.scores);
    const review: Review = { revision, cut, passed, checks, scores: judged.scores, mean, notes: judged.notes, summary: judged.summary };
    await writeFile(join(exec.workDir, reviewPath(revision)), `${JSON.stringify(review, null, 2)}\n`);
    const left = view.limits.max_re_edits === undefined ? undefined : Math.max(0, view.limits.max_re_edits - view.reEdits);
    return { ...review, path: reviewPath(revision), reEditsLeft: left };
  },
  render(_input, r) {
    const scores = RUBRIC.map((k) => `- ${k}: ${r.scores[k].score} of 5. ${r.scores[k].why}`).join("\n");
    const fails = r.checks.filter((c) => c.severity === "fail").map((c) => `- ${c.what}`);
    const notes = [...r.checks.filter((c) => c.severity === "note").map((c) => `- ${c.what}`), ...r.notes.map((n) => `- At ${n.at.toFixed(1)} s: ${n.issue}`)];
    const next = r.passed
      ? "Hand it in with submit_cut."
      : r.reEditsLeft === 0
        ? "You have no revisions of your own left, so hand it in with submit_cut: the review goes with it."
        : "Start the edit stage again, fix what the critic found, render and review again.";
    return [
      `The critic ${r.passed ? "passed" : "did not pass"} cut ${r.revision} (average ${r.mean.toFixed(1)} of 5). Saved as ${r.path}.`,
      r.summary,
      `Scores:\n${scores}`,
      fails.length ? `Checks it fails:\n${fails.join("\n")}` : "",
      notes.length ? `Notes:\n${notes.join("\n")}` : "",
      next,
    ]
      .filter(Boolean)
      .join("\n\n");
  },
  images: () => [`${FILM_DIR}/out/critique/sheet.jpg`],
});
