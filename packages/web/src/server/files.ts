import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntry, FileKind } from "../api/contract.ts";

/**
 * Files a run made and files in a project: what kind each is, listing a folder, and serving one. Everything
 * is confined to its root, and nothing is ever served as a page: agent-written HTML arrives as plain text, and
 * every response is sandboxed, so a file cannot act on the harness through the browser.
 */

const VIDEO = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
const AUDIO = new Set([".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac", ".opus"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const CODE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".css"]);
const DATA = new Set([".json", ".csv", ".srt", ".vtt", ".tsv", ".yaml", ".yml"]);
const TEXT = new Set([".md", ".txt"]);

export function fileKind(path: string, context: "run" | "project"): FileKind {
  const p = path.replaceAll("\\", "/").toLowerCase();
  const ext = extname(p);
  const name = p.split("/").pop() ?? p;
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (IMAGE.has(ext)) return "image";
  if (ext === ".html" || ext === ".htm") return "page";
  if (context === "run") {
    if (p === "script/narration.txt" || name === "narration.txt") return "narration";
    if (p.startsWith("script/")) return "script";
    if (p.startsWith("notes/")) return "notes";
    if (p.startsWith("research/") && (TEXT.has(ext) || DATA.has(ext))) return "research";
  } else if (TEXT.has(ext)) {
    if (/script|narration/.test(name)) return name.includes("narration") ? "narration" : "script";
    if (/research/.test(name)) return "research";
    return "notes";
  }
  if (CODE.has(ext)) return "code";
  if (DATA.has(ext)) return "data";
  if (TEXT.has(ext)) return "notes";
  return "other";
}

const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", ".DS_Store"]);

/** Lists files under `root`, newest structure first by path. Skips the kit the harness rewrites on every use. */
export async function listFiles(root: string, context: "run" | "project", limit = 1500, maxDepth = 6): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (context === "run" && (rel === "film/kit" || rel === "tool-results")) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const info = await stat(full).catch(() => undefined);
        if (info) out.push({ path: rel, bytes: info.size, kind: fileKind(rel, context), modifiedAt: info.mtime.toISOString() });
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** The real path of `path` under `root`, or nothing if it would leave the root (by `..` or by a link). */
export async function confined(root: string, path: string): Promise<string | undefined> {
  if (path.includes("\0")) return undefined;
  const base = await realpath(root).catch(() => undefined);
  if (!base) return undefined;
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  const real = await realpath(target).catch(() => undefined);
  if (!real || (real !== base && !real.startsWith(base + sep))) return undefined;
  return real;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Media gets its own type; everything else, HTML and SVG included, is plain text. */
export const contentTypeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8";

/** A file to send: its size, when it was written, and its bytes by range. On disk or in blob storage. */
export type ServedFile = {
  /** The file's name, for its type and a download. */
  name: string;
  bytes: number;
  modifiedAt: string;
  /** Bytes `start` to `end` inclusive, or all of them. */
  read(range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array>>;
};

/** A file on this machine, or nothing if there is no file there. */
export async function diskFile(path: string): Promise<ServedFile | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return {
    name: basename(path),
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    read: async (range) => createReadStream(path, range ? { start: range.start, end: range.end } : {}),
  };
}

/** Sends a file, honouring a byte range so video and audio can seek. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, download = false): Promise<void> {
  return sendServed(req, res, await diskFile(path), download);
}

/** Sends a file from wherever it is kept, honouring a byte range. Nothing there is a 404. */
export async function sendServed(req: IncomingMessage, res: ServerResponse, file: ServedFile | undefined, download = false): Promise<void> {
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("There is no file there.");
    return;
  }
  const size = file.bytes;
  const headers: Record<string, string> = {
    "content-type": contentTypeOf(file.name),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    // Nothing a run wrote may run script or reach the API through this origin.
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    "cache-control": "no-cache",
    "last-modified": new Date(file.modifiedAt).toUTCString(),
  };
  if (download) headers["content-disposition"] = `attachment; filename="${encodeURIComponent(file.name)}"`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let span: { start: number; end: number } | undefined;
  if (range && size > 0) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (!range[1] && !range[2]) [start, end] = [0, size - 1];
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || Number.isNaN(start) || Number.isNaN(end)) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    span = { start, end };
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
  } else {
    res.writeHead(200, { ...headers, "content-length": String(size) });
  }
  if (req.method === "HEAD") return void res.end();
  try {
    await pipeline(Readable.from(await file.read(span)), res);
  } catch {
    // The browser went away mid-file (a seek, a closed tab), or the store failed after the headers went out.
    res.destroy();
  }
}
