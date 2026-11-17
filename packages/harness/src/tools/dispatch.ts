import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { HarnessEvent, NewEvent } from "../events/envelope.ts";
import type { ToolCallBlock } from "../model/types.ts";
import { errorMessage } from "../util.ts";
import { ImageError, storeImage, type StoredImage } from "../artifacts.ts";
import type { SandboxSession } from "../sandbox.ts";
import { resolveInside } from "./builtins.ts";
import { GateSuspend, ToolError, type RunView, type StageTrigger, type ToolDefinition, type ToolExec } from "./define.ts";

/** An event before the loop gives it an id and a time. */
export type EventDraft = Omit<NewEvent, "eventId" | "occurredAt">;

/** What dispatch needs from the loop. Everything it does to the run goes through here. */
export type DispatchHost = {
  runId: string;
  agentId: string;
  agentSpanId: string;
  workDir: string;
  append(drafts: EventDraft[]): Promise<HarnessEvent[]>;
  newId(): string;
  now(): Date;
  /** Where pictures shown to the model are kept, named by hash. */
  artifactsDir: string;
  /** Where the run is, for preconditions and tools. */
  view(): RunView;
  /** How many more pictures the conversation may take. */
  imagesLeft(): number;
  sandbox(): Promise<SandboxSession>;
  enterStage(stage: string, reviewGate: string | undefined): Promise<{ stage: string; revision: number; trigger: StageTrigger }>;
  completeStage(): Promise<void>;
  /** The limit the run has hit, if any, in words for the model. */
  budgetExceeded(): string | undefined;
  /** Records the gate as open, closing the open stage in the same batch when asked. */
  openGate(gate: string, callId: string, payload: Record<string, unknown>, completeStage: boolean): Promise<void>;
  extract: (parentSpanId: string, request: { instructions: string; untrusted: string; schema: z.ZodType }, signal: AbortSignal) => Promise<unknown>;
  /** Records a turn-ending tool's result together with the end of the agent and the run. */
  conclude(completed: EventDraft, result: unknown): Promise<void>;
  policy: Readonly<Record<string, "allow" | "deny">>;
  maxInlineChars: number;
  maxParallel: number;
};

export type BatchOutcome = {
  /** A call opened a gate; the run waits. */
  suspended: boolean;
  /** A call ended the agent's work. */
  concluded: boolean;
};

/** Results that bypass the size cap (their tool pages its own output) are still kept under the event size limit. */
const HARD_CAP_CHARS = 100_000;
const RESULTS_DIR = "tool-results";

export const NOT_STARTED = "The tool call was not started. Call it again if it is still needed.";
export const CANCELLED = "The tool call was not run because the run was stopped.";

/**
 * Runs the tool calls of one model response. Calls are taken in the model's order: a parallel-safe call may
 * overlap with its neighbours, any other call runs alone and nothing after it starts until it is done. Every
 * call gets a `tool.call.started` and exactly one closing event, whatever happens, so the conversation always
 * has a result for each call. Nothing a tool does can throw out of here except a failure to write the log.
 */
export async function dispatchBatch(
  host: DispatchHost,
  registry: ReadonlyMap<string, ToolDefinition>,
  calls: readonly ToolCallBlock[],
  signal: AbortSignal,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { suspended: false, concluded: false };
  let i = 0;
  while (i < calls.length) {
    const call = calls[i]!;
    // The run is over once a call concludes it; nothing more is recorded.
    if (outcome.concluded) break;
    if (outcome.suspended || signal.aborted) {
      await skip(host, registry, call, signal.aborted ? "cancelled" : "not_started", signal.aborted ? CANCELLED : NOT_STARTED);
      i += 1;
      continue;
    }
    if (registry.get(call.name)?.parallelSafe) {
      let end = i;
      while (end < calls.length && registry.get(calls[end]!.name)?.parallelSafe) end += 1;
      await pool(calls.slice(i, end), host.maxParallel, (c) => runOne(host, registry, c, signal));
      i = end;
      continue;
    }
    const result = await runOne(host, registry, call, signal);
    if (result === "suspended") outcome.suspended = true;
    if (result === "concluded") outcome.concluded = true;
    i += 1;
  }
  return outcome;
}

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(runners);
}

