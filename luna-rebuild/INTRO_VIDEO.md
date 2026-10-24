# Intro Video — spec (no code yet)

Matthew's idea, 2026-10-24, sparked by the boss-requested walkaround video
he filmed that morning. Status: **spec only — nothing built, nothing
changed.** When built, it is built in `luna-rebuild/` only and reaches the
live app solely on Matthew's explicit approval, like every feature this
week.

## The idea in one line

A salesperson records ONE short personal intro video, uploads it once,
and AutoLaunch attaches it to their posts automatically — so every
listing carries the same human face, and buyers start recognizing the rep
before they ever message.

This is the *evergreen* video (same for every post). Per-car walkaround
videos (like the Civic one) are a different thing and are out of scope
here.

## What the rep sees

Settings → **Dealership** tab, a new card **"My intro video"** sitting
beside the logo upload (same mental home: your brand). It reuses the
logo's proven upload pattern.

Card states:
- **Empty:** "No intro video yet" + Upload button + one guidance line:
  *Shoot it vertical, 10–20 seconds: your name, your store, one line
  that sounds like you.*
- **Uploading:** progress, then an inline preview player.
- **Ready:** preview player, **Replace**, **Remove**. Replacing
  overwrites — there is only ever one intro video per user.

Below the card, one toggle: **"Attach my intro video to my posts"** —
**default OFF**. Below that, one honest line naming which channels
currently use it (updated as phases land), so nobody believes it is
attached somewhere it is not.

Upload rules (enforced before upload, on the device):
- MP4, MOV, or WebM; **≤ 50 MB**.
- Duration read on-device: **warn** over 30 seconds ("long for an
  intro"), **block** over 90 seconds. Recommended: 10–20.

## Storage & data (additive only)

- New public Storage bucket **`intro-videos`** (kept separate from
  `branding` so video size/lifecycle never tangles with logos), path
  `{user_id}/intro.<ext>` — same per-user pattern the logo uses.
- `user_settings` gains exactly two columns, via an additive migration
  draft in `supabase/migrations_draft/` (drafted, **not applied** until
  a build is approved — same pattern as the wishlist migration):
  - `intro_video_url` (text, nullable)
  - `intro_video_enabled` (boolean, **default false**)
- Nothing is added to queue rows or inventory. Every reader looks the
  video up in settings at the moment it is needed, so **Remove** and the
  toggle take effect everywhere immediately.

## What happens per channel

| Channel | Behavior | Depends on |
|---|---|---|
| TikTok / Instagram | The intro is stitched as the **opener** of the auto-generated per-car video (car content follows) | The video-generation build (not built yet) |
| Facebook Page posts | The video rides as the post's media alongside the listing text | The Page channel (Meta Advanced Access) |
| Facebook Marketplace (extension) | **Unknown.** The vehicle composer's video support has never been tested. First step is a test, not a promise: if the composer takes a video, the helper attaches it; if not, this channel is formally dropped from the feature and the settings line says so | One composer test on Matthew's account |
| Everywhere, always | If anything about the video fails — missing, disabled, unreachable, too large — the post goes out **exactly as it does today**, with no video | — |

## Safety invariants (why this cannot mess up what we have)

1. **Default OFF.** A user who never touches it gets byte-for-byte
   today's behavior.
2. **Fail-open, everywhere.** No code path may fail, block, delay, or
   alter a post because of the intro video. Failures are noted in the
   post's step notes and otherwise ignored.
3. **The proven loop is untouched.** Queue claiming, pacing, daily
   limits, delete logic, and the post→delete flow graduated on
   2026-10-23 (ext 2.1.23) are not modified. The only new behavior is a
   settings lookup at post-prep time.
4. **Instant kill switch.** Toggle off, or Remove, and it is detached
   everywhere from the next post onward — no cleanup queue, no residue.
5. **Rebuild-only until approved.** Tested on Matthew's account in the
   test copy first; live merge only on his word.

## Build phases

- **P1 — App side only.** Upload/preview/replace/remove, toggle, storage,
  migration draft. Fully visible and testable; affects **no** channel
  yet. This is the only phase this spec asks to approve.
- **P2 — TikTok/IG bookend.** Lands with the generated-video build; also
  strengthens the TikTok sandbox demo (a real end-to-end flow to film).
- **P3 — Facebook Page attach.** Lands with the Page channel.
- **P4 — Marketplace test.** One composer test decides in or out.

## Open decisions for Matthew

1. **Opener vs closer** on TikTok/IG. Recommendation: opener — it is the
   "meet me" moment; the car still gets the remaining runtime. (A closer
   variant can come later without re-uploading.)
2. **Length policy.** Recommendation as specced: warn > 30s, block >
   90s.
3. **Approve P1** to build in the rebuild — or park the spec here.

## Test plan (when P1+ is built)

- Toggle OFF → queue, post, delete a car: behavior identical to the
  2026-10-23 graduation run.
- Toggle ON with a deliberately broken video URL → the post still
  succeeds; the step notes record "intro skipped".
- Toggle ON with a real video → TikTok sandbox post opens with the
  intro, car content follows.
