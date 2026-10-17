import { z } from "zod";
import { defineNativeJob, ProviderError, type WorkspaceContext } from "@attentionos/core";
import { alertOnce, enqueueRun } from "../lib/ops.ts";
import { collapseTrialVariants, syncOwnMetrics } from "../repo/ownPosts.ts";
import { researchSettings } from "../settings.ts";

export const ownSyncInput = z.object({
  /** Re-read the whole history instead of the recent lookback window (first run, or after connecting IG Graph). */
  backfill: z.boolean().default(false),
});

/**
 * The owner's own breakouts (imported posts with a transcript, best by views first) get a teardown, so the
 * Copywriter can redo what worked for them ("do that again, new angle") and write in their words.
 */
export async function queueOwnTeardowns(ws: WorkspaceContext, limit: number, runId: string | null): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await ws.sql`
    select p.id from external_posts p join tracked_creators c on c.id = p.tracked_creator_id and c.workspace_id = p.workspace_id
     where p.workspace_id = ${ws.id} and c.tier = 'own' and p.transcript is not null and p.views is not null
       and not exists (select 1 from teardowns t where t.workspace_id = p.workspace_id and t.external_post_id = p.id)
     order by p.views desc limit ${limit}`;
  let n = 0;
  for (const r of rows) {
    const id = await enqueueRun(ws, { jobId: "research.teardown", agent: "analyst", input: { externalPostId: r.id }, dedupeKey: `teardown:${r.id}`, parentRunId: runId, createdBy: "agent:analyst" });
    if (id) n++;
  }
  return n;
}

export const ownSyncJob = defineNativeJob({
  kind: "native",
  id: "research.own-sync",
  agent: "analyst",
  description: "Pulls your own posts and their latest numbers from your analytics provider, and tears down your best ones.",
  input: ownSyncInput,
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const { ws } = ctx;
    const settings = researchSettings(ws);
    const ownTeardownsQueued = await queueOwnTeardowns(ws, settings.ownTeardowns.perSync, ctx.runId);
    if (ownTeardownsQueued) await ctx.progress(`Queued teardowns of ${ownTeardownsQueued} of your best post${ownTeardownsQueued === 1 ? "" : "s"}`);
    if (!ws.providers.ownAnalytics) {
      await ctx.progress("No analytics provider is connected yet, so there were no numbers to pull");
      return { skipped: "no_provider", ownTeardownsQueued };
    }
    const since = ctx.input.backfill ? undefined : new Date(ws.now().getTime() - settings.ownSync.lookbackDays * 86_400_000).toISOString();
    try {
      const res = await syncOwnMetrics(ws, since ? { since } : {});
      const collapsed = await collapseTrialVariants(ws);
      await ctx.progress(
        `Updated numbers for ${res.snapshots} post${res.snapshots === 1 ? "" : "s"}` +
          (res.postsCreated ? `, including ${res.postsCreated} older post${res.postsCreated === 1 ? "" : "s"} seen for the first time` : "") +
          (collapsed ? `; grouped ${collapsed} trial variant${collapsed === 1 ? "" : "s"} with their main post` : ""),
      );
      return { accounts: res.accounts, snapshots: res.snapshots, postsCreated: res.postsCreated, variantsCollapsed: collapsed, ownTeardownsQueued };
    } catch (err) {
      if (err instanceof ProviderError && err.code === "auth") {
        await alertOnce(ws, `own-sync:auth:${err.provider}`, `Your ${err.provider} connection needs attention: ${err.message}. Run \`attentionos doctor\` for the fix.`);
        return { skipped: "auth", ownTeardownsQueued };
      }
      throw err;
    }
  },
});
