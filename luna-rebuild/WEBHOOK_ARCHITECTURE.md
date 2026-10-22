# AutoLaunch — Webhook-First Architecture
Decision by Matthew, 2026-10-22.

## The rule
End users (dealers / sales reps) NEVER obtain, paste, or manage a key or
token for Facebook, GitHub, or Supabase. Ever.
- Users only: create an AutoLaunch account, sign in, enter their dealer
  inventory URLs, and (for Facebook) click Connect and log in to THEIR OWN
  Facebook account once to authorize it.
- Every key/secret belongs to Matthew (platform owner) and lives ONLY in
  server-side secret stores. No service_role key, GitHub PAT, or Meta app
  secret ever ships in frontend code, the extension, or a user's hands.

## Where each secret lives (Matthew only)
| Secret | Owner | Stored in | Used by |
|---|---|---|---|
| Supabase publishable (anon) key | Matthew | Frontend code (public by design) | App + extension, ALWAYS with the signed-in user's JWT + RLS |
| Supabase service_role key | Matthew | GitHub Secrets + Supabase Edge Function secrets | Scraper workflow, Edge Functions only |
| GitHub PAT (workflow dispatch, this repo only, Actions:write) | Matthew | Supabase Edge Function secrets | The scrape-dispatch Edge Function |
| Meta app ID/secret (only if Page posting is kept as a channel) | Matthew | Supabase Edge Function secrets | Facebook connect/token Edge Functions |
| A user's Facebook user/page token | That user | Supabase DB, server-side only, set by the OAuth callback — the user never sees or pastes it | Page-posting Edge Function for that user |

## Event flows (everything is an event + webhook, no polling theatre)
1. REFRESH INVENTORY
   App inserts scrape_jobs(pending) -> Supabase Database Webhook ->
   Edge Function `dispatch-scrape` -> GitHub workflow_dispatch API
   (inputs: user_id) -> scraper.yml / scraper.py -> writes scraped_inventory
   with the service key from GitHub Secrets -> marks the job completed ->
   app reads updated inventory + last-sync from Supabase (Realtime or reload).
   Users see: a Refresh button and a spinner. Nothing else.

2. NEW CAR ARRIVES (auto-post)
   scraped_inventory insert / scrape-job-completed event -> webhook ->
   Edge Function `evaluate-auto-post` -> checks that user's settings
   (auto-post on/off, conditions, locations, daily safety limit — enforced
   HERE, server-side, not just in the UI) -> inserts auto_posting_queue rows.

3. MARKETPLACE POSTING (extension — see honest limit below)
   Queue row pending -> extension, signed in via the web-app bridge with the
   user's Supabase session (no key handling by the user), claims the job ->
   fills the Marketplace form in the user's own logged-in Facebook session ->
   user confirms Publish -> extension reports back -> webhook/REST marks
   posted. Status vocabulary everywhere: pending -> processing -> posted/failed.

4. FACEBOOK PAGE POSTING (optional channel, only if Matthew keeps it)
   "Connect Facebook" button -> Meta OAuth dialog (user logs in, approves
   their Page) -> OAuth callback Edge Function exchanges the code, stores
   the token server-side -> queue items for the Page channel are posted by
   an Edge Function calling the Graph API. Users never copy a token from
   Meta's developer tools — that current fb_access_token-by-hand design dies.

5. SCHEDULED HOUSEKEEPING
   GitHub Actions schedules (nightly full scrape, hourly queue sweep) stay
   as a safety net only. They are Matthew's infrastructure, use Matthew's
   secrets, and are invisible to users. Webhooks are the primary trigger;
   schedules only catch anything a webhook missed.

## Additional channels (2026-10-22) — see CHANNELS.md
Instagram and TikTok publish through OFFICIAL APIs, so for those channels
the webhook model is complete: Connect-click OAuth -> tokens stored
server-side -> queue webhook -> worker publishes while the user is offline.
Gates: Meta App Review + Advanced Access (Instagram/Page); TikTok client
AUDIT before any public post (unaudited = private-only). TikTok/Reels need
a generated vehicle video — a shared ffmpeg video pipeline feeds both.

## The one honest limit: Facebook Marketplace itself
Meta offers NO official API for posting personal Marketplace vehicle
listings. No webhook or key — Matthew's or the user's — can server-post to
Marketplace. That channel will always need the user's own logged-in
Facebook session in their browser (the extension). What webhook-first DOES
remove for the user: every key, token, developer account, and setup step.
Their whole job is: stay signed in to Facebook, click Publish.
Page posting, by contrast, CAN be fully server-side via OAuth + webhooks.

## What this decision kills in the current code
- scripts/fb_inventory_sync.js expecting fb_page_id / fb_access_token to
  somehow already exist in user_settings with nobody ever setting them.
- Any design where a dealer needs a GitHub or Supabase account at all.
- The publishable-key-only extension calls with no user JWT (Phase 2 bridge
  must pass the user's session, so RLS — not a shared key — controls access).
