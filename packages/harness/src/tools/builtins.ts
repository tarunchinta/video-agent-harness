import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool, ToolError, type ToolDefinition } from "./define.ts";

/** Resolves a model-supplied path inside the working directory, and refuses anything that leaves it. */
export function resolveInside(workDir: string, path: string): string {
  const root = resolve(workDir);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ToolError(`"${path}" is outside the working directory.`, "Use a path relative to the working directory.");
  }
  return full;
}

const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 80_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from the working directory. Returns up to `limit` lines starting at line `offset` (0-based). Use offset and limit to page through a long file.",
  input: z.object({
    path: z.string().min(1).describe("Path relative to the working directory."),
    offset: z.number().int().nonnegative().default(0).describe("First line to return, 0-based."),
    limit: z.number().int().positive().max(MAX_READ_LINES).default(500).describe("Most lines to return."),
  }),
  readOnly: true,
  idempotent: true,
  parallelSafe: true,
  exemptFromOffload: true,
  async execute(input, exec) {
    let text: string;
    try {
      text = await readFile(resolveInside(exec.workDir, input.path), "utf8");
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Could not read "${input.path}".`, "Check the path with list_files.");
    }
    const lines = text.split("\n");
    let body = lines.slice(input.offset, input.offset + input.limit).join("\n");
    let cut = false;
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      cut = true;
    }
    const last = Math.min(lines.length, input.offset + input.limit);
    const note = cut
      ? `\n\n(Stopped after ${MAX_READ_CHARS.toLocaleString("en-US")} characters. Ask for fewer lines to see the rest.)`
      : last < lines.length
        ? `\n\n(Lines ${input.offset} to ${last - 1} of ${lines.length}. Read on with offset ${last}.)`
        : "";
    return body + note;
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or replace a text file in the working directory. Parent folders are created as needed.",
  input: z.object({
    path: z.string().min(1).describe("Path relative to the working directory."),
    content: z.string().describe("The full text of the file."),
  }),
  idempotent: true,
  async execute(input, exec) {
    const full = resolveInside(exec.workDir, input.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, input.content, "utf8");
    return `Wrote ${Buffer.byteLength(input.content, "utf8").toLocaleString("en-US")} bytes to ${input.path}.`;
  },
});

export const listFilesTool = defineTool({
  name: "list_files",
  description: "List the files and folders in a folder of the working directory.",
  input: z.object({ path: z.string().default(".").describe("Folder relative to the working directory.") }),
  readOnly: true,
  idempotent: true,
  parallelSafe: true,
  async execute(input, exec) {
    const full = resolveInside(exec.workDir, input.path);
    let names: string[];
    try {
      names = (await readdir(full)).sort();
    } catch {
      throw new ToolError(`There is no folder at "${input.path}".`);
    }
    if (!names.length) return "(empty)";
    const rows = await Promise.all(
      names.slice(0, 500).map(async (name) => {
        const info = await stat(resolve(full, name));
        const path = relative(resolve(exec.workDir), resolve(full, name)).split(sep).join("/");
        return info.isDirectory() ? `${path}/` : `${path}  (${info.size.toLocaleString("en-US")} bytes)`;
      }),
    );
    return rows.join("\n") + (names.length > 500 ? `\n(${names.length - 500} more not shown.)` : "");
  },
});

export const viewImageTool = defineTool({
  name: "view_image",
  description:
    "Look at a picture in the working directory: a chart you made, a frame of a render, a screenshot. PNG, JPEG, WebP or GIF, up to 3.5 MB. " +
    "The picture is shown to you with the result.",
  input: z.object({ path: z.string().min(1).describe("Path relative to the working directory.") }),
  readOnly: true,
  idempotent: true,
  async execute(input, exec) {
    const info = await stat(resolveInside(exec.workDir, input.path)).catch(() => undefined);
    if (!info?.isFile()) throw new ToolError(`There is no file at "${input.path}".`, "Check the path with list_files.");
    return `${input.path} (${info.size.toLocaleString("en-US")} bytes)`;
  },
  images: (input) => [input.path],
});

export const defaultFinishSchema = z.object({ summary: z.string().min(1).describe("What was done, in a few plain sentences.") });

/**
 * The tool that ends a run. The loop's objective is "finish was called with a valid result": a model that stops
 * without calling it is sent back to work, up to the round limit.
 */
export function finishTool<S extends z.ZodObject>(schema: S): ToolDefinition<S, z.output<S>> {
  return defineTool({
    name: "finish",
    description: "Call this once, when the task is complete, with the result. This ends the run. Do not call it to ask a question or to report partial work.",
    input: schema,
    concludesTurn: true,
    idempotent: true,
    execute: async (input) => input,
    render: () => "Recorded. The run is complete.",
  });
}

export const fileTools: ToolDefinition[] = [readFileTool, writeFileTool, listFilesTool] as ToolDefinition[];
