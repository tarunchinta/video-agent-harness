import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/** The repo's `db/` folder: the bootstrap script and the migrations, in order. */
export const DB_DIR = fileURLToPath(new URL("../../../db", import.meta.url));

/**
 * Applies `db/bootstrap.sql` and every migration not yet recorded in `harness.schema_migrations`, in name
 * order. Run it as the server administrator: the bootstrap creates roles, and each migration acts as
 * `harness_owner`. Each migration file holds its own transaction and records itself.
 */
export async function migrate(sql: Sql, dir = DB_DIR): Promise<string[]> {
  await sql.unsafe(await readFile(join(dir, "bootstrap.sql"), "utf8"));
  const [table] = await sql<{ exists: boolean }[]>`SELECT to_regclass('harness.schema_migrations') IS NOT NULL AS exists`;
  const done = new Set(
    table?.exists ? (await sql<{ version: string }[]>`SELECT version FROM harness.schema_migrations`).map((r) => r.version) : [],
  );
  const files = (await readdir(join(dir, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    await sql.unsafe(await readFile(join(dir, "migrations", file), "utf8"));
    applied.push(version);
  }
  return applied;
}
