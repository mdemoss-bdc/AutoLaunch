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
