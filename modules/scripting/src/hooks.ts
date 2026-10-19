import type { WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import { scriptingSettings } from "./settings.ts";
import { HOOK_PATTERNS, preClassifyHook, UNCLASSIFIED } from "./taxonomy.ts";

/**
 * Hook banks:
 * - own: the user's openers that beat their own median by ≥ ownBankMultiplier (default 3×), from posts,
 *   post_metrics and the script that produced each post;
 * - manual: hooks a person saved by hand.
 */

export type HarvestResult = { own: { added: number; updated: number; median: number | null } };

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export async function harvestOwnHooks(ws: WorkspaceContext): Promise<HarvestResult["own"]> {
  const settings = scriptingSettings(ws);
  const rows = await ws.sql<{ post_id: string; content_id: string | null; url: string | null; views: string | null; x_score: string | null; hook_text: string | null; pattern: string | null }[]>`
    with latest as (
      select distinct on (pm.post_id) pm.post_id, pm.views, pm.x_score
        from post_metrics pm where pm.workspace_id = ${ws.id}
       order by pm.post_id, pm.captured_at desc
    )
    select p.id as post_id, p.content_id, p.url, l.views, l.x_score,
           s.hook_text, coalesce(s.hook_source ->> 'pattern', c.hook_pattern) as pattern
      from posts p
      join latest l on l.post_id = p.id
      left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
      left join lateral (
        select hook_text, hook_source from scripts sc
         where sc.workspace_id = p.workspace_id and sc.content_id = p.content_id
         order by (sc.status = 'approved') desc, sc.version desc limit 1
      ) s on true
     where p.workspace_id = ${ws.id} and p.status = 'published' and p.is_trial = false`;
  const med = median(rows.map((r) => Number(r.views ?? NaN)));
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const x = r.x_score !== null ? Number(r.x_score) : med ? Number(r.views ?? 0) / med : NaN;
    if (!Number.isFinite(x) || x < settings.ownBankMultiplier || !r.hook_text?.trim()) continue;
    const pattern = r.pattern && HOOK_PATTERNS.some((p) => p.id === r.pattern) ? r.pattern : preClassifyHook(r.hook_text)?.pattern ?? UNCLASSIFIED;
    const res = await ws.sql<{ inserted: boolean }[]>`
      insert into hooks (workspace_id, text, pattern, origin, source_ref, score, wins)
      values (${ws.id}, ${r.hook_text.trim()}, ${pattern}, 'own', ${jsonb(ws.sql, { post_id: r.post_id, content_id: r.content_id, url: r.url })}, ${x}, 1)
      on conflict (workspace_id, (source_ref ->> 'post_id')) where origin = 'own'
      do update set score = excluded.score
      returning (xmax = 0) as inserted`;
    if (res[0]?.inserted) added++;
    else updated++;
  }
  return { added, updated, median: med };
}
