import { z } from "zod";
import { fileTools, gateApproved, runCommandTool, viewImageTool, type Precondition, type ToolDefinition } from "@harness/harness";
import { submitCutTool } from "./tools/cut.ts";
import { renderFilmTool, renderStillsTool } from "./tools/render.ts";
import { webFetchTool, type WebFetchDeps } from "./tools/research.ts";
import { submitScriptTool } from "./tools/script.ts";
import { startStageTool } from "./tools/stage.ts";
import { prepareVoiceoverTool } from "./tools/voice.ts";

export { FILM_DIR, installKit } from "./kit.ts";
export { REEL_SYSTEM, reelTask, type ReelBrief } from "./prompt.ts";
export { submitCutTool } from "./tools/cut.ts";
export { CUTS_DIR, cutPath, renderFilmTool, renderStillsTool } from "./tools/render.ts";
export { htmlToText, isPrivateAddress, webFetchTool, type WebFetchDeps } from "./tools/research.ts";
export { submitScriptTool, WORDS_PER_SECOND } from "./tools/script.ts";
export { STAGES, startStageTool, type Stage } from "./tools/stage.ts";
export { INPUTS_DIR, prepareVoiceoverTool, VOICEOVER_EXTENSIONS, VOICEOVER_NAME } from "./tools/voice.ts";
export { firstDifference, narrationWords, normWord, standInWords, wordsSchema, type Word } from "./words.ts";

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

/** Everything the engine needs to run the reel pipeline: the tools and the conditions on finishing. */
export function reelPipeline(deps: { web?: WebFetchDeps } = {}): ReelPipeline {
  const tools = [
    ...fileTools,
    viewImageTool,
    runCommandTool,
    startStageTool,
    webFetchTool(deps.web),
    submitScriptTool,
    prepareVoiceoverTool,
    renderStillsTool,
    renderFilmTool,
    submitCutTool,
  ] as ToolDefinition[];
  return { tools, finishSchema: reelFinishSchema, finishRequires: [finalCutApproved] };
}
