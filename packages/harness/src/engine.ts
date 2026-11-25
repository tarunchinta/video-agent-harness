import { dirname, join } from "node:path";
import { z } from "zod";
import { loadImage, storeImage } from "./artifacts.ts";
import { describeBudget, evaluateBudget, type BudgetCheck, type BudgetUsage } from "./budget.ts";
import { buildRequest, clearedResult, ContextBuilder, estimateRequestChars, IMAGE_CHARS, requestHash, transcriptText, type AgentContext } from "./context.ts";
import { closeAll, MAIN_AGENT } from "./creator.ts";
import { MAX_PAYLOAD_BYTES, payloadOf, type HarnessEvent, type NewEvent } from "./events/envelope.ts";
import { activeMsAt, isTerminal, reduce, type RunState, type RunStatus } from "./events/reducer.ts";
import { HeadMovedError, LEASE_MS, type EventStore } from "./events/store.ts";
import { COMPACT_SYSTEM, extractPrompt, JUDGE_SYSTEM, parseJsonFromText, TOOLLESS_SYSTEM } from "./extract.ts";
import { ModelError, promptTokens, type ContentBlock, type ImageBlock, type ModelProvider, type ModelRequest, type ModelResponse, type ToolCallBlock, type ToolSpec } from "./model/types.ts";
import type { SandboxFactory, SandboxSession } from "./sandbox.ts";
import { defaultFinishSchema, fileTools, finishTool } from "./tools/builtins.ts";
import { ToolError, type Precondition, type RunView, type StageTrigger, type ToolDefinition } from "./tools/define.ts";
import { dispatchBatch, failedDraft, NOT_STARTED, saveResult, startedDraft, type DispatchHost, type EventDraft, type ToollessRequest } from "./tools/dispatch.ts";
import { canonicalJson, errorMessage, estimateTokens, randomIds, realSleep, sha256, systemClock, type Clock, type IdSource, type Sleep } from "./util.ts";

export type RetryPolicy = { maxRetries: number; initialDelayMs: number; maxDelayMs: number; jitterRatio: number };

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };

export type EngineOptions = {
  store: EventStore;
  provider: ModelProvider;
  /** Tools the agent may call, besides `finish`. Defaults to the file tools. */
  tools?: ToolDefinition[];
  /** Shape of the result the agent must hand to `finish`. */
  finishSchema?: z.ZodObject;
  /** Conditions `finish` must meet, such as an approved review. Checked in code like any other tool's. */
  finishRequires?: Precondition[];
  /** The run's working directory. File tools and large tool results live under it. */
  workDir: (runId: string) => string;
  /** Where pictures shown to the model are kept. Defaults to `artifacts`, next to the working directory. */
  artifactsDir?: (runId: string) => string;
  /** Starts the run's sandbox. Without it, tools that ask for a sandbox are refused. */
  sandbox?: SandboxFactory;
  /** Most pictures one agent's conversation may hold. Further ones are named in the result but not shown. */
  maxImages?: number;
  worker?: string;
  clock?: Clock;
  ids?: IdSource;
  sleep?: Sleep;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  /** Tools turned off for this deployment. */
  toolPolicy?: Record<string, "allow" | "deny">;
  maxParallelToolCalls?: number;
  /** Tool results longer than this are cut to a preview and saved in full to a file. About 12,000 tokens. */
  maxInlineChars?: number;
  /** Room kept free below the context limit before the model is told to wrap up. */
  contextHeadroomTokens?: number;
  /** Rounds allowed when the run sets no `max_rounds`. */
  defaultMaxRounds?: number;
  /** Identical tool calls in a row before the model is told, and before the run stops. */
  repeatWarnAt?: number;
  repeatStopAt?: number;
  /** Called for every event as it is written. */
  onEvent?: (event: HarnessEvent) => void;
  /** Called with model text as it streams. Never stored. */
  onText?: (delta: string) => void;
};

export type RunOutcome = {
  runId: string;
  status: RunStatus;
  /** Why a paused run paused: `creator`, `budget:<dimension>` or `error:<kind>`. */
  reason?: string;
  /** The review the run is waiting on. */
  gate?: string;
  failure?: { kind: string; message: string };
  /** What the agent handed to `finish`. */
  result?: unknown;
};

/** Cut-off responses a run may have before it fails. */
const MAX_OUTPUT_STOPS = 3;

/** Compaction clears old results until the projection is about this share of the usable window. */
const COMPACT_TARGET = 0.6;
/** Model responses at the end of the conversation whose tool results are never cleared. */
const KEEP_RECENT_STEPS = 4;
/** Tool results shorter than this are not worth clearing, unless they carry pictures. */
const MIN_TRIM_CHARS = 2_000;
/** Longest summary kept, before the harness's own facts are added. */
const MAX_SUMMARY_CHARS = 24_000;

class Session {
  readonly events: HarnessEvent[] = [];
  private current: RunState | undefined;
  /** The main agent's conversation, kept up to date as events are loaded. */
  readonly context = new ContextBuilder(MAIN_AGENT);
  /** Counts the loop checks on every step, kept as events load so no check rescans the log. */
  steps = 0;
  maxOutputStops = 0;
  readonly notes = new Map<string, number>();
  /** The main agent's latest tool call, and how many times in a row it was made with the same input. */
  streak = { key: "", tool: "", count: 0 };
  chain: Promise<unknown> = Promise.resolve();
  /** The sandbox this worker started, and the span that records it. */
  sandbox?: { session: SandboxSession; spanId: string };
  sandboxStarting?: Promise<SandboxSession>;
  /** Why the sandbox could not be started, when it could not. The run pauses on it. */
  sandboxFailure?: string;
  /** This worker has let go of the run (a gate, a pause, the end). Nothing new is started after that. */
  released = false;
  /** Pictures already read from disk, as base64, by hash. */
  readonly imageData = new Map<string, string>();

  constructor(readonly runId: string, readonly epoch: number, readonly worker: string) {}

  get state(): RunState {
    if (!this.current) throw new Error(`Run ${this.runId} has no events.`);
    return this.current;
  }

  load(events: readonly HarnessEvent[]): void {
    for (const e of events) {
      this.current = reduce(this.current, e);
      this.events.push(e);
      this.context.add(e);
      this.count(e);
    }
  }

