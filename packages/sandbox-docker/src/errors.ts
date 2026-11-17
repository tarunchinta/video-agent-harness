/**
 * Every failure the driver reports has a stable code, so callers branch on the code and never on message text.
 * `retryable` says whether doing the same thing again can succeed without anyone changing anything.
 */
export type SandboxErrorCode =
  | "docker_unavailable" // the docker command is missing or the daemon does not answer
  | "image_missing" // the sandbox image has not been built
  | "image_incompatible" // the image was built for another version of this driver
  | "start_failed" // the container, its network or its proxy could not be created
  | "not_running" // the container is gone (stopped, removed, or the daemon restarted)
  | "invalid_request" // bad options, a bad path or an empty command
  | "aborted" // the caller's signal fired
  | "too_large" // a file read out of the sandbox is over the size limit
  | "io"; // a read or write inside the container failed (for example, no such file)

const RETRYABLE: ReadonlySet<SandboxErrorCode> = new Set(["docker_unavailable"]);

export class SandboxError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: SandboxErrorCode,
    message: string,
    public readonly details?: { stderr?: string; cause?: unknown },
  ) {
    super(`[sandbox] ${code}: ${message}`);
    this.name = "SandboxError";
    this.retryable = RETRYABLE.has(code);
  }
}
