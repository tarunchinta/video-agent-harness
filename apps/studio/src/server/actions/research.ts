"use server";

import { requireSession } from "@/server/auth";
import { revalidatePath } from "next/cache";
import { recordAgentEvent } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, id as idSchema, key, parse } from "@/server/validate";

/** Mutations for /research. Every change is plain-language logged so the agent stream shows it. */

export type ActionResult<T = undefined> = { ok: true; message: string; data?: T } | { ok: false; error: string };

const ACTOR = "user:studio";

// ---------------------------------------------------------------------------------------------------------------
// Trend radar
// ---------------------------------------------------------------------------------------------------------------

const TREND_STATUSES = ["new", "shortlisted", "dismissed"] as const;

export async function setTrendStatus(trendId: string, status: (typeof TREND_STATUSES)[number]): Promise<ActionResult> {
  await requireSession();
  const args = parse(z.object({ trendId: idSchema, status: key }), { trendId, status });
  if (!args) return { ok: false, error: BAD_REQUEST };
  if (!TREND_STATUSES.includes(status)) return { ok: false, error: "Unknown trend status." };
  const ws = workspace();
  const [row] = await ws.sql<{ title: string }[]>`
    update trends set status = ${status} where workspace_id = ${ws.id} and id = ${trendId} returning title`;
  if (!row) return { ok: false, error: "That trend is gone." };
  if (status !== "new") {
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "progress",
      message: `${status === "shortlisted" ? "Shortlisted" : "Dismissed"} a trend: ${row.title}`,
      data: { trendId, status },
    });
  }
  revalidatePath("/research");
  return { ok: true, message: status === "shortlisted" ? "Shortlisted. The Strategist will consider it for the next brief." : status === "dismissed" ? "Dismissed" : "Moved back to new" };
}