  private count(e: HarnessEvent): void {
    if (e.type === "context.message") {
      const kind = payloadOf(e, "context.message").kind;
      if (kind) this.notes.set(kind, (this.notes.get(kind) ?? 0) + 1);
      return;
    }
    if (e.agentId !== MAIN_AGENT) return;
    if (e.type === "model.call.completed") {
      this.steps += 1;
      if (payloadOf(e, "model.call.completed").stop_reason === "max_output") this.maxOutputStops += 1;
    } else if (e.type === "tool.call.started") {
      const p = payloadOf(e, "tool.call.started");
      const key = `${p.tool}:${canonicalJson(p.input)}`;
      this.streak = key === this.streak.key ? { ...this.streak, count: this.streak.count + 1 } : { key, tool: p.tool, count: 1 };
    }
  }

  noteCount(kind: string): number {
    return this.notes.get(kind) ?? 0;
  }
}

type CallResult =
  | { kind: "response"; response: ModelResponse }
  | { kind: "aborted" }
  /** The response could not be used; a note to the model was added and the loop should go round again. */
  | { kind: "noted" }
  | { kind: "error"; error: ModelError };

type Streamed = { response: ModelResponse; latencyMs: number; firstTokenMs: number | null } | { error: ModelError };

const INTERRUPTED_SAFE = "The tool call was interrupted before a result was recorded, so its outcome is unknown. This tool is safe to call again.";
const INTERRUPTED_UNSAFE =
  "The tool call was interrupted before a result was recorded, so its outcome is unknown. It may already have had an effect: check the current state before calling it again.";
const TRUNCATED = "Not run: your response reached the output limit before this call was complete. Send it again, in smaller parts if it is large.";

/** Events after which this worker no longer drives the run, and what the sandbox's record says about why it went. */
const RELEASES: Readonly<Record<string, string>> = {
  "gate.opened": "gate",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.failed": "failed",
};

/**
 * The agent loop. `run` drives one run from wherever its log says it is: a fresh start, a clean stop, or a
 * crash. Each pass round the loop folds the log, checks the limits in code, makes one model call and runs the
 * tools it asked for. Everything the model sees and everything the loop decides is written to the log first.
 */
export class Engine {
  private readonly registry = new Map<string, ToolDefinition>();
  private readonly specs: ToolSpec[];
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly retry: RetryPolicy;

  constructor(private readonly opts: EngineOptions) {
    const finish = { ...finishTool(opts.finishSchema ?? defaultFinishSchema), ...(opts.finishRequires ? { requires: opts.finishRequires } : {}) };
    const tools = [...(opts.tools ?? fileTools), finish as ToolDefinition];
    for (const tool of tools) {
      if (this.registry.has(tool.name)) throw new Error(`Two tools are named "${tool.name}".`);
      this.registry.set(tool.name, tool);
    }
    this.specs = [...this.registry.values()]
      .map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? randomIds;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
  }

