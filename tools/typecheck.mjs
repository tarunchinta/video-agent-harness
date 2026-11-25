#!/usr/bin/env node
// Typechecks every workspace package that has a tsconfig.json, with the repo's own TypeScript, one package at a
// time. It calls tsc directly instead of going through a package manager, so it works the same on any machine
// that can run `node`, whichever pnpm (if any) is on the PATH.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

/** Workspace folders from pnpm-workspace.yaml, read without a YAML library: one `- "glob/*"` per line. */
function workspaceDirs() {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const dirs = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) continue;
    const parent = join(root, glob.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    }
  }
  return dirs;
}

const packages = workspaceDirs().filter((dir) => {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest) || !existsSync(join(dir, "tsconfig.json"))) return false;
  return Boolean(JSON.parse(readFileSync(manifest, "utf8")).scripts?.typecheck);
});

let failed = 0;
for (const dir of packages) {
  const name = relative(root, dir).replaceAll("\\", "/");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" });
  if (result.status === 0) {
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}
console.log(`\n${packages.length - failed} of ${packages.length} packages typecheck.`);
process.exit(failed ? 1 : 0);
