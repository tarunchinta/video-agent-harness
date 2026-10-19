import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestWorkspace, DEMO_BRAND_DIR } from "@attentionos/module-research/testing";
import { isPlaceholderRemixTitle, remixTitle } from "@attentionos/core";
import { nicheRelevance, provenScore, rankRemixSources, remixSlots, sameVideoKeys, type RemixPoolItem, type RemixRankOptions } from "../src/remix.ts";
import { remixPool } from "../src/repo.ts";
import { runBrief } from "../src/jobs/brief.ts";

const NOW = new Date("2026-10-12T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function item(id: string, over: Partial<RemixPoolItem> = {}): RemixPoolItem {
  return {
    id, url: `https://www.instagram.com/reel/${id}/`, creator: "@examplebrand", platform: "instagram", x: 4, views: 50_000, publishedAt: daysAgo(3),
    hasBlueprint: false, hasTranscript: true, topic: null, hookPattern: null, format: null,
    matchText: "kitchen remodel quote cabinets budget", used: false, ...over,
  };
}

const OPTS: RemixRankOptions = { now: NOW, nicheWords: ["kitchen", "remodel", "budget", "cabinet", "quote"], ownMaxAgeDays: 365, ownMinX: 2 };

describe("remix source ranking", () => {
  it("ranks by absolute views and times-normal together", () => {
    const ranked = rankRemixSources([
      item("small-big-x", { views: 8_000, x: 9 }),
      item("viral", { views: 1_200_000, x: 14 }),
      item("big-views-low-x", { views: 900_000, x: 2.1 }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["viral", "big-views-low-x", "small-big-x"]);
    expect(ranked[0]!.reasons).toEqual(expect.arrayContaining(["14x your normal", "1,200,000 views", "in your niche"]));
    expect(provenScore(1_000_000, 16)).toBeCloseTo(1, 5);
    expect(provenScore(null, null)).toBe(0);
    // Views from 1K (nothing) to 1M (full marks).
    expect(provenScore(900, null)).toBe(0);
    expect(provenScore(1_000_000, null)).toBeCloseTo(0.65, 5);
  });

  it("drops posts already remixed, past the age limit, or not clearly above the owner's normal", () => {
    const ranked = rankRemixSources([
      item("used", { used: true, x: 20 }),
      item("ancient", { publishedAt: daysAgo(400), x: 20 }),
      item("meh", { x: 1.5 }),
      item("old-ok", { publishedAt: daysAgo(200), x: 3 }),
      item("ok"),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["ok", "old-ok"]);
    expect(ranked[1]!.reasons[0]).toBe("3x your normal");
  });

  it("needs the absolute view bar whatever the owner's normal", () => {
    expect(rankRemixSources([item("small", { views: 2_100, x: 5.7 })], { ...OPTS, ownMinViews: 10_000 })).toEqual([]);
    expect(rankRemixSources([item("big", { views: 40_000, x: 5.7 })], { ...OPTS, ownMinViews: 10_000 }).map((r) => r.id)).toEqual(["big"]);
  });

  it("prefers the owner's niche and posts with a ready blueprint", () => {
    expect(rankRemixSources([item("offtopic", { matchText: "sports cars and racing" }), item("niche")], OPTS)[0]!.id).toBe("niche");
    expect(rankRemixSources([item("raw", { hasTranscript: false }), item("ready", { hasBlueprint: true })], OPTS)[0]!.id).toBe("ready");
    expect(nicheRelevance("nothing relevant", new Set(["kitchen"]))).toBe(0.6);
    // Calls to action and platform words aren't niche, even when a Brand Kit uses them.
    expect(nicheRelevance("Link in comments, follow for more", new Set(["link", "comment", "follow", "kitchen"]))).toBe(0.6);
    expect(nicheRelevance("anything", new Set())).toBe(1);
  });

  it("keeps only the best-ranked copy of a video the owner posted more than once", () => {
    const hook = "If we did this back in school I would never have finished a single class";
    const ranked = rankRemixSources([
      item("repost-a", { views: 830_000, x: 13, sameVideo: sameVideoKeys("@examplebrand", hook, 24.82) }),
      item("repost-b", { views: 630_000, x: 6, sameVideo: sameVideoKeys("@examplebrand", hook, 24.82) }),
      item("other", { views: 500_000, x: 4, sameVideo: sameVideoKeys("@examplebrand", "A different hook about kitchen quotes entirely", 31) }),
    ], OPTS);
    expect(ranked.map((r) => r.id)).toEqual(["repost-a", "other"]);
  });
});

describe("remix titles", () => {
  it("titles a remix by its blueprint topic, and knows a placeholder when it sees one", () => {
    const base = { own: false, handle: "demo_creator_a", platform: "instagram", views: 833_000 };
    expect(remixTitle(base)).toBe("Remix: @demo_creator_a's 833K-view instagram post");
    expect(remixTitle({ ...base, own: true, views: 2_100 })).toBe("Remix: your 2.1K-view instagram post");
    expect(remixTitle({ ...base, topic: "what a cheap quote leaves out." })).toBe("Remix: What a cheap quote leaves out");
    const long = "A free surprising discovery that lets people do something they normally pay for or download, demoed live on screen";
    expect(remixTitle({ ...base, topic: long })).toBe("Remix: A free surprising discovery that lets people do something they normally pay for");
    expect(isPlaceholderRemixTitle(remixTitle(base))).toBe(true);
    expect(isPlaceholderRemixTitle(remixTitle({ ...base, views: null }))).toBe(true);
    expect(isPlaceholderRemixTitle("Remix: What a cheap quote leaves out")).toBe(false);
  });
});

describe("remix share of the slate", () => {
  it("turns most of the slate into remixes, keeping the offer and one news slot", () => {
    expect(remixSlots({ news: 2, remix: 2, talking_head: 2, offer: 1 }, 0.7)).toEqual({ news: 1, remix: 5, talking_head: 0, offer: 1 });
    expect(remixSlots({ news: 0, remix: 1, talking_head: 6, offer: 1 }, 0.7)).toEqual({ news: 0, remix: 6, talking_head: 1, offer: 1 });
  });

  it("never shrinks the offer, and 0 leaves the configured slots alone", () => {
    expect(remixSlots({ news: 0, remix: 0, talking_head: 0, offer: 2 }, 1)).toEqual({ news: 0, remix: 0, talking_head: 0, offer: 2 });
    expect(remixSlots({ news: 2, remix: 2, talking_head: 2, offer: 1 }, 0)).toEqual({ news: 2, remix: 2, talking_head: 2, offer: 1 });
    expect(remixSlots({ news: 1, remix: 0, talking_head: 1, offer: 1 }, 1)).toEqual({ news: 0, remix: 2, talking_head: 0, offer: 1 });
  });
});

function brandCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "aos-strategy-remix-")), "brand");
  cpSync(DEMO_BRAND_DIR, dir, { recursive: true });
  return dir;
}

