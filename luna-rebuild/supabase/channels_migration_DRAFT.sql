-- =====================================================================
-- DRAFT ONLY — DO NOT RUN without Matthew reviewing it first.
-- AutoLaunch Phase 6: per-channel queue fan-out.
--
-- Model (CHANNELS.md): one car produces one auto_posting_queue row PER
-- enabled channel. target_channel already exists on the table per the
-- original design ('marketplace' | 'instagram' | 'tiktok' |
-- 'facebook_page'); this migration is additive and idempotent:
--   * guarantees target_channel exists with the right default
--   * adds per-channel outcome columns (posted link/id, error, time)
--   * adds per-user channel enable switches to user_settings
--   * adds a partial unique index so the same car can never be queued
--     twice for the same channel at the same time
-- RLS: no policy changes. New columns inherit the tables' existing
-- row-level security; nothing here widens anyone's access.
-- =====================================================================

-- 1) Queue: channel + outcome columns ---------------------------------
alter table public.auto_posting_queue
  add column if not exists target_channel text not null default 'marketplace';

alter table public.auto_posting_queue
  add column if not exists posted_url text,
  add column if not exists external_post_id text,
  add column if not exists posted_at timestamptz,
  add column if not exists last_error text;

comment on column public.auto_posting_queue.target_channel is
  'marketplace | instagram | tiktok | facebook_page';
comment on column public.auto_posting_queue.posted_url is
  'Public URL of the live post on that channel, written by its worker.';
comment on column public.auto_posting_queue.last_error is
  'Plain-language failure reason from the channel worker (status=failed).';

create index if not exists auto_posting_queue_user_channel_status_idx
  on public.auto_posting_queue (user_id, target_channel, status);

-- One live row per (user, car, channel). Posted/failed rows don't block
-- a future repost; pending/processing rows do.
create unique index if not exists auto_posting_queue_one_live_per_channel_idx
  on public.auto_posting_queue (user_id, vin, target_channel)
  where status in ('pending', 'processing');

-- 2) Per-user channel switches -----------------------------------------
-- Marketplace has no switch: it is the core channel, gated by the
-- extension being installed + the user being signed in to Facebook.
alter table public.user_settings
  add column if not exists channel_instagram_enabled boolean not null default false,
  add column if not exists channel_tiktok_enabled boolean not null default false,
  add column if not exists channel_facebook_page_enabled boolean not null default false;

-- 3) Channel connections (FUTURE — tokens live here, server-side only) --
-- Deliberately created with RLS enabled and NO policies for anon /
-- authenticated roles: only the service role (Edge Functions) can read
-- or write it, so a user's browser can never fetch a token — not even
-- their own. Connection STATUS for the UI comes from a separate view or
-- Edge Function that exposes booleans only. Uncomment when the Meta /
-- TikTok OAuth work starts (Phase 6a/6d).
--
-- create table if not exists public.channel_connections (
--   user_id uuid not null references auth.users (id) on delete cascade,
--   channel text not null,               -- instagram | tiktok | facebook_page
--   external_account_id text,
--   access_token text,                    -- server-side only, never shipped to clients
--   refresh_token text,                   -- server-side only
--   token_expires_at timestamptz,
--   connected_at timestamptz not null default now(),
--   primary key (user_id, channel)
-- );
-- alter table public.channel_connections enable row level security;
-- -- (intentionally no policies: service role bypasses RLS; nobody else gets in)
