import { posix } from "node:path";
import { z } from "zod";
import { SANDBOX_WORK_DIR } from "../sandbox.ts";
import { defineTool, ToolError } from "./define.ts";

const MAX_SECONDS = 1_800;
const MAX_OUTPUT_BYTES = 200_000;

/** Turns a model-supplied folder into a path under `/work`, and refuses anything that leaves it. */
export function sandboxPath(path: string): string {
  const full = posix.resolve(SANDBOX_WORK_DIR, path.replaceAll("\\", "/"));
  if (full !== SANDBOX_WORK_DIR && !full.startsWith(`${SANDBOX_WORK_DIR}/`)) {
    throw new ToolError(`"${path}" is outside the working directory.`, "Use a path relative to the working directory.");
  }
  return full;
}

const section = (name: string, text: string) => (text.trim() ? `\n\n${name}:\n${text.trimEnd()}` : "");

/**
 * Runs a command in the run's sandbox. The sandbox sees the same working directory as the file tools, so a
 * script written with `write_file` can be run here and what it writes can be read back with `read_file`.
 */
export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a command in the run's sandbox: a Linux container with Node, Python (numpy, pandas, matplotlib, duckdb, httpx), ffmpeg and a headless browser. " +
    "It sees the same working directory as the file tools. Give the command as a list of arguments. There is no shell, so for pipes or redirects use " +
    '["sh", "-c", "..."]. Nothing you install outside the working directory is kept between commands. Returns the exit code and what the command printed.',
  input: z.object({
    command: z.array(z.string()).min(1).describe('The program and its arguments, for example ["python", "analysis/plot.py"].'),
    cwd: z.string().default(".").describe("Folder to run in, relative to the working directory."),
    timeout_seconds: z.number().int().positive().max(MAX_SECONDS).default(120).describe("The command is stopped after this long."),
    stdin: z.string().optional().describe("Text to send to the command's standard input."),
  }),
  sandboxed: true,
  timeoutMs: (MAX_SECONDS + 60) * 1000,
  async execute(input, exec) {
    const cwd = sandboxPath(input.cwd);
    const sandbox = await exec.sandbox();
    const result = await sandbox.exec(input.command, {
      cwd,
      timeoutMs: input.timeout_seconds * 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: exec.signal,
      ...(input.stdin !== undefined ? { input: input.stdin } : {}),
    });
    return result;
  },
  render(input, r) {
    const seconds = (r.durationMs / 1000).toFixed(1);
    const head = r.timedOut
      ? `Stopped after ${input.timeout_seconds} seconds without finishing.`
      : `Exit code ${r.exitCode} in ${seconds} s.`;
    const cut = r.truncated ? "\n\n(Some output was left out because it was too long. Write long output to a file and read that.)" : "";
    return `${head}${section("stdout", r.stdout)}${section("stderr", r.stderr)}${cut}`;
  },
});
