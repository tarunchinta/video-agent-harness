import { z } from "zod";
import { fileTools, gateApproved, runCommandTool, viewImageTool, type Precondition, type SearchProvider, type ToolDefinition } from "@harness/harness";
import { reviewCutTool } from "./tools/critic.ts";
import { submitCutToolWith } from "./tools/cut.ts";
import { renderFilmTool, renderStillsTool } from "./tools/render.ts";
import { webFetchTool, type WebFetchDeps } from "./tools/research.ts";
import { webSearchTool } from "./tools/search.ts";
import { submitScriptToolWith } from "./tools/script.ts";
import { startStageToolWith } from "./tools/stage.ts";
import { prepareVoiceoverTool } from "./tools/voice.ts";

export { FILM_DIR, installKit } from "./kit.ts";
export { REEL_SYSTEM, reelTask, type ReelBrief } from "./prompt.ts";
export { checkCut, passes, readReview, reviewCutTool, reviewPath, RUBRIC, type Check, type Review, type RubricKey } from "./tools/critic.ts";
export { submitCutTool, submitCutToolWith } from "./tools/cut.ts";
export { webSearchTool } from "./tools/search.ts";
export { CUTS_DIR, cutPath, renderFilmTool, renderStillsTool } from "./tools/render.ts";
export { htmlToText, isPrivateAddress, publicFetch, webFetchTool, type WebFetchDeps } from "./tools/research.ts";
export { departureFrom, MAX_LINE_WORDS, MAX_WORDS, MIN_WORDS, submitScriptTool, submitScriptToolWith, WORDS_PER_SECOND } from "./tools/script.ts";
export { STAGES, startStageTool, startStageToolWith, type Stage } from "./tools/stage.ts";
export { INPUTS_DIR, prepareVoiceoverTool, VOICEOVER_EXTENSIONS, VOICEOVER_NAME } from "./tools/voice.ts";
export { applyCorrections, differences, narrationWords, normWord, standInWords, wordsSchema, type Correction, type Difference, type Word } from "./words.ts";

/** Recorded on a run so a later worker knows to build these tools again. */
export const REEL_PIPELINE = "reel";

/** What the agent hands to `finish`. */
export const reelFinishSchema = z.object({
  summary: z.string().min(1).describe("What the reel is about and what was made, in a few plain sentences."),
  film: z.string().min(1).describe("Path of the approved cut, for example cuts/cut-2.mp4."),
});

const finalCutApproved: Precondition = {
  ...gateApproved("final_cut"),
  message: "The creator has not approved the final cut. Hand it in with submit_cut and wait for their answer.",
};

export type ReelPipeline = {
  tools: ToolDefinition[];
  finishSchema: typeof reelFinishSchema;
  /** A reel run cannot finish before the creator has approved the cut. */
  finishRequires: Precondition[];
};

export type ReelPipelineDeps = {
  web?: WebFetchDeps;
  /** Adds `web_search`. Without one, research starts from the sources in the brief and what the model knows. */
  search?: SearchProvider;
  /**
   * The critic: `review_cut`, and a `submit_cut` that needs a review first. On for every reel created since the
   * critic existed; the run records it, so a resumed run gets the same rule it started with.
   */
  critic?: boolean;
  /**
   * The creator's own narration, when they wrote and recorded it themselves. It is put in place for the agent,
   * and `submit_script` refuses a narration that changes its words. The run records it, like the critic.
   */
  narration?: string;
};

/** Everything the engine needs to run the reel pipeline: the tools and the conditions on finishing. */
export function reelPipeline(deps: ReelPipelineDeps = {}): ReelPipeline {
  const critic = deps.critic ?? true;
  const narration = deps.narration !== undefined ? { narration: deps.narration } : {};
  const tools = [
    ...fileTools,
    viewImageTool,
    runCommandTool,
    startStageToolWith(narration),
    webFetchTool(deps.web),
    ...(deps.search ? [webSearchTool(deps.search)] : []),
    submitScriptToolWith(narration),
    prepareVoiceoverTool,
    renderStillsTool,
    renderFilmTool,
    ...(critic ? [reviewCutTool] : []),
    submitCutToolWith({ requireReview: critic }),
  ] as ToolDefinition[];
  return { tools, finishSchema: reelFinishSchema, finishRequires: [finalCutApproved] };
}
