-- =====================================================================
-- APPLIED 2026-10-26 via Supabase Management API (project Phantom),
-- additive only, for scraper_next.py (self-healing / self-learning
-- scraper, REBUILD sibling of scraper.py — production untouched).
--   1. scraper_playbooks — per-lot AND per-platform learned state
--      (strategy stats + timings, count/price bands, needs list).
--      scope='lot' rows carry user_id; scope='platform' rows are
--      global (user_id NULL) so learning transfers across sites.
--   2. scraper_run_log — watchdog heartbeat: started / feed_* /
--      finished rows per run_id. A run that never starts leaves no
--      'started' row (scheduler-layer failure); a run that dies
--      mid-flight leaves 'started' with no 'finished'.
--   3. scraper_uncertain — the review list: low-confidence
--      extractions with what was found and why it's unsure.
-- RLS: enabled on all three; authenticated users may SELECT their
-- own rows. There are deliberately NO client write policies — the
-- scraper writes with its server-side key (the same posture as
-- tiktok_connections), and every write in scraper_next.py is
-- fail-open so a missing/blocked write degrades to today's behavior
-- instead of breaking the crawl.
-- Followed by: notify pgrst, 'reload schema'.
-- =====================================================================

create table if not exists public.scraper_playbooks (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('lot','platform')),
  user_id uuid references auth.users (id) on delete cascade,
  site_key text not null,
  platform text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create unique index if not exists scraper_playbooks_key_idx
  on public.scraper_playbooks (scope, site_key, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.scraper_playbooks enable row level security;
create policy "scraper_playbooks_select_own" on public.scraper_playbooks
  for select to authenticated using (auth.uid() = user_id);

create table if not exists public.scraper_run_log (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  user_id uuid,
  site_key text,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists scraper_run_log_run_idx
  on public.scraper_run_log (run_id, created_at);
alter table public.scraper_run_log enable row level security;
create policy "scraper_run_log_select_own" on public.scraper_run_log
  for select to authenticated using (auth.uid() = user_id);

create table if not exists public.scraper_uncertain (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  user_id uuid,
  site_key text,
  vin text,
  field text,
  found_value text,
  reason text,
  evidence text,
  created_at timestamptz not null default now()
);
create index if not exists scraper_uncertain_run_idx
  on public.scraper_uncertain (run_id, created_at desc);
alter table public.scraper_uncertain enable row level security;
create policy "scraper_uncertain_select_own" on public.scraper_uncertain
  for select to authenticated using (auth.uid() = user_id);

-- After applying, run: notify pgrst, 'reload schema';
