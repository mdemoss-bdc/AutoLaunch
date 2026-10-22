# Morning Report — Overnight Rebuild, Thu 2026-10-22

Matthew — everything below is in the **test copy only** (`luna-rebuild/` on
GitHub, live for testing at the usual test address). Your live app and
root files were not touched. Work through this with Luna over coffee;
each phase is its own commit, so anything can be reverted on its own.

## TL;DR

Phases 1, 4, 2+3, 5, the webhook groundwork, and the Phase 6 groundwork
are **built, syntax-verified, and pushed**. On top of the plan: the new
**logo is integrated** and the **per-channel queue fan-out is built**
(not just drafted). Nothing was deployed to Supabase, no live scrape was
run, no Facebook post was attempted — those need you awake, by design.

---

## Phase 1 — Scraper stale inventory ✅
Commit `d42ffe8` (+ cleanup `f7e7020`)

- After a **fully clean** crawl (cars seen, zero navigation/extraction
  errors, no page-1 404), cars in `scraped_inventory` that the crawl did
  not see are flagged `is_active = false`. Status is NOT changed — a car
  leaving the feed isn't proof it sold. If it reappears later, the normal
  upsert reactivates it.
- Safety brake: if a run would deactivate more than half of a dealer's
  active lot (20+ units), it refuses and logs — that's a broken feed,
  not a sell-out.
- Uses only columns the scraper already writes — no migration needed.
  The gentler "miss 2 syncs in a row" upgrade is drafted at
  `supabase/migrations_draft/stale_tracking_DRAFT.sql` (not applied).
- Details appended to PHASE1_NOTES.md. Verified: Python compiles.
  **Untested against live feeds** — first real scrape will exercise it;
  look for "Stale pass" lines in the Actions log.

## Phase 4 — Settings that were theatre ✅
Commit `83e62f2`

- **Ribbon toggles save now.** They write to the same `user_settings`
  columns the settings modals use (arrivals→`auto_post_enabled`,
  repost→`enable_auto_repost`, crop→`auto_crop_enabled`); the master
  "Automations" switch drives all three. On load, the ribbon reflects
  what's actually saved, the Settings modal's Auto Posting switch is
  wired to the same save, and a failed save reverts the switch and tells
  you — no more fake toggles.
- **Daily posting limit is enforced.** Queueing (single or bulk) counts
  today's marketplace queue rows (not failed) plus cars posted today,
  and blocks with a plain message when you'd pass your saved limit.
  The ribbon safety counter now shows the REAL count (it hardcoded
  "1 of X" before). Other channels don't consume the Marketplace limit.
- **testInventory() is real.** It probes the actual dealer URLs from the
  browser (9s timeout each) and reports reachable / not reachable per
  feed, with an honest note: browser security (CORS) means cars/photos/
  VINs can only be verified by the scraper's first run. No more fake
  1.5-second success.

## Phases 2+3 — Extension unified + form fill ✅
Commits `a144fa1` — full write-up in EXTENSION_NOTES.md

- **Handshake fixed:** new `extension/bridge.js` runs on the AutoLaunch
  origin and forwards the app's existing `AUTOLAUNCH_EXT_LOGIN` message
  to the background worker. Manifest gains the content script,
  `externally_connectable`, and the `alarms` permission.
- **Polling:** `chrome.alarms` (1 min) replaces the `setInterval` that
  MV3 kept killing.
- **One status vocabulary** everywhere: pending → processing →
  posted/failed (queue UI now renders Failed too). Claims are
  conditional so a car can't be double-claimed. The worker enforces the
  daily limit as well.
- **Form fill:** React-safe value setting (native setter + events),
  fills photos, year/make/model, price, mileage, condition, transmission,
  body style, description. Photo upload must produce a preview or the
  job FAILS loudly. Login walls/checkpoints stop the job immediately.
- **Posted means posted:** nothing is marked posted on a timer — only
  when a real Facebook success state is detected. Confirm mode is the
  default (it fills, you review and click Publish, it verifies). Full
  auto is a storage flag away.
- **Untested against live Facebook** — selectors are heuristics against
  the current vehicle-create flow. First test: load it unpacked (steps
  in EXTENSION_NOTES.md), queue one car, watch the banner.

## Phase 5 — Hardening ✅
Commit `91dd8f1`

- **Escaping:** scraped/user data in the inventory table, queue list,
  details modal, filter dropdowns, and test results now goes through
  `escapeHtml`; photo/detail URLs are restricted to http(s). All the
  inline `onclick="...'${vin}'..."` attributes in rendering were
  replaced with `data-action` + one delegated click handler — a rogue
  quote in dealer data can no longer break a row or inject markup.
- **Error audit:** the remaining unchecked Supabase calls now check
  their returned `error` (settings save, Refresh's job insert, onboarding
  finish, FB-remove queue cleanup, queue load). No more success messages
  for saves that failed.
