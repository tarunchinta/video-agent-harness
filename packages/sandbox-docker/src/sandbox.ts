import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LABEL_API, LABEL_KIND, LABEL_RUN, SANDBOX_API, containerName, execArgs, killArgs, networkCreateArgs,
  networkName, proxyConnectArgs, proxyName, proxyRunArgs, proxyWaitArgs, readFileArgs, sandboxRunArgs,
  writeFileArgs,
  type HostFacts,
} from "./args.ts";
import { createDockerCli, type DockerCli, type DockerResult } from "./docker.ts";
import { SandboxError } from "./errors.ts";
import {
  execOptionsSchema, parseOptions, sandboxOptionsSchema,
  type ExecOptionsInput, type SandboxOptions, type SandboxOptionsInput,
} from "./options.ts";

/** How long a stopped command gets to exit (pid-file wait, TERM, KILL) before the local docker client is dropped. */
const KILL_GRACE_MS = 8_000;
/** Largest file `read` copies out unless the caller sets its own limit (2 GiB). */
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EGRESS_LOG_BYTES = 8 * 1024 * 1024;

export type SandboxInfo = {
  runId: string;
  /** The image reference asked for, and the exact image it resolved to (for `sandbox.started`). */
  image: string;
  imageId: string;
  containerId: string;
  containerName: string;
  network: SandboxOptions["network"];
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Bytes each stream produced, including any that were left out. */
  stdoutBytes: number;
  stderrBytes: number;
  /** True when stdout or stderr was longer than `maxOutputBytes`. */
  truncated: boolean;
  /** True when the command was stopped for running past `timeoutMs`. */
  timedOut: boolean;
  durationMs: number;
};

export type FileInfo = { bytes: number; sha256: string };

export type SandboxDeps = {
  docker?: DockerCli;
  /** Overrides for tests; default to this process. */
  platform?: NodeJS.Platform;
  uid?: number;
  gid?: number;
};

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** A message from the Docker daemon (not from the command) saying the container cannot be used. */
function saysContainerGone(stderr: string): boolean {
  return /^Error response from daemon:.*(No such container|is not running|is paused|is restarting)/m.test(stderr);
}

function checkContainerPath(path: string): void {
  if (path.length === 0 || path.includes("\0")) {
    throw new SandboxError("invalid_request", "a path inside the sandbox must be a non-empty string");
  }
}

async function describeHost(docker: DockerCli, deps: SandboxDeps): Promise<HostFacts> {
  const info = await docker.run(["info", "--format", "{{.NCPU}} {{.MemTotal}}"]);
  const [cpus, memoryBytes] = info.stdout.trim().split(/\s+/).map(Number);
  if (info.code !== 0 || !cpus || !memoryBytes) {
    throw new SandboxError("docker_unavailable", firstLine(info.stderr) || "the Docker daemon did not answer", {
      stderr: info.stderr,
    });
  }
  const host: HostFacts = { cpus, memoryMb: Math.floor(memoryBytes / (1024 * 1024)) };
  // Docker Desktop (Windows, macOS) maps file ownership itself. On Linux the container must run as the
  // caller, or files written to /work would belong to another user. Root on the host still maps to uid 1000.
  if ((deps.platform ?? process.platform) === "linux") {
    const uid = deps.uid ?? process.getuid?.();
    const gid = deps.gid ?? process.getgid?.();
    if (uid !== undefined && gid !== undefined && uid !== 0) host.user = `${uid}:${gid}`;
  }
  return host;
}

async function describeImage(docker: DockerCli, image: string): Promise<string> {
  const inspect = await docker.run([
    "image", "inspect", "--format", `{{.Id}} {{index .Config.Labels "${LABEL_API}"}}`, image,
  ]);
  if (inspect.code !== 0) {
    throw new SandboxError(
      "image_missing",
      `the image "${image}" is not built. Build it with: docker build -t ${image} packages/sandbox-docker/image`,
      { stderr: inspect.stderr },
    );
  }
  const [imageId = "", api = ""] = inspect.stdout.trim().split(/\s+/);
  if (api !== SANDBOX_API) {
    throw new SandboxError(
      "image_incompatible",
      `the image "${image}" has sandbox version "${api || "none"}" and this driver needs "${SANDBOX_API}". Rebuild it.`,
    );
  }
  return imageId;
}

