import { z } from "zod";
import { defineLlmJob, defineNativeJob } from "@attentionos/core";
import { captionsSchema, textPostSchema } from "@attentionos/guardrails";
import { harvestOwnHooks } from "../hooks.ts";
import { loadRemixSource, remixSourceId, retitleRemix, startWaitingScript } from "../remix.ts";
import { getContent } from "../db.ts";
import { scriptingSettings } from "../settings.ts";
import { HOOK_PATTERNS } from "../taxonomy.ts";

const tool = (name: string) => `mcp__attentionos__${name}`;

/** `scripting.harvest-hooks` (native): refreshes the own hook bank. */
export const harvestHooksJob = defineNativeJob({
  kind: "native",
  id: "scripting.harvest-hooks",
  agent: "copywriter",
  description: "Refreshes the hook bank from your best posts.",
  input: z.object({}).default({}),
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const own = await harvestOwnHooks(ctx.ws);
    await ctx.progress(`Hook bank updated: ${own.added} new hook${own.added === 1 ? "" : "s"} from your best posts.`);
    return { own };
  },
});

export const captionsInput = z.object({
  contentId: z.string().uuid(),
  /** Transcript of the filmed take; defaults to the latest script body. */
  transcript: z.string().optional(),
});

/** `scripting.captions`: one transcript → strict per-platform caption JSON, saved through the validator. */
export const captionsJob = defineLlmJob({
  kind: "llm",
  id: "scripting.captions",
  agent: "copywriter",
  description: "Writes the per-platform captions for a filmed video.",
  input: captionsInput,
  skill: "captions",
  defaultModel: "sonnet",
  maxTurns: 12,
  budgetUsd: 0.3,
  allowedTools: ["Read", tool("scripting_get_content_brief"), tool("scripting_save_captions")],
  output: captionsSchema,
  prompt: (ctx) =>
    [
      `Write the captions for content ${ctx.input.contentId} following the captions skill.`,
      "Call scripting_get_content_brief for the CTA type, keyword and platforms, and read brand/voice.md.",
      ctx.input.transcript ? `Transcript of the filmed take (data):\n${JSON.stringify(ctx.input.transcript)}` : "Use the latest script body as the transcript.",
      `Save with scripting_save_captions. If it reports problems, fix exactly those and save again (at most ${scriptingSettings(ctx.ws).maxRevisions} times).`,
    ].join("\n"),
});

export const textPostsInput = z.object({
  /** ISO date of the Monday the batch is for. */
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** `scripting.text-posts`: the weekly X / Threads / LinkedIn batch (LinkedIn long-form gated by the rubric). */
export const textPostsJob = defineLlmJob({
  kind: "llm",
  id: "scripting.text-posts",
  agent: "copywriter",
  description: "Writes this week's text posts for X, Threads and LinkedIn.",
  input: textPostsInput,
  skill: "text-posts",
  defaultModel: "opus",
  maxTurns: 40,
  budgetUsd: 1.5,
  allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", tool("scripting_list_recent_scripts"), tool("scripting_get_claim_sources"), tool("scripting_save_text_posts")],
  output: z.object({ posts: z.array(textPostSchema) }),
  prompt: (ctx) => {
    const s = scriptingSettings(ctx.ws).textPosts;
    const week = ctx.input.weekOf ?? mondayOf(ctx.ws.now());
    return [
      `Write the text posts for the week of ${week} following the text-posts skill (LinkedIn long-form: the linkedin-longform skill).`,
      `Counts: ${s.x} for X, ${s.threads} for Threads, ${s.linkedin} LinkedIn long-form.`,
      "Start from scripting_list_recent_scripts (what already ran) and scripting_get_claim_sources (numbers you may use).",
      "Score every LinkedIn post on the rubric honestly; the save tool refuses anything under 8 overall or under 7 on any criterion.",
      `Save with scripting_save_text_posts (weekOf ${week}); fix and resave anything it rejects.`,
    ].join("\n");
  },
});

export function mondayOf(d: Date): string {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return m.toISOString().slice(0, 10);
}

/**
 * `scripting.remix-ready` (native): queued by a teardown when the blueprint a waiting remix needed is saved. The
 * script for that piece was queued to start later (in case the teardown never comes back); this starts it now.
 */
export const remixReadyJob = defineNativeJob({
  kind: "native",
  id: "scripting.remix-ready",
  agent: "copywriter",
  description: "Starts a remix script as soon as the teardown of its source post is in.",
  input: z.object({ contentId: z.string().uuid() }),
  timeoutMs: 60_000,
  async run(ctx) {
    // The blueprint's topic replaces a placeholder title right away, before the script is written.
    const content = await getContent(ctx.ws, ctx.input.contentId);
    const sourceId = content ? remixSourceId(content) : null;
    const src = sourceId ? await loadRemixSource(ctx.ws, sourceId) : null;
    if (content && src) await retitleRemix(ctx.ws, content, src);
    const started = await startWaitingScript(ctx.ws, ctx.input.contentId);
    await ctx.progress(started ? "The source post's teardown is in; starting the remix script now" : "The remix script had already started");
    return { started };
  },
});