type Owner = Pick<DispatchHost, "agentId" | "agentSpanId">;

export function startedDraft(host: Owner, def: ToolDefinition | undefined, call: ToolCallBlock, spanId: string): EventDraft {
  return {
    type: "tool.call.started",
    actor: "agent",
    agentId: host.agentId,
    spanId,
    parentSpanId: host.agentSpanId,
    payload: {
      tool: call.name,
      plugin: def?.plugin ?? "builtin",
      plugin_version: def?.pluginVersion ?? "0",
      tool_call_id: call.id,
      input: call.input ?? null,
      idempotent: Boolean(def?.idempotent || def?.readOnly),
      sandboxed: Boolean(def?.sandboxed),
    },
  };
}

export function failedDraft(host: Owner, call: ToolCallBlock, spanId: string, kind: string, message: string, detail?: string): EventDraft {
  return {
    type: "tool.call.failed",
    actor: "engine",
    agentId: host.agentId,
    spanId,
    parentSpanId: host.agentSpanId,
    payload: { tool_call_id: call.id, error: { kind, message, ...(detail ? { detail } : {}) } },
  };
}

async function skip(host: DispatchHost, registry: ReadonlyMap<string, ToolDefinition>, call: ToolCallBlock, kind: string, message: string) {
  const spanId = host.newId();
  await host.append([startedDraft(host, registry.get(call.name), call, spanId), failedDraft(host, call, spanId, kind, message)]);
}

async function runOne(
  host: DispatchHost,
  registry: ReadonlyMap<string, ToolDefinition>,
  call: ToolCallBlock,
  signal: AbortSignal,
): Promise<"done" | "suspended" | "concluded"> {
  const def = registry.get(call.name);
  const spanId = host.newId();
  // Recorded, and durable, before anything the tool does can have an effect.
  await host.append([startedDraft(host, def, call, spanId)]);
  const fail = async (kind: string, message: string, detail?: string) => {
    await host.append([failedDraft(host, call, spanId, kind, message, detail)]);
    return "done" as const;
  };

  if (!def) {
    const names = [...registry.keys()].sort().join(", ");
    return fail("unknown_tool", `There is no tool named "${call.name}". The tools are: ${names}.`);
  }
  const parsed = def.input.safeParse(call.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    return fail("invalid_input", `The input for ${def.name} is not valid (${issues}). Fix it and call the tool again.`);
  }

  // Guards. Each can only refuse; none can be skipped, reordered or overridden by a tool or a plugin.
  if (host.policy[def.name] === "deny") return fail("denied", `The tool "${def.name}" is turned off for this run.`);
  const view = host.view();
  const blocked = def.requires?.find((r) => !r.check(view));
  if (blocked) return fail("precondition", blocked.message);
  const over = host.budgetExceeded();
  if (over) return fail("budget", `Not run: ${over}`);
  if (signal.aborted) return fail("cancelled", CANCELLED);

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = def.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, def.timeoutMs)
    : undefined;
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});

  const exec: ToolExec = {
    runId: host.runId,
    agentId: host.agentId,
    callId: call.id,
    signal: controller.signal,
    workDir: host.workDir,
    gate: async (name, payload = {}, options = {}) => {
      if (def.parallelSafe) throw new ToolError(`The tool "${def.name}" may run alongside others, so it cannot ask for a review.`);
      await host.openGate(name, call.id, payload, Boolean(options.completeStage));
      throw new GateSuspend(name);
    },
    extract: (request) => host.extract(spanId, request, controller.signal) as Promise<never>,
    sandbox: () => host.sandbox(),
    run: () => host.view(),
    enterStage: async (stage, options = {}) => {
      if (def.parallelSafe) throw new ToolError(`The tool "${def.name}" may run alongside others, so it cannot change the stage.`);
      return host.enterStage(stage, options.reviewGate);
    },
    completeStage: async () => {
      if (def.parallelSafe) throw new ToolError(`The tool "${def.name}" may run alongside others, so it cannot change the stage.`);
      return host.completeStage();
    },
  };

  const startedAt = host.now().getTime();
  let value: unknown;
  try {
    value = await Promise.race([def.execute(parsed.data, exec), aborted]);
  } catch (err) {
    if (err instanceof GateSuspend) return "suspended";
    if (timedOut) return fail("timeout", `${def.name} did not finish within ${Math.round(def.timeoutMs! / 1000)} seconds.`);
    if (signal.aborted) return fail("cancelled", "The tool call was stopped before it finished. Its outcome is unknown.");
    if (err instanceof ToolError) return fail("tool_error", err.hint ? `${err.message} ${err.hint}` : err.message);
    return fail("internal", `${def.name} failed unexpectedly.`, errorMessage(err));
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }

  if (def.output) {
    const checked = def.output.safeParse(value);
    if (!checked.success) return fail("invalid_output", `${def.name} returned a result that does not match its declared shape.`, checked.error.message);
    value = checked.data;
  }
  let text: string;
  try {
    text = def.render ? def.render(parsed.data, value) : typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  } catch (err) {
    return fail("internal", `${def.name} produced a result that could not be shown.`, errorMessage(err));
  }
  const attached = def.images ? await attach(host, def, parsed.data, value) : { images: [], notes: "" };
  text += attached.notes;
  const shaped = def.exemptFromOffload
    ? { output: text.slice(0, HARD_CAP_CHARS), truncated: text.length > HARD_CAP_CHARS }
    : await offload(text, host.workDir, call.id, host.maxInlineChars);

  const completed: EventDraft = {
    type: "tool.call.completed",
    actor: "plugin",
    agentId: host.agentId,
    spanId,
    parentSpanId: host.agentSpanId,
    payload: {
      tool_call_id: call.id,
      ...shaped,
      ...(attached.images.length ? { images: attached.images } : {}),
      duration_ms: Math.max(0, host.now().getTime() - startedAt),
    },
  };
  if (def.concludesTurn) {
    await host.conclude(completed, value);
    return "concluded";
  }
  await host.append([completed]);
  return "done";
}

