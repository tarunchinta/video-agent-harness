import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineTool, ToolError } from "@harness/harness";
import { FILM_DIR, installKit } from "../kit.ts";
import { departureFrom } from "./script.ts";

const NARRATION_PATH = "script/narration.txt";

export const STAGES = ["research", "script", "assets", "edit"] as const;
export type Stage = (typeof STAGES)[number];

/** The review that can send each stage back to be done again. */
const REVIEW_GATE: Partial<Record<Stage, string>> = { script: "script", edit: "final_cut" };

const GUIDE: Record<Stage, string> = {
  research:
    "Find out what is true before deciding what to say. Use web_fetch on the sources you were given and on primary sources you know of, one question per call. " +
    "If you have web_search, use it to find primary sources, then read them with web_fetch. " +
    "Write what you found to research/notes.md: each fact with its figure and the address it came from. Note what is uncertain or disputed. " +
    "Use run_command for any calculation, and keep its script under research/. When you know enough to tell the story, start the script stage.",
  script:
    "Write two files. script/script.md: the working title, the hook, then each beat with what is said, what is on screen and which source backs it. " +
    "script/narration.txt: only the words to be spoken, one caption-sized line per line (about four to nine words). " +
    "Every number in the narration must be in research/notes.md with its source. When both are ready, call submit_script. The creator reads it and answers.",
  assets:
    "Call prepare_voiceover. It times every word of the creator's recording, or makes stand-in timing from the narration when there is no recording. " +
    "Read what it reports. Where a name or a term was misheard, call it again with corrections. Where the creator really said something else, the film follows the recording. Then start the edit stage.",
  edit:
    "Read film/kit/README.md first: it is the whole contract for the film page. Then write film/index.html, look at it with render_stills, and fix what you see. " +
    "Call render_film once the stills are right. A full render ends this revision. If you have review_cut, call it next: the critic's checks and scores decide whether the cut can be handed in.",
};

const exists = (path: string) => access(path).then(() => true, () => false);

/** Puts the creator's narration in place, unless the file already holds their words (perhaps on other lines). */
async function placeNarration(workDir: string, narration: string): Promise<void> {
  const path = join(workDir, NARRATION_PATH);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current !== undefined && !departureFrom(narration, current)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${narration.trim()}\n`, "utf8");
}

/**
 * Moves the run from one stage to the next. The order and the script review are enforced here, in code: the
 * model says which stage it is starting, and this decides whether it may.
 */
export const startStageToolWith = (opts: { narration?: string } = {}) => defineTool({
  name: "start_stage",
  description:
    "Start a stage of the work: research, script, assets or edit, in that order. Call it before doing that stage's work; the tools of a stage are refused until it is open. " +
    "Starting a stage that was finished before starts a new revision of it, for example to rework the script after the creator asked for changes, or to revise a rendered cut.",
  input: z.object({ stage: z.enum(STAGES).describe("The stage to start.") }),
  async execute({ stage }, exec) {
    const view = exec.run();
    if (view.stage?.name === stage) return { stage, revision: view.stage.revision, opened: false, selfRevisions: undefined as string | undefined };
    if ((stage === "assets" || stage === "edit") && view.gates.script !== "approved") {
      throw new ToolError("The creator has not approved the script yet.", "Finish the script and hand it in with submit_script.");
    }
    if (stage === "edit") {
      if (!(await exists(join(exec.workDir, FILM_DIR, "words.json")))) {
        throw new ToolError("There are no word timings yet, so the film has nothing to be timed to.", "Start the assets stage and call prepare_voiceover first.");
      }
      await installKit(exec.workDir);
    }
    // A narration the creator wrote is in place from the start, and put back if anything changed its words.
    if (opts.narration !== undefined && (stage === "research" || stage === "script")) await placeNarration(exec.workDir, opts.narration);
    const started = await exec.enterStage(stage, { reviewGate: REVIEW_GATE[stage] });
    const max = exec.run().limits.max_re_edits;
    const selfRevisions =
      stage === "edit" && started.trigger === "critique" && max !== undefined
        ? `This is revision ${started.revision}, started on your own judgement: ${exec.run().reEdits} of ${max} such revisions used.`
        : undefined;
    return { stage, revision: started.revision, opened: true, selfRevisions };
  },
  render(_input, value) {
    if (!value.opened) return `The ${value.stage} stage is already open (revision ${value.revision}). Carry on with it.`;
    const head = value.revision > 1 ? `Started revision ${value.revision} of the ${value.stage} stage.` : `Started the ${value.stage} stage.`;
    return [head, value.selfRevisions, GUIDE[value.stage]].filter(Boolean).join("\n\n");
  },
});

/** `start_stage` for a run whose narration the agent writes. */
export const startStageTool = startStageToolWith();
