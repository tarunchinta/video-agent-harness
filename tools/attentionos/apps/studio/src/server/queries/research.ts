import "server-only";
import { workspace } from "@/server/workspace";

/** Read models for /research: the trend radar and teardowns. */

export type TrendKit = {
  header?: string;
  beats?: { text: string; visual?: string }[];
  caption?: string;
  keyword?: string;
  sources?: string[];
};

export type Trend = {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  heat: number | null;
  velocity: number | null;
  relevance: number | null;
  points: number | null;
  comments: number | null;
  coverage: number;
  status: string;
  kit: TrendKit | null;
  filmBy: string | null;
  /** Engagement (points + comments) over time, oldest first. */
  history: number[];
  /** Content made from this trend, if any. */
  content: { id: string; title: string; status: string } | null;
};

export async function getTrends(): Promise<Trend[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      title: string;
      url: string;
      source_id: string;
      author: string | null;
      published_at: Date | null;
      first_seen_at: Date;
      heat: string | null;
      velocity: string | null;
      relevance: string | null;
      points: string | null;
      comments: string | null;
      coverage: number | null;
      status: string;
      story: TrendKit | null;
      film_by: Date | null;
      history: (string | number)[] | null;
      content_id: string | null;
      content_title: string | null;
      content_status: string | null;
    }[]
  >`
    select t.id, t.title, t.url, t.source_id, t.author, t.published_at, t.first_seen_at, t.heat::text, t.velocity::text,
           t.relevance::text, t.points::text, t.comments::text, t.coverage, t.status, t.story, t.film_by,
           (select array_agg(coalesce(s.points, 0) + coalesce(s.comments, 0) order by s.captured_at)
              from trend_snapshots s where s.trend_id = t.id and s.workspace_id = t.workspace_id) as history,
           c.id as content_id, c.title as content_title, c.status as content_status
      from trends t
      left join lateral (
        select c.id, c.title, c.status from content c
         where c.workspace_id = t.workspace_id
           and exists (select 1 from jsonb_array_elements(c.source_refs) s where s ->> 'type' = 'trend' and s ->> 'id' = t.id::text)
         order by c.created_at desc limit 1
      ) c on true
     where t.workspace_id = ${ws.id}
     order by case when t.status in ('kit', 'shortlisted', 'new') then 0 when t.status = 'used' then 1 when t.status = 'dismissed' then 2 else 3 end,
              t.heat desc nulls last
     limit 60`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    source: r.source_id,
    author: r.author,
    publishedAt: r.published_at?.toISOString() ?? null,
    firstSeenAt: r.first_seen_at.toISOString(),
    heat: r.heat != null ? Number(r.heat) : null,
    velocity: r.velocity != null ? Number(r.velocity) : null,
    relevance: r.relevance != null ? Number(r.relevance) : null,
    points: r.points != null ? Number(r.points) : null,
    comments: r.comments != null ? Number(r.comments) : null,
    coverage: r.coverage ?? 1,
    status: r.status,
    kit: r.story && (r.story.header || r.story.beats?.length) ? r.story : null,
    filmBy: r.film_by?.toISOString() ?? null,
    history: (r.history ?? []).map(Number),
    content: r.content_id ? { id: r.content_id, title: r.content_title ?? "", status: r.content_status ?? "idea" } : null,
  }));
}

export type Teardown = {
  id: string;
  platform: string | null;
  author: string | null;
  url: string;
  analysisMd: string;
  fingerprint: Record<string, unknown> | null;
  createdAt: string;
  caption: string | null;
};

/** Not used yet: no Studio page calls this. Kept for a later release. */
export async function getTeardowns(): Promise<Teardown[]> {
  const ws = workspace();
  const rows = await ws.sql<
    { id: string; platform: string | null; author_handle: string | null; url: string; analysis_md: string; fingerprint: Record<string, unknown> | null; created_at: Date; caption: string | null }[]
  >`
    select t.id, t.platform, t.author_handle, t.url, t.analysis_md, t.fingerprint, t.created_at, e.caption
      from teardowns t left join external_posts e on e.id = t.external_post_id
     where t.workspace_id = ${ws.id}
     order by t.created_at desc limit 20`;
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    author: r.author_handle,
    url: r.url,
    analysisMd: r.analysis_md,
    fingerprint: r.fingerprint,
    createdAt: r.created_at.toISOString(),
    caption: r.caption,
  }));
}
