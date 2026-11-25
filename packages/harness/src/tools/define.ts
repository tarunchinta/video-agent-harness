import type { z } from "zod";
import type { GateDecisionKind, Limits } from "../events/envelope.ts";
import type { SandboxSession } from "../sandbox.ts";

/** What a review gate returned, as the tool that opened it sees it. */
export type GateDecision = { gate: string; decision: GateDecisionKind; notes: string[] };

/** Where the run is, as far as a tool or a precondition may know. Computed from the log. */
export type RunView = {
  /** Latest decision per gate, or "open" while it waits. */
  gates: Readonly<Record<string, string>>;
  /** The stage being worked on, if one is open. */
  stage?: { name: string; revision: number };
  /** Latest revision started for each stage. */
  stageRevisions: Readonly<Record<string, number>>;
  reEdits: number;
  limits: Readonly<Limits>;
};

/** Why a stage was started: the plan called for it, a critique sent the work back, or the creator did. */
export type StageTrigger = "plan" | "critique" | "creator";

/** A condition checked in code before a tool runs. It can only block; nothing a model says can satisfy it. */
export type Precondition = {
  /** Shown to the model when the condition fails. */
  message: string;
  check(view: RunView): boolean;
};

/** Blocks a tool until the creator has approved the named gate. */
export const gateApproved = (gate: string): Precondition => ({
  message: `This needs the "${gate}" review to be approved first. Ask for that review, then try again.`,
  check: (view) => view.gates[gate] === "approved",
});

/** Blocks a tool unless the run is working on one of the named stages. */
export const inStage = (...stages: string[]): Precondition => ({
  message:
    stages.length === 1
      ? `This belongs to the ${stages[0]} stage, which is not open. Start it first.`
      : `This belongs to the ${stages.join(" or ")} stage, and neither is open. Start one first.`,
  check: (view) => view.stage !== undefined && stages.includes(view.stage.name),
});

/** What a tool body is handed besides its input. */
export type ToolExec = {
  runId: string;
  agentId: string;
  callId: string;
  /** Aborted on cancel and on timeout. Long work must watch it. */
  signal: AbortSignal;
  /** The run's working directory. File tools stay inside it. */
  workDir: string;
  /**
   * Stops the run and waits for a person. The run exits cleanly; when the gate is decided and the run resumes,
   * the decision becomes this tool call's result. Never returns.
   */
  gate(name: string, payload?: Record<string, unknown>, options?: { /** Close the open stage in the same write. */ completeStage?: boolean }): Promise<never>;
  /**
   * Turns text written by strangers into validated data: one model call with no tools, whose answer must match
   * `schema`. The only way such text may reach an agent that has tools.
   */
  extract<S extends z.ZodType>(request: { instructions: string; untrusted: string; schema: S }): Promise<z.output<S>>;
  /**
   * Asks a separate model call, with no tools and no view of this conversation, to judge the run's own work:
   * a critic. `material` is the text it judges, `images` are pictures in the working directory it looks at, and
   * its answer must match `schema`. The answer is a second opinion, not a decision: the tool decides what it means.
   */
  judge<S extends z.ZodType>(request: { instructions: string; material: string; schema: S; images?: string[] }): Promise<z.output<S>>;
  /**
   * The run's sandbox, started the first time a tool asks for it. It is removed whenever the run stops, so
   * only the working directory carries over to the next call.
   */
  sandbox(): Promise<SandboxSession>;
  /** Where the run is: gates, stage, re-edits and limits. */
  run(): RunView;
  /**
   * Closes the stage that is open and starts this one. Starting a stage again starts its next revision. The
   * loop works out why: the first time is the plan, a later time is the creator if `reviewGate` came back with
   * changes since the last start, and a critique otherwise. Refused when the run has no re-edits left.
   */
  enterStage(stage: string, options?: { reviewGate?: string }): Promise<{ stage: string; revision: number; trigger: StageTrigger }>;
  /** Closes the stage that is open, if any. */
  completeStage(): Promise<void>;
};

export type ToolDefinition<I extends z.ZodObject = z.ZodObject, O = unknown> = {
  /** snake_case. */
  name: string;
  /** What it does and when to call it, written for the model. */
  description: string;
  input: I;
  /** Shape of the value `execute` returns. Required for `untrusted` tools. */
  output?: z.ZodType<O>;
  /** Changes nothing outside the run. */
  readOnly?: boolean;
  /** Safe to run twice with the same input. Decides what an interrupted call tells the model. */
  idempotent?: boolean;
  /** May overlap with neighbouring calls. Must depend only on the call itself, not on what else is running. */
  parallelSafe?: boolean;
  /** Reads content written by strangers (web pages, retrieved posts). */
  untrusted?: boolean;
  /** Runs inside the sandbox. */
  sandboxed?: boolean;
  /** A successful call ends the agent's work; its value is the agent's result. */
  concludesTurn?: boolean;
  /** Has its own paging, so its result is never cut and moved to a file. */
  exemptFromOffload?: boolean;
  requires?: Precondition[];
  timeoutMs?: number;
  plugin?: string;
  pluginVersion?: string;
  /** Returns the value. Throw `ToolError` for a problem the model can act on. */
  execute(input: z.output<I>, exec: ToolExec): Promise<O>;
  /** Turns the value into what the model reads. Defaults to the string itself, or indented JSON. */
  render?(input: z.output<I>, value: O): string;
  /** Pictures to show the model with the result: paths in the working directory. PNG, JPEG, WebP or GIF. */
  images?(input: z.output<I>, value: O): string[];
};

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function defineTool<I extends z.ZodObject, O>(tool: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!NAME_RE.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be snake_case.`);
  if (tool.untrusted && !tool.output) {
    throw new Error(`Tool "${tool.name}" reads untrusted content, so it must declare an output schema for what it returns.`);
  }
  if (tool.parallelSafe && tool.concludesTurn) throw new Error(`Tool "${tool.name}" ends the turn, so it cannot be parallel-safe.`);
  return tool;
}

/** Thrown by a tool body for a problem the model can do something about. Becomes an error result, with the hint. */
export class ToolError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Thrown by `exec.gate` after the gate is recorded. Dispatch leaves the call open and stops the run. */
export class GateSuspend extends Error {
  constructor(public readonly gate: string) {
    super(`Waiting for the "${gate}" review.`);
    this.name = "GateSuspend";
  }
}
