-- Competitor tracking was removed from the engine: no competitor scan, outliers, competitor hook bank, competitor
-- benchmarks or competitor prior in attribution. `tracked_creators` now only holds the owner's own accounts, and
-- `external_posts` holds the owner's imported posts plus posts pasted by hand for a teardown.
--
-- This deletes every competitor's data in existing workspaces. It can't be undone.

-- Runs of jobs that no longer exist would never be claimed by a worker.
update agent_runs set status = 'cancelled', error = 'Competitor tracking was removed', finished_at = coalesce(finished_at, now())
 where status in ('queued', 'running', 'waiting_approval')
   and job_id in ('research.competitor-scan', 'scripting.classify-hooks', 'onboarding.suggest-competitors');

-- Competitor hooks and the competitor attribution prior.
delete from hooks where origin = 'competitor';
delete from feature_stats where time_window like 'competitor:%';
delete from alert_log where key like 'competitor-scan:%';

-- Competitor posts (and their teardowns, snapshots and knowledge chunks), then the creators themselves.
delete from teardowns t
 using external_posts p, tracked_creators c
 where t.external_post_id = p.id and p.tracked_creator_id = c.id and c.tier <> 'own';
delete from external_posts p
 using tracked_creators c
 where p.tracked_creator_id = c.id and c.tier <> 'own';
delete from tracked_creators where tier <> 'own';

-- Columns and indexes only the competitor scan and competitor hooks used.
drop index if exists external_posts_outlier_idx;
alter table external_posts
  drop column if exists x_score,
  drop column if exists x_detail,
  drop column if exists is_outlier,
  drop column if exists is_meme;
alter table tracked_creators
  drop column if exists baseline,
  drop column if exists last_scanned_at;
alter table tracked_creators drop constraint if exists tracked_creators_tier_check;
alter table tracked_creators alter column tier set default 'own';
alter table tracked_creators add constraint tracked_creators_tier_check check (tier = 'own');

drop index if exists hooks_competitor_source_uidx;
alter table hooks drop column if exists abstract;
alter table hooks drop constraint if exists hooks_origin_check;
alter table hooks add constraint hooks_origin_check check (origin in ('own', 'manual'));

-- Knowledge chunks of research-library posts: no longer "competitor" transcripts.
do $$
begin
  if to_regclass('knowledge_chunks') is not null then
    alter table knowledge_chunks drop constraint if exists knowledge_chunks_source_type_check;
    update knowledge_chunks set source_type = 'library_transcript' where source_type = 'competitor_transcript';
    -- Chunks of the posts, teardowns and hooks deleted above.
    delete from knowledge_chunks k
     where k.source_type in ('library_transcript', 'comment_gold')
       and not exists (select 1 from external_posts p where p.workspace_id = k.workspace_id and p.id::text = k.source_id);
    delete from knowledge_chunks k
     where k.source_type = 'teardown'
       and not exists (select 1 from teardowns t where t.workspace_id = k.workspace_id and t.id::text = k.source_id);
    delete from knowledge_chunks k
     where k.source_type = 'hook'
       and not exists (select 1 from hooks h where h.workspace_id = k.workspace_id and h.id::text = k.source_id);
    alter table knowledge_chunks add constraint knowledge_chunks_source_type_check check (source_type in (
      'brand_doc', 'knowledge_doc', 'own_transcript', 'own_caption', 'library_transcript',
      'comment_gold', 'hook', 'script', 'post_mortem', 'lesson', 'teardown', 'trend_kit', 'dm',
      'lead_note', 'other'));
  end if;
end $$;
