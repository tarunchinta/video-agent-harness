#!/usr/bin/env node
/**
 * Openverse sound-effect search and download, with a provenance manifest. No dependencies: run it with Node 22.18+
 * (`node openverse.ts ...`, types are stripped).
 *
 *   node openverse.ts search "glass ting" [--license cc0,pdm,by] [--length shortest] [--max-seconds 3]
 *                     [--source freesound] [--page 1] [--page-size 20] --out out/sfx/openverse-search.json
 *   node openverse.ts download <id> [<id> ...] --dir audio/assets/openverse [--search out/sfx/openverse-search.json]
 *
 * Only licences that allow commercial use and changes without share-alike are accepted: CC0, the public domain mark
 * and CC BY (which needs a credit line). Anything else is refused, whatever Openverse returns.
 *
 * Titles, tags, creator names and attribution text are written by strangers. They are kept in the JSON files (the
 * manifest needs them for credits) under `untrusted`, and never printed: choose by listening (earshot rank / match /
 * realness on the downloaded files), not by reading them.
 *
 * Anonymous requests work (20 results a page). For higher limits register an API key at
 * https://api.openverse.org/v1/auth_tokens/register/ and set OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

export const API = "https://api.openverse.org/v1";
export const USER_AGENT = "AttentionOS sound-effects skill (https://github.com/tarunchinta/video-agent-harness)";

/** Licences we accept: commercial use and changes allowed, no share-alike. */
export const ALLOWED_LICENSES = ["cc0", "pdm", "by"] as const;
export type AllowedLicense = (typeof ALLOWED_LICENSES)[number];
export const LENGTHS = ["shortest", "short", "medium", "long"] as const;

export type SearchOptions = {
  query: string;
  licenses?: string[];
  length?: string;
  source?: string;
  page?: number;
  pageSize?: number;
};

/** One Openverse audio result as the API returns it (only the fields we use). */
export type OpenverseAudio = {
  id: string;
  title?: string | null;
  creator?: string | null;
  creator_url?: string | null;
  license: string;
  license_version?: string | null;
  license_url?: string | null;
  foreign_landing_url?: string | null;
  url: string;
  filetype?: string | null;
  duration?: number | null;
  source?: string | null;
  provider?: string | null;
  category?: string | null;
  tags?: { name: string }[] | null;
  attribution?: string | null;
};

/** What the search file and the manifest keep about a result. Trusted facts at the top, strangers' text below. */
export type Candidate = {
  id: string;
  license: AllowedLicense;
  licenseVersion: string | null;
  licenseUrl: string | null;
  landingUrl: string | null;
  fileUrl: string;
  filetype: string | null;
  durationSeconds: number | null;
  source: string | null;
  provider: string | null;
  creditRequired: boolean;
  untrusted: { title: string; creator: string; creatorUrl: string; tags: string[]; attribution: string };
};

export function checkLicenses(raw: string[] | undefined): AllowedLicense[] {
  const list = (raw?.length ? raw : [...ALLOWED_LICENSES]).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const refused = list.filter((l) => !(ALLOWED_LICENSES as readonly string[]).includes(l));
  if (refused.length) {
    throw new Error(`licence ${refused.join(", ")} is not allowed: use ${ALLOWED_LICENSES.join(", ")} (commercial use, changes, no share-alike)`);
  }
  return [...new Set(list)] as AllowedLicense[];
}

export function searchUrl(o: SearchOptions): string {
  if (!o.query.trim()) throw new Error("search needs a query, like \"glass ting\"");
  if (o.length && !(LENGTHS as readonly string[]).includes(o.length)) throw new Error(`--length must be one of ${LENGTHS.join(", ")}`);
  const p = new URLSearchParams({
    q: o.query.trim(),
    category: "sound_effect",
    license: checkLicenses(o.licenses).join(","),
    page: String(o.page ?? 1),
    page_size: String(o.pageSize ?? 20),
  });
  if (o.length) p.set("length", o.length);
  if (o.source) p.set("source", o.source);
  return `${API}/audio/?${p.toString()}`;
}

