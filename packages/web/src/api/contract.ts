import { z } from "zod";
import type { HarnessEvent, RunState } from "@harness/harness";

/**
 * The one contract between the web server and the browser. Browser-safe: it imports only types from the harness,
 * so nothing from Node reaches the client bundle.
 *
 * Two directions, as in the DeepSeek harness's GUI protocol, cut down to what one local creator needs:
 * - Calls: `POST /api/<method>` with the input as JSON. The answer is always HTTP 200 with a `Result`.
 * - Frames: one server-sent event stream, `GET /api/stream`, pushing what changed.
 *
 * Events on the wire are the harness's own events. There is no second set of shapes to keep in step.
 */

export const runStatusSchema = z.enum(["created", "running", "waiting_gate", "paused", "succeeded", "failed", "cancelled"]);

export const limitsInputSchema = z
  .object({
    max_cost_micro_usd: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    max_active_ms: z.number().int().positive(),
    max_steps: z.number().int().positive(),
    max_rounds: z.number().int().nonnegative(),
    max_re_edits: z.number().int().nonnegative(),
  })
  .partial();
export type LimitsInput = z.infer<typeof limitsInputSchema>;

/** Who is driving a run right now: this server, another process (the terminal), or nobody. */
export const driverSchema = z.enum(["here", "elsewhere", "none"]);
export type Driver = z.infer<typeof driverSchema>;

export const runCardSchema = z.object({
  runId: z.string(),
  title: z.string(),
  status: runStatusSchema,
  statusReason: z.string().optional(),
  pendingGate: z.string().optional(),
  stage: z.object({ name: z.string(), revision: z.number() }).optional(),
  project: z.string().optional(),
  pipeline: z.string().optional(),
  model: z.string(),
  costMicroUsd: z.number(),
  tokens: z.number(),
  activeMs: z.number(),
  createdAt: z.string(),
  lastEventAt: z.string(),
  events: z.number(),
  cuts: z.number(),
  driver: driverSchema,
  /** Why the last attempt to drive the run here did not start or stopped early. Kept in memory only. */
  driveError: z.string().optional(),
});
export type RunCard = z.infer<typeof runCardSchema>;

export const fileKindSchema = z.enum(["script", "narration", "notes", "research", "video", "audio", "image", "code", "data", "page", "other"]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const fileEntrySchema = z.object({ path: z.string(), bytes: z.number(), kind: fileKindSchema, modifiedAt: z.string() });
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const projectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  files: z.array(fileEntrySchema),
  /** True when the folder holds .md or .txt notes a reel can be given. */
  hasNotes: z.boolean(),
  modifiedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const hostInfoSchema = z.object({
  cwd: z.string(),
  runsDir: z.string(),
  projectsDir: z.string(),
  defaultModel: z.string(),
  models: z.array(z.string()),
  version: z.string(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;

/** Loose on purpose: the server validated every event when it was appended, and the client only reads it. */
const eventSchema = z.custom<HarnessEvent>(
  (v) => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string" && typeof (v as { seq?: unknown }).seq === "number",
);
const stateSchema = z.custom<RunState>((v) => typeof v === "object" && v !== null && typeof (v as { runId?: unknown }).runId === "string");

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i, "A project name is letters, numbers, dots, dashes and underscores.");
const runId = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/, "That is not a run id.");

export const voiceoverChoiceSchema = z.discriminatedUnion("kind", [
  /** A recording uploaded through `POST /api/upload`, by the name the upload returned. */
  z.object({ kind: z.literal("upload"), name: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("none") }),
  /** Use the recording the run already has. */
  z.object({ kind: z.literal("keep") }),
]);
export type VoiceoverChoice = z.infer<typeof voiceoverChoiceSchema>;

const ok = z.object({});

/** Every call the browser can make: its input and the value it gets back. The map key is the URL path. */
export const methods = {
  "host.describe": { input: ok, output: hostInfoSchema },
  "runs.list": { input: ok, output: z.object({ runs: z.array(runCardSchema) }) },
  "runs.get": {
    input: z.object({ runId }),
    output: z.object({ card: runCardSchema, state: stateSchema, events: z.array(eventSchema) }),
  },
  "runs.createReel": {
    input: z.object({
      topic: z.string().trim().min(3).max(400),
      seconds: z.number().int().min(10).max(180).default(60),
      sources: z.array(z.url()).max(20).default([]),
      project: slug.optional(),
      network: z.enum(["none", "public"]).default("none"),
      model: z.string().min(1).max(120).optional(),
      limits: limitsInputSchema.default({}),
    }),
    output: z.object({ runId: z.string() }),
  },
  "runs.createTask": {
    input: z.object({
      task: z.string().trim().min(3).max(4000),
      project: slug.optional(),
      sandbox: z.boolean().default(false),
      model: z.string().min(1).max(120).optional(),
      limits: limitsInputSchema.default({}),
    }),
    output: z.object({ runId: z.string() }),
  },
  "runs.decide": {
    input: z.object({
      runId,
      gate: z.string().min(1).max(40),
      decision: z.enum(["approved", "changes_requested", "rejected"]),
      notes: z.string().max(8000).default(""),
      voiceover: voiceoverChoiceSchema.optional(),
    }),
    output: z.object({ card: runCardSchema }),
  },
  "runs.resume": { input: z.object({ runId, limits: limitsInputSchema.default({}) }), output: z.object({ card: runCardSchema }) },
  "runs.pause": { input: z.object({ runId }), output: z.object({ card: runCardSchema }) },
  "runs.cancel": { input: z.object({ runId }), output: z.object({ card: runCardSchema }) },
  "runs.file": { input: z.object({ runId, project: slug.nullable() }), output: z.object({ card: runCardSchema }) },
  "runs.files": { input: z.object({ runId }), output: z.object({ files: z.array(fileEntrySchema) }) },
  "projects.list": { input: ok, output: z.object({ projects: z.array(projectSchema) }) },
  "projects.create": { input: z.object({ name: z.string().trim().min(1).max(80) }), output: z.object({ project: projectSchema }) },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type InputOf<M extends MethodName> = z.input<Methods[M]["input"]>;
export type ParsedInputOf<M extends MethodName> = z.output<Methods[M]["input"]>;
export type OutputOf<M extends MethodName> = z.output<Methods[M]["output"]>;

export const errorCodeSchema = z.enum(["bad-request", "not-found", "conflict", "failed"]);
export type ApiError = { code: z.infer<typeof errorCodeSchema>; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const resultSchema = <T extends z.ZodType>(value: T) =>
  z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: z.object({ code: errorCodeSchema, message: z.string() }) }),
  ]);

/** What the stream pushes. `events` frames carry the run's state after them, folded on the server. */
export const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runs"), runs: z.array(runCardSchema) }),
  z.object({ type: z.literal("events"), runId: z.string(), events: z.array(eventSchema), state: stateSchema }),
  /** Model text as it streams. Never stored: the finished text arrives on `model.call.completed`. */
  z.object({ type: z.literal("text"), runId: z.string(), delta: z.string() }),
  z.object({ type: z.literal("projects"), projects: z.array(projectSchema) }),
]);
export type Frame = z.infer<typeof frameSchema>;

/** Header every call that changes something must carry. A page on another site cannot set it without CORS. */
export const CLIENT_HEADER = "x-harness-client";

export const UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024;
