# AutoLaunch — Syndication Channels
Decision by Matthew, 2026-10-22. Goal: MAXIMUM REACH — one car, entered
once, seen by as many people as possible, on as many platforms as possible.
One inventory -> one queue -> many channels. The user picks channels once
in settings; every eligible car then fans out automatically.

## The unified model (applies to every channel)
- The queue is per-channel: one car produces one queue row PER enabled
  channel, all sharing the same status vocabulary:
  pending -> processing -> posted / failed.
  (auto_posting_queue.target_channel already exists — use it properly:
  'marketplace', 'instagram', 'tiktok', 'facebook_page'.)
- Webhook fan-out: car becomes eligible (new arrival / user queues it) ->
  webhook -> Edge Function checks that user's per-channel settings, safety
  limits and connections -> creates the channel queue rows -> each
  channel's worker publishes and writes back its own posted URL/ID, so the
  UI can show "Posted: Marketplace ✓ · Instagram ✓ · TikTok ⏳" per car.
- Users NEVER handle keys (see WEBHOOK_ARCHITECTURE.md). Per channel they
  do exactly one thing, once: connect / stay signed in.

## Channel 1 — Facebook Marketplace (browser extension)
How: NO official listing API exists. The extension works in the user's
own logged-in Facebook session in Chrome.
User does: install extension, stay signed in to Facebook in Chrome,
leave Chrome open. Optionally use Confirm mode (stop before Publish).
AutoLaunch does: claims pending 'marketplace' rows for that user, opens
Create Vehicle, fills all fields, uploads photos in order, human pacing,
daily-limit enforcement, publishes, marks posted with the listing URL.
Safety: stop on CAPTCHA/checkpoint/account warning — never force through;
randomised human-like delays; per-user daily caps; failed rows retry with
backoff, never in a burst.
Status: Phase 2/3 of GAMEPLAN.md.

## Channel 2 — Instagram (official API — true server-side auto-post)
How: Instagram Content Publishing API, from Matthew's Meta app.
User does: ONE Connect click + Meta login, and the Instagram account must
be a Professional (Business/Creator) account — onboarding must check this
and walk personal accounts through converting (it's free, in IG settings).
AutoLaunch does (server-side, user can be offline):
- Photo carousel (up to 10 dealer photos) and/or a Reel of the generated
  vehicle video — same webhook fan-out creates an 'instagram' queue row.
- Two-step publish: create media container from a public HTTPS media URL
  (media must be hosted — Supabase Storage), poll until processed, publish.
- Caption generated from vehicle + the user's posting preferences
  (emoji/length/AI prompt settings they already have) + dealer hashtags.
Approvals Matthew must get: Meta App Review for the content-publish
permission + Advanced Access (required before OTHER users' accounts can
post, not just Matthew's own test accounts). Long-lived tokens (~60 days)
are refreshed automatically server-side before expiry.
Limits to respect in code: API-published posts are capped per 24h per
account (design for ~50/day safe ceiling), no licensed music in API Reels
(original audio only), no editing a post after publish (fix = delete/repost).

## Channel 3 — TikTok (official API — true server-side auto-post, after audit)
How: TikTok Content Posting API, Direct Post, from Matthew's TikTok app.
User does: ONE Connect click + TikTok login (video.publish scope).
AutoLaunch does (server-side, user can be offline):
- Generates the vehicle video first (see Video Pipeline below) — TikTok is
  video-first, photos are secondary.
- Before EVERY post, query creator_info for that account's allowed privacy
  levels and post with an allowed one — never hardcode PUBLIC.
- Direct Post the MP4 (file upload, or pull-from-URL only from a verified
  domain Matthew owns), with generated caption + hashtags + disclosure
  settings, then record the TikTok post URL on the queue row.
THE GATE: until TikTok AUDITS and approves Matthew's API client, posts are
forced private (SELF_ONLY) and the client is limited to a handful of
creators/day. Public auto-posting unlocks only after audit approval.
=> Start the audit application EARLY (it is the long pole); build and test
everything in private mode meanwhile. Do not promise users public TikTok
posting before the audit passes.
Tokens: access token lasts ~24h, refresh token ~365 days — the backend
refreshes automatically; the user only reconnects if they revoke access.

## Channel 4 — Facebook Page (official API — bonus, nearly free)
If a user connects Meta for Instagram, the same connection can usually
authorize their dealership Facebook Page. Page posts (photos/video/Reel +
caption) publish fully server-side via the Graph API. This replaces and
retires the current scripts/fb_inventory_sync.js design (which expected
hand-pasted tokens). Low extra build cost once Channel 2 exists — same
OAuth, same token store, same worker pattern.

## Video Pipeline (shared by TikTok + Instagram Reels + Page video)
New cars need a video, dealers only have photos. Pipeline:
queue row needs video -> webhook -> video worker (ffmpeg — runs as a
GitHub Actions job or a small worker service; Edge Functions are not the
place for video rendering) -> builds a 9:16 MP4: photo slideshow with
smart crop (uses the user's existing photo-crop/background settings),
overlay: year/make/model, price, mileage, dealership name + CTA,
original-audio music bed (no licensed tracks) -> stores MP4 in Supabase
Storage at a public URL -> marks the asset ready -> TikTok/IG workers
pick it up. One video per car, reused by every video channel.

## Reach rules built into the fan-out
- Stagger, don't blast: the same car hits channels at spaced times, and
  per-channel daily pacing applies independently.
- Sold = everywhere off: when a car sells / is removed, the fan-out creates
  delete/unpublish tasks per channel where the platform supports it
  (Marketplace delist via extension, IG delete via API), and stops any
  pending rows for that VIN.
- Per-car reach report in the UI: which channels it is live on, with links
  — this is the "see how many people you reach" proof for the sales rep.

## Build order (extends GAMEPLAN.md)
Phase 2/3: Marketplace extension (as planned).
Phase 6a: Instagram channel (Meta OAuth + carousel posting) — fastest true
  auto-post win, one Meta app also unlocks Channel 4.
Phase 6b: Facebook Page channel off the same Meta connection.
Phase 6c: Video pipeline worker.
Phase 6d: TikTok channel — file the audit application FIRST, build in
  private mode, flip to public when the audit passes.
