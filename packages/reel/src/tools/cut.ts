import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, ToolError } from "@harness/harness";
import { cutPath } from "./render.ts";

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Gate 2. Hands the latest rendered cut to the creator and stops the run until they answer. The hash of the
 * file goes into the log with the request, so the record says exactly which bytes were approved.
 */
export const submitCutTool = defineTool({
  name: "submit_cut",
  description:
    "Hand the latest rendered cut to the creator for review. The run stops until they answer, and their answer is this call's result: approved, or changes requested with their notes. " +
    "If they ask for changes, start the edit stage again, make them and render again. Once it is approved, call finish.",
  input: z.object({
    note: z.string().max(600).default("").describe("What the creator should know before watching: anything you are unsure of, or that differs from the script."),
  }),
  requires: [gateApproved("script")],
  async execute(input, exec) {
    const view = exec.run();
    const revision = view.stageRevisions.edit;
    if (!revision) throw new ToolError("No cut has been rendered yet.", "Start the edit stage, build the film and call render_film.");
    if (view.stage?.name === "edit") {
      throw new ToolError("A revision of the edit is open and has not been rendered.", "Call render_film first, so the cut you hand in is the one you last worked on.");
    }
    const path = cutPath(revision);
    const info = await stat(join(exec.workDir, path)).catch(() => undefined);
    if (!info?.isFile()) throw new ToolError(`The rendered cut is missing from ${path}.`, "Start the edit stage and render it again.");
    return exec.gate("final_cut", {
      files: [path],
      revision,
      bytes: info.size,
      sha256: await sha256Of(join(exec.workDir, path)),
      ...(input.note.trim() ? { note: input.note.trim() } : {}),
    });
  },
});