- **Signup:** with email confirmation on, sign-up now says "check your
  email to confirm" instead of dying on a fake "wrong password" error,
  and an `onAuthStateChange` listener starts the app when a session
  appears (e.g. returning from the confirmation link). The 10s sync
  poller now follows sign-in state. Phase 0 fixes re-verified intact.

## Webhook groundwork ✅ (drafts only — nothing deployed)
Commit `643ff4c`

- `supabase/functions/dispatch-scrape/index.ts` — draft Edge Function:
  takes a `scrape_jobs` INSERT webhook payload, verifies a shared-secret
  header, calls GitHub `workflow_dispatch` with the user_id, PAT read
  from `Deno.env`. Fails loudly (401/500/502) instead of silently.
- `supabase/WEBHOOK_SETUP.md` — **your** step-by-step: create a dedicated
  dispatch PAT (Actions: read/write, AutoLaunch only), deploy the
  function, set 4 secrets, create the database webhook, verify with Luna.
- TypeScript was sanity-checked by inspection only (no Deno/TS toolchain
  ran overnight).

## Phase 6 — Channels ✅ groundwork + fan-out built
Commit `c89ea71` (with branding, below)

- `supabase/channels_migration_DRAFT.sql` — additive, idempotent,
  **not applied**: guarantees `target_channel`, adds posted_url /
  external_post_id / posted_at / last_error to the queue, per-user
  channel switches to user_settings, a partial unique index preventing
  double-queueing per channel, and a commented, service-role-only
  `channel_connections` design for OAuth tokens (no client policies —
  browsers can never read tokens).
- `CHANNELS_IMPLEMENTATION.md` — the sequence: approvals first, then
  Instagram (6a), Facebook Page (6b), video pipeline (6c), TikTok (6d).
- **Built in the app already:** Settings → Syndication Channels card
  (Instagram / TikTok / Facebook Page switches, persisted — they fail
  honestly with a pointer to the migration until it's applied), and
  queueing now **fans out**: one row per enabled channel, per-channel
  dedupe, channel shown on every queue row. The extension only claims
  marketplace rows; other channels' rows wait for their Phase 6 workers.

## Branding — new logo ✅
Commit `c89ea71` — write-up in BRANDING.md

- Emblem (`icons/logo-mark-512.png`) replaces the blue bolt tiles on the
  sign-in screen and sidebar header. Tagline under the wordmark now
  reads **"Intelligence Suite"** (tab title and dealer copy untouched,
  as instructed).
- `manifest.webmanifest` + favicons + `icons/icon-180/192/512` +
  maskable icon: add AutoLaunch to a phone home screen and it installs
  with the emblem, full-screen, like a native app.

## What Matthew needs to decide / do next

1. **Test Phase 0 + mobile + branding** on the test address (phone):
   sign in, cars + queue render, drawer, new logo, home-screen install.
2. **Meta App Review** — file it (developers.facebook.com): Instagram +
   Pages products, content-publishing permission, Advanced Access.
   Days-to-weeks clock; only you can file. See CHANNELS_IMPLEMENTATION.md.
3. **TikTok client audit** — file it (developers.tiktok.com):
   Content Posting API / video.publish. Until it passes, TikTok posts
   are private-only. Only you can file. **These two are the long poles —
   start them first.**
4. **Webhook dashboards** (~15 min with Luna): the 5 steps in
   `supabase/WEBHOOK_SETUP.md` — second GitHub PAT, function secrets,
   database webhook. Then Refresh becomes instant instead of nightly.
5. **Apply the two draft migrations** when ready (Supabase SQL editor):
   channels first if you want the channel switches live in the test app;
   stale-tracking only if you want the gentler 2-miss rule.
6. **Extension live test** with Luna: load unpacked, one car, confirm
   mode. Expect possible selector tweaks against real Facebook.
7. Still parked from before: **GitHub Pro / private repo** decision —
   nothing changed there.

## Honest gaps

- No live-system testing was possible overnight: no scrape run, no
  Facebook session, no Supabase writes from the new code paths. Every
  phase is syntax-verified and code-reviewed, and each lists its own
  first-live-test steps.
- The extension still talks to Supabase with the publishable key (no
  user JWT yet) — the bridge is where that token will travel in a
  follow-up; RLS is the current guard, as in the original design.
- One stray file was pushed and removed during Phase 1 (a Python
  `__pycache__` artifact) — removed in commit `f7e7020`; repo is clean.

## Commit index (all in luna-rebuild/ only)

- `d42ffe8` Phase 1 stale inventory · `f7e7020` pycache cleanup
- `83e62f2` Phase 4 settings wiring
- `a144fa1` Phases 2+3 extension
- `91dd8f1` Phase 5 hardening
- `643ff4c` Webhook groundwork drafts
- `c89ea71` Phase 6 groundwork + fan-out + branding
- (this report + GAMEPLAN status updates — final commit of the night)
