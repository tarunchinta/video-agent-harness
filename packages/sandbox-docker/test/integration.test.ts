import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxError } from "../src/errors.ts";
import { DockerSandbox, listSandboxes } from "../src/sandbox.ts";

// Real containers. Off by default: it needs Docker and the built image, and CI has neither.
//
//   HARNESS_SANDBOX_IT=1       run against Docker (image: harness-sandbox:local)
//   HARNESS_SANDBOX_IT_NET=1   also run the tests that reach the public internet
const enabled = process.env.HARNESS_SANDBOX_IT === "1";
const online = enabled && process.env.HARNESS_SANDBOX_IT_NET === "1";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

describe.skipIf(!enabled)("sandbox against Docker, no network", () => {
  const runId = `it-${Date.now().toString(36)}`;
  let dir: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandbox-it-"));
    sandbox = await DockerSandbox.start({ runId, workDir: join(dir, "work"), env: { RUN_LABEL: "integration" } });
  }, 120_000);
  afterAll(async () => {
    await sandbox?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("can do what research, demo capture and rendering need", async () => {
    const check = await sandbox.exec(["sandbox-selfcheck"], { timeoutMs: 180_000 });
    expect(check.stderr + check.stdout).toContain("sandbox self-check passed");
    expect(check.exitCode).toBe(0);
  }, 200_000);

  it("runs a command with its own directory, environment and stdin", async () => {
    await sandbox.exec(["mkdir", "-p", "/work/demo"]);
    const result = await sandbox.exec(["sh", "-c", 'echo "$PWD $RUN_LABEL $EXTRA $(cat)"; echo oops >&2; exit 7'], {
      cwd: "/work/demo", env: { EXTRA: "extra" }, input: "from stdin",
    });
    expect(result).toMatchObject({ exitCode: 7, stdout: "/work/demo integration extra from stdin\n", stderr: "oops\n", timedOut: false });
  });

  it("is locked down: not root, no capabilities, no network", async () => {
    const result = await sandbox.exec(["sh", "-c", 'id -u; grep CapEff /proc/self/status; curl -sS -m 3 -o /dev/null https://example.com || echo "no network"']);
    const [uid, caps, net] = result.stdout.trim().split("\n");
    expect(uid).not.toBe("0");
    expect(caps).toMatch(/CapEff:\s+0000000000000000/);
    expect(net).toBe("no network");
  });

  it("stops the whole process tree on timeout", async () => {
    const result = await sandbox.exec(["sh", "-c", "sleep 300 & sleep 300 & echo started; wait"], { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("started\n");
    expect(result.durationMs).toBeLessThan(10_000);
    // Only the container's own idle `sleep infinity` is left.
    const left = await sandbox.exec(["sh", "-c", "pgrep -x sleep | wc -l"]);
    expect(left.stdout.trim()).toBe("1");
  }, 30_000);

  it("stops the command when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = sandbox.exec(["sleep", "300"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    const left = await sandbox.exec(["sh", "-c", "pgrep -x sleep | wc -l"]);
    expect(left.stdout.trim()).toBe("1");
  }, 30_000);

  it("keeps the start and end of long output", async () => {
    const result = await sandbox.exec(["sh", "-c", "seq 1 200000"], { maxOutputBytes: 2048 });
    expect(result.truncated).toBe(true);
    expect(result.stdoutBytes).toBeGreaterThan(1_000_000);
    expect(result.stdout.startsWith("1\n2\n")).toBe(true);
    expect(result.stdout.endsWith("200000\n")).toBe(true);
  });

  it("copies files in and out with matching hashes", async () => {
    const source = join(dir, "in.bin");
    const data = Buffer.alloc(3 * 1024 * 1024, 7);
    await writeFile(source, data);
    const written = await sandbox.write("inputs/in.bin", source);
    expect(written).toEqual({ bytes: data.length, sha256: sha256(data) });

    // The bind mount shows the same file on the host.
    expect(sha256(await readFile(join(dir, "work", "inputs", "in.bin")))).toBe(written.sha256);

    const destination = join(dir, "out", "copy.bin");
    expect(await sandbox.read("/work/inputs/in.bin", destination)).toEqual(written);
    expect(sha256(await readFile(destination))).toBe(written.sha256);
  });

  it("resolves paths inside the container, so a planted symlink cannot reach a host file", async () => {
    await sandbox.exec(["ln", "-sf", "/etc/hostname", "/work/link"]);
    const destination = join(dir, "link.txt");
    await sandbox.read("link", destination);
    expect((await readFile(destination, "utf8")).trim()).toBe("sandbox");
  });

  it("refuses to copy out a file over the limit and reports a missing one", async () => {
    const big = join(dir, "big.bin");
    await expect(sandbox.read("inputs/in.bin", big, { maxBytes: 1024 })).rejects.toMatchObject({ code: "too_large" });
    expect(existsSync(big)).toBe(false);
    await expect(sandbox.read("nope.txt", join(dir, "nope.txt"))).rejects.toMatchObject({ code: "io" });
  });

  it("keeps /work and nothing else across a restart", async () => {
    await sandbox.exec(["sh", "-c", "echo kept > /work/kept.txt; echo lost > /tmp/lost.txt"]);
    const before = sandbox.info.containerId;
    await sandbox.stop();
    expect((await listSandboxes()).map((entry) => entry.runId)).not.toContain(runId);
    await expect(sandbox.exec(["true"])).rejects.toBeInstanceOf(SandboxError);

    sandbox = await DockerSandbox.start({ runId, workDir: join(dir, "work") });
    expect(sandbox.info.containerId).not.toBe(before);
    const after = await sandbox.exec(["sh", "-c", "cat /work/kept.txt; ls /tmp/lost.txt 2>/dev/null || echo gone"]);
    expect(after.stdout).toBe("kept\ngone\n");
  }, 120_000);

  it("reports a container removed behind its back", async () => {
    const other = await DockerSandbox.start({ runId: `${runId}-gone`, workDir: join(dir, "work-gone") });
    // Starting again with the same run id is what a resumed worker does: the old container is replaced.
    const replacement = await DockerSandbox.start({ runId: `${runId}-gone`, workDir: join(dir, "work-gone") });
    await replacement.stop();
    await expect(other.exec(["true"])).rejects.toMatchObject({ code: "not_running" });
  }, 120_000);
});

describe.skipIf(!online)("sandbox against Docker, public network", () => {
  const runId = `it-net-${Date.now().toString(36)}`;
  let dir: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandbox-it-"));
    sandbox = await DockerSandbox.start({ runId, workDir: join(dir, "work"), network: "public" });
  }, 120_000);
  afterAll(async () => {
    await sandbox?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const status = async (...curl: string[]): Promise<string> =>
    (await sandbox.exec(["curl", "-sS", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", ...curl])).stdout.trim();

  it("reaches public sites through the proxy", async () => {
    expect(await status("https://example.com")).toBe("200");
    expect(await status("http://example.com")).toBe("200");
  }, 60_000);

  it("cannot reach the host, the local network or anything directly", async () => {
    expect(await status("http://169.254.169.254/latest/meta-data/")).toBe("403");
    expect(await status("http://host.docker.internal/")).toBe("403");
    expect(await status("http://192.168.1.1/")).toBe("403");
    expect(await status("--noproxy", "*", "-m", "5", "https://1.1.1.1")).toBe("000");
  }, 60_000);

  it("gives Node, Python and the browser the same way out", async () => {
    const node = await sandbox.exec(["node", "-e", "fetch('https://example.com').then(r => console.log(r.status))"], { timeoutMs: 60_000 });
    expect(node.stdout.trim()).toBe("200");
    const python = await sandbox.exec(["python", "-c", "import httpx; print(httpx.get('https://example.com').status_code)"], { timeoutMs: 60_000 });
    expect(python.stdout.trim()).toBe("200");
    const script = `
      import { chromium } from "playwright";
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const response = await page.goto("https://example.com");
      console.log(response.status(), await page.title());
      await browser.close();`;
    await sandbox.exec(["sh", "-c", "cat > /work/browse.mjs"], { input: script });
    const browser = await sandbox.exec(["node", "/work/browse.mjs"], { timeoutMs: 90_000 });
    expect(browser.stderr).toBe("");
    expect(browser.stdout.trim()).toBe("200 Example Domain");
  }, 240_000);

  it("installs extra Python packages where they survive a restart", async () => {
    const install = await sandbox.exec(["uv", "pip", "install", "--target", "/work/.packages", "tabulate"], { timeoutMs: 120_000 });
    expect(install.exitCode, install.stderr).toBe(0);
    const use = await sandbox.exec(["python", "-c", "import tabulate; print(tabulate.__name__)"]);
    expect(use.stdout.trim()).toBe("tabulate");
  }, 180_000);

  it("keeps a record of every host the run contacted", async () => {
    const entries = (await sandbox.egressLog()).trim().split("\n").map((line) => JSON.parse(line) as { host?: string; decision?: string });
    expect(entries).toContainEqual(expect.objectContaining({ host: "example.com", decision: "allow" }));
    expect(entries).toContainEqual(expect.objectContaining({ host: "169.254.169.254", decision: "deny" }));
  });
});
