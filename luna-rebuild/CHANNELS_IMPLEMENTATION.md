# Channels — Implementation Sequence (Phase 6)

Design: CHANNELS.md. Migration draft: supabase/channels_migration_DRAFT.sql
(NOT applied — Matthew runs it in the Supabase SQL editor after review).
Status of the app-side fan-out built tonight is at the bottom.

## First actions — approvals only Matthew can file (do these FIRST)

Everything else waits on these two clocks, so they start before any
channel code beyond the fan-out:

1. **Meta App Review + Advanced Access** (unlocks Instagram + Facebook
   Page posting for OTHER users' accounts, not just Matthew's own).
   - Create the Meta app (developers.facebook.com) as a Business app.
   - Add the Instagram Content Publishing + Facebook Pages products.
   - Build the OAuth connect flow against test users (works pre-review).
   - Submit for App Review with a screencast of the connect + post flow,
     requesting the content-publishing permission and Advanced Access.
   - Review takes days to weeks and often bounces once for clarification.
2. **TikTok client audit** (unlocks PUBLIC TikTok posting).
   - Register the app at developers.tiktok.com, request the
     Content Posting API / Direct Post (video.publish scope).
   - File the audit application immediately — until it passes, every
     post is forced private (SELF_ONLY) and daily creator counts are tiny.
   - Build and test in private mode; do not promise public posting yet.

## Build sequence after / alongside the approvals

### 6a — Instagram (first real channel)
- Prereqs: draft migration applied; Meta app exists; user IG account is
  Professional (Business/Creator) — onboarding checks and explains the
  free conversion.
- OAuth connect Edge Function: Meta login -> code exchange -> long-lived
  token (~60d) stored in channel_connections (service-role only table in
  the migration draft) -> token refresh job before expiry.
- Media must be public HTTPS: dealer photos copied into Supabase Storage
  at queue time (dealer CDNs hotlink-block and expire).
- Worker (Edge Function or Actions job): for each pending 'instagram'
  row: create carousel container (up to 10 photos), poll processing,
  publish, write posted_url/external_post_id/posted_at back to the row.
  Caption from the user's existing posting-preference settings.
- Respect the ~50 posts/24h per-account API ceiling in the worker.

### 6b — Facebook Page (rides the same Meta connection)
- Same OAuth grant usually covers the user's Page. Page worker posts
  photo set + caption (or the 6c video) via the Graph API and writes the
  post URL back. This retires scripts/fb_inventory_sync.js for good.

### 6c — Video pipeline (shared by TikTok + Reels + Page video)
- Worker (GitHub Actions job with ffmpeg — Edge Functions are the wrong
  place for rendering): photos -> 9:16 MP4, smart crop honoring the
  user's photo settings, overlay year/make/model + price + mileage +
  dealership name + CTA, original-audio music bed only.
- Output to Supabase Storage (public URL), one video per car, reused by
  every video channel. Queue rows for video channels wait on the asset.

### 6d — TikTok
- Prereqs: audit approved (public) or private-mode testing.
- Before EVERY post: query creator_info for that account and use one of
  ITS allowed privacy levels — never hardcode PUBLIC.
- Direct Post the 6c MP4 (upload; pull-from-URL only from a verified
  domain), caption + hashtags, write the TikTok URL back.
- Tokens: access ~24h / refresh ~365d — backend refreshes automatically.

### Cross-channel rules (from CHANNELS.md)
- Stagger cross-posts of the same car; per-channel daily pacing is
  independent of the Marketplace safety limit.
- Sold/removed fans out as delist/delete per channel where supported,
  and cancels pending rows for that VIN.
- The queue UI is the reach report: per car, per channel, status + link.

## What is already built (overnight, test copy)

- Queue rows carry target_channel end-to-end; the queue list shows the
  channel per row.
- Settings has a "Syndication Channels" card with per-channel switches
  persisted to user_settings (channel_instagram_enabled,
  channel_tiktok_enabled, channel_facebook_page_enabled). Until the
  draft migration is applied those saves fail honestly with a message
  pointing here — they do not fake-save.
- Queueing (single "Post To Facebook" and bulk) now FANS OUT: one row
  per enabled channel (marketplace always; others when switched on and
  the migration is in). Marketplace rows are the only ones the extension
  claims; other channels' rows wait for their workers (6a/6b/6d).
- The Marketplace daily safety limit now counts marketplace rows only,
  so other channels do not consume it.
