import { isAbsolute } from "node:path";
import { z } from "zod";
import { SandboxError } from "./errors.ts";

/** Run ids become container, network and label names, so they are limited to what Docker accepts in a name. */
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "use letters, digits, '_', '.' or '-' (64 at most)");

const absolutePath = z.string().min(1).refine((value) => isAbsolute(value), "must be an absolute path");

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");
const env = z.record(envName, z.string().refine((value) => !value.includes("\0"), "must not contain a NUL byte"));

/** "example.com" for one host, ".example.com" for a host and its subdomains. */
const hostPattern = z.string().regex(/^\.?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "not a host name");

const limits = z.object({
  /** Memory for everything in the container, including /dev/shm. No swap on top. */
  memoryMb: z.number().int().min(256).default(4096),
  cpus: z.number().min(0.25).default(4),
  /** Processes and threads. Chromium alone uses a few hundred. */
  pids: z.number().int().min(64).default(2048),
  /** Shared memory. Chromium crashes on large pages with Docker's 64 MB default. */
  shmMb: z.number().int().min(64).default(1024),
});

export const sandboxOptionsSchema = z.object({
  runId,
  /** The run's working directory on the host. Mounted read-write at /work. Created if missing. */
  workDir: absolutePath,
  /** The run's artifacts directory on the host. Mounted read-only at /artifacts when given. */
  artifactsDir: absolutePath.optional(),
  image: z.string().min(1).default("harness-sandbox:local"),
  /**
   * `none`: no network at all. `public`: HTTP and HTTPS to the public internet through the run's egress
   * proxy; the host, the local network and other containers stay unreachable.
   */
  network: z.enum(["none", "public"]).default("none"),
  /** With `network: "public"`, limit the proxy to these hosts. Empty means any public host. */
  allowHosts: z.array(hostPattern).default([]),
  limits: limits.default(() => limits.parse({})),
  /** Extra environment for every command. Never put secrets here: run code can read all of it. */
  env: env.default({}),
  /**
   * A named Docker volume for npm, uv and pip download caches, shared between runs. Off by default, because
   * a shared cache is something one run can leave behind for the next.
   */
  cacheVolume: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional(),
});

export type SandboxOptionsInput = z.input<typeof sandboxOptionsSchema>;
export type SandboxOptions = z.output<typeof sandboxOptionsSchema>;

export const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000;

export const execOptionsSchema = z.object({
  /** Directory inside the container. */
  cwd: z.string().min(1).refine((value) => !value.includes("\0"), "must not contain a NUL byte").default("/work"),
  env: env.default({}),
  /** The command and everything it started are stopped after this long. */
  timeoutMs: z.number().int().min(1).max(MAX_EXEC_TIMEOUT_MS).default(120_000),
  /** Text sent to the command's stdin. */
  input: z.string().optional(),
  /** Most bytes of stdout and of stderr returned. The start and the end are kept. */
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
});

export type ExecOptionsInput = z.input<typeof execOptionsSchema> & {
  /** Stops the command and makes `exec` throw `aborted`. */
  signal?: AbortSignal;
};
export type ExecOptions = z.output<typeof execOptionsSchema>;

export function parseOptions<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || what}: ${issue.message}`);
  throw new SandboxError("invalid_request", `${what} are not valid (${problems.join("; ")})`);
}
