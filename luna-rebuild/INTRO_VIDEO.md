# Intro Video — spec + Phase 1 build record

Matthew's idea, 2026-10-24, sparked by the boss-requested walkaround video
he filmed that morning. Status: **APPROVED by Matthew 2026-10-24, with a
multi-video expansion he added the same day** (below); **Phase 1 (app
side) is BUILT** — see "Build phases". The expansion: a user may upload
**multiple** intro videos, pin one as the selection, or choose a
**random-per-post** mode; each video can be deleted individually. The
selection/mode stays exactly as the user left it until they change it.
Backend (bucket, table, settings columns) was applied live 2026-10-24;
the app changes were built in `luna-rebuild/` and the root copy, like
every feature this week.

## The idea in one line

A salesperson records one or more short personal intro videos, uploads
them once, and AutoLaunch attaches one to their posts automatically —
so every listing carries the same human face, and buyers start
recognizing the rep before they ever message.

This is the *evergreen* video (same for every post). Per-car walkaround
videos (like the Civic one) are a different thing and are out of scope
here.

## What the rep sees

Settings → **Dealership** tab, a new card **"My Intro Videos"** sitting
immediately after the Dealership Configuration card (same mental home:
your brand). It reuses the logo's proven upload pattern.

Card contents (as built):
- One guidance line: *Shoot it vertical, 10–20 seconds: your name, your
  store, one line that sounds like you.*
- A toggle: **"Attach an intro video to my posts"** — **default OFF**,
  saved the moment it is flipped.
- A mode control with two choices: **Use selected video** and **Pick
  randomly each post**. Random mode says plainly that a random one of
  the videos below is chosen for each post.
- An **Upload intro video** button accepting MP4/MOV/WebM, multiple
  files at once, with per-file progress in a status line.
- **Empty:** "No intro videos yet."
- **Each video:** an inline preview player, a **Use this one** button
  (shown as **Selected ✓** on the pinned video while mode is
  'selected'), and a **Delete** button (asks first; deletes the storage
  file and the record; deleting the selected video clears the
  selection). The first video a user ever uploads becomes the selection
  automatically.
- One honest footer line naming which channels currently use it
  (updated as phases land), so nobody believes it is attached somewhere
  it is not: attaching goes live channel by channel — TikTok and
  Instagram first — and Phase 1 changes no posts.

