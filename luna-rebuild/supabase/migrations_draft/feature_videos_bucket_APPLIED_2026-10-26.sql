-- =====================================================================
-- APPLIED 2026-10-26 via Management API (additive). Public storage for
-- the upgrade-notice feature demo clips (Matthew, 2026-10-26: a trial
-- user who clicks a paid feature should SEE it in action inside the
-- notice). Clips are referenced by FEATURE_VIDEOS in index.html and
-- uploaded as <feature>.mp4; see "Feature demo videos" in TIERS.md.
-- =====================================================================

-- Public read; writes service-role only (deliberately NO insert /
-- update / delete policies — only the service role can write).
insert into storage.buckets (id, name, public, file_size_limit)
values ('feature-videos', 'feature-videos', true, 52428800)
on conflict (id) do nothing;

create policy "feature_videos_read_all" on storage.objects
  for select using (bucket_id = 'feature-videos');
