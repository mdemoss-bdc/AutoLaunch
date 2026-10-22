# AutoLaunch — Rebuild Game Plan (Luna's test copy)
Owner: Matthew DeMoss — Private / confidential. Do not share outside Matthew's review.
Rule: Nothing here replaces files in the repo root until Matthew approves it and moves it himself.

## Architecture decision (Matthew, 2026-10-22)
Webhook-first, zero keys for end users. Full design: WEBHOOK_ARCHITECTURE.md

## Canonical decision (Phase 2 needs Matthew sign-off)
There are currently THREE posting paths. The rebuild makes ONE canonical:
- CANONICAL: Inventory -> auto_posting_queue -> Chrome extension -> Facebook Marketplace
  (matches the product vision: Marketplace domination for reps/dealers)
- PARKED: scripts/fb_inventory_sync.js (Facebook Page Graph API poster)
  Keep the file, do not run it as a second poster, until/unless Matthew wants
  Page posting as a separate, explicitly-enabled channel.

## Phase 0 — Stabilize what exists (IN PROGRESS in this folder)
Goal: Inventory and Queue screens render reliably. No new features.
- [x] Fix renderTableRows crash: `item` -> `car`
- [x] Fix loadPostingQueue crash: define VIN lookup against rawInventory, remove debug FOUND/NOT FOUND UI + console spam
- [x] Fix load order in initAppSession: inventory first, then queue
- [x] Fix stock number loss: bulk queue saves stock_number fallback; queue UI reads it
- [x] Fix Sold pill: count + filter now use status === "Sold" instead of hardcoded 0 / always-empty
- [x] Fix silent Supabase failures: price change, FB link save, remove-from-inventory now check `error`
- [x] Remove duplicate element ID chkRibbonAutoMain (settings-modal copy renamed)
- [ ] Matthew tests this index.html against his Supabase login and confirms cars + queue render

## Phase 1 — Scraper that actually responds (IN PROGRESS — see PHASE1_NOTES.md)
Goal: "Refresh Inventory" works for every dealer, not just one hardcoded user.
- [x] Remove hardcoded default user_id from .github/workflows/scraper.yml (test copy built)
- Make the scheduled run scrape ALL configured users (scraper.py already has that branch when USER_ID is empty — the workflow never lets it be empty)
- [x] DECIDED 2026-10-22 (Matthew): webhook-first for everything — a Supabase webhook on scrape_jobs calls an Edge Function that dispatches the Action with a user_id. See WEBHOOK_ARCHITECTURE.md. Users never handle Facebook/GitHub/Supabase keys; all secrets are Matthew's, server-side only.
- [x] Fix parseFromUrl model parsing at the source (HR-V / CR-V / CX / F-series, test copy built + unit tested)
- [ ] Remove the frontend Hr/Cr hack — AFTER a full re-scrape replaces old rows; keep it until then
- [x] Mark stale inventory: DONE overnight 2026-10-22 — clean-crawl rule flags unseen cars is_active=false (status untouched), 50% safety brake. See PHASE1_NOTES.md completion section.

## Phase 2 — Unify the queue + extension handshake (DONE overnight 2026-10-22 in luna-rebuild/extension/ — see EXTENSION_NOTES.md)
Goal: A queued car can actually reach Facebook Marketplace.
- Replace window.postMessage("*") / onMessageExternal mismatch with ONE bridge:
  a content script on the AutoLaunch origin that forwards the signed-in user id
  to the extension, plus "externally_connectable" for the Pages origin in manifest.json
- Replace setInterval in the MV3 service worker with chrome.alarms (survives worker sleep)
- One queue status vocabulary everywhere: pending -> processing -> posted / failed
  (extension currently writes "completed", the UI expects "posted")
- Extension must NOT mark a car posted until publishing is confirmed on Facebook

## Phase 3 — Content script that can fill Facebook's form (DONE overnight 2026-10-22, same extension pass — see EXTENSION_NOTES.md)
Goal: Reliable form fill on facebook.com/marketplace/create/vehicle
- Use the native value setter + input/change events React actually listens to
- Fill year/make/model/condition etc., not just price/mileage/first textarea
- Handle photo upload failures visibly instead of silently continuing
- Keep a human final click: user reviews and publishes; only then write marketplace_posted_at

## Phase 4 — Wire the settings that are currently theatre (DONE overnight 2026-10-22 — ribbon toggles persist, daily limit enforced at enqueue, real testInventory; auto-post/repost/photo modal saves already persisted and now share columns with the ribbon)
Goal: Every toggle in the UI either works or is removed.
- Ribbon toggles (toggleRibbonSetting is currently a console.log) persist to user_settings like the modals do
- Daily safety limit: count today's real posts, enforce in enqueue + bulk queue, replace hardcoded "1 of X"
- testInventory(): perform a real check of the dealer URLs instead of a 1.5s always-success timeout
- Auto-post / repost / photo settings: connect each to the worker/extension behaviour it claims to control, or label it "not yet active"

## Phase 5 — Hardening before real dealers rely on it (DONE overnight 2026-10-22 — escaping + delegated handlers, error audit, signup confirmation flow, onAuthStateChange. Repo privacy/Pro decision still Matthew's, deferred)
- Escape scraped fields (or use DOM/textContent) instead of interpolating dealer data into HTML + inline onclick
- Check every Supabase call's `error` return (they do not throw) — audit remains after Phase 0
- Signup flow when email confirmation is on (signUp -> immediate signIn currently fails with "Email not confirmed")
- Auth state listener instead of only checking session on page load
- Move the repo to PRIVATE (see README warning) and rotate any key that was ever service_role

## Phase 6 — Everywhere syndication (Matthew, 2026-10-22)
Goal: MAXIMUM REACH — one car, once, posted everywhere. Full design: CHANNELS.md
- [ ] Unified per-channel queue fan-out (marketplace / instagram / tiktok / facebook_page rows per car, per-channel status + posted links in the UI)
- [ ] Phase 6a: Instagram via official Content Publishing API (Meta OAuth connect, Professional account check, carousels + Reels) — needs Matthew's Meta App Review + Advanced Access
- [ ] Phase 6b: Facebook Page posting off the same Meta connection (retires fb_inventory_sync.js hand-pasted-token design)
- [ ] Phase 6c: Video pipeline worker (ffmpeg): 9:16 vehicle video from dealer photos for TikTok/Reels
- [ ] Phase 6d: TikTok via Content Posting API — FILE THE AUDIT APPLICATION EARLY; build/test private-only, public posting unlocks only after TikTok approves the client
- [ ] Sold/repost fan-out: delist/delete across channels, per-channel pacing + daily limits

## How Matthew reviews each phase
1. Open the file(s) in this folder and compare with the root originals (diff).
2. Test the copy (Phase 0: just open luna-rebuild/index.html via the same Pages/local setup).
3. Say "approved" — only then does Matthew (or Luna, on his explicit say-so) copy it over the root file in GitHub.
