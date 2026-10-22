# Phase 1 — Scraper (test copy)

Built:
1. workflows/scraper.yml
   - REMOVED the hardcoded default user UUID (it was Matthew's own user id,
     baked into the repo for every run). Scheduled runs now scrape ALL users
     in user_settings, which scraper.py already supported when USER_ID is
     empty — the workflow simply never let it be empty.
   - Manual dispatch: user_id is now optional. Fill it in only to re-scrape
     one dealer; leave blank for everyone.
2. scraper.py — parseFromUrl()
   - Fixed hyphenated model names at the source: HR-V, CR-V, CX-5/50/90,
     F-150/250/350 were being split (model "Hr"/"F", rest dumped in trim).
   - Verified with unit tests for HR-V, CR-V, CX-90, F-150, and a normal
     model (Nautilus) which is unchanged. Python syntax compiles clean.
   - The frontend Hr/Cr hack should be KEPT for now: it repairs inventory
     rows already scraped with the old parser. Remove it only after a full
     re-scrape has replaced the old data.

On-demand refresh — DECIDED 2026-10-22 (Matthew): Option A, webhook-first.
  A Supabase Database Webhook on scrape_jobs insert calls an Edge Function
  that dispatches this workflow with that user_id. The GitHub PAT lives in
  Supabase Edge Function secrets (Matthew's secret only — never frontend,
  never a user). See WEBHOOK_ARCHITECTURE.md for the full event design.
- Stale inventory: cars that vanish from a dealer feed are never marked
  inactive/sold today. Needs a rule (e.g. not seen in 2 consecutive full
  syncs -> is_active=false) designed around real feed behaviour.

## Completion — stale inventory (2026-10-22, overnight)

Implemented in scraper.py: mark_stale_inventory() + tracking in run_scraper().

Rule shipped (conservative, existing columns only — no migration required):
- During a user's crawl the scraper now collects every VIN seen across all
  of that user's feeds, and tracks whether the crawl stayed clean.
- After the feeds finish, IF the crawl saw at least one car AND had zero
  navigation errors, zero page-1 404s and zero extraction errors, then any
  of that user's rows with is_active=true whose VIN was not seen get
  is_active=false. Their status is deliberately NOT changed (a car leaving
  the feed is not proof it sold).
- Safety brake: if the stale pass would deactivate more than 50% of a
  dealer's active inventory (and they have 20+ active units), it refuses
  and logs instead — that pattern means the feed changed, not the lot.
- If a "stale" VIN reappears in a later crawl, the existing upsert
  reactivates it automatically (is_active=true, status="Available").
- The whole pass is wrapped so a database error (including the theoretical
  case that is_active does not exist) logs a warning and never fails the
  scrape. The select is paginated and updates are chunked at 200 VINs.
- Bonus hardening in the same pass: extraction errors on a page are now
  caught per-feed instead of crashing the entire multi-user run.

Choice note: the gentler "2 consecutive missed syncs" rule from the
original note needs per-row memory of misses, which the current schema
has no column for. A DRAFT migration for that upgrade lives at
supabase/migrations_draft/stale_tracking_DRAFT.sql (adds last_seen_at +
stale_miss_count, additive only). It is NOT applied and the scraper does
not depend on it. Matthew: apply it only if you want the 2-miss rule.

Verified: python3 -m py_compile passes. NOT yet run against the live
dealer feeds (no scrape was triggered overnight) — first scheduled or
manual run will exercise it; watch for the "Stale pass" log lines.
