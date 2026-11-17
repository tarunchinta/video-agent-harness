import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { SandboxError } from "./errors.ts";
import { OutputBuffer } from "./output.ts";

/** Output kept from a docker command when the caller sets no limit (1 MiB per stream). */
export const DEFAULT_CAPTURE_BYTES = 1024 * 1024;

export type DockerRunOptions = {
  /** Sent to the command's stdin. Without it stdin is closed. */
  input?: string | Readable;
  /** Stdout goes here instead of being captured (used to copy files out of a container). */
  stdoutTo?: Writable;
  /** Most bytes kept per captured stream. */
  captureLimit?: number;
  /** Kills the local docker client. Processes inside a container are stopped separately (sandbox-kill). */
  signal?: AbortSignal;
};

export type DockerResult = {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** True when either stream was longer than the capture limit. */
  truncated: boolean;
};

/**
 * The one place the driver talks to Docker: the `docker` command line, with arguments passed as an array
 * (no shell). Tests swap this for a fake, so nothing else in the package needs Docker to be installed.
 */
export interface DockerCli {
  run(args: readonly string[], options?: DockerRunOptions): Promise<DockerResult>;
}

export function createDockerCli(bin = "docker"): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise<DockerResult>((resolve, reject) => {
        const child = spawn(bin, [...args], {
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const limit = options.captureLimit ?? DEFAULT_CAPTURE_BYTES;
        const stdout = new OutputBuffer(limit);
        const stderr = new OutputBuffer(limit);
        const kill = (): void => {
          child.kill();
        };

        options.signal?.addEventListener("abort", kill, { once: true });
        if (options.signal?.aborted) kill();

        let sinkDone: Promise<void> = Promise.resolve();
        if (options.stdoutTo) {
          const sink = options.stdoutTo;
          // If the destination fails (disk full, size limit), stop the command: nothing is reading it any more.
          sink.once("error", kill);
          sinkDone = finished(sink).catch(() => undefined);
          child.stdout!.pipe(sink);
        } else {
          child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
        }
        child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));

        if (child.stdin) {
          // The command may exit before reading everything; that is its business, not an error here.
          child.stdin.on("error", () => undefined);
          if (typeof options.input === "string") {
            child.stdin.end(options.input);
          } else if (options.input) {
            options.input.once("error", kill);
            options.input.pipe(child.stdin);
          }
        }

        child.once("error", (error: NodeJS.ErrnoException) => {
          options.signal?.removeEventListener("abort", kill);
          const why = error.code === "ENOENT" ? `the "${bin}" command was not found` : error.message;
          reject(new SandboxError("docker_unavailable", why, { cause: error }));
        });
        child.once("close", (code, signal) => {
          options.signal?.removeEventListener("abort", kill);
          void sinkDone.then(() =>
            resolve({
              code: code ?? (signal ? 137 : 1),
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              truncated: stdout.truncated || stderr.truncated,
            }),
          );
        });
      });
    },
  };
}
