# VIN Reels (rebuild)

Per-car narrated showcase videos, generated from a car's real photos
and data. Approved by Matthew 2026-11-05 from the RAV4 spike sample
(`sample-MT600945A-vo-fixed.mp4`); this folder is the productized
pipeline. **Rebuild only** — nothing here touches the live app.

## Flow

1. The app (Automate tier; `TIER_FEATURES.vin_reels`) inserts a row
   into `public.vin_reels` with `status='queued'`. A partial unique
   index allows only one live (queued/generating) row per
   (user_id, vin).
2. `worker.py` polls for queued rows (oldest first), claims one with
   an atomic conditional PATCH (`status='queued'` → `'generating'`,
   so two workers can never take the same row), and runs
   `generator.py` as a subprocess (1500s timeout).
3. The generator renders the video, runs the finished-file QA gate,
   uploads to the public `vin-reels` storage bucket, and marks the
   row `ready` (+ `video_url`, + `qa` measurements) or `failed`
   (+ `error`). A failed gate is a failed row — never a ready one.

## Posting-ready foundation (Matt's constraint, 2026-11-05)

- `video_url` is a **stable public URL resolvable by user + VIN**:
  `https://<project>.supabase.co/storage/v1/object/public/vin-reels/<user_id>/<vin>.mp4`.
  Re-renders overwrite the same object (`x-upsert`), so the URL
  never changes. The poster will attach ready reels to Marketplace
  listings (the intro-video media slot) and reels will feed the
  TikTok channel once that API approval lands.
- `qa.file_size_bytes` records the finished file's size (the ZT6732
  E2E render: 15,936,423 bytes ≈ 15.2 MB for 36.15s at 1080×1920).
  Posting encodes may need a **lighter variant later — deliberately
  NOT built now**.

## The audio rule (the lesson that cost a failed delivery)

The spike's first mix ran a loudnorm pass over the summed mix, which
raised the music bed ~14 dB and buried the voice ~10 dB under it —
while QA measured the stems and reported health. The canonical mix
(the approved `-fixed` file) is:

1. Sidechain-duck the bed against the voice (threshold 0.02, ratio 6,
   attack 20 ms, release 400 ms, makeup=1).
2. Mix ducked bed + voice stem at **native gains** (`amix
   normalize=0`). **No loudnorm, no dynamics on the sum.**
3. One uniform makeup gain so the finished file peaks ≈ −1.5 dB.

And the worker-side **QA gate measures the finished mp4's own
audio**, never the stems: every speech window (from the segment map)
must read ≥ **+6 dB** against the gain-matched ducked bed alone in
the same window, and a stem-silent gap window (≥1.2s, when one
exists) must read within **±1.5 dB** of the bed alone. Speech spans
are island-union measurements (first island start → last island
end, silencedetect −45 dB / d=0.15) — truncating at the first comma
pause under-measures real sentences and weakens the gate.

## Content rules