describe("remix-first brief (database)", () => {
  async function seedOwn(ws: Awaited<ReturnType<typeof createTestWorkspace>>, posts: { id: string; views: number; days: number }[]): Promise<Record<string, string>> {
    const [own] = await ws.sql`insert into tracked_creators (workspace_id, platform, handle, tier, active) values (${ws.id}, 'instagram', 'examplebrand', 'own', true) returning id`;
    const ids: Record<string, string> = {};
    for (const p of posts) {
      const [row] = await ws.sql`insert into external_posts (workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, views, transcript)
        values (${ws.id}, ${own!.id}, 'instagram', ${p.id}, 'examplebrand', ${`https://www.instagram.com/reel/${p.id}/`}, ${daysAgo(p.days)}, ${p.views}, 'A transcript') returning id`;
      ids[p.id] = row!.id as string;
    }
    return ids;
  }

  it("plans the owner's breakouts, never a pasted post, and waits for a teardown when the blueprint is missing", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000301", brandDir: brandCopy(), now: () => NOW });
    // Own posts: median 11,000 views; two breakouts (past the 10K-view bar), one already torn down.
    const ids = await seedOwn(ws, [
      { id: "own0", views: 10_000, days: 60 }, { id: "own1", views: 9000, days: 60 }, { id: "own2", views: 11_000, days: 60 },
      { id: "hit", views: 60_000, days: 60 }, { id: "ready", views: 50_000, days: 20 },
    ]);
    await ws.sql`insert into teardowns (workspace_id, external_post_id, platform, author_handle, url, analysis_md, fingerprint)
      values (${ws.id}, ${ids.ready!}, 'instagram', 'examplebrand', 'https://www.instagram.com/reel/ready/', 'x',
              ${ws.sql.json({ facets: { blueprint: { topic: "What a cheap quote leaves out", hookLine: "x", beats: [] } } })})`;
    // Someone else's post pasted in for a teardown: in the library, never in the pool.
    const [pasted] = await ws.sql`insert into external_posts (workspace_id, platform, platform_post_id, author_handle, url, published_at, views, transcript)
      values (${ws.id}, 'instagram', 'url:pasted', 'demo_creator_a', 'https://www.instagram.com/reel/pasted/', ${daysAgo(2)}, 900000, 'A transcript') returning id`;

    const pool = await remixPool(ws, { ownMaxAgeDays: 365 });
    expect(pool.find((p) => p.id === ids.hit)).toMatchObject({ creator: "@examplebrand", x: 5.45, hasBlueprint: false });
    expect(pool.find((p) => p.id === ids.ready)).toMatchObject({ x: 4.55, views: 50_000, hasBlueprint: true, topic: "What a cheap quote leaves out" });
    expect(pool.some((p) => p.id === pasted!.id)).toBe(false);

    const r = await runBrief(ws, { mode: "daily" });
    const remixes = r.items.filter((i) => i.brief.kind === "remix");
    expect(remixes).toHaveLength(2);
    const fromReady = remixes.find((i) => (i.brief.remixOf as { externalPostId: string }).externalPostId === ids.ready)!;
    expect(fromReady.title).toBe("Remix: What a cheap quote leaves out");
    expect(fromReady.brief.remixOf).toMatchObject({ own: true, line: "Based on your own reel, 50K views, 4.6x your normal" });
    const fromHit = remixes.find((i) => (i.brief.remixOf as { externalPostId: string }).externalPostId === ids.hit)!;
    expect(fromHit.brief.remixOf).toMatchObject({ own: true, line: "Based on your own reel, 60K views, 5.5x your normal" });

    // The breakout without a blueprint waits while research tears it down; the ready one starts sooner.
    const runs = await ws.sql<{ job_id: string; input: Record<string, unknown>; run_after: Date }[]>`
      select job_id, input, run_after from agent_runs where workspace_id = ${ws.id} and job_id in ('scripting.write-script', 'research.teardown-prep')`;
    const script = (id: string) => runs.find((x) => x.job_id === "scripting.write-script" && x.input.contentId === id);
    expect(script(fromHit.id)!.run_after.getTime() - NOW.getTime()).toBe(30 * 60_000);
    expect(script(fromReady.id)!.run_after.getTime() - NOW.getTime()).toBe(10 * 60_000);
    expect(runs.filter((x) => x.job_id === "research.teardown-prep").map((x) => x.input)).toEqual([
      { externalPostId: ids.hit, reuseBlueprint: true, then: { jobId: "scripting.remix-ready", agent: "copywriter", input: { contentId: fromHit.id } } },
    ]);
  });

  it("an older idea that only cited a breakout doesn't block a proper remix of it; a filmed or remixed one does", async () => {
    const ws = await createTestWorkspace({ id: "00000000-0000-4000-8000-000000000302", brandDir: brandCopy(), now: () => NOW });
    const ids = await seedOwn(ws, [
      { id: "own0", views: 10_000, days: 90 }, { id: "own1", views: 9000, days: 90 }, { id: "own2", views: 11_000, days: 90 },
      { id: "big", views: 90_000, days: 80 }, { id: "filmed", views: 70_000, days: 80 }, { id: "remixed", views: 60_000, days: 10 },
    ]);
    for (const [post, status] of [[ids.big!, "scripted"], [ids.filmed!, "filming"]] as const) {
      await ws.sql`insert into content (workspace_id, title, status, brief, source_refs)
        values (${ws.id}, 'Old structure idea', ${status}, ${ws.sql.json({ kind: "remix" })}, ${ws.sql.json([{ type: "external_post", id: post }])})`;
    }
    await ws.sql`insert into content (workspace_id, title, status, brief, source_refs)
      values (${ws.id}, 'A proper remix', 'idea', ${ws.sql.json({ kind: "remix", remixOf: { externalPostId: ids.remixed! } })}, ${ws.sql.json([{ type: "external_post", id: ids.remixed! }])})`;
    const pool = await remixPool(ws, { ownMaxAgeDays: 365 });
    expect(pool.find((p) => p.id === ids.big)).toMatchObject({ used: false });
    expect(pool.find((p) => p.id === ids.filmed)).toMatchObject({ used: true });
    expect(pool.find((p) => p.id === ids.remixed)).toMatchObject({ used: true });

    // ...and the brief plans a proper remix of the post the old draft only cited.
    const r = await runBrief(ws, { mode: "batch", date: "2026-10-13" });
    const sources = r.items.filter((i) => i.brief.kind === "remix").map((i) => (i.brief.remixOf as { externalPostId: string }).externalPostId);
    expect(sources).toContain(ids.big);
    expect(sources).not.toContain(ids.filmed);
    expect(sources).not.toContain(ids.remixed);
  });
});
