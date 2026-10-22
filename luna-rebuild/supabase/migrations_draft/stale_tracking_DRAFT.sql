-- =====================================================================
-- DRAFT ONLY — DO NOT RUN without Matthew reviewing it first.
-- AutoLaunch: optional stronger stale-inventory tracking.
--
-- Tonight's scraper change does NOT need this migration: it flags stale
-- inventory using the existing is_active column after one fully clean
-- crawl (with a >50% safety brake). This draft is the upgrade path if
-- Matthew wants the gentler rule discussed in PHASE1_NOTES.md:
-- "not seen in 2 consecutive full syncs -> inactive".
--
-- Additive only: two new nullable columns, no changes to existing data.
-- scraped_inventory is written by the scraper with the owner's keys and
-- read by signed-in users under existing RLS; adding columns does not
-- change any policy. No policy changes are included or needed here.
-- =====================================================================

alter table public.scraped_inventory
  add column if not exists last_seen_at timestamptz,
  add column if not exists stale_miss_count integer not null default 0;

comment on column public.scraped_inventory.last_seen_at is
  'Last crawl (any feed) in which this VIN was seen. Set by scraper.';
comment on column public.scraped_inventory.stale_miss_count is
  'Consecutive fully-successful crawls that did not see this VIN. '
  'Scraper increments on a clean crawl, resets to 0 when seen, and sets '
  'is_active=false when the count reaches 2.';
