import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, gateApproved, ToolError } from "@harness/harness";
import { readReview, reviewPath } from "./critic.ts";
import { cutPath } from "./render.ts";

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Gate 2. Hands the latest rendered cut to the creator and stops the run until they answer. The hash of the
 * file goes into the log with the request, so the record says exactly which bytes were approved.
 *
 * With `requireReview`, the critic must have reviewed this cut first, and a cut it did not pass can only be
 * handed in once the agent has no revisions of its own left; the review goes to the creator with the cut.
 */
export function submitCutToolWith(options: { requireReview: boolean }) {
  return defineTool({
    name: "submit_cut",
    description:
      "Hand the latest rendered cut to the creator for review. The run stops until they answer, and their answer is this call's result: approved, or changes requested with their notes. " +
      (options.requireReview ? "The critic must have reviewed the cut with review_cut first. " : "") +
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
      const review = options.requireReview ? await readReview(exec.workDir, revision) : undefined;
      if (options.requireReview) {
        if (!review) throw new ToolError(`The critic has not reviewed cut ${revision} yet.`, "Call review_cut, then hand the cut in.");
        const left = view.limits.max_re_edits === undefined ? Number.POSITIVE_INFINITY : view.limits.max_re_edits - view.reEdits;
        if (!review.passed && left > 0) {
          throw new ToolError(
            `The critic did not pass cut ${revision}, and you can still revise it on your own judgement.`,
            "Start the edit stage again and fix what the review found.",
          );
        }
      }
      const reviewed = review
        ? {
            review: {
              passed: review.passed,
              mean: review.mean,
              scores: Object.fromEntries(Object.entries(review.scores).map(([key, value]) => [key, value.score])),
              path: reviewPath(revision),
              summary: review.summary,
            },
          }
        : {};
      return exec.gate("final_cut", {
        files: [path],
        revision,
        bytes: info.size,
        sha256: await sha256Of(join(exec.workDir, path)),
        ...(input.note.trim() ? { note: input.note.trim() } : {}),
        ...reviewed,
      });
    },
  });
}

/** Gate 2 without the critic, for runs started before the critic existed. */
export const submitCutTool = submitCutToolWith({ requireReview: false });
