# Instagram Channel — Integration Checklist

**Status: BUILT + DEPLOYED, DARK (2026-11-19).** The functions, table,
callback page, Settings connect panel and per-car Post to Instagram
action are built and deployed (rebuild scope). Two gates remain
before a real post can land: (1) the `META_APP_ID` / `META_APP_SECRET`
function secrets must be set, and (2) Meta App Review must grant
Advanced Access for `instagram_content_publish` on the "Auto Launch
Feed" app and the app must be flipped Live — until then the flow
connects accounts but publishing honestly reports
`instagram_permission_pending`. Matthew's own IG business account
(@autolaunchhq) was converted to Professional and linked to the new
AutoLaunch Facebook Page on 2026-11-19. The submission kit is
`INSTAGRAM_APP_REVIEW.md` in this folder. Modeled on how TikTok was
wired (same channel fan-out — the auto-post pass already emits an
`instagram` channel row whenever `channel_instagram_enabled` is on;
the queue executor for those rows is still a promotion-time piece,
step 8 below).

## What is already prepared (rebuild only)

| Piece | Where | State |
|---|---|---|
| Auth Edge Function | `supabase/functions/instagram-auth/index.ts` | **Deployed 2026-11-19** — Facebook Login code exchange → long-lived token → `/me/permissions` grant read → Page/IG resolution → `instagram_connections` upsert. Routes: `/exchange`, `/status`, `/disconnect`. Status reports `publish_permission` (granted / pending / unknown). |
| Post Edge Function | `supabase/functions/instagram-post/index.ts` | **Deployed 2026-11-19** — Content Publishing API: media container → poll until FINISHED (Reels + carousels) → publish. Single photo, photo carousel (2–10), and Reels. Every attempt's outcome is recorded in `instagram_posts`. Meta permission failures return `instagram_permission_pending` with Meta's verbatim message. |
| Connections + posts tables | `supabase/migrations_draft/instagram_connections_APPLIED_2026-11-19.sql` | **Applied 2026-11-19** — mirrors `tiktok_connections` (owner SELECT only, service-role writes, tokens server-side); adds the `instagram_posts` outcome log. |
| Queue / fan-out | `scraper.py` `_auto_post_filtered` + app queue | **Live already** — instagram channel rows are produced today when the channel flag is on; they simply have no executor yet. |

## Remaining Meta-side steps (in order)

1. **Business verification.** Business portfolio `148237120197918`
   ("Auto Launch", legal name Matthew DeMoss). Rechecked 2026-11-18:
   the portfolio reads "Unverified" with no pending review, and the
   Security Center says verification is not needed — so this is no
   longer treated as the blocker it was in October. If App Review
   demands it, the bank-letter path from the original draft applies.
2. **App Review for Advanced Access.** On the Meta app
   **"Auto Launch Feed" (`1442518901327928`)**, request Advanced Access
   for **`instagram_content_publish`** and **`instagram_basic`** (the
   Facebook-Login / Graph API permission names this build uses;
   `pages_show_list` rides along for Page resolution. The
   `instagram_business_*` names in the October draft belong to the
   separate Instagram-Login API product, which this build does not
   use.) Standard Access today is enough to build against app-role
   accounts, not to ship. Submission kit: `INSTAGRAM_APP_REVIEW.md`.
3. **Flip the app from Development to Live** (after review passes).
4. **Confirm the redirect URI** `https://autolaunch.org/luna-rebuild/instagram-callback.html`
   is registered in the Facebook Login settings of the app (Valid
   OAuth Redirect URIs) — that is the rebuild callback this build
   uses (the function takes `META_REDIRECT_URI` as an override
   secret, and the app constant must match it).

## Remaining AutoLaunch-side steps (promotion time)

5. ~~Apply the connections migration~~ **DONE 2026-11-19**
   (`instagram_connections_APPLIED_2026-11-19.sql`, incl. the
   `instagram_posts` outcome table; schema reloaded).
6. Set Phantom secrets `META_APP_ID` + `META_APP_SECRET`
   (app `1442518901327928`; secret stays server-side, never in code).
   **← the one remaining Matthew-side input for a live connect.**
7. ~~Deploy both functions~~ **DONE 2026-11-19** (Management API
   multipart pattern, per AGENTS.md, from git HEAD bytes):
   `instagram-auth`, `instagram-post`, `verify_jwt=false`.
8. App-side pieces, modeled on TikTok's:
   - ~~`instagram-callback.html`~~ **DONE 2026-11-19** (clone of
     `tiktok-callback.html`, exchanging the code against
     `/instagram-auth/exchange`).
   - ~~Settings connect UI~~ **DONE 2026-11-19** as a Settings →
     Instagram tab + panel driven by `/instagram-auth/status` (the
     TikTok tab is the template), plus the per-car **Post to
     Instagram** button (photo / carousel / Reel chosen from the
     car's media) that calls `/instagram-post` directly.
   - STILL OPEN (promotion time): the executor that picks up queue
     rows with `target_channel = 'instagram'` for hands-free
     auto-posting. The manual per-car action ships first; the
     channel toggle stays disabled until this executor exists.
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