/** Strangers' text: one line, no control characters, capped. Never interpreted, only stored. */
export function clean(s: unknown, max = 300): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Turns an API result into a candidate, or null when its licence is not one we accept. */
export function toCandidate(r: OpenverseAudio): Candidate | null {
  const license = String(r.license ?? "").toLowerCase();
  if (!(ALLOWED_LICENSES as readonly string[]).includes(license) || !r.url || !r.id) return null;
  return {
    id: r.id,
    license: license as AllowedLicense,
    licenseVersion: r.license_version ?? null,
    licenseUrl: r.license_url ?? null,
    landingUrl: r.foreign_landing_url ?? null,
    fileUrl: r.url,
    filetype: r.filetype ?? null,
    durationSeconds: typeof r.duration === "number" ? Math.round(r.duration) / 1000 : null,
    source: r.source ?? null,
    provider: r.provider ?? null,
    creditRequired: license === "by",
    untrusted: {
      title: clean(r.title),
      creator: clean(r.creator, 120),
      creatorUrl: clean(r.creator_url, 300),
      tags: (r.tags ?? []).map((t) => clean(t?.name, 40)).filter(Boolean).slice(0, 20),
      attribution: clean(r.attribution, 500),
    },
  };
}

/** The file name a download gets: `ov-<first 8 of the id>.<ext>`. */
export function fileName(c: Pick<Candidate, "id" | "filetype" | "fileUrl">): string {
  const fromUrl = extname(new URL(c.fileUrl).pathname).replace(/^\./, "").toLowerCase();
  const ext = (c.filetype || fromUrl || "audio").replace(/[^a-z0-9]/gi, "").toLowerCase() || "audio";
  return `ov-${c.id.replace(/[^a-z0-9]/gi, "").slice(0, 8)}.${ext}`;
}

/** The plain table printed after a search: facts only, no strangers' text. */
export function table(cs: Candidate[]): string {
  if (!cs.length) return "No results with an allowed licence. Try other words, --length short, or no --source.";
  const rows = cs.map((c, i) =>
    [String(i + 1).padStart(2), c.id, c.license + (c.licenseVersion ? ` ${c.licenseVersion}` : ""), c.durationSeconds === null ? "?" : `${c.durationSeconds.toFixed(2)} s`, c.filetype ?? "?", c.source ?? "?"].join("  "),
  );
  return ["  #  id                                    licence    length   type  source", ...rows].join("\n");
}

type Fetch = typeof fetch;

export async function token(env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): Promise<string | null> {
  const id = env.OPENVERSE_CLIENT_ID;
  const secret = env.OPENVERSE_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await f(`${API}/auth_tokens/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
  });
  if (!res.ok) throw new Error(`Openverse refused the API key (${res.status}). Check OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET.`);
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

async function getJson(url: string, bearer: string | null, f: Fetch): Promise<unknown> {
  const res = await f(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
  if (res.status === 429) throw new Error("Openverse rate limit reached. Wait a minute, or set an API key (OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET).");
  if (!res.ok) throw new Error(`Openverse answered ${res.status} for ${url}`);
  return res.json();
}

export async function search(o: SearchOptions & { maxSeconds?: number }, f: Fetch = fetch, env = process.env): Promise<{ url: string; resultCount: number; candidates: Candidate[] }> {
  const url = searchUrl(o);
  const body = (await getJson(url, await token(env, f), f)) as { result_count?: number; results?: OpenverseAudio[] };
  const candidates = (body.results ?? [])
    .map(toCandidate)
    .filter((c): c is Candidate => c !== null)
    .filter((c) => o.maxSeconds === undefined || (c.durationSeconds !== null && c.durationSeconds <= o.maxSeconds));
  return { url, resultCount: body.result_count ?? candidates.length, candidates };
}

export type ManifestEntry = Candidate & { file: string; sha256: string; bytes: number; retrievedAt: string };

/** Downloads each id (looked up in the search file, or fetched by id) one after another, and updates manifest.json. */
export async function download(ids: string[], dir: string, opts: { searchFile?: string; now?: Date } = {}, f: Fetch = fetch, env = process.env): Promise<ManifestEntry[]> {
  if (!ids.length) throw new Error("download needs at least one id from the search table");
  const known = new Map<string, Candidate>();
  if (opts.searchFile && existsSync(opts.searchFile)) {
    for (const c of (JSON.parse(readFileSync(opts.searchFile, "utf8")) as { candidates?: Candidate[] }).candidates ?? []) known.set(c.id, c);
  }
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const bearer = await token(env, f);
  const added: ManifestEntry[] = [];
  for (const id of ids) {
    let c = known.get(id) ?? null;
    if (!c) c = toCandidate((await getJson(`${API}/audio/${encodeURIComponent(id)}/`, bearer, f)) as OpenverseAudio);
    if (!c) throw new Error(`${id}: its licence is not one we accept (${ALLOWED_LICENSES.join(", ")}); not downloaded`);
    const res = await f(c.fileUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${id}: the file answered ${res.status}; pick another result`);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = fileName(c);
    writeFileSync(join(dir, file), buf);
    const entry: ManifestEntry = { ...c, file, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, retrievedAt: (opts.now ?? new Date()).toISOString() };
    const i = manifest.findIndex((m) => m.id === id);
    if (i >= 0) manifest[i] = entry;
    else manifest.push(entry);
    added.push(entry);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return added;
}