- **Facts only.** Script sources: the stored inventory row
  (year/make/model/colors/miles/price) + the free NHTSA vPIC decode
  (engine/drivetrain only). The stored **trim string is never used**
  (it is corrupted in the data — it has VINs mashed into it) and no
  feature is ever invented. ~55–70 spoken words; numbers are spoken
  as words ("twenty twenty six", "fifty one thousand six hundred
  eighty dollars"); the price line lands on the end card.
- **Dealership name comes from the rendering account's own
  `user_settings.dealership_name`** (the same field the app uses) —
  never hardcoded anywhere in the pipeline. When the account has no
  dealership name set, the dealer lines are omitted entirely
  (eyebrow, both voiceover mentions, end-card line). The
  "0 TO POSTED" tagline is AutoLaunch's brand and is constant.
- Voice: **Helio** (`avocado_v2:MAI_03`), via the built-in TTS CLI —
  no paid AI APIs. Voice-selection UI and a music-only variant are
  later calls, not built.

## Visuals

1080×1920, 30 fps, ~36s: up to 12 gallery photos in gallery order
(dealer banner composites are skipped by the overlay heuristic),
slow push-in 1.00→1.06 rendered per-frame in PIL (no zoompan
jitter), 0.45s crossfades, gentle unsharp, Montserrat/Inter type on
a gradient scrim, navy end card (price + car + tagline). Vendored
into this folder so it is self-contained: `fonts/` (Inter,
Montserrat TTFs) and `assets/music-bed.mp3` (the spike's intro bed,
1.8 MB).

## Running the worker

Rebuild proof mode runs on this VM:

```
python3 worker.py            # poll every 20s, render as rows arrive
python3 worker.py --once     # one pass: exit 0 = a row was processed,
                             # exit 3 = queue empty (cron-friendly)
```

Credentials: the worker/generator fetch the project ref + service
key at runtime through the same Management-API surrogate the
scraper uses (`custom.supabase` helper internals + `auth_admin.py`'s
pattern); the key lives in memory only — never printed, never
written to disk. RLS does not gate the worker (service role); the
app's own inserts/selects are owner-scoped by RLS.

**Production path (not built):** a scheduled runner (GitHub Actions
cron or a small always-on host) invoking `worker.py --once` — the
VM loop is the rebuild's proof mode. A `generating` row older than
45 minutes is logged as likely stale (a crashed run); there is no
automatic requeue yet.

## Phase 2 lifecycle (BUILT 2026-11-05 — helper 2.85, rebuild test build)

The Automation-tab toggle **"Make a video before posting"**
(`user_settings.vin_reel_before_post`, default OFF) drives the
lifecycle the schema was pre-built for:

- **Hold.** With the toggle ON, `_auto_post_filtered` queues
  the car's marketplace row with `awaiting_reel=true` +
  `reel_requested_at`, and `_queue_reel_jobs` inserts a
  `source='poster'` reel row unless a live (queued /
  generating / ready) reel already exists for the VIN.
  Manual queue rows are never held, and other channels' rows
  are never held. Toggle OFF is byte-identical behavior.
- **Release.** The worker's `reconcile_holds()` runs on every
  poll and keys off the LATEST reel for (user, vin): `ready`
  releases the hold; `failed`/`consumed` releases it with
  `reel_failed=true`; a hold older than **60 minutes** with
  no ready reel releases flagged whatever the reel state —
  a dead worker can never starve posts. Only rows still
  `awaiting_reel=true` are patched, so a reel that finishes
  after its hold released changes nothing (no resurrection).
  The app's health bar counts the day's flagged posts in a
  "posted without video" chip that filters to those cars.
- **Attach.** Helper 2.85's claim fetch excludes
  `awaiting_reel=true` rows. At claim time a post looks up
  the car's latest reel: a **ready** reel rides the job's
  `introVideo` slot *instead of* the intro video (the reel
  carries the dealership branding) through the unchanged
  content-side attach path. No ready reel → the post runs
  exactly as before; the claim never waits on a video.
- **Consume.** After the post succeeds (direct finish or a
  replayed stashed finish), a `source='poster'` reel the job
  attached is consumed: storage object `<user_id>/<vin>.mp4`
  deleted, row `status='consumed'` + `consumed_at`. A ready
  `source='manual'` reel attaches but is **never** consumed.
  Consumption is fail-open — it runs after the post is
  confirmed and can never fail it.
- **Provenance/cleanup law** (unchanged from the design):
  cleanup may only ever touch `source='poster'` rows, and
  only the row the poster itself consumed.

**Production note:** the worker is still VM-run in rebuild
proof mode. Production needs the scheduled/always-on runner
named under "Running the worker" — until then the 60-minute
stale sweep only fires while a worker is actually polling,
so with the toggle on and no worker running, held posts wait
for the sweep's next poll rather than posting on time.

## Cost

~5 minutes of CPU per car on this VM (the per-frame PIL push-in
dominates; ~2:50 without the sharpen pass). Renders are one-at-a-time
by design.
