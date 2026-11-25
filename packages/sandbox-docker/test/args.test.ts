import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bindMount, execArgs, proxyRunArgs, sandboxRunArgs, type HostFacts } from "../src/args.ts";
import { execOptionsSchema, sandboxOptionsSchema, type SandboxOptionsInput } from "../src/options.ts";

const workDir = resolve("runs", "run-1", "work");
const host: HostFacts = { cpus: 8, memoryMb: 16000 };

function runArgs(overrides: Partial<SandboxOptionsInput> = {}, facts: HostFacts = host): string[] {
  return sandboxRunArgs(sandboxOptionsSchema.parse({ runId: "run-1", workDir, ...overrides }), facts);
}

/** The value that follows a flag, for flags that appear once. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("sandboxRunArgs", () => {
  it("drops every capability and blocks privilege gain", () => {
    const args = runArgs();
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(flagValue(args, "--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--init");
  });

  it("never asks for a way out of the container", () => {
    for (const args of [runArgs(), runArgs({ network: "public", cacheVolume: "cache", artifactsDir: resolve("a") })]) {
      const forbidden = ["--privileged", "--pid", "--ipc", "--cap-add", "--device", "--publish", "-p", "--publish-all", "-P", "--volume", "-v"];
      expect(args.filter((arg) => forbidden.includes(arg))).toEqual([]);
      expect(args.filter((arg) => arg.includes("docker.sock"))).toEqual([]);
      expect(flagValue(args, "--network")).not.toBe("host");
    }
  });

  it("has no network and no proxy settings by default", () => {
    const args = runArgs();
    expect(flagValue(args, "--network")).toBe("none");
    expect(args.join(" ")).not.toContain("PROXY");
  });

  it("joins the run's own network and points at the proxy when public", () => {
    const args = runArgs({ network: "public" });
    expect(flagValue(args, "--network")).toBe("harness-net-run-1");
    expect(args).toContain("HTTPS_PROXY=http://egress:3128");
    expect(args).toContain("NO_PROXY=localhost,127.0.0.1,::1");
  });

  it("limits memory, CPU and processes, with no swap on top", () => {
    const args = runArgs();
    expect(flagValue(args, "--memory")).toBe("4096m");
    expect(flagValue(args, "--memory-swap")).toBe("4096m");
    expect(flagValue(args, "--cpus")).toBe("4");
    expect(flagValue(args, "--pids-limit")).toBe("2048");
    // No single file may outgrow the whole working folder's limit, 10 GB unless set.
    expect(args).toContain(`fsize=${10 * 1024 ** 3}`);
  });

  it("clamps limits to what the Docker host has", () => {
    const args = runArgs({}, { cpus: 2, memoryMb: 512 });
    expect(flagValue(args, "--cpus")).toBe("2");
    expect(flagValue(args, "--memory")).toBe("512m");
    expect(flagValue(args, "--shm-size")).toBe("512m");
  });

  it("runs as the host user only when one is given", () => {
    expect(runArgs()).not.toContain("--user");
    expect(flagValue(runArgs({}, { ...host, user: "1001:1001" }), "--user")).toBe("1001:1001");
  });

  it("mounts the working directory read-write and artifacts read-only", () => {
    const artifactsDir = resolve("runs", "run-1", "artifacts");
    const args = runArgs({ artifactsDir });
    expect(args).toContain(`type=bind,src=${workDir},dst=/work`);
    expect(args).toContain(`type=bind,src=${artifactsDir},dst=/artifacts,readonly`);
  });

  it("passes only the environment it was given", () => {
    const args = runArgs({ env: { TZ: "UTC" } });
    const env = args.filter((_, index) => args[index - 1] === "-e");
    expect(env).toEqual(["TZ=UTC"]);
  });

  it("ends with the image and an idle command", () => {
    expect(runArgs({ image: "harness-sandbox:test" }).slice(-3)).toEqual(["harness-sandbox:test", "sleep", "infinity"]);
  });
});

describe("bindMount", () => {
  it("quotes a path that contains a comma or a quote", () => {
    expect(bindMount('/data/a,b"c', "/work", false)).toBe('type=bind,"src=/data/a,b""c",dst=/work');
  });
});

describe("proxyRunArgs", () => {
  it("is locked down and carries the allow list", () => {
    const args = proxyRunArgs(sandboxOptionsSchema.parse({ runId: "run-1", workDir, network: "public", allowHosts: [".example.com", "data.example"] }));
    expect(args).toContain("--read-only");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(flagValue(args, "--network")).toBe("bridge");
    expect(args).toContain("EGRESS_ALLOW_HOSTS=.example.com,data.example");
    expect(args.join(" ")).not.toContain(workDir);
  });
});

describe("execArgs", () => {
  it("wraps the command so its process tree can be stopped", () => {
    const options = execOptionsSchema.parse({ timeoutMs: 5000, env: { A: "1" }, cwd: "/work/demo" });
    expect(execArgs("run-1", "exec-1", ["python", "plot.py"], options)).toEqual([
      "exec", "--workdir", "/work/demo", "-e", "A=1", "harness-run-run-1", "sandbox-exec", "exec-1", "35", "python", "plot.py",
    ]);
  });

  it("opens stdin only when there is input", () => {
    expect(execArgs("run-1", "e", ["cat"], execOptionsSchema.parse({ input: "hi" }))).toContain("--interactive");
    expect(execArgs("run-1", "e", ["cat"], execOptionsSchema.parse({}))).not.toContain("--interactive");
  });
});
