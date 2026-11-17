import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, inStage, ToolError, type ToolExec } from "@harness/harness";
import { FILM_DIR, installKit, kitResult, SANDBOX_FILM_DIR } from "../kit.ts";

export const CUTS_DIR = "cuts";
export const cutPath = (revision: number) => `${CUTS_DIR}/cut-${revision}.mp4`;

const requires = [gateApproved("script"), inStage("edit")];

async function render(exec: ToolExec, args: string[], timeoutMs: number, what: string): Promise<Record<string, unknown>> {
  await installKit(exec.workDir);
  const sandbox = await exec.sandbox();
  const result = await sandbox.exec(["node", "kit/render.mjs", ...args], { cwd: SANDBOX_FILM_DIR, timeoutMs, signal: exec.signal });
  return kitResult(result, what);
}

const stillsSchema = z.object({
  duration: z.number(),
  stills: z.array(z.object({ n: z.number(), t: z.number(), cue: z.string().optional(), file: z.string() })).max(40),
  sheet: z.string(),
});

/** A cheap look at the film: single frames, on one contact sheet the model is shown. */
export const renderStillsTool = defineTool({
  name: "render_stills",
  description:
    "Draw single frames of the film and look at them on one contact sheet. With no times it takes one frame just after each named cue. " +
    "Give times, in seconds, to look closely at particular moments: fewer frames are drawn larger. Takes a few seconds; use it as often as you need while editing.",
  input: z.object({
    times: z.array(z.number().min(0).max(600)).max(24).default([]).describe("Seconds into the film. Leave empty for one frame per cue."),
  }),
  sandboxed: true,
  readOnly: true,
  idempotent: true,
  requires,
  timeoutMs: 6 * 60_000,
  async execute(input, exec) {
    const raw = await render(exec, ["--stills", ...input.times.map((t) => String(t))], 5 * 60_000, "Drawing the stills");
    const parsed = stillsSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError("The stills came back in a shape that cannot be used.", "Try again.");
    return parsed.data;
  },
  render(_input, value) {
    const rows = value.stills.map((s) => `${s.n}. ${s.t.toFixed(2)} s${s.cue ? ` (${s.cue})` : ""}: ${FILM_DIR}/${s.file}`);
    return `The film is ${value.duration.toFixed(1)} seconds long. ${value.stills.length} frames, shown on the contact sheet in this order:\n${rows.join("\n")}\n\nUse view_image on one of the files to see it at full size.`;
  },
  images: (_input, value) => [`${FILM_DIR}/${value.sheet}`],
});

const filmSchema = z.object({
  film: z.string(),
  sheet: z.string(),
  duration: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  bytes: z.number(),
  voice: z.boolean(),
  sound_effects: z.number(),
  missing_sound_effects: z.array(z.string()).max(50),
  render_seconds: z.number(),
});

/**
 * The full render. It ends the revision of the edit it belongs to: the cut is kept under `cuts/`, and another
 * render needs a new revision, which the loop counts against the run's re-edit limit.
 */
export const renderFilmTool = defineTool({
  name: "render_film",
  description:
    "Render the whole film to a video file, with the voiceover and sound effects. Takes a few minutes. " +
    "This finishes the current revision of the edit: you are shown a contact sheet cut from the finished file, and the cut is saved. " +
    "After it, either hand the cut in with submit_cut, or start the edit stage again to revise it. Call it only when the stills are right.",
  input: z.object({}),
  sandboxed: true,
  requires,
  timeoutMs: 45 * 60_000,
  async execute(_input, exec) {
    const revision = exec.run().stage!.revision;
    const raw = await render(exec, ["--film"], 40 * 60_000, "Rendering the film");
    const parsed = filmSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError("The render finished, but its report cannot be used.", "Render again.");
    const saved = cutPath(revision);
    await mkdir(join(exec.workDir, CUTS_DIR), { recursive: true });
    await copyFile(join(exec.workDir, FILM_DIR, parsed.data.film), join(exec.workDir, saved));
    await exec.completeStage();
    const view = exec.run();
    return { ...parsed.data, revision, saved, reEdits: view.reEdits, maxReEdits: view.limits.max_re_edits };
  },
  render(_input, v) {
    const size = v.width && v.height ? `${v.width} by ${v.height}, ` : "";
    const sound = v.voice ? "with the voiceover" : "with no voice (stand-in timing)";
    const missing = v.missing_sound_effects.length ? ` These sound effects have no file and were left out: ${[...new Set(v.missing_sound_effects)].join(", ")}.` : "";
    const left =
      v.maxReEdits === undefined
        ? ""
        : v.reEdits >= v.maxReEdits
          ? " You have no revisions of your own left, so hand this cut in."
          : ` You may revise it on your own judgement ${v.maxReEdits - v.reEdits} more ${v.maxReEdits - v.reEdits === 1 ? "time" : "times"}.`;
    return (
      `Rendered cut ${v.revision}: ${v.duration.toFixed(1)} seconds, ${size}${(v.bytes / 1_000_000).toFixed(1)} MB, ${sound}. Saved as ${v.saved}.${missing}\n\n` +
      "The contact sheet shows twelve frames taken from the finished file, in order. Check it against the script: is every beat there, readable, and on the right words? " +
      `If it is right, call submit_cut. If not, call start_stage with stage edit to start a new revision.${left}`
    );
  },
  images: (_input, value) => [`${FILM_DIR}/${value.sheet}`],
});