/**
 * Removes everything that belongs to a run: its container, its proxy and its network. Safe to call when
 * some or all of them are already gone. Also the way to clean up after a worker that crashed.
 */
export async function removeSandbox(runId: string, docker: DockerCli = createDockerCli()): Promise<void> {
  const id = parseOptions(sandboxOptionsSchema.shape.runId, runId, "run id");
  await docker.run(["rm", "--force", "--volumes", containerName(id), proxyName(id)]);
  await docker.run(["network", "rm", networkName(id)]);
}

export type SandboxListing = { runId: string; containerId: string; state: string; createdAt: string };

/** Every run container on this Docker host, running or not. A caller that knows which runs are live can remove the rest. */
export async function listSandboxes(docker: DockerCli = createDockerCli()): Promise<SandboxListing[]> {
  const ps = await docker.run([
    "ps", "--all", "--filter", `label=${LABEL_KIND}=run`,
    "--format", `{{.Label "${LABEL_RUN}"}}\t{{.ID}}\t{{.State}}\t{{.CreatedAt}}`,
  ]);
  if (ps.code !== 0) {
    throw new SandboxError("docker_unavailable", firstLine(ps.stderr) || "could not list containers", { stderr: ps.stderr });
  }
  return ps.stdout
    .split("\n")
    .map((line) => line.trim().split("\t"))
    .filter((fields) => fields.length === 4)
    .map(([runId, containerId, state, createdAt]) => ({ runId: runId!, containerId: containerId!, state: state!, createdAt: createdAt! }));
}

/**
 * One run's sandbox: a container that exists from `start` to `stop`. Everything agent-written runs here.
 * The only state that outlives it is the run's working directory, mounted at /work.
 */
export class DockerSandbox {
  private stopped = false;

  private constructor(
    readonly info: SandboxInfo,
    private readonly docker: DockerCli,
  ) {}

