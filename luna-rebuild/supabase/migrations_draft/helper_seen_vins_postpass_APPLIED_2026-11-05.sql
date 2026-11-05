-- APPLIED 2026-11-05 (DWS auto-post wiring, Matthew "go" 14:24 ET).
-- Helper-side DWS syncs stamp their assembled seen-VIN set on the
-- completed scrape_jobs row (helper_seen_vins) and leave one
-- sync_mode='postpass' row behind (source_job_id -> the sync job);
-- the server scraper's postpass pickup runs the EXISTING
-- _auto_post_filtered over exactly that set. Additive + nullable:
-- every pre-existing row and reader is unaffected.
ALTER TABLE public.scrape_jobs
  ADD COLUMN IF NOT EXISTS helper_seen_vins jsonb,
  ADD COLUMN IF NOT EXISTS source_job_id uuid;
select pg_notify('pgrst', 'reload schema');
