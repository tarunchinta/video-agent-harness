import { contentWords } from "@attentionos/scoring";
import type { IdeaKind, Lane } from "./pillars.ts";

/**
 * Remix-first planning: most of the slate remakes the owner's own breakouts ("do that again, new angle"), and only
 * what the brand's lanes require is original (the offer, fresh news). Pure functions, so the ranking and the slot
 * split are easy to test.
 */

export type RemixPoolItem = {
  id: string;
  url: string;
  /** The owner's own handle on that platform. */
  creator: string;
  platform: string;
  /** Times the owner's normal: views over the median of their imported posts. */
  x: number;
  views: number | null;
  publishedAt: string | null;
  /** Checked teardown with a remix blueprint exists. */
  hasBlueprint: boolean;
  hasTranscript: boolean;
  /** From the checked blueprint: what the post is about (safe to show). */
  topic: string | null;
  hookPattern: string | null;
  format: string | null;
  /** Caption, spoken hook and blueprint text, for niche matching in code only. Never shown to a model. */
  matchText: string;
  /** Already remade into a piece that wasn't archived. */
  used: boolean;
  /**
   * Keys that identify the same video posted more than once (owners repost a hit): the handle with its spoken
   * hook, and the handle with its exact length. Only the best-ranked copy is kept.
   */
  sameVideo?: string[];
};

export type RankedRemix = RemixPoolItem & { score: number; relevance: number; reasons: string[] };

export type RemixRankOptions = {
  now: Date;
  /** Words of the owner's niche: lanes, pillars, offers, audience. */
  nicheWords: readonly string[];
  ownMaxAgeDays: number;
  ownMinX: number;
  /** Views a post needs to qualify, whatever the owner's normal. Default 0 (no bar). */
  ownMinViews?: number;
};

const D = 86_400_000;

/**
 * 0 to 1, absolute views first: views on a log scale from 1K (0) to 1M (1), times-normal on a log scale up to 16x.
 * A reel that pulled 800K beats one that did 5x a tiny normal, which is what "copy what works" means.
 */
export function provenScore(views: number | null, x: number | null): number {
  const v = views && views > 0 ? Math.min(1, Math.max(0, (Math.log10(views) - 3) / 3)) : 0;
  const t = x && x > 0 ? Math.min(1, Math.log2(1 + x) / Math.log2(17)) : 0;
  return 0.65 * v + 0.35 * t;
}

/**
 * Words every post and every Brand Kit uses (calls to action, platform words): they say nothing about the niche, so a
 * caption's "link in comments" never counts as a match.
 */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "link", "links", "comment", "comments", "follow", "follows", "bio", "post", "posts", "video", "videos", "reel", "reels", "content", "like", "likes",
  "share", "save", "dm", "click", "watch", "help", "people", "thing", "things", "make", "made", "want", "need", "know", "get", "got", "way", "time",
  "day", "today", "more", "most", "best", "new", "one", "first", "try", "free", "crazy", "world", "live", "part",
]);

/** Niche relevance in [0.6, 1.4]: how many of the owner's niche words the post uses (3 or more is a full match). */
export function nicheRelevance(text: string, niche: ReadonlySet<string>): number {
  if (niche.size === 0) return 1;
  const hits = new Set(contentWords(text).filter((w) => niche.has(w) && !GENERIC_WORDS.has(w))).size;
  return 0.6 + 0.8 * Math.min(1, hits / 3);
}

export function nicheWordsFrom(lanes: readonly Lane[], texts: readonly (string | null | undefined)[]): string[] {
  return [...new Set([...lanes.flatMap((l) => contentWords(`${l.name} ${l.description}`)), ...texts.flatMap((t) => contentWords(t ?? ""))])];
}

/**
 * Ranks the owner's breakouts to remake: absolute views first, then times-normal, the owner's niche first, posts
 * with a ready blueprint a little ahead. Drops what was already remade, what's too old, what didn't clearly beat the
 * owner's normal, and posts below `ownMinViews`. Own breakouts are evergreen for the owner's audience, so age only
 * cuts off at `ownMaxAgeDays`.
 */
export function rankRemixSources(pool: readonly RemixPoolItem[], opts: RemixRankOptions): RankedRemix[] {
  const niche = new Set(opts.nicheWords);
  const now = opts.now.getTime();
  const out: RankedRemix[] = [];
  for (const p of pool) {
    if (p.used) continue;
    if ((p.views ?? 0) < (opts.ownMinViews ?? 0)) continue;
    if (!(p.x >= opts.ownMinX)) continue;
    const ageDays = p.publishedAt ? Math.max(0, (now - new Date(p.publishedAt).getTime()) / D) : null;
    if (ageDays !== null && ageDays > opts.ownMaxAgeDays) continue;
    const relevance = nicheRelevance(p.matchText, niche);
    // A ready blueprint saves a minute of teardown, no more: it nudges, it doesn't outrank a bigger post.
    const ready = p.hasBlueprint ? 1.1 : p.hasTranscript ? 1 : 0.85;
    const score = Math.round((0.1 + provenScore(p.views, p.x)) * relevance * ready * 1000) / 1000;
    const reasons = [
      `${Math.round(p.x * 10) / 10}x your normal`,
      ...(p.views ? [`${p.views.toLocaleString("en-US")} views`] : []),
      ...(relevance >= 1.2 ? ["in your niche"] : relevance <= 0.7 ? ["loosely related to your niche"] : []),
      ...(p.hasBlueprint ? ["blueprint ready"] : []),
    ];
    out.push({ ...p, score, relevance, reasons });
  }
  out.sort((a, b) => b.score - a.score || b.x - a.x || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return out.filter((r) => {
    const keys = r.sameVideo ?? [];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/** `sameVideo` keys for a post: its creator with its spoken hook, and with its exact length. */
export function sameVideoKeys(creator: string, spokenHook: string | null | undefined, durationS: number | null | undefined): string[] {
  const who = creator.replace(/^@+/, "").toLowerCase();
  const hook = (spokenHook ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
  return [...(hook.split(" ").length >= 4 ? [`${who}|hook|${hook}`] : []), ...(durationS && durationS > 0 ? [`${who}|len|${durationS.toFixed(2)}`] : [])];
}

/**
 * Splits the slate so about `share` of it is remixes. Offer slots never shrink (the brand's ask); talking heads give
 * way first, then news (fresh news still gets at least one slot when it had some).
 */
export function remixSlots(slots: Record<IdeaKind, number>, share: number): Record<IdeaKind, number> {
  const total = slots.news + slots.remix + slots.talking_head + slots.offer;
  if (total === 0) return { ...slots };
  const target = Math.min(total - slots.offer, Math.max(slots.remix, Math.round(total * Math.min(1, Math.max(0, share)))));
  const out = { ...slots };
  let need = target - out.remix;
  const take = (k: "talking_head" | "news", floor: number) => {
    const n = Math.max(0, Math.min(need, out[k] - floor));
    out[k] -= n;
    out.remix += n;
    need -= n;
  };
  take("talking_head", 0);
  take("news", slots.news > 0 ? 1 : 0);
  take("news", 0);
  return out;
}