  static async start(input: SandboxOptionsInput, deps: SandboxDeps = {}): Promise<DockerSandbox> {
    const options = parseOptions(sandboxOptionsSchema, input, "sandbox options");
    const docker = deps.docker ?? createDockerCli();
    const host = await describeHost(docker, deps);
    const imageId = await describeImage(docker, options.image);

    // A previous worker may have died holding this run. Only one worker drives a run (the lease), so
    // anything still carrying this run id is left over.
    await removeSandbox(options.runId, docker);
    await mkdir(options.workDir, { recursive: true });

    const must = async (args: string[], what: string): Promise<DockerResult> => {
      const result = await docker.run(args);
      if (result.code !== 0) {
        throw new SandboxError("start_failed", `could not ${what}: ${firstLine(result.stderr) || `exit code ${result.code}`}`, {
          stderr: result.stderr,
        });
      }
      return result;
    };

    try {
      if (options.network === "public") {
        await must(networkCreateArgs(options.runId), "create the run's network");
        await must(proxyRunArgs(options), "start the egress proxy");
        await must(proxyConnectArgs(options.runId), "attach the egress proxy to the run's network");
        await must(proxyWaitArgs(options.runId), "reach the egress proxy");
      }
      const run = await must(sandboxRunArgs(options, host), "start the sandbox container");
      return new DockerSandbox(
        {
          runId: options.runId,
          image: options.image,
          imageId,
          containerId: run.stdout.trim(),
          containerName: containerName(options.runId),
          network: options.network,
        },
        docker,
      );
    } catch (error) {
      await removeSandbox(options.runId, docker).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Runs a command (an argument array, no shell) and waits for it. A command that runs past its timeout is
   * stopped with everything it started, and the result says so. A cancelled command throws `aborted`.
   */
  async exec(command: readonly string[], input: ExecOptionsInput = {}): Promise<ExecResult> {
    this.assertUsable();
    const { signal, ...rest } = input;
    const options = parseOptions(execOptionsSchema, rest, "exec options");
    if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\0"))) {
      throw new SandboxError("invalid_request", "a command is a non-empty list of strings");
    }
    if (signal?.aborted) throw new SandboxError("aborted", "cancelled before the command started");

    const execId = randomUUID();
    const started = performance.now();
    const client = new AbortController();
    let timedOut = false;
    let aborted = false;
    let lastResort: NodeJS.Timeout | undefined;
    const stop = (): void => {
      void this.docker.run(killArgs(this.info.runId, execId)).catch(() => undefined);
      // If the container itself is stuck, stop waiting for it.
      lastResort ??= setTimeout(() => client.abort(), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await this.docker.run(execArgs(this.info.runId, execId, command, options), {
        input: options.input,
        captureLimit: options.maxOutputBytes,
        signal: client.signal,
      });
      if (aborted) throw new SandboxError("aborted", "the command was cancelled");
      if (!timedOut && result.code !== 0 && saysContainerGone(result.stderr)) await this.throwIfGone(result.stderr);
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        truncated: result.truncated,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(lastResort);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Copies one file out of the sandbox to `destination` on the host. The path is resolved inside the
   * container, so a symlink planted by run code cannot point the copy at a host file.
   */
  async read(path: string, destination: string, limits: { maxBytes?: number } = {}): Promise<FileInfo> {
    this.assertUsable();
    checkContainerPath(path);
    if (!isAbsolute(destination)) throw new SandboxError("invalid_request", "the destination must be an absolute host path");
    const maxBytes = limits.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    await mkdir(dirname(destination), { recursive: true });

    const hash = createHash("sha256");
    let bytes = 0;
    let tooLarge = false;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          tooLarge = true;
          done(new Error("over the size limit"));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const saved = pipeline(meter, createWriteStream(destination)).then(() => undefined, (error: Error) => error);
    const result = await this.docker.run(readFileArgs(this.info.runId, path), { stdoutTo: meter });
    const saveError = await saved;

    if (tooLarge || saveError || result.code !== 0) {
      await rm(destination, { force: true });
      if (tooLarge) throw new SandboxError("too_large", `"${path}" is larger than ${maxBytes} bytes`);
      if (result.code !== 0 && saysContainerGone(result.stderr)) await this.throwIfGone(result.stderr);
      if (result.code !== 0) throw new SandboxError("io", `could not read "${path}": ${firstLine(result.stderr)}`, { stderr: result.stderr });
      throw new SandboxError("io", `could not save "${path}" to ${destination}: ${saveError!.message}`, { cause: saveError });
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  /** Copies one host file into the sandbox, creating parent folders. Relative paths are under /work. */
  async write(path: string, source: string): Promise<FileInfo> {
    this.assertUsable();
    checkContainerPath(path);
    const sourceStat = await stat(source).catch(() => null);
    if (!isAbsolute(source) || !sourceStat?.isFile()) {
      throw new SandboxError("invalid_request", `the source must be an absolute path to a file: ${source}`);
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const file = createReadStream(source);
    file.once("error", (error) => meter.destroy(error));
    file.pipe(meter);

    const result = await this.docker.run(writeFileArgs(this.info.runId, path), { input: meter });
    if (result.code !== 0) {
      if (saysContainerGone(result.stderr)) await this.throwIfGone(result.stderr);
      throw new SandboxError("io", `could not write "${path}": ${firstLine(result.stderr)}`, { stderr: result.stderr });
    }
    if (bytes !== sourceStat.size) {
      throw new SandboxError("io", `only ${bytes} of ${sourceStat.size} bytes of ${source} were sent`);
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  /** True while the container is up. */
  async isRunning(): Promise<boolean> {
    if (this.stopped) return false;
    const inspect = await this.docker.run(["inspect", "--format", "{{.State.Running}}", this.info.containerName]);
    return inspect.code === 0 && inspect.stdout.trim() === "true";
  }

  /**
   * The proxy's record of this run's network use: one JSON object per line, each a host, a port and whether
   * it was allowed. Empty when the run has no network. Call it before `stop`.
   */
  async egressLog(): Promise<string> {
    if (this.stopped || this.info.network !== "public") return "";
    const logs = await this.docker.run(["logs", proxyName(this.info.runId)], { captureLimit: MAX_EGRESS_LOG_BYTES });
    return logs.code === 0 ? logs.stdout : "";
  }

  /** Removes the container, its proxy and its network. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await removeSandbox(this.info.runId, this.docker);
  }

  private assertUsable(): void {
    if (this.stopped) throw new SandboxError("not_running", "this sandbox has been stopped");
  }

  private async throwIfGone(stderr: string): Promise<void> {
    if (await this.isRunning()) return;
    throw new SandboxError("not_running", `the sandbox container is gone: ${firstLine(stderr)}`, { stderr });
  }
}
