import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlEventStore } from "@harness/harness";
import { main } from "../src/main.ts";
import { serveWeb } from "../src/web.ts";

describe("harness web", () => {
  it("serves the runs folder until it is told to stop", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "harness-web-cli-"));
    const runsDir = join(cwd, "runs");
    const controller = new AbortController();
    const lines: string[] = [];
    let listed: unknown;
    const code = await serveWeb({
      store: new JsonlEventStore(runsDir),
      io: { env: {}, cwd, signal: controller.signal },
      runsDir,
      port: 0,
      line: (text) => lines.push(text),
      started: async (server) => {
        const response = await fetch(`${server.url}/api/host.describe`, { method: "POST", headers: { "content-type": "application/json", "x-harness-client": "1" }, body: "{}" });
        listed = await response.json();
        controller.abort();
      },
    });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^The harness is open at http:\/\/localhost:\d+$/);
    expect(lines.at(-1)).toBe("Stopped the web server.");
    expect(listed).toMatchObject({ ok: true, value: { runsDir, projectsDir: join(cwd, "projects"), defaultModel: "claude-opus-5-5" } });
  });

  it("will not listen beyond this machine until it is told who signs people in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "harness-web-cli-"));
    let err = "";
    const code = await main(["web", "--remote", "--bind", "0.0.0.0", "--port", "0"], { out: () => {}, err: (text) => (err += text), env: {}, cwd });
    expect(code).toBe(1);
    expect(err).toMatch(/Set HARNESS_WEB_AUTH=entra/);
  });
});
