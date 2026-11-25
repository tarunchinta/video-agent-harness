import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Project } from "../api/contract.ts";
import { listFiles } from "./files.ts";

/**
 * A project is a folder under `projects/`: the creator's scripts, notes, recordings and footage for one reel or
 * one series. Runs are filed under a project in their own log, so this module only reads folders.
 */

const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export const isProjectSlug = (slug: string) => SLUG.test(slug) && !slug.includes("..");

const humanize = (slug: string) => {
  const words = slug.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The title: the first heading of the project's script or notes, else its folder name. */
async function titleOf(dir: string, slug: string, names: string[]): Promise<string> {
  const ordered = [...names.filter((n) => /^script/i.test(n)), ...names.filter((n) => !/^script/i.test(n))].filter((n) => extname(n).toLowerCase() === ".md");
  for (const name of ordered.slice(0, 4)) {
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (heading) return heading.length > 90 ? `${heading.slice(0, 89)}…` : heading;
  }
  return humanize(slug);
}

export async function readProject(projectsDir: string, slug: string): Promise<Project | undefined> {
  if (!isProjectSlug(slug)) return undefined;
  const dir = join(projectsDir, slug);
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const files = await listFiles(dir, "project", 500, 4);
  // ISO times sort as text, so the latest is the largest string.
  const latest = [info.mtime.toISOString(), ...files.map((f) => f.modifiedAt)].sort().at(-1)!;
  return {
    slug,
    title: await titleOf(dir, slug, names),
    files,
    hasNotes: files.some((f) => !f.path.includes("/") && [".md", ".txt"].includes(extname(f.path).toLowerCase()) && f.bytes > 0),
    modifiedAt: latest,
  };
}

export async function listProjects(projectsDir: string): Promise<Project[]> {
  if (!existsSync(projectsDir)) return [];
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projects = await Promise.all(entries.filter((e) => e.isDirectory() && isProjectSlug(e.name)).map((e) => readProject(projectsDir, e.name)));
  return projects.filter((p): p is Project => Boolean(p)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "project"
  );
}

/** Makes a project folder with a notes file to start from. Picks a free name if the slug is taken. */
export async function createProject(projectsDir: string, name: string): Promise<Project> {
  const base = slugFor(name);
  let slug = base;
  for (let n = 2; existsSync(join(projectsDir, slug)); n += 1) slug = `${base}-${n}`;
  const dir = join(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "notes.md"),
    `# ${name.trim()}\n\nWhat this reel is about, who it is for, and how you like it made. Every reel started from this project is given these notes.\n`,
    "utf8",
  );
  const project = await readProject(projectsDir, slug);
  if (!project) throw new Error(`The project folder ${dir} could not be read back.`);
  return project;
}
