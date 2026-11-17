import { describeBudget, payloadOf, type BudgetDimension, type HarnessEvent, type RunOutcome, type RunSummary } from "@harness/harness";
import type { OutcomeDetail } from "./pipeline.ts";

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;
const firstLine = (text: string, max = 100) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Turns events into lines a person can follow: what was done, not how the harness did it. The same code
 * prints a live run and a replay, so a replay reads exactly as the run did.
 */
export class Renderer {
  private readonly tools = new Map<string, string>();

  /** `withText` prints what the model said. A live run leaves it off, because the text was already streamed. */
  constructor(private readonly write: (line: string) => void, private readonly withText: boolean) {}

  event(e: HarnessEvent): void {
    switch (e.type) {
      case "run.started":
        this.write(`Started run ${e.runId}.`);
        break;
      case "run.resumed": {
        const why = { crash: "after it was interrupted", gate: "after your review", unpaused: "after the pause" }[payloadOf(e, "run.resumed").reason];
        this.write(`Picked the run back up ${why}.`);
        break;
      }
      case "model.call.completed": {
        if (!this.withText || e.agentId !== "main") break;
        for (const block of payloadOf(e, "model.call.completed").content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) this.write(block.text.trim());
        }
        break;
      }
      case "model.call.failed": {
        const p = payloadOf(e, "model.call.failed");
        if (p.error.kind === "cancelled" || p.error.kind === "interrupted") break;
        const again = p.retry_in_ms !== undefined ? ` Trying again in ${Math.max(1, Math.round(p.retry_in_ms / 1000))} s.` : "";
        this.write(`The model call did not go through: ${p.error.message}${again}`);
        break;
      }
      case "tool.call.started": {
        const p = payloadOf(e, "tool.call.started");
        this.tools.set(p.tool_call_id, p.tool);
        break;
      }
      case "tool.call.completed": {
        const p = payloadOf(e, "tool.call.completed");
        const tool = this.tools.get(p.tool_call_id) ?? "tool";
        // A review's answer is recorded as the result of the call that asked for it. It has its own line.
        if (tool === "finish" || e.actor === "creator") break;
        this.write(`  ${tool}: ${firstLine(p.output)}`);
        break;
      }
      case "tool.call.failed": {
        const p = payloadOf(e, "tool.call.failed");
        this.write(`  ${this.tools.get(p.tool_call_id) ?? "tool"} did not run: ${firstLine(p.error.message, 160)}`);
        break;
      }
      case "context.message": {
        const p = payloadOf(e, "context.message");
        if (p.origin === "engine") this.write(`Told the model: ${firstLine(p.content, 160)}`);
        break;
      }
      case "stage.started": {
        const p = payloadOf(e, "stage.started");
        this.write(stageLine(p.stage, p.revision));
        break;
      }
      case "gate.opened":
        this.write(`Waiting for your review of the ${gateName(payloadOf(e, "gate.opened").gate)}.`);
        break;
      case "gate.decided": {
        const p = payloadOf(e, "gate.decided");
        this.write(`You ${p.decision.replace("_", " ")} the ${gateName(p.gate)}.`);
        break;
      }
      case "budget.exceeded": {
        const p = payloadOf(e, "budget.exceeded");
        this.write(`Reached the limit: ${describeBudget(p.dimension as BudgetDimension, p.used, p.limit)}.`);
        break;
      }
      default:
        break;
    }
  }
}

const gateName = (gate: string) => gate.replaceAll("_", " ");

const FIRST: Record<string, string> = {
  research: "Researching the topic.",
  script: "Writing the script.",
  assets: "Preparing the voiceover.",
  edit: "Building the film.",
};
const AGAIN: Record<string, string> = { script: "Revising the script", edit: "Revising the cut" };

function stageLine(stage: string, revision: number): string {
  if (revision === 1) return FIRST[stage] ?? `Started the ${stage} stage.`;
  return AGAIN[stage] ? `${AGAIN[stage]} (revision ${revision}).` : `Started revision ${revision} of the ${stage} stage.`;
}