/** Credit lines for CC BY files (CC0 and public-domain files need none), for CREDITS.md and the video description. */
export function credits(manifest: ManifestEntry[]): string[] {
  return manifest
    .filter((m) => m.creditRequired)
    .map((m) => `"${m.untrusted.title || m.id}" by ${m.untrusted.creator || "unknown"}, ${m.landingUrl ?? m.fileUrl}, licensed under CC BY ${m.licenseVersion ?? ""}`.replace(/\s+,/g, ",").trim());
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--")));
  if (cmd === "search") {
    const out = flag(rest, "--out");
    const max = flag(rest, "--max-seconds");
    const r = await search({
      query: positional.join(" "),
      licenses: flag(rest, "--license")?.split(","),
      length: flag(rest, "--length"),
      source: flag(rest, "--source"),
      page: flag(rest, "--page") ? Number(flag(rest, "--page")) : undefined,
      pageSize: flag(rest, "--page-size") ? Number(flag(rest, "--page-size")) : undefined,
      maxSeconds: max ? Number(max) : undefined,
    });
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify({ query: positional.join(" "), searchedAt: new Date().toISOString(), ...r }, null, 2)}\n`);
    }
    console.log(`${r.candidates.length} with an allowed licence (of ${r.resultCount} matches)${out ? `; saved to ${out}` : ""}`);
    console.log(table(r.candidates));
    return;
  }
  if (cmd === "download") {
    const dir = flag(rest, "--dir");
    if (!dir) throw new Error("download needs --dir, like --dir audio/assets/openverse");
    const added = await download(positional, dir, { searchFile: flag(rest, "--search") });
    for (const a of added) console.log(`${a.file}  ${a.license}${a.creditRequired ? " (credit required)" : ""}  ${a.bytes} bytes`);
    console.log(`manifest: ${join(dir, "manifest.json")}`);
    return;
  }
  if (cmd === "credits") {
    const dir = flag(rest, "--dir") ?? positional[0];
    if (!dir) throw new Error("credits needs --dir");
    const lines = credits(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    console.log(lines.length ? lines.join("\n") : "No CC BY files: nothing to credit.");
    return;
  }
  console.log("usage: node openverse.ts search QUERY [--license cc0,pdm,by] [--length shortest|short|medium|long] [--max-seconds N] [--source NAME] [--page N] [--page-size N] [--out FILE]\n       node openverse.ts download ID... --dir DIR [--search FILE]\n       node openverse.ts credits --dir DIR");
  if (cmd !== undefined && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(`openverse: error: ${err.message}`);
    process.exitCode = 1;
  });
}
