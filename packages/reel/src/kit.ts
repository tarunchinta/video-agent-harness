import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError, type SandboxExecResult } from "@harness/harness";
import { wordsScript } from "./words.ts";

/** The film's folder in the working directory, and where it sits inside the sandbox. */
export const FILM_DIR = "film";
export const SANDBOX_FILM_DIR = "/work/film";

const KIT_SOURCE = fileURLToPath(new URL("../kit/", import.meta.url));
/** Files the tools run or the page loads. Written fresh before every use, so the agent cannot break them. */
const FIXED = ["film.js", "render.mjs", "align.py", "README.md"];

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Puts the film kit in the working directory. The runtime files under `film/kit` are always replaced with the
 * originals; the page itself, `film/index.html`, is created from the template only when there is none.
 */
export async function installKit(workDir: string): Promise<{ createdPage: boolean }> {
  const film = join(workDir, FILM_DIR);
  await mkdir(join(film, "kit"), { recursive: true });
  for (const name of FIXED) await copyFile(join(KIT_SOURCE, name), join(film, "kit", name));
  if (!(await exists(join(film, "words.js")))) await writeFile(join(film, "words.js"), wordsScript([]), "utf8");
  const page = join(film, "index.html");
  if (await exists(page)) return { createdPage: false };
  await writeFile(page, await readFile(join(KIT_SOURCE, "index.html"), "utf8"), "utf8");
  return { createdPage: true };
}

/**
 * Reads the one JSON object a kit script prints on its last line. A script that printed something else did
 * not finish, and what it wrote to stderr is the best account of why.
 */
export function kitResult(result: SandboxExecResult, what: string): Record<string, unknown> {
  if (result.timedOut) throw new ToolError(`${what} ran out of time and was stopped.`);
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-12).join("\n").slice(-1500);
    throw new ToolError(`${what} stopped without a result (exit code ${result.exitCode}).${tail ? `\n${tail}` : ""}`);
  }
  const value = parsed as Record<string, unknown>;
  if (value.ok !== true) throw new ToolError(`${what} failed: ${typeof value.error === "string" ? value.error : "no reason was given"}`);
  return value;
}
