import { z } from "zod";
import { compact, defineTool } from "@attentionos/core";
import { fmtUsd, periodStart, spendSince } from "../lib/ops.ts";
import { ownSyncStats } from "../repo/ownPosts.ts";
import { trendCounts } from "../repo/trends.ts";

export const researchStatusTool = defineTool({
  name: "research_status",
  description: "One-glance research status: own posts synced, teardowns saved, trend desk counts, and scraping spend against the monthly budget.",
  input: z.object({}),
  annotations: { readOnly: true },
  async handler({ ws }) {
    const tz = ws.config.workspace.timezone;
    const [own, teardowns, trends, scraping] = await Promise.all([
      ownSyncStats(ws),
      ws.sql`select count(*)::int as n from teardowns where workspace_id = ${ws.id}`,
      trendCounts(ws),
      spendSince(ws, "scraping", periodStart(ws.now(), tz, "month")),
    ]);
    const limit = ws.config.budgets.scrapingMonthlyUsd;
    return compact({
      ownPosts: own.posts,
      lastMetricsAt: own.lastCapturedAt,
      teardowns: Number(teardowns[0]?.n ?? 0),
      trends,
      scraping: { spent: fmtUsd(scraping), budget: fmtUsd(limit), left: fmtUsd(Math.max(0, limit - scraping)) },
      providers: {
        analytics: ws.providers.ownAnalytics?.id ?? "not connected",
        scraper: ws.providers.scraper?.id ?? "not connected",
        trendSources: Object.keys(ws.providers.trendSources),
      },
    });
  },
});
