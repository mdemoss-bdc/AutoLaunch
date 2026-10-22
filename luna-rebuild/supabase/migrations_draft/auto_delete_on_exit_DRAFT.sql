-- =====================================================================
-- DRAFT ONLY — DO NOT RUN without Matthew reviewing it first.
-- AutoLaunch: auto-delete-on-exit master switch.
--
-- One additive column on user_settings:
--   auto_delete_on_exit_enabled (boolean, default true)
--
-- TRUE (and the default for every existing row) means: when a car
-- with a live Marketplace listing is marked sold, removed from
-- inventory, or drops off the dealer feed, AutoLaunch queues a
-- Facebook delete job automatically. FALSE turns all of those
-- triggers off; listings then stay up until removed by hand.
--
-- The app and the scraper both treat a MISSING column as "enabled",
-- so this migration is not a prerequisite for the feature — it only
-- makes the Settings toggle (Settings -> Automation -> "Auto-remove
-- sold & exited cars") able to persist. Until it is applied,
-- toggling the switch in Settings will report a save error and the
-- feature simply stays on.
--
-- Additive only: one new column with a default, no changes to
-- existing data, no policy changes (user_settings RLS already
-- restricts rows to their owner).
-- =====================================================================

alter table public.user_settings
  add column if not exists auto_delete_on_exit_enabled boolean not null default true;

comment on column public.user_settings.auto_delete_on_exit_enabled is
  'When true, a posted car that is marked sold / removed / drops off '
  'the feed gets a Facebook delete job queued automatically. Read by '
  'the app (mark-sold + remove triggers) and scraper.py (stale pass).';
