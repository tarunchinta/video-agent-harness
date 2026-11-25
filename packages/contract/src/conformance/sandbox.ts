import { describe, expect, it } from "vitest";
import type { SandboxSession } from "@harness/harness";

/**
 * The checks every sandbox must pass: commands run as argument lists with no shell, exit codes and output come
 * back, a timeout stops the command and says so, a cancel stops it, and `stop` can be called twice. A real
 * sandbox needs its runtime (Docker), so a provider passes `enabled: false` when that is not available and the
 * kit is skipped.
 */
export function testSandbox(name: string, start: () => Promise<SandboxSession>, options: { enabled?: boolean; timeoutMs?: number } = {}): void {
  describe.skipIf(options.enabled === false)(`${name} meets the sandbox contract`, () => {
    const t = options.timeoutMs ?? 120_000;

    it("runs a command with no shell and returns its exit code and output", { timeout: t }, async () => {
      const box = await start();
      try {
        const ok = await box.exec(["sh", "-c", "printf out; printf err >&2; exit 3"]);
        expect([ok.exitCode, ok.stdout, ok.stderr, ok.timedOut]).toEqual([3, "out", "err", false]);
        // No shell between the harness and the program: a `;` is just a character in an argument.
        const literal = await box.exec(["echo", "a; echo b"]);
        expect(literal.stdout.trim()).toBe("a; echo b");
      } finally {
        await box.stop();
      }
    });

    it("stops a command that runs past its time and says it timed out", { timeout: t }, async () => {
      const box = await start();
      try {
        const slow = await box.exec(["sleep", "30"], { timeoutMs: 1_000 });
        expect(slow.timedOut).toBe(true);
      } finally {
        await box.stop();
      }
    });

    it("stops a command when cancelled, and can be stopped twice", { timeout: t }, async () => {
      const box = await start();
      const cancel = new AbortController();
      const running = box.exec(["sleep", "30"], { signal: cancel.signal, timeoutMs: 60_000 });
      setTimeout(() => cancel.abort(), 500);
      await expect(running).rejects.toThrow();
      await box.stop();
      await box.stop();
    });
  });
}
