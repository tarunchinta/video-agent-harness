/**
 * What the loop needs from a sandbox, in its own vocabulary. The Docker driver in `@harness/sandbox-docker`
 * fits this shape as it is; the loop never imports it. Whoever builds the engine passes a factory.
 */

export type SandboxExecOptions = {
  /** Directory inside the sandbox. The run's working directory is mounted at `/work`. */
  cwd?: string;
  env?: Record<string, string>;
  /** The command and everything it started are stopped after this long. */
  timeoutMs?: number;
  /** Text sent to the command's stdin. */
  input?: string;
  /** Most bytes of stdout and of stderr returned. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export type SandboxExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Output was longer than the limit, and part of it was left out. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Set when the run's working folder holds more than its limit after the command. */
  diskFull?: { usedBytes: number; limitBytes: number };
};

export interface SandboxSession {
  readonly info: { image: string; containerId: string };
  /** Runs a command given as a list of arguments, with no shell, and waits for it. */
  exec(command: readonly string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Removes the sandbox. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Starts the sandbox for one run. Called at most once per worker, the first time a tool asks for it. */
export type SandboxFactory = (run: { runId: string; workDir: string; artifactsDir: string }) => Promise<SandboxSession>;

/** Where the run's working directory appears inside the sandbox. */
export const SANDBOX_WORK_DIR = "/work";
