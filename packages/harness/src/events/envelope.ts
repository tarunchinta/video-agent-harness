import { z } from "zod";

/**
 * The event envelope and the payloads the loop writes. Column names and event types follow
 * docs/plans/event-log-and-run-state.md; the TypeScript envelope uses camelCase for the columns and the
 * payloads keep the snake_case keys of the catalogue.
 */

export type Actor = "creator" | "agent" | "engine" | "plugin";

/** An event as a writer proposes it. The store assigns `runId` and `seq`. */
export type NewEvent = {
  eventId: string;
  type: string;
  schemaVersion?: number;
  occurredAt: string;
  actor: Actor;
  agentId?: string;
  spanId: string;
  parentSpanId?: string;
  untrusted?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  costMicroUsd?: number;
  payload: Record<string, unknown>;
};

/** An event as stored: immutable, with its gapless per-run position. */
export type HarnessEvent = NewEvent & { runId: string; seq: number; schemaVersion: number; untrusted: boolean };

export const MAX_PAYLOAD_BYTES = 262_144;
const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const limitsSchema = z.looseObject({
  max_tokens: z.number().int().positive().optional(),
  max_cost_micro_usd: z.number().int().positive().optional(),
  max_active_ms: z.number().int().positive().optional(),
  max_re_edits: z.number().int().nonnegative().optional(),
  max_steps: z.number().int().positive().optional(),
  max_rounds: z.number().int().nonnegative().optional(),
});
export type Limits = z.infer<typeof limitsSchema>;

const errorSchema = z.looseObject({ kind: z.string(), message: z.string() });
const usageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
});

export const gateDecisionSchema = z.enum(["approved", "changes_requested", "rejected"]);
export type GateDecisionKind = z.infer<typeof gateDecisionSchema>;

