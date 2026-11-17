import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxError, type SandboxErrorCode } from "../src/errors.ts";
import { OutputBuffer } from "../src/output.ts";
import { DockerSandbox, listSandboxes } from "../src/sandbox.ts";
import { fakeDocker, verbs, type Handler } from "./fake-docker.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const isExec = (args: string[], script: string): boolean => args[0] === "exec" && args.includes(script);

async function expectCode(promise: Promise<unknown>, code: SandboxErrorCode): Promise<SandboxError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SandboxError);
  expect((error as SandboxError).code).toBe(code);
  return error as SandboxError;
}

function start(handler?: Handler, options: Record<string, unknown> = {}) {
  const docker = fakeDocker(handler);
  const sandbox = DockerSandbox.start({ runId: "run-1", workDir: join(dir, "work"), ...options }, { docker, platform: "win32" });
  return { docker, sandbox };
}

describe("start", () => {
  it("checks the host and the image, clears leftovers, then starts one container", async () => {
    const { docker, sandbox } = start();
    const { info } = await sandbox;
    expect(verbs(docker.calls)).toEqual(["info", "image inspect", "rm", "network rm", "run"]);
    expect(info).toEqual({
      runId: "run-1", image: "harness-sandbox:local", imageId: "sha256:feedface", containerId: "c0ffee",
      containerName: "harness-run-run-1", network: "none",
    });
    expect(existsSync(join(dir, "work"))).toBe(true);
  });

  it("brings up the network and the proxy before the sandbox when public", async () => {
    const { docker, sandbox } = start(undefined, { network: "public" });
    await sandbox;
    expect(verbs(docker.calls).slice(4)).toEqual(["network create", "run", "network connect", "exec", "run"]);
    expect(docker.calls[4]!.args).toContain("--internal");
    expect(docker.calls[5]!.args).toContain("harness-egress-run-1");
    expect(docker.calls[8]!.args).toContain("harness-run-run-1");
  });

  it("runs as the caller on a Linux host", async () => {
    const docker = fakeDocker();
    await DockerSandbox.start({ runId: "run-1", workDir: join(dir, "work") }, { docker, platform: "linux", uid: 1001, gid: 1002 });
    const run = docker.calls.at(-1)!.args;
    expect(run[run.indexOf("--user") + 1]).toBe("1001:1002");
  });

  it("says how to build the image when it is missing", async () => {
    const { docker, sandbox } = start((args) => (args[0] === "image" ? { code: 1, stderr: "Error: No such image" } : undefined));
    const error = await expectCode(sandbox, "image_missing");
    expect(error.message).toContain("docker build");
    expect(verbs(docker.calls)).not.toContain("run");
  });

  it("refuses an image built for another driver version", async () => {
    const { sandbox } = start((args) => (args[0] === "image" ? { stdout: "sha256:feedface 0\n" } : undefined));
    await expectCode(sandbox, "image_incompatible");
  });

  it("reports an unreachable daemon as retryable", async () => {
    const { sandbox } = start((args) => (args[0] === "info" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
    expect((await expectCode(sandbox, "docker_unavailable")).retryable).toBe(true);
  });

  it("cleans up what it created when a step fails", async () => {
    const { docker, sandbox } = start(
      (args) => (args[0] === "network" && args[1] === "connect" ? { code: 1, stderr: "network not found" } : undefined),
      { network: "public" },
    );
    await expectCode(sandbox, "start_failed");
    expect(verbs(docker.calls).slice(-2)).toEqual(["rm", "network rm"]);
  });

  it("rejects options that are not valid before touching Docker", async () => {
    const docker = fakeDocker();
    await expectCode(DockerSandbox.start({ runId: "../etc", workDir: join(dir, "work") }, { docker }), "invalid_request");
    await expectCode(DockerSandbox.start({ runId: "run-1", workDir: "relative/work" }, { docker }), "invalid_request");
    await expectCode(DockerSandbox.start({ runId: "run-1", workDir: dir, env: { "BAD NAME": "x" } }, { docker }), "invalid_request");
    expect(docker.calls).toEqual([]);
  });
});

describe("exec", () => {
  it("returns the exit code and output", async () => {
    const { docker, sandbox } = start((args) => (isExec(args, "sandbox-exec") ? { code: 3, stdout: "out", stderr: "err", stdoutBytes: 3, stderrBytes: 3 } : undefined));
    const result = await (await sandbox).exec(["python", "x.py"], { maxOutputBytes: 2048, input: "data" });
    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err", timedOut: false, truncated: false });
    const call = docker.calls.at(-1)!;
    expect(call.args.slice(-2)).toEqual(["python", "x.py"]);
    expect(call.options).toMatchObject({ captureLimit: 2048, input: "data" });
  });

  it("stops the command's process tree on timeout and reports it as a result", async () => {
    let release: (() => void) | undefined;
    const { docker, sandbox } = start((args) => {
      if (isExec(args, "sandbox-kill")) {
        release?.();
        return {};
      }
      if (isExec(args, "sandbox-exec")) return new Promise((done) => (release = () => done({ code: 143, stdout: "partial" })));
      return undefined;
    });
    const result = await (await sandbox).exec(["sleep", "60"], { timeoutMs: 20 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 143, stdout: "partial" });
    const exec = docker.calls.find(({ args }) => isExec(args, "sandbox-exec"))!.args;
    const kill = docker.calls.find(({ args }) => isExec(args, "sandbox-kill"))!.args;
    expect(kill.at(-1)).toBe(exec[exec.indexOf("sandbox-exec") + 1]);
  });

  it("stops the command and throws when the caller cancels", async () => {
    let release: (() => void) | undefined;
    const { docker, sandbox } = start((args) => {
      if (isExec(args, "sandbox-kill")) {
        release?.();
        return {};
      }
      if (isExec(args, "sandbox-exec")) return new Promise((done) => (release = () => done({ code: 143 })));
      return undefined;
    });
    const controller = new AbortController();
    const pending = (await sandbox).exec(["sleep", "60"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expectCode(pending, "aborted");
    expect(docker.calls.some(({ args }) => isExec(args, "sandbox-kill"))).toBe(true);
  });

  it("does not start a command for a signal that already fired", async () => {
    const { docker, sandbox } = start();
    const ready = await sandbox;
    const before = docker.calls.length;
    await expectCode(ready.exec(["true"], { signal: AbortSignal.abort() }), "aborted");
    expect(docker.calls.length).toBe(before);
  });

  it("tells a vanished container apart from a failing command", async () => {
    const gone = "Error response from daemon: No such container: harness-run-run-1";
    const { sandbox } = start((args) => {
      if (isExec(args, "sandbox-exec")) return { code: 1, stderr: gone };
      if (args[0] === "inspect") return { code: 1, stderr: gone };
      return undefined;
    });
    await expectCode((await sandbox).exec(["true"]), "not_running");

    // The same words printed by the command itself, with the container still up, are just output.
    const { sandbox: alive } = start((args) => {
      if (isExec(args, "sandbox-exec")) return { code: 1, stderr: gone };
      if (args[0] === "inspect") return { stdout: "true\n" };
      return undefined;
    });
    expect((await (await alive).exec(["true"])).exitCode).toBe(1);
  });

  it("rejects an empty command and bad options", async () => {
    const ready = await start().sandbox;
    await expectCode(ready.exec([]), "invalid_request");
    await expectCode(ready.exec(["true"], { timeoutMs: 0 }), "invalid_request");
  });
});

describe("read and write", () => {
  it("copies a file out and reports its size and hash", async () => {
    const { docker, sandbox } = start(async (args, options) => {
      if (args.includes("cat")) {
        options.stdoutTo!.end("chart bytes");
        await finished(options.stdoutTo!).catch(() => undefined);
        return {};
      }
      return undefined;
    });
    const destination = join(dir, "artifacts", "chart.png");
    const info = await (await sandbox).read("charts/chart.png", destination);
    expect(info).toEqual({ bytes: 11, sha256: sha256("chart bytes") });
    expect(await readFile(destination, "utf8")).toBe("chart bytes");
    expect(docker.calls.at(-1)!.args.slice(-3)).toEqual(["cat", "--", "charts/chart.png"]);
  });

  it("stops and leaves nothing behind when a file is over the limit", async () => {
    const { sandbox } = start(async (args, options) => {
      if (args.includes("cat")) {
        options.stdoutTo!.on("error", () => undefined);
        options.stdoutTo!.end("0123456789");
        await finished(options.stdoutTo!).catch(() => undefined);
        return { code: 137 };
      }
      return undefined;
    });
    const destination = join(dir, "big.bin");
    await expectCode((await sandbox).read("big.bin", destination, { maxBytes: 4 }), "too_large");
    expect(existsSync(destination)).toBe(false);
  });

  it("reports a missing file as an io error", async () => {
    const { sandbox } = start(async (args, options) => {
      if (args.includes("cat")) {
        options.stdoutTo!.end();
        return { code: 1, stderr: "cat: nope.txt: No such file or directory" };
      }
      return undefined;
    });
    const destination = join(dir, "nope.txt");
    const error = await expectCode((await sandbox).read("nope.txt", destination), "io");
    expect(error.message).toContain("No such file");
    expect(existsSync(destination)).toBe(false);
  });

  it("copies a host file in through stdin", async () => {
    let received = "";
    const { docker, sandbox } = start(async (args, options) => {
      if (args.includes("sh")) {
        for await (const chunk of options.input as Readable) received += String(chunk);
        return {};
      }
      return undefined;
    });
    const source = join(dir, "voiceover.txt");
    await writeFile(source, "hello sandbox");
    const info = await (await sandbox).write("inputs/voiceover.txt", source);
    expect(received).toBe("hello sandbox");
    expect(info).toEqual({ bytes: 13, sha256: sha256("hello sandbox") });
    expect(docker.calls.at(-1)!.args.at(-1)).toBe("inputs/voiceover.txt");
  });

  it("rejects a source that is not a file", async () => {
    await expectCode((await start().sandbox).write("x", join(dir, "missing.txt")), "invalid_request");
  });
});

describe("stop", () => {
  it("removes the container, proxy and network once, and refuses further use", async () => {
    const { docker, sandbox } = start();
    const ready = await sandbox;
    const before = docker.calls.length;
    await ready.stop();
    await ready.stop();
    expect(verbs(docker.calls.slice(before))).toEqual(["rm", "network rm"]);
    expect(docker.calls[before]!.args).toEqual(["rm", "--force", "--volumes", "harness-run-run-1", "harness-egress-run-1"]);
    await expectCode(ready.exec(["true"]), "not_running");
    expect(await ready.isRunning()).toBe(false);
  });
});

describe("listSandboxes", () => {
  it("lists run containers by run id", async () => {
    const docker = fakeDocker((args) => (args[0] === "ps" ? { stdout: "run-1\tabc123\trunning\t2026-01-01 10:00:00 +0000 UTC\nrun-2\tdef456\texited\t2026-01-01 09:00:00 +0000 UTC\n" } : undefined));
    expect(await listSandboxes(docker)).toEqual([
      { runId: "run-1", containerId: "abc123", state: "running", createdAt: "2026-01-01 10:00:00 +0000 UTC" },
      { runId: "run-2", containerId: "def456", state: "exited", createdAt: "2026-01-01 09:00:00 +0000 UTC" },
    ]);
  });
});

describe("OutputBuffer", () => {
  it("keeps short output whole", () => {
    const buffer = new OutputBuffer(100);
    buffer.push(Buffer.from("hello "));
    buffer.push(Buffer.from("world"));
    expect(buffer.toString()).toBe("hello world");
    expect(buffer.truncated).toBe(false);
  });

  it("keeps the start and the end of long output and says what it dropped", () => {
    const buffer = new OutputBuffer(8);
    for (const chunk of ["abcdef", "ghijkl", "mnopqr", "stuvwx", "yz"]) buffer.push(Buffer.from(chunk));
    expect(buffer.bytes).toBe(26);
    expect(buffer.truncated).toBe(true);
    expect(buffer.toString()).toBe("abcd\n[... 18 bytes left out ...]\nwxyz");
  });
});