  /**
   * Starts or continues a run and returns when it finishes, pauses or waits for a review. Safe to call on a run
   * in any state: one that is waiting, paused or over is reported as it is, and nothing is written.
   */
  async run(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunOutcome> {
    const { store } = this.opts;
    const probe = new Session(runId, 0, "");
    probe.load(await store.read(runId));
    if (probe.state.status !== "created" && probe.state.status !== "running") return this.outcome(probe);

    const worker = this.opts.worker ?? `worker-${process.pid}`;
    const lease = await store.acquireLease(runId, worker);
    const session = new Session(runId, lease.epoch, worker);
    // A lease lasts a minute. Keep it alive while this worker lives, however long a tool takes.
    const heartbeat = setInterval(() => void store.renewLease(runId, worker, lease.epoch).catch(() => {}), LEASE_MS / 3);
    heartbeat.unref();
    try {
      session.load(await store.read(runId));
      if (session.state.status !== "created" && session.state.status !== "running") return this.outcome(session);
      return await this.drive(session, options.signal ?? new AbortController().signal);
    } finally {
      clearInterval(heartbeat);
      // A sandbox still up here means the loop was thrown out of. Remove it; the next worker records that.
      session.released = true;
      await session.sandboxStarting?.catch(() => {});
      await session.sandbox?.session.stop().catch(() => {});
      await store.releaseLease(runId, worker, lease.epoch).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------------------

  private async drive(s: Session, signal: AbortSignal): Promise<RunOutcome> {
    if (s.state.status === "created") await this.start(s);
    else await this.repair(s);

    for (;;) {
      if (s.state.status !== "running") return this.outcome(s);
      const ctx = s.context.snapshot();

      if (s.state.cancelRequested) return this.fail(s, "cancelled", "The run was cancelled.");
      if (signal.aborted || s.state.pauseRequested) return this.pause(s, "creator");

      if (ctx.turnEnded && ctx.lastStop !== "paused") {
        const ended = await this.afterTurn(s, ctx);
        if (ended) return ended;
        continue;
      }

      const budget = evaluateBudget(this.usage(s), s.state.limits);
      if (budget.exceeded) {
        const { dimension, used, limit } = budget.exceeded;
        await this.append(s, [
          { type: "budget.exceeded", actor: "engine", spanId: s.state.runSpanId, payload: { dimension, used, limit } },
          { type: "run.paused", actor: "engine", spanId: s.state.runSpanId, payload: { reason: `budget:${dimension}` } },
        ]);
        return this.outcome(s);
      }

      if (await this.compact(s, ctx, signal)) continue;
      const noted = await this.notes(s, ctx, budget);
      if (noted === "continue") continue;
      if (noted) return noted;

      const result = await this.callModel(s, ctx, signal);
      if (result.kind === "aborted" || result.kind === "noted") continue;
      if (result.kind === "error") {
        // A request the provider found too long gets one summary, and is then tried again.
        if (result.error.kind === "context_overflow" && (await this.compact(s, s.context.snapshot(), signal, true))) continue;
        return this.modelFailure(s, result.error);
      }

      const { response } = result;
      const calls = response.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
      if (response.stopReason === "refusal") return this.refused(s, response);
      if (!calls.length) continue;
      if (response.stopReason === "max_output") {
        // A cut-off response can hold a half-written call. None of its calls run, and it counts toward the
        // limit on cut-off responses like any other.
        await this.append(
          s,
          calls.flatMap((call) => {
            const spanId = this.ids.uuid();
            const owner = { agentId: MAIN_AGENT, agentSpanId: ctx.spanId! };
            return [startedDraft(owner, this.registry.get(call.name), call, spanId), failedDraft(owner, call, spanId, "truncated", TRUNCATED)];
          }),
        );
        if (s.maxOutputStops >= MAX_OUTPUT_STOPS) return this.fail(s, "max_output", "The model's responses kept reaching the output limit.");
        continue;
      }

      const batch = await dispatchBatch(this.host(s, ctx.spanId!), this.registry, calls, signal);
      if (batch.concluded || batch.suspended) return this.outcome(s);
      // Not the run's fault and not something the model can fix: stop cleanly so it can be picked up again.
      if (s.sandboxFailure) return this.pause(s, "error:sandbox", s.sandboxFailure);
      const stuck = await this.guard(s, ctx.spanId!);
      if (stuck) return stuck;
    }
  }

  private async start(s: Session): Promise<void> {
    const { config, task, runSpanId } = s.state;
    await this.append(s, [
      { type: "run.started", actor: "engine", spanId: runSpanId, payload: { worker: s.worker, epoch: s.epoch } },
      {
        type: "agent.started",
        actor: "engine",
        agentId: MAIN_AGENT,
        spanId: this.ids.uuid(),
        parentSpanId: runSpanId,
        payload: {
          role: "orchestrator",
          model: config.model,
          tools: this.specs.map((t) => t.name),
          system_prompt_sha256: sha256(config.system),
          system_prompt: config.system,
          ...(this.opts.provider.pricesCheckedOn ? { prices_checked_on: this.opts.provider.pricesCheckedOn } : {}),
          tool_specs: this.specs.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
          task,
        },
      },
    ]);
  }

  /**
   * Makes the log whole again after a stop, by appending only. A call that was in flight gets an error result
   * that says so; nothing is run again here. A tool runs a second time only if the model asks for it again.
   */
  private async repair(s: Session): Promise<void> {
    const ctx = s.context.snapshot();
    const drafts: EventDraft[] = [];
    const interrupted: string[] = [];

    const lastStart = s.events.findLastIndex((e) => e.type === "run.started" || e.type === "run.resumed");
    const since = s.events.slice(lastStart + 1);
    let reason: "crash" | "gate" | "unpaused" = "crash";
    if (since.some((e) => e.type === "run.paused")) reason = "unpaused";
    if (since.some((e) => e.type === "gate.decided")) reason = "gate";

    const opened = s.events.findLast((e) => e.type === "gate.opened");
    const gate = opened ? payloadOf(opened, "gate.opened") : undefined;
    const decided = gate ? s.events.findLast((e) => e.type === "gate.decided" && payloadOf(e, "gate.decided").gate === gate.gate) : undefined;

    for (const [callId, started] of ctx.openToolCalls) {
      const base = { agentId: started.agentId, spanId: started.spanId, parentSpanId: started.parentSpanId };
      if (gate && decided && decided.seq > opened!.seq && callId === gate.tool_call_id) {
        // The call that asked for the review gets the creator's answer as its result.
        const p = payloadOf(decided, "gate.decided");
        const output = JSON.stringify({ gate: p.gate, decision: p.decision, notes: p.notes.map((n) => n.text) }, null, 2);
        drafts.push({ ...base, type: "tool.call.completed", actor: "creator", payload: { tool_call_id: callId, output, truncated: false, duration_ms: 0 } });
        continue;
      }
      const safe = payloadOf(started, "tool.call.started").idempotent;
      drafts.push({
        ...base,
        type: "tool.call.failed",
        actor: "engine",
        payload: { tool_call_id: callId, error: { kind: "interrupted", message: safe ? INTERRUPTED_SAFE : INTERRUPTED_UNSAFE } },
      });
      interrupted.push(started.spanId);
    }

    const closed = new Set(s.events.filter((e) => e.type === "model.call.completed" || e.type === "model.call.failed").map((e) => e.spanId));
    for (const started of s.events) {
      if (started.type !== "model.call.started" || closed.has(started.spanId)) continue;
      drafts.push({
        type: "model.call.failed",
        actor: "engine",
        agentId: started.agentId,
        spanId: started.spanId,
        parentSpanId: started.parentSpanId,
        payload: {
          error: { kind: "interrupted", message: "The call was in flight when the run stopped.", retryable: true },
          attempt: payloadOf(started, "model.call.started").attempt,
        },
      });
      interrupted.push(started.spanId);
    }

    // A sandbox the last worker started and never closed is gone with that worker.
    const sandboxClosed = new Set(s.events.filter((e) => e.type === "sandbox.completed").map((e) => e.spanId));
    for (const started of s.events) {
      if (started.type !== "sandbox.started" || sandboxClosed.has(started.spanId)) continue;
      drafts.push({ type: "sandbox.completed", actor: "engine", spanId: started.spanId, parentSpanId: started.parentSpanId, payload: { exit_reason: "interrupted" } });
      interrupted.push(started.spanId);
    }

    if (ctx.spanId) {
      const owner = { agentId: MAIN_AGENT, agentSpanId: ctx.spanId };
      for (const call of ctx.unanswered) {
        if (ctx.openToolCalls.has(call.id)) continue;
        const spanId = this.ids.uuid();
        drafts.push(startedDraft(owner, this.registry.get(call.name), call, spanId), failedDraft(owner, call, spanId, "not_started", NOT_STARTED));
      }
    }

    drafts.push({
      type: "run.resumed",
      actor: "engine",
      spanId: s.state.runSpanId,
      payload: { worker: s.worker, epoch: s.epoch, reason, interrupted_spans: interrupted },
    });
    await this.append(s, drafts);
  }

  /** The model stopped without asking for tools. Either the run is over for a reason, or it gets another round. */
  private async afterTurn(s: Session, ctx: AgentContext): Promise<RunOutcome | undefined> {
    if (ctx.lastStop === "refusal") return this.fail(s, "refusal", "The model declined to continue.");
    if (ctx.lastStop === "max_output") {
      if (s.maxOutputStops >= MAX_OUTPUT_STOPS) return this.fail(s, "max_output", "The model's responses kept reaching the output limit.");
      await this.note(s, ctx, "max_output", "Your last response was cut off at the output limit. Continue from where it stopped, and keep each response shorter.");
      return undefined;
    }
    const max = s.state.limits.max_rounds ?? this.opts.defaultMaxRounds ?? 3;
    if (ctx.rounds >= max) {
      return this.fail(s, "round_limit", `The model stopped ${ctx.rounds + 1} times without finishing the task.`);
    }
    await this.note(
      s,
      ctx,
      "round",
      `You stopped before the task was finished. The task is: ${JSON.stringify(s.state.task)}. This is continuation ${ctx.rounds + 1} of ${max}. ` +
        "Carry on from the current state of the work, and call the finish tool when the task is complete.",
    );
    return undefined;
  }

  /** Warnings the model should hear before a limit is hit. Each is said once, and always in full. */
  private async notes(s: Session, ctx: AgentContext, budget: BudgetCheck): Promise<RunOutcome | "continue" | undefined> {
    let added = false;
    for (const near of budget.near) {
      const kind = `budget_warning:${near.dimension}`;
      if (ctx.noteKinds.has(kind)) continue;
      await this.note(
        s,
        ctx,
        kind,
        `The run has used ${describeBudget(near.dimension, near.used, near.limit)}. It stops when the limit is reached. ` +
          "Do the most important remaining work now and call finish.",
      );
      added = true;
    }

    const { projected, warnAt, stopAt } = this.project(s, ctx);
    if (projected >= stopAt) {
      return this.fail(s, "context_exhausted", "The conversation no longer fits in the model's context window.");
    }
    if (projected >= warnAt && !ctx.noteKinds.has("context_warning")) {
      await this.note(
        s,
        ctx,
        "context_warning",
        `This conversation has used about ${Math.round((projected / stopAt) * 100)}% of the space the model has. The run stops when it is full. ` +
          "Finish the most important remaining work and call finish. Read files in small parts.",
      );
      added = true;
    }
    return added ? "continue" : undefined;
  }

  /**
   * The size of the next request, and the sizes at which the loop acts. The projection starts from the prompt
   * size the provider reported for the last request and adds an estimate for what was appended since.
   */
  private project(s: Session, ctx: AgentContext): { projected: number; warnAt: number; stopAt: number } {
    const { contextWindow, maxOutputTokens } = this.opts.provider.capabilities(ctx.model);
    // Room is kept for the longest answer the model can give: the run's setting, or the model's own cap when that is lower.
    const stopAt = contextWindow - Math.min(s.state.config.max_output_tokens, maxOutputTokens);
    const headroom = this.opts.contextHeadroomTokens ?? 16_384;
    const warnAt = Math.min(contextWindow * 0.8, stopAt - headroom) > 0 ? Math.min(contextWindow * 0.8, stopAt - headroom) : stopAt * 0.8;
    const projected = ctx.lastUsage
      ? promptTokens(ctx.lastUsage) + ctx.lastUsage.outputTokens + estimateTokens(ctx.charsSinceUsage)
      : estimateTokens(estimateRequestChars(ctx));
    return { projected, warnAt, stopAt };
  }

  /**
   * Makes the conversation smaller once it passes the warning line, for runs created with compaction. First,
   * and at no model cost, old large tool results are cleared, each pointing at its full text on disk. If that is
   * not enough, a tool-less call summarises the conversation, and facts kept by code (stages, reviews and the
   * creator's notes word for word) are added to the summary. At most one of each happens between two model
   * responses, and never while a tool call is waiting for its result. `force` skips straight to a summary, for
   * a request the provider has already rejected as too long. Returns whether anything was written.
   */
  private async compact(s: Session, ctx: AgentContext, signal: AbortSignal, force = false): Promise<boolean> {
    if (!s.state.config.compaction || ctx.unanswered.length || ctx.openToolCalls.size || ctx.lastStop === "paused") return false;
    if (ctx.compactedSinceStep === "summary" || ctx.messages.length < 2) return false;
    const { projected, warnAt, stopAt } = this.project(s, ctx);
    if (!force && projected < warnAt) return false;

    if (!force && !ctx.compactedSinceStep) {
      const cleared = await this.trimPlan(s, ctx, projected - Math.floor(stopAt * COMPACT_TARGET));
      if (cleared.length) {
        const saved = cleared.reduce((n, c) => n + c.saving, 0);
        await this.append(s, [
          {
            type: "context.compacted",
            actor: "engine",
            agentId: MAIN_AGENT,
            spanId: ctx.spanId!,
            parentSpanId: s.state.runSpanId,
            payload: {
              mode: "trim",
              cleared: cleared.map((c) => ({ tool_call_id: c.id, path: c.path })),
              tokens_before: Math.round(projected),
              tokens_after: Math.max(0, Math.round(projected - saved)),
            },
          },
        ]);
        return true;
      }
    }

    const budgetChars = Math.max(20_000, Math.floor((stopAt - 12_000) * 3));
    let summary: string;
    try {
      const value = (await this.toolless(
        s,
        ctx.spanId!,
        {
          kind: "compact",
          instructions:
            "Summarise this conversation for the agent that wrote it, so it can carry on without it. Write it as notes to yourself, under these headings: " +
            "Task, Done so far, Decisions, Files, Feedback from the reviewer, Open problems, Next step.",
          text: transcriptText(ctx.messages, budgetChars),
          schema: z.object({ summary: z.string().min(1) }),
        },
        signal,
      )) as { summary: string };
      summary = value.summary.slice(0, MAX_SUMMARY_CHARS);
    } catch {
      // Nothing is lost: the loop falls back to warning the model and, at the limit, failing the run.
      return false;
    }
    const text = `${summary}\n\n${this.facts(s)}`;
    const after = estimateTokens(text.length + ctx.system.length + JSON.stringify(ctx.toolSpecs).length + s.state.task.length);
    await this.append(s, [
      {
        type: "context.compacted",
        actor: "engine",
        agentId: MAIN_AGENT,
        spanId: ctx.spanId!,
        parentSpanId: s.state.runSpanId,
        payload: { mode: "summary", summary: text, from_seq: 1, to_seq: ctx.throughSeq, tokens_before: Math.round(projected), tokens_after: after },
      },
    ]);
    return true;
  }

  /** Old large tool results to clear, oldest first, until about `needed` tokens are saved. Each is saved to disk first. */
  private async trimPlan(s: Session, ctx: AgentContext, needed: number): Promise<{ id: string; path: string; saving: number }[]> {
    // The newest steps stay as they are: the model is most likely to need what it has just seen.
    let protectFrom = ctx.messages.length;
    for (let i = ctx.messages.length - 1, seen = 0; i >= 0 && seen < KEEP_RECENT_STEPS; i -= 1) {
      if (ctx.messages[i]!.role === "assistant") {
        seen += 1;
        protectFrom = i;
      }
    }
    const completed = new Map<string, HarnessEvent>();
    for (const e of s.events) if (e.agentId === MAIN_AGENT && e.type === "tool.call.completed") completed.set(payloadOf(e, "tool.call.completed").tool_call_id, e);

    const plan: { id: string; path: string; saving: number }[] = [];
    let saved = 0;
    for (let i = 0; i < protectFrom && saved < needed; i += 1) {
      const message = ctx.messages[i]!;
      if (message.role !== "user") continue;
      for (const block of message.content) {
        if (saved >= needed) break;
        if (block.type !== "tool_result" || block.isError || ctx.cleared.has(block.toolCallId)) continue;
        const images = block.images?.length ?? 0;
        if (block.content.length < MIN_TRIM_CHARS && !images) continue;
        const event = completed.get(block.toolCallId);
        if (!event) continue;
        // A result already cut to a preview has its full text on disk. Any other is saved now, and kept if that fails.
        const p = payloadOf(event, "tool.call.completed");
        const path = p.output_path ?? (await saveResult(p.output, this.opts.workDir(s.runId), block.toolCallId));
        if (!path) continue;
        const saving = estimateTokens(Math.max(0, block.content.length - clearedResult(block.content, path).length) + images * IMAGE_CHARS);
        plan.push({ id: block.toolCallId, path, saving });
        saved += saving;
      }
    }
    return plan;
  }

  /** What a summary must never lose, read from the log by code rather than remembered by a model. */
  private facts(s: Session): string {
    const { stage, reEdits, limits, gates } = s.state;
    const lines = ["Facts kept by the harness (these are exact):"];
    if (stage) lines.push(`- Current stage: ${stage.name}, revision ${stage.revision}.`);
    if (limits.max_re_edits !== undefined) lines.push(`- Revisions of the cut on your own judgement: ${reEdits} of ${limits.max_re_edits}.`);
    for (const [gate, decision] of Object.entries(gates)) lines.push(`- Review "${gate}": ${decision.replace("_", " ")}.`);
    for (const e of s.events) {
      if (e.type !== "gate.decided") continue;
      const p = payloadOf(e, "gate.decided");
      for (const note of p.notes) lines.push(`- The creator's note on "${p.gate}" (${p.decision.replace("_", " ")}): ${JSON.stringify(note.text)}`);
    }
    const opened = s.events.findLast((e) => e.type === "gate.opened");
    const files = opened ? (payloadOf(opened, "gate.opened") as { files?: unknown }).files : undefined;
    if (Array.isArray(files) && files.length) lines.push(`- Last handed in for review: ${files.filter((f) => typeof f === "string").join(", ")}.`);
    lines.push("- Full text of cleared tool results is under tool-results/ in the working directory.");
    return lines.join("\n");
  }

  /** Stops a model that keeps making the same call. */
  private async guard(s: Session, agentSpanId: string): Promise<RunOutcome | undefined> {
    const { count: streak, tool } = s.streak;
    if (!streak) return undefined;
    if (streak >= (this.opts.repeatStopAt ?? 6)) {
      return this.fail(s, "stuck", `The model made the same ${tool} call ${streak} times in a row.`);
    }
    if (streak >= (this.opts.repeatWarnAt ?? 3) && s.noteCount("repeat_warning") === 0) {
      await this.append(s, [
        this.noteDraft(
          s,
          agentSpanId,
          "repeat_warning",
          `You have made the same ${tool} call ${streak} times in a row with the same input. Repeating it will not change the result. Try a different approach.`,
        ),
      ]);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Model calls
  // ---------------------------------------------------------------------------------------------------------

  private async callModel(s: Session, ctx: AgentContext, signal: AbortSignal): Promise<CallResult> {
    const { provider } = this.opts;
    const config = s.state.config;
    const request = buildRequest(ctx, config.max_output_tokens, config.effort);
    const hash = requestHash(request);
    // The log and the hash name pictures by their own hash. The bytes join the request only on its way out.
    const outgoing = await this.withImages(s, request);

    for (let attempt = 1; ; attempt += 1) {
      const base = { agentId: MAIN_AGENT, spanId: this.ids.uuid(), parentSpanId: ctx.spanId };
      await this.append(s, [
        {
          ...base,
          type: "model.call.started",
          actor: "engine",
          payload: {
            provider: provider.id,
            model: request.model,
            params: { max_output_tokens: request.maxOutputTokens, ...(request.effort ? { effort: request.effort } : {}) },
            purpose: "agent",
            tools_enabled: request.tools.length > 0,
            context_through_seq: ctx.throughSeq,
            request_sha256: hash,
            attempt,
            step: ctx.steps + 1,
          },
        },
      ]);

      const streamed = await this.stream(outgoing, signal, true);
      let error: ModelError;
      let billed: ModelResponse | undefined;
      if ("response" in streamed) {
        const { response } = streamed;
        const tooLarge = Buffer.byteLength(JSON.stringify(response.content), "utf8") > MAX_PAYLOAD_BYTES - 4096;
        if (!tooLarge && (response.content.length > 0 || response.stopReason !== "end_turn")) {
          await this.append(s, [this.completedDraft(base, request.model, streamed)]);
          return { kind: "response", response };
        }
        billed = response;
        if (tooLarge) {
          await this.append(s, [
            {
              ...base,
              ...this.usageColumns(request.model, response),
              type: "model.call.failed",
              actor: "engine",
              payload: { error: { kind: "response_too_large", message: "The response was too large to record.", retryable: false }, attempt },
            },
          ]);
          if (s.noteCount("response_too_large") >= 3) {
            return { kind: "error", error: new ModelError("invalid_request", "The model's responses kept being too large to record.") };
          }
          await this.note(s, ctx, "response_too_large", "Your last response was too large to record, so it was dropped. Send large content in smaller parts, for example one file at a time.");
          return { kind: "noted" };
        }
        error = new ModelError("empty_response", "The model returned an empty response.");
      } else {
        error = streamed.error;
      }

      const aborted = signal.aborted || error.kind === "aborted";
      const willRetry = !aborted && error.retryable && attempt <= this.retry.maxRetries;
      const delay = willRetry ? this.backoff(attempt, error.retryAfterMs) : undefined;
      // Written before the wait, so a crash during backoff leaves no hidden pending retry.
      await this.append(s, [
        {
          ...base,
          ...(billed ? this.usageColumns(request.model, billed) : {}),
          type: "model.call.failed",
          actor: "engine",
          payload: {
            error: { kind: aborted ? "cancelled" : error.kind, message: error.message, retryable: error.retryable },
            attempt,
            ...(delay !== undefined ? { retry_in_ms: delay } : {}),
          },
        },
      ]);
      if (signal.aborted) return { kind: "aborted" };
      if (aborted) return { kind: "error", error: new ModelError("transport", error.message) };
      if (!willRetry) return { kind: "error", error };
      try {
        await this.sleep(delay!, signal);
      } catch {
        return { kind: "aborted" };
      }
    }
  }

  private async stream(request: ModelRequest, signal: AbortSignal, live: boolean): Promise<Streamed> {
    const started = this.clock.now().getTime();
    let firstTokenMs: number | null = null;
    let response: ModelResponse | undefined;
    try {
      for await (const event of this.opts.provider.stream(request, signal)) {
        if (event.type === "text_delta") {
          firstTokenMs ??= this.clock.now().getTime() - started;
          if (live) this.opts.onText?.(event.text);
        } else {
          response = event.response;
        }
      }
    } catch (err) {
      if (err instanceof ModelError) return { error: err };
      return { error: new ModelError(signal.aborted ? "aborted" : "transport", errorMessage(err)) };
    }
    if (!response) return { error: new ModelError("empty_response", "The model returned no response.") };
    return { response, latencyMs: Math.max(0, this.clock.now().getTime() - started), firstTokenMs };
  }

  private usageColumns(model: string, response: ModelResponse) {
    return {
      tokensIn: promptTokens(response.usage),
      tokensOut: response.usage.outputTokens,
      // Priced at the rates of the model that actually answered.
      costMicroUsd: Math.round(this.opts.provider.priceMicroUsd(response.model ?? model, response.usage)),
    };
  }

  private completedDraft(
    base: { agentId: string; spanId: string; parentSpanId?: string },
    model: string,
    streamed: { response: ModelResponse; latencyMs: number; firstTokenMs: number | null },
    untrusted = false,
  ): EventDraft {
    const { response } = streamed;
    return {
      ...base,
      ...this.usageColumns(model, response),
      type: "model.call.completed",
      actor: "agent",
      untrusted,
      payload: {
        response_id: response.responseId ?? null,
        stop_reason: response.stopReason,
        content: response.content,
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          ...(response.usage.cacheReadTokens !== undefined ? { cache_read_tokens: response.usage.cacheReadTokens } : {}),
          ...(response.usage.cacheWriteTokens !== undefined ? { cache_write_tokens: response.usage.cacheWriteTokens } : {}),
        },
        latency_ms: streamed.latencyMs,
        first_token_ms: streamed.firstTokenMs,
        ...(response.model && response.model !== model ? { served_model: response.model } : {}),
        ...(response.refusal ? { refusal: response.refusal } : {}),
      },
    };
  }

  private backoff(attempt: number, retryAfterMs: number | undefined): number {
    // The provider's own instruction wins when it is a wait the run can reasonably sit through.
    if (retryAfterMs !== undefined && retryAfterMs >= 0 && retryAfterMs <= 120_000) return Math.round(retryAfterMs);
    const { initialDelayMs, maxDelayMs, jitterRatio } = this.retry;
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
    return Math.round(delay * (1 + jitterRatio * (this.random() * 2 - 1)));
  }

  private modelFailure(s: Session, error: ModelError): Promise<RunOutcome> {
    if (error.kind === "context_overflow") {
      return this.fail(s, "context_exhausted", "The conversation no longer fits in the model's context window.");
    }
    // An outage is not the run's fault: stop cleanly so it can be picked up again later.
    if (error.retryable) return this.pause(s, `error:${error.kind}`);
    return this.fail(s, error.kind, error.message);
  }

  private refused(s: Session, response: ModelResponse): Promise<RunOutcome> {
    const why = response.refusal?.category ? ` (${response.refusal.category})` : "";
    return this.fail(s, "refusal", `The model declined to continue${why}.`);
  }

  /**
   * One model call with no tools. `extract` is for text written by strangers: its answer must parse as JSON and
   * match the schema, and only that value goes back to the tool. `judge` is a critic looking at the run's own
   * work, with pictures. Each is logged under its own agent id, so nothing from it can enter the main agent's
   * conversation except through the tool's validated result. Outages are retried with the same backoff as the
   * agent's own calls; an answer in the wrong shape is asked for once more.
   */
  private async toolless(s: Session, parentSpanId: string, request: ToollessRequest, signal: AbortSignal): Promise<unknown> {
    const config = s.state.config;
    const judge = request.kind === "judge";
    const images: ImageBlock[] = [];
    for (const path of request.images ?? []) {
      try {
        const stored = await storeImage(this.artifactsDir(s.runId), path);
        images.push({ type: "image", mediaType: stored.media_type, sha256: stored.sha256 });
      } catch (err) {
        throw new ToolError(`A picture for the review could not be read: ${errorMessage(err)}.`);
      }
    }
    const compact = request.kind === "compact";
    const prompt = extractPrompt(request.instructions, z.toJSONSchema(request.schema), request.text, request.kind === "extract" ? "untrusted" : "material");
    const modelRequest: ModelRequest = {
      model: config.model,
      system: judge ? JUDGE_SYSTEM : compact ? COMPACT_SYSTEM : TOOLLESS_SYSTEM,
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }],
      maxOutputTokens: Math.min(config.max_output_tokens, 8_000),
    };
    const hash = requestHash(modelRequest);
    const outgoing = images.length ? await this.withImages(s, modelRequest) : modelRequest;
    const agentId = `${MAIN_AGENT}/${judge ? "critic" : compact ? "compactor" : "extract"}`;
    let shapeAttempts = 0;
    for (let attempt = 1; ; attempt += 1) {
      const base = { agentId, spanId: this.ids.uuid(), parentSpanId };
      await this.append(s, [
        {
          ...base,
          type: "model.call.started",
          actor: "engine",
          payload: {
            provider: this.opts.provider.id,
            model: modelRequest.model,
            params: { max_output_tokens: modelRequest.maxOutputTokens },
            purpose: judge ? "critique" : compact ? "compact" : "extract",
            tools_enabled: false,
            context_through_seq: 0,
            request_sha256: hash,
            attempt,
            ...(images.length ? { images: images.map((i) => ({ sha256: i.sha256, media_type: i.mediaType })) } : {}),
          },
        },
      ]);
      const streamed = await this.stream(outgoing, signal, false);
      if ("error" in streamed) {
        const { error } = streamed;
        const willRetry = !signal.aborted && error.retryable && attempt <= this.retry.maxRetries;
        const delay = willRetry ? this.backoff(attempt, error.retryAfterMs) : undefined;
        await this.append(s, [
          {
            ...base,
            type: "model.call.failed",
            actor: "engine",
            payload: {
              error: { kind: signal.aborted ? "cancelled" : error.kind, message: error.message, retryable: error.retryable },
              attempt,
              ...(delay !== undefined ? { retry_in_ms: delay } : {}),
            },
          },
        ]);
        if (signal.aborted) throw new ToolError("The call was stopped.");
        if (!willRetry) {
          throw new ToolError(judge ? "The review could not be done right now." : "The content could not be read right now.", "Try again in a moment, or use another source.");
        }
        try {
          await this.sleep(delay!, signal);
        } catch {
          throw new ToolError("The call was stopped.");
        }
        continue;
      }
      // Only text written by strangers is marked untrusted. A critique or a summary is of the run's own work.
      await this.append(s, [this.completedDraft(base, modelRequest.model, streamed, request.kind === "extract")]);
      const text = streamed.response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const checked = request.schema.safeParse(parseJsonFromText(text));
      if (checked.success) return checked.data;
      shapeAttempts += 1;
      if (shapeAttempts >= 2) break;
    }
    throw new ToolError(
      judge ? "The review came back in a shape that cannot be used." : "The content could not be turned into the expected shape.",
      judge ? "Try the review again." : "Use another source.",
    );
  }

  // ---------------------------------------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------------------------------------

  private host(s: Session, agentSpanId: string): DispatchHost {
    const runSpanId = s.state.runSpanId;
    return {
      runId: s.runId,
      agentId: MAIN_AGENT,
      agentSpanId,
      workDir: this.opts.workDir(s.runId),
      artifactsDir: this.artifactsDir(s.runId),
      append: (drafts) => this.append(s, drafts),
      newId: () => this.ids.uuid(),
      now: () => this.clock.now(),
      view: () => this.view(s),
      imagesLeft: () => (this.opts.maxImages ?? 60) - s.context.peek().images,
      sandbox: () => this.sandboxFor(s),
      enterStage: (stage, reviewGate) => this.enterStage(s, stage, reviewGate),
      completeStage: async () => {
        const closing = this.stageClose(s);
        if (closing.length) await this.append(s, closing);
      },
      budgetExceeded: () => {
        // The step limit counts model responses, so it never stops the tools a response already asked for.
        const hit = evaluateBudget({ ...this.usage(s), steps: 0 }, s.state.limits).exceeded;
        return hit ? `the run has reached its limit (${describeBudget(hit.dimension, hit.used, hit.limit)}).` : undefined;
      },
      openGate: async (gate, callId, payload, completeStage) => {
        // One batch: the stage cannot be closed and the review left unasked.
        await this.append(s, [
          ...(completeStage ? this.stageClose(s) : []),
          { type: "gate.opened", actor: "engine", agentId: MAIN_AGENT, spanId: agentSpanId, parentSpanId: runSpanId, payload: { ...payload, gate, tool_call_id: callId } },
        ]);
      },
      toolless: (parentSpanId, request, signal) => this.toolless(s, parentSpanId, request, signal),
      conclude: async (completed, result) => {
        // One batch: a crash cannot leave the result recorded and the run still open.
        await this.append(s, [
          completed,
          ...this.stageClose(s),
          { type: "agent.completed", actor: "agent", agentId: MAIN_AGENT, spanId: agentSpanId, parentSpanId: runSpanId, payload: { result: result ?? null } },
          { type: "run.completed", actor: "engine", spanId: runSpanId, payload: { final_artifact_id: null } },
        ]);
      },
      policy: this.opts.toolPolicy ?? {},
      maxInlineChars: this.opts.maxInlineChars ?? 42_000,
      maxParallel: this.opts.maxParallelToolCalls ?? 10,
    };
  }

  private usage(s: Session): BudgetUsage {
    return {
      tokens: s.state.tokensIn + s.state.tokensOut,
      costMicroUsd: s.state.costMicroUsd,
      activeMs: activeMsAt(s.state, this.clock.now()),
      steps: s.steps,
    };
  }

  private noteDraft(s: Session, agentSpanId: string, kind: string, content: string): EventDraft {
    return {
      type: "context.message",
      actor: "engine",
      agentId: MAIN_AGENT,
      spanId: agentSpanId,
      parentSpanId: s.state.runSpanId,
      payload: { origin: "engine", content, kind },
    };
  }

  private async note(s: Session, ctx: AgentContext, kind: string, content: string): Promise<void> {
    await this.append(s, [this.noteDraft(s, ctx.spanId!, kind, content)]);
  }

  private async pause(s: Session, reason: string, detail?: string): Promise<RunOutcome> {
    await this.append(s, [{ type: "run.paused", actor: "engine", spanId: s.state.runSpanId, payload: { reason, ...(detail ? { detail } : {}) } }]);
    return this.outcome(s);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Stages, the sandbox and pictures
  // ---------------------------------------------------------------------------------------------------------

  private artifactsDir(runId: string): string {
    return this.opts.artifactsDir?.(runId) ?? join(dirname(this.opts.workDir(runId)), "artifacts");
  }

  private view(s: Session): RunView {
    const { gates, stage, stageRevisions, reEdits, limits } = s.state;
    return { gates, ...(stage ? { stage: { name: stage.name, revision: stage.revision } } : {}), stageRevisions, reEdits, limits };
  }

  private stageClose(s: Session): EventDraft[] {
    const open = s.state.stage;
    if (!open) return [];
    return [{ type: "stage.completed", actor: "engine", spanId: open.spanId, parentSpanId: s.state.runSpanId, payload: { stage: open.name, output_artifact_ids: [] } }];
  }

  /**
   * Closes the open stage and starts this one, in one batch. The reason is read from the log: the first start
   * of a stage is the plan; a later one is the creator's doing if its review came back with changes since the
   * last start, and a critique otherwise. Revisions of the edit made on a critique count against the re-edit limit.
   */
  private async enterStage(s: Session, stage: string, reviewGate: string | undefined): Promise<{ stage: string; revision: number; trigger: StageTrigger }> {
    const revision = (s.state.stageRevisions[stage] ?? 0) + 1;
    let trigger: StageTrigger = "plan";
    if (revision > 1) {
      const last = s.events.findLast((e) => e.type === "stage.started" && payloadOf(e, "stage.started").stage === stage);
      const asked =
        reviewGate !== undefined &&
        s.events.some((e) => {
          if (e.type !== "gate.decided" || e.seq < (last?.seq ?? 0)) return false;
          const p = payloadOf(e, "gate.decided");
          return p.gate === reviewGate && p.decision === "changes_requested";
        });
      trigger = asked ? "creator" : "critique";
    }
    const max = s.state.limits.max_re_edits;
    if (stage === "edit" && trigger === "critique" && max !== undefined && s.state.reEdits >= max) {
      throw new ToolError(
        `The cut has been revised ${s.state.reEdits} ${s.state.reEdits === 1 ? "time" : "times"} on your own judgement, which is the limit for this run.`,
        "Hand in the current cut for review instead of revising it again.",
      );
    }
    await this.append(s, [
      ...this.stageClose(s),
      { type: "stage.started", actor: "engine", spanId: this.ids.uuid(), parentSpanId: s.state.runSpanId, payload: { stage, revision, trigger } },
    ]);
    return { stage, revision, trigger };
  }

  /** The run's sandbox, started once per worker on first use and recorded as its own span. */
  private sandboxFor(s: Session): Promise<SandboxSession> {
    const factory = this.opts.sandbox;
    if (!factory) return Promise.reject(new ToolError("This run has no sandbox, so nothing can be run in one."));
    if (s.sandbox) return Promise.resolve(s.sandbox.session);
    s.sandboxStarting ??= (async () => {
      let session: SandboxSession;
      try {
        session = await factory({ runId: s.runId, workDir: this.opts.workDir(s.runId), artifactsDir: this.artifactsDir(s.runId) });
      } catch (err) {
        s.sandboxStarting = undefined;
        s.sandboxFailure = errorMessage(err);
        throw new ToolError(`The sandbox could not be started: ${errorMessage(err)}`);
      }
      if (s.released) {
        await session.stop().catch(() => {});
        throw new ToolError("The run stopped before the sandbox was ready.");
      }
      s.sandbox = { session, spanId: this.ids.uuid() };
      await this.append(s, [
        {
          type: "sandbox.started",
          actor: "engine",
          spanId: s.sandbox.spanId,
          parentSpanId: s.state.runSpanId,
          payload: { image: session.info.image, container_id: session.info.containerId },
        },
      ]);
      return session;
    })();
    return s.sandboxStarting;
  }

  /** The request as the provider needs it: every picture with its bytes. One that can no longer be read is said so, in words. */
  private async withImages(s: Session, request: ModelRequest): Promise<ModelRequest> {
    const has = (b: ContentBlock) => b.type === "image" || (b.type === "tool_result" && Boolean(b.images?.length));
    if (!request.messages.some((m) => m.content.some(has))) return request;
    const dir = this.artifactsDir(s.runId);
    const read = async (sha256: string, mediaType: string): Promise<string | undefined> => {
      let data = s.imageData.get(sha256);
      if (data === undefined) {
        data = await loadImage(dir, sha256, mediaType);
        if (data !== undefined) s.imageData.set(sha256, data);
      }
      return data;
    };
    const fill = async (block: ContentBlock): Promise<ContentBlock> => {
      if (block.type === "image") {
        const data = await read(block.sha256, block.mediaType);
        return data === undefined ? { type: "text", text: "(A picture that was meant to be here can no longer be read.)" } : { ...block, data };
      }
      if (block.type !== "tool_result" || !block.images?.length) return block;
      const images = [];
      let missing = 0;
      for (const image of block.images) {
        const data = await read(image.sha256, image.mediaType);
        if (data === undefined) missing += 1;
        else images.push({ ...image, data });
      }
      const note = missing ? `\n\n(${missing === 1 ? "A picture" : `${missing} pictures`} shown here earlier can no longer be read.)` : "";
      return { ...block, content: block.content + note, images };
    };
    const messages = [];
    for (const message of request.messages) messages.push({ ...message, content: await Promise.all(message.content.map(fill)) });
    return { ...request, messages };
  }

  private async fail(s: Session, kind: string, message: string): Promise<RunOutcome> {
    await this.append(s, closeAll(s.events, kind, message));
    return this.outcome(s);
  }

  /**
   * Appends at the head of the log, one batch at a time. If a creator wrote in the meantime (a pause or cancel
   * request), the new events are folded in and the append is tried again.
   */
  private append(s: Session, drafts: EventDraft[]): Promise<HarnessEvent[]> {
    // The sandbox lives only while this worker drives the run. When a batch lets go of the run, the sandbox
    // is removed first and its closing event goes in ahead of the batch.
    const exitReason = drafts.map((d) => RELEASES[d.type]).find((reason) => reason !== undefined);
    let closing: { session: SandboxSession; spanId: string } | undefined;
    if (exitReason) {
      s.released = true;
      closing = s.sandbox;
      s.sandbox = undefined;
    }
    const work = async () => {
      let all = drafts;
      if (closing) {
        await closing.session.stop().catch(() => {});
        const spanId = closing.spanId;
        all = [
          { type: "sandbox.completed", actor: "engine", spanId, parentSpanId: s.state.runSpanId, payload: { exit_reason: exitReason } },
          ...drafts.filter((d) => !(d.type === "sandbox.completed" && d.spanId === spanId)),
        ];
      }
      const batch: NewEvent[] = all.map((d) => ({ ...d, eventId: this.ids.uuid(), occurredAt: this.clock.now().toISOString() }));
      for (let attempt = 0; ; attempt += 1) {
        try {
          const stored = await this.opts.store.append(s.runId, s.state.lastSeq, batch, s.epoch);
          s.load(stored);
          for (const e of stored) this.opts.onEvent?.(e);
          return stored;
        } catch (err) {
          if (!(err instanceof HeadMovedError) || attempt >= 5) throw err;
          const missed = await this.opts.store.read(s.runId, s.state.lastSeq);
          s.load(missed);
          for (const e of missed) this.opts.onEvent?.(e);
        }
      }
    };
    const result = s.chain.then(work, work);
    s.chain = result.catch(() => {});
    return result;
  }

  private outcome(s: Session): RunOutcome {
    const { state } = s;
    const done = state.status === "succeeded" ? s.events.findLast((e) => e.type === "agent.completed" && e.agentId === MAIN_AGENT) : undefined;
    return {
      runId: s.runId,
      status: state.status,
      ...(state.statusReason ? { reason: state.statusReason } : {}),
      ...(state.pendingGate ? { gate: state.pendingGate } : {}),
      ...(state.failure ? { failure: state.failure } : {}),
      ...(done ? { result: payloadOf(done, "agent.completed").result } : {}),
    };
  }
}

/** Whether a run can make progress without a person, for callers deciding whether to call `run` again. */
export const canContinue = (status: RunStatus): boolean => !isTerminal(status) && status !== "waiting_gate" && status !== "paused";