/** Payload schemas for every type the loop writes. Extra fields are allowed so the catalogue can grow. */
export const payloadSchemas = {
  "run.created": z.looseObject({
    title: z.string(),
    brief: z.looseObject({ task: z.string() }),
    config: z.looseObject({
      model: z.string(),
      system: z.string(),
      max_output_tokens: z.number().int().positive(),
      effort: z.string().optional(),
      /** The set of tools and prompts the run was started with, so a later worker builds the same ones. */
      pipeline: z.string().optional(),
      /** Set when the run has a sandbox: what its commands can reach. */
      sandbox_network: z.enum(["none", "public"]).optional(),
      /** Set when a critic must review each cut before it is handed in. */
      critic: z.boolean().optional(),
      /** Set when the loop may clear old tool results and summarise the conversation as it fills the window. */
      compaction: z.boolean().optional(),
      /** Set when the creator wrote and recorded the narration themselves: its words, which the run may not change. */
      narration: z.string().optional(),
    }),
    limits: limitsSchema,
    harness_version: z.string(),
  }),
  "run.started": z.looseObject({ worker: z.string(), epoch: z.number().int() }),
  "run.resumed": z.looseObject({
    worker: z.string(),
    epoch: z.number().int(),
    reason: z.enum(["crash", "gate", "unpaused"]),
    interrupted_spans: z.array(z.string()),
  }),
  "run.pause_requested": z.looseObject({ note: z.string().optional() }),
  "run.paused": z.looseObject({ reason: z.string() }),
  "run.resume_requested": z.looseObject({ note: z.string().optional() }),
  "run.cancel_requested": z.looseObject({ note: z.string().optional() }),
  "run.completed": z.looseObject({ final_artifact_id: z.string().nullable().optional() }),
  "run.failed": z.looseObject({ error: errorSchema }),
  "budget.updated": z.looseObject({ limits: limitsSchema }),
  "budget.exceeded": z.looseObject({ dimension: z.string(), used: z.number(), limit: z.number() }),
  "stage.started": z.looseObject({
    stage: z.string(),
    revision: z.number().int().positive(),
    trigger: z.enum(["plan", "critique", "creator"]),
  }),
  "stage.completed": z.looseObject({ stage: z.string(), output_artifact_ids: z.array(z.string()).optional() }),
  "stage.failed": z.looseObject({ stage: z.string(), error: errorSchema }),
  "sandbox.started": z.looseObject({ image: z.string(), container_id: z.string() }),
  "sandbox.completed": z.looseObject({ exit_reason: z.string() }),
  "gate.opened": z.looseObject({ gate: z.string(), tool_call_id: z.string().optional() }),
  "gate.decided": z.looseObject({
    gate: z.string(),
    decision: gateDecisionSchema,
    notes: z.array(z.looseObject({ text: z.string() })).default([]),
  }),
  "agent.started": z.looseObject({
    role: z.string(),
    model: z.string(),
    tools: z.array(z.string()),
    system_prompt_sha256: z.string(),
    // Kept in full so any model request can be rebuilt from the log alone.
    system_prompt: z.string(),
    tool_specs: z.array(z.looseObject({ name: z.string(), description: z.string(), input_schema: z.unknown() })),
    task: z.string(),
  }),
  "agent.completed": z.looseObject({ result: z.unknown() }),
  "agent.failed": z.looseObject({ error: errorSchema }),
  "context.message": z.looseObject({ origin: z.string(), content: z.string(), kind: z.string().optional() }),
  /**
   * The agent's conversation was made smaller. `trim` replaces the named tool results with a pointer to their
   * saved text; `summary` replaces everything after the task with one summary. Either starts a new request prefix.
   */
  "context.compacted": z.discriminatedUnion("mode", [
    z.looseObject({
      mode: z.literal("trim"),
      cleared: z.array(z.looseObject({ tool_call_id: z.string(), path: z.string() })).min(1),
      tokens_before: z.number().int().nonnegative(),
      tokens_after: z.number().int().nonnegative(),
    }),
    z.looseObject({
      mode: z.literal("summary"),
      summary: z.string().min(1),
      from_seq: z.number().int().nonnegative(),
      to_seq: z.number().int().nonnegative(),
      tokens_before: z.number().int().nonnegative(),
      tokens_after: z.number().int().nonnegative(),
    }),
  ]),
  "model.call.started": z.looseObject({
    provider: z.string(),
    model: z.string(),
    params: z.looseObject({}),
    purpose: z.string(),
    tools_enabled: z.boolean(),
    context_through_seq: z.number().int().nonnegative(),
    request_sha256: z.string(),
    attempt: z.number().int().positive(),
  }),
  "model.call.completed": z.looseObject({
    response_id: z.string().nullable().optional(),
    stop_reason: z.string(),
    content: z.array(z.looseObject({ type: z.string() })),
    usage: usageSchema,
    latency_ms: z.number().nonnegative(),
    first_token_ms: z.number().nonnegative().nullable().optional(),
  }),
  "model.call.failed": z.looseObject({
    error: errorSchema.extend({ retryable: z.boolean() }),
    attempt: z.number().int().positive(),
    // Written before the wait starts, so a crash during backoff leaves no hidden pending retry.
    retry_in_ms: z.number().nonnegative().optional(),
  }),
  "tool.call.started": z.looseObject({
    tool: z.string(),
    plugin: z.string(),
    plugin_version: z.string(),
    tool_call_id: z.string(),
    input: z.unknown(),
    idempotent: z.boolean(),
    sandboxed: z.boolean(),
  }),
  "tool.call.completed": z.looseObject({
    tool_call_id: z.string(),
    // What the model reads. Large results are cut to a preview, with the full text at `output_path`.
    output: z.string(),
    truncated: z.boolean(),
    output_path: z.string().optional(),
    // Pictures the model is shown with the result. The bytes are in the run's artifacts folder, named by hash.
    images: z.array(z.looseObject({ sha256: z.string(), media_type: z.string(), bytes: z.number().int().nonnegative() })).optional(),
    duration_ms: z.number().nonnegative(),
  }),
  "tool.call.failed": z.looseObject({ tool_call_id: z.string(), error: errorSchema }),
} as const;

export type EventType = keyof typeof payloadSchemas;
export type PayloadOf<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

/**
 * Checks an event before it is appended. Known types must match their schema. Plugin types (`x.<plugin>.…`) are
 * accepted as they are: the reducer ignores them, so they can record anything but never move a run between states.
 */
export function validateNewEvent(event: NewEvent): void {
  if (!TYPE_RE.test(event.type)) throw new EventValidationError(`Event type "${event.type}" is not lowercase and dot-separated.`);
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new EventValidationError(`Event ${event.type} needs an object payload.`);
  }
  let text: string;
  try {
    text = JSON.stringify(event.payload);
  } catch {
    throw new EventValidationError(`Event ${event.type} has a payload that is not JSON.`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new EventValidationError(`Event ${event.type} has a payload over ${MAX_PAYLOAD_BYTES} bytes. Large data belongs in a file.`);
  }
  const schema = (payloadSchemas as Record<string, z.ZodType>)[event.type];
  if (!schema) {
    if (event.type.startsWith("x.")) return;
    throw new EventValidationError(`Event type "${event.type}" is not in the catalogue. Plugin types start with "x.".`);
  }
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ");
    throw new EventValidationError(`Event ${event.type} has an invalid payload: ${issues}`);
  }
}

export const isSpanOpen = (type: string) => type.endsWith(".started");
export const isSpanClose = (type: string) => type.endsWith(".completed") || type.endsWith(".failed");

/** Reads a payload with the type its schema promises. The store validated it on the way in. */
export function payloadOf<T extends EventType>(event: HarnessEvent, _type: T): PayloadOf<T> {
  return event.payload as PayloadOf<T>;
}