/**
 * Stores the pictures a tool wants the model to see. Best effort, like the size cap: a picture that cannot be
 * shown becomes a sentence in the result, and never turns a successful call into an error.
 */
async function attach(host: DispatchHost, def: ToolDefinition, input: unknown, value: unknown): Promise<{ images: StoredImage[]; notes: string }> {
  const images: StoredImage[] = [];
  let notes = "";
  let paths: string[];
  try {
    paths = def.images!(input as never, value);
  } catch {
    return { images, notes };
  }
  let left = host.imagesLeft();
  for (const path of paths) {
    if (left <= 0) {
      notes += `\n\n(${path} is not shown: this conversation already holds as many pictures as it can.)`;
      continue;
    }
    try {
      images.push(await storeImage(host.artifactsDir, resolveInside(host.workDir, path)));
      left -= 1;
    } catch (err) {
      const why = err instanceof ImageError || err instanceof ToolError ? err.message.replace(/\.$/, "") : "it could not be read";
      notes += `\n\n(${path} is not shown: ${why}.)`;
    }
  }
  return { images, notes };
}

/**
 * Keeps a large result out of the conversation: the full text goes to a file in the working directory and the
 * model gets the start, the end and where to find the rest. Best effort: if the file cannot be written the
 * result stays in context, so a successful call is never turned into an error by the cap.
 */
export async function offload(
  text: string,
  workDir: string,
  callId: string,
  maxInlineChars: number,
): Promise<{ output: string; truncated: boolean; output_path?: string }> {
  if (text.length <= maxInlineChars) return { output: text, truncated: false };
  const relative = `${RESULTS_DIR}/${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
  try {
    await mkdir(join(workDir, RESULTS_DIR), { recursive: true });
    await writeFile(join(workDir, relative), text, "utf8");
  } catch {
    return { output: text.slice(0, HARD_CAP_CHARS), truncated: text.length > HARD_CAP_CHARS };
  }
  const half = Math.max(0, Math.floor(maxInlineChars / 2));
  const omitted = text.length - half * 2;
  const notice = `\n\n(Left out ${omitted.toLocaleString("en-US")} characters from the middle. The full result is at ${relative}. Use read_file with offset and limit to read it.)\n\n`;
  return { output: text.slice(0, half) + notice + text.slice(text.length - half), truncated: true, output_path: relative };
}