Upload rules (enforced before upload, on the device):
- MP4, MOV, or WebM; **≤ 50 MB**.
- Duration read on-device: **warn** over 30 seconds ("long for an
  intro"), **block** over 90 seconds. Recommended: 10–20.

## Storage & data (additive only) — AS SHIPPED 2026-10-24

- New public Storage bucket **`intro-videos`** (kept separate from
  `branding` so video size/lifecycle never tangles with logos), per-user
  folder, path `{user_id}/intro-<timestamp>-<index>.<ext>`; its RLS
  mirrors the `branding` bucket.
- New table **`user_intro_videos`** (owner CRUD via RLS): `id` (uuid),
  `user_id`, `video_url` (text), `storage_path` (text), `created_at`.
  One row per uploaded video — this is what makes multiple videos,
  per-video selection, and per-video delete work.
- `user_settings` gained exactly three columns:
  - `intro_video_enabled` (boolean, **default false**)
  - `intro_video_mode` (text, **default 'selected'** — 'selected' |
    'random')
  - `intro_selected_video_id` (uuid, nullable, FK →
    `user_intro_videos.id` **ON DELETE SET NULL**, so deleting the
    selected video clears the selection by itself)
- The bucket, table, and columns were applied live via an additive
  migration on **2026-10-24** (Matthew's approval above). An earlier
  draft of this spec had a single `intro_video_url` column on
  user_settings instead — superseded by the table when Matthew asked
  for multiple videos.
- Nothing is added to queue rows or inventory. Every reader looks the
  video up in settings at the moment it is needed, so **Delete** and the
  toggle take effect everywhere immediately.

## What happens per channel

| Channel | Behavior | Depends on |
|---|---|---|
| TikTok / Instagram | The intro is stitched as the **opener** of the auto-generated per-car video (car content follows) | The video-generation build (not built yet) |
| Facebook Page posts | The video rides as the post's media alongside the listing text | The Page channel (Meta Advanced Access) |
| Facebook Marketplace (extension) | The helper attaches the resolved clip through the composer's dedicated video control (1 video max, 60 seconds max), after the photos, and waits for processing to finish before Publish. Strictly fail-open: any video problem skips the clip and the post goes out exactly as before | ✅ Composer test passed 2026-10-28; attach built in ext v2.1.53 (Phase 4) — pending first live post confirmation on the new helper |
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
4. **Instant kill switch.** Toggle off, or Delete the videos, and it is
   detached everywhere from the next post onward — no cleanup queue, no
   residue.
5. **Rebuild-only until approved.** Tested on Matthew's account in the
   test copy first; live merge only on his word.

## Build phases

- **P1 — App side only. ✅ BUILT 2026-10-24.** Upload (multiple files,
  with the size/duration guards below), preview players, per-video
  select + random mode, per-video delete, toggle, storage, table and
  settings columns (migration applied live the same day). Fully visible
  and testable; affects **no** channel yet. Follow-up the same day:
  per-user cap of **6 videos** (bounds worst-case storage per account)
  and a **1080p recording tip** in the card — the 50 MB per-file cap is
  the Supabase free plan's global limit (paid tier raises it to
  500 MB); at ~20 MB per typical intro, even 1,000 users ≈ 60 GB,
  inside the paid tier's included 100 GB.
- **P2 — TikTok/IG bookend.** Lands with the generated-video build; also
  strengthens the TikTok sandbox demo (a real end-to-end flow to film).
- **P3 — Facebook Page attach.** Lands with the Page channel.
- **P4 — Marketplace. ✅ BUILT 2026-10-28 (ext v2.1.53).** The one composer test on Matthew's account passed — the vehicle composer takes one video (60 seconds max) through a dedicated control, alongside the photos — and the attach is wired: claim-time resolution in the worker ('selected' / 'random' per the preference, lookup-at-use, nothing added to queue rows), the content script downloads the clip, attaches it after the photos, probes its duration (over 60s = skip), and waits for processing to complete before Publish. Every failure is a named skip; the post is unchanged. Status: built, pending first live post confirmation on the new helper.
- **P4 fix — bounded download (ext v2.1.54, 2026-10-28).** The first live 2.53 post attempt wedged: the clip download had no time limit at any layer (worker's bare fetch → content relay wait), so a stalled download hung the post silently behind the "Uploading photo(s)…" banner (~55 min), and a surviving tab later re-drove the fill for the already-settled row. Fixed in 2.54 (extension header note 28 in both files): the worker fetch aborts at 30s (`video_fetch_timeout`), the content side races the relay at 35s and bounds its direct fallback at 30s, the duration probe gives up at 10s, the banner announces the video step BEFORE the download, and the fill now asks the worker for a job-liveness verdict before starting (definitive "no" only — uncertainty always proceeds). A dead download is now the ordinary `intro_video_download_failed` skip: the post always proceeds without the clip rather than hanging.

## Open decisions for Matthew

1. **Opener vs closer** on TikTok/IG. Recommendation: opener — it is the
   "meet me" moment; the car still gets the remaining runtime. (A closer
   variant can come later without re-uploading.)
2. **Length policy.** Recommendation as specced: warn > 30s, block >
   90s.
3. **Approve P1** — ✅ decided 2026-10-24: Matthew approved P1 and
   expanded it the same day to multiple videos + per-video select +
   random-per-post mode + per-video delete (all shipped in P1, above).

## Test plan (when P1+ is built)

- Toggle OFF → queue, post, delete a car: behavior identical to the
  2026-10-23 graduation run.
- Toggle ON with a deliberately broken video URL → the post still
  succeeds; the step notes record "intro skipped".
- Toggle ON with a real video → TikTok sandbox post opens with the
  intro, car content follows.