/** The last word on a run: what happened and what to do next. */
export function describeOutcome(outcome: RunOutcome, detail: OutcomeDetail = {}): string[] {
  const id = outcome.runId;
  switch (outcome.status) {
    case "succeeded": {
      const result = outcome.result as { summary?: unknown } | undefined;
      const done = typeof result?.summary === "string" ? `Done. ${result.summary}` : `Done. ${JSON.stringify(outcome.result)}`;
      return detail.film ? [done, `The film is at ${detail.film}`] : [done];
    }
    case "waiting_gate": {
      const lines = [`Waiting for your review of the ${gateName(outcome.gate ?? "work")}.`];
      for (const file of detail.files ?? []) lines.push(`  ${file}`);
      if (detail.note) lines.push(`Note with it: ${detail.note}`);
      if (detail.reel && outcome.gate === "script") {
        const length = detail.estimatedSeconds ? ` It should run about ${detail.estimatedSeconds} seconds.` : "";
        lines.push(
          `To approve it, record yourself reading the narration, then: harness resume ${id} --approve --voiceover <your recording>${length}`,
          `  (or --approve --no-voiceover to render without a voice)`,
          `Otherwise: harness resume ${id} --changes "what to fix"   (or --reject)`,
        );
        return lines;
      }
      lines.push(`Answer with: harness resume ${id} --approve   (or --changes "what to fix", or --reject)`);
      return lines;
    }
    case "paused":
      if (outcome.reason === "error:sandbox") {
        return [
          `Paused because the sandbox could not be started.${detail.pauseDetail ? ` ${detail.pauseDetail}` : ""}`,
          `Check that Docker is running and the image is built, then: harness resume ${id}`,
        ];
      }
      if (outcome.reason?.startsWith("budget:")) {
        return ["Paused at a limit.", `Raise it and carry on with: harness resume ${id} --max-usd <amount>   (or --max-tokens, --max-minutes, --max-steps)`];
      }
      if (outcome.reason?.startsWith("error:")) return ["Paused because the model could not be reached.", `Try again with: harness resume ${id}`];
      return ["Paused.", `Carry on with: harness resume ${id}`];
    case "cancelled":
      return [`Cancelled. ${outcome.failure?.message ?? ""}`.trim()];
    case "failed":
      return [`Stopped: ${outcome.failure?.message ?? "the run failed."}`];
    default:
      return [`The run is ${outcome.status}.`];
  }
}

export function describeSummary(s: RunSummary): string[] {
  const lines = [
    `${s.title}`,
    `Run ${s.runId}: ${s.status.replace("_", " ")}${s.reason ? ` (${s.reason})` : ""}${s.failure ? `, ${s.failure.message}` : ""}`,
    `${s.modelCalls} model calls, ${s.toolCalls} tool calls, ${(s.tokensIn + s.tokensOut).toLocaleString("en-US")} tokens, ${usd(s.costMicroUsd)}, ${Math.round(s.activeMs / 1000)} s of work`,
    "",
  ];
  for (const row of s.rows) {
    const what = row.kind === "model" ? `model  ${row.name}` : row.kind === "stage" ? `stage  ${row.name}` : `tool   ${row.name}`;
    const how = row.outcome === "ok" ? "ok" : row.outcome === "open" ? "unfinished" : `failed (${row.error ?? "error"})`;
    const cost = row.costMicroUsd !== undefined ? `  ${(row.tokensIn ?? 0).toLocaleString("en-US")} in, ${(row.tokensOut ?? 0).toLocaleString("en-US")} out, ${usd(row.costMicroUsd)}` : "";
    const time = row.durationMs !== undefined ? `  ${(row.durationMs / 1000).toFixed(1)} s` : "";
    lines.push(`${String(row.seq).padStart(5)}  ${what.padEnd(32)} ${how}${time}${cost}`);
  }
  return lines;
}
