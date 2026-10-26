# Instagram Channel — Integration Checklist

**Status: PREPARED, NOT LIVE (2026-10-26).** The server-side plumbing is
drafted and waiting; nothing is deployed and the Meta app settings are
untouched. Instagram was decided YES on 2026-10-22 and has been gated
on one thing ever since: Meta business verification, which is waiting
on the bank letter. This doc is the exact remaining path from
"verification lands" to "first Instagram post," modeled on how TikTok
was wired (same queue rows, same channel fan-out — the auto-post pass
already emits an `instagram` channel row whenever
`channel_instagram_enabled` is on; nothing in the posting pipeline
needs to change).

## What is already prepared (rebuild only)

| Piece | Where | State |
|---|---|---|
| Auth Edge Function draft | `supabase/functions/instagram-auth/index.ts` | Draft — Facebook Login code exchange → long-lived token → Page/IG resolution → `instagram_connections` upsert. Routes: `/exchange`, `/status`, `/disconnect`. NOT deployed. |
| Post Edge Function draft | `supabase/functions/instagram-post/index.ts` | Draft — Content Publishing API: media container → (video: poll until FINISHED) → publish. Photo posts and Reels. NOT deployed. |
| Connections table draft | `supabase/migrations_draft/instagram_connections_DRAFT.sql` | Draft — mirrors `tiktok_connections` (owner SELECT only, service-role writes, tokens server-side). NOT applied. |
| Queue / fan-out | `scraper.py` `_auto_post_filtered` + app queue | **Live already** — instagram channel rows are produced today when the channel flag is on; they simply have no executor yet. |

## Remaining Meta-side steps (in order)

1. **Bank letter arrives → finish business verification.**
   Business portfolio `148237120197918` ("Auto Launch", legal name
   Matthew DeMoss). Submit the bank statement (name + address source)
   plus the bank letter (letterhead, dated/signed, legal name +
   address + phone on file) as the supporting document. Nothing else
   on this list can start until verification is approved.
2. **App Review for Advanced Access.** On the Meta app
   **"Auto Launch Feed" (`1442518901327928`)**, request Advanced Access
   for **`instagram_business_content_publish`** (Standard Access today
   is enough to build against your own accounts, not to ship).
   Submission needs: a screencast of the connect → post flow (the
   TikTok review recording pattern works — record against the sandbox
   flow below), a privacy policy URL (the repo's `privacy.html`), and
   the use-case text: "dealership reps publish their own vehicle
   listing photos/videos to their own Instagram business accounts."
   Also request `instagram_business_basic` if it is not already
   Advanced.
3. **Flip the app from Development to Live** (after review passes).
4. **Confirm the redirect URI** `https://mdemoss-bdc.github.io/AutoLaunch/instagram-callback.html`
   is registered in the Facebook Login settings of the app (Valid
   OAuth Redirect URIs). Add the `luna-rebuild/` variant too if the
   rebuild is tested against it first — the function takes
   `META_REDIRECT_URI` as an override secret.

## Remaining AutoLaunch-side steps (promotion time)

5. Apply `supabase/migrations_draft/instagram_connections_DRAFT.sql`
   via the Management API (additive; then
   `notify pgrst, 'reload schema'`).
6. Set Phantom secrets `META_APP_ID` + `META_APP_SECRET`
   (app `1442518901327928`; secret stays server-side, never in code).
7. Deploy both functions (Management API multipart pattern, per
   AGENTS.md): `instagram-auth`, `instagram-post`, `verify_jwt=false`.
8. Build the small app-side pieces, modeled on TikTok's:
   - `instagram-callback.html` (clone of `tiktok-callback.html`,
     exchanging the code against `/instagram-auth/exchange`).
   - Settings → Channels: "Connect Instagram" button + status line
     driven by `/instagram-auth/status` (the TikTok block is the
     template), and the executor that picks up queue rows with
     `target_channel = 'instagram'` and calls `/instagram-post` with
     the car's first photo (photo post) or its listing video (Reel).
9. **Test end-to-end on the reviewer account** against a real IG
   business account linked to a Page, then restore the reviewer
   baseline. Verify one photo post and one Reel actually appear on
   Instagram (the platform itself is the ground truth, same rule as
   Marketplace deletes).
10. Only then flip `channel_instagram_enabled` for real users.

## Known platform constraints to design around

- **Business/Creator accounts only**, and the IG account must be
  linked to a Facebook Page the user manages — personal IG accounts
  cannot publish via the API at all.
- **Media must sit at a public https URL** Meta's servers can fetch
  (Supabase Storage public URLs qualify); photos must be JPEG.
- **Publishing cap:** 25 published posts per IG account per rolling
  24h (at drafting time) — the daily posting limits already in the
  app stay the pacing control; keep the Instagram default at or
  under that cap.
- **Long-lived tokens last ~60 days and are not refreshable in
  place** — `instagram-post` returns `instagram_token_expired` and
  the rep reconnects in Settings (same UX as TikTok's expired-token
  path).
