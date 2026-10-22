> **RETIRED 2026-10-22 — background replacement removed by Matthew's decision; photos post as originals. Kept for history.**
>
> What replaced it: the photo-edits modal now previews the vehicle's real
> photo at full size ("Photo | Adjust crop | Branding" tabs), the optional
> branding frame still stamps the original, and a hard rule — a vehicle
> with no real photos is never posted — is enforced by `hasRealPhoto()` in
> the app and mirrored in the extension. Everything below describes the
> retired engine.

# AI Background Cut-Out Engine (v1)

Powers the live preview in **Settings → Automatic photo edits**: the preview
vehicle is cut out of its dealer photo and composited onto the selected
showroom background (Bright / Dark / Clean lot), entirely in the browser.

Built 2026-10-22. Status: **v1.2 — preview only** (hi-res source photos,
full-precision model, matte edge refinement — see the v1.2 section below;
v1.1 added the realism pass, branding frame, custom backgrounds). Posting
with edited photos is deliberately NOT wired yet (see "Remaining wiring"
below).

## How it works

1. **Trigger points** — `refreshCutoutPreview()` runs when:
   - the Automatic Photo Edits modal opens (`openAutoPhotoEditsModal`),
   - the vehicle cycles ("Try another vehicle" → `cyclePreviewVehicle`),
   - the background changes (`setPreviewBg`),
   - the AI background mode select changes (switching to *Disabled* shows the
     original photo instead).
2. **Lazy engine load** — the first time a cut-out is needed, the engine
   module is fetched with a dynamic `import()`. Nothing downloads at app
   startup. The library then downloads its AI model + ONNX WASM binaries
   once (tens of MB) and the browser caches them for later visits. The
   preview overlay shows progress ("Downloading AI model — n%", then
   "Removing background — n%") and tells the user the first download is
   one-time.
3. **Removal** — `@imgly/background-removal` (`removeBackground`, ISNet
   full-precision model — the library's `model: "large"`) runs on-device
   via onnxruntime-web, fed the photo's full-size original (see v1.2).
   No API keys, no server, no photo uploads — this matches AutoLaunch's
   local-first principle: the user's machine does the work.
4. **Cut-out cache** — results are kept in a `Map` keyed by photo URL
   (transparent PNG blob + dimensions + alpha bounding box). Switching
   backgrounds re-composites from the cached cut-out instantly; the removal
   runs exactly once per vehicle photo per session.
5. **Composite renderer** — a 1600×1200 (4:3) canvas: background drawn
   cover-fit, a soft elliptical ground shadow (radial gradient, no
   `ctx.filter` dependency), and the cut-out drawn from its alpha-trimmed
   bounding box, scaled to ≤94% of canvas width and bottom-aligned on the
   ground line (90% height) so the wheels sit on the "floor". Exported as
   JPEG (quality 0.9) into the preview image; caption reads
   "Live cut-out preview".
6. **Download preview** button under the preview saves the current composite
   JPEG, named after the vehicle. Enabled only when a composite exists.

Only the single preview vehicle's **first photo** is ever processed (per the
modal's default "First photo only" mode). Inventory is never batch-processed.

## CDN dependency (pinned)

| Piece | URL |
|---|---|
| Engine library | `https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/dist/index.mjs` |
| Peer runtime (import map) | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.bundle.min.mjs` |
| Peer runtime, WebGPU (import map) | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.webgpu.bundle.min.mjs` |
| Model + WASM assets | library default `publicPath`: `https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/` (fetches `resources.json`, verified live with `Access-Control-Allow-Origin: *`) |

**Why the raw `dist/index.mjs` and not jsDelivr's `+esm` build:** the `+esm`
bundle rewrites the library's `onnxruntime-web` peer import to an
origin-relative path (`/npm/onnxruntime-web@1.21.0/+esm`), which resolves
against the *page's* origin and 404s anywhere except jsDelivr itself (esm.sh
has the same shape). The raw dist keeps the bare specifier
`import("onnxruntime-web")`, which the `<script type="importmap">` in
`index.html`'s `<head>` pins to the exact peer version (1.21.0). The library
itself points onnxruntime's WASM loader at the model CDN manifest, so no
further asset wiring is needed.

Requirements/risks: import maps need a modern browser (Chrome 89+, Safari
16.4+, Firefox 108+). On anything older the engine load fails and the
fallback below applies. Runtime behavior was verified statically (URLs,
headers, manifest contents, bundle source); it has not yet been run in a
live browser session.

## CORS limitation & fallback behavior

Vehicle photos live on dealer CDNs. The engine first tries `fetch -> Blob`
with CORS; dealer hosts usually send `Access-Control-Allow-Origin` headers
(the ones AutoLaunch scrapes do), so this normally works. If the fetch is
blocked, the photo URL is handed to the library directly as a second chance.

If anything fails — photo CORS, module load, model download, or the removal
itself — the preview **never breaks**: it falls back to the vehicle's
original photo with the honest note
*"Couldn't process this photo — showing the original"*, the caption reads
"Original Photo", the Download button stays disabled, and the full error is
logged to the console with a `[PhotoEngine]` prefix. A sequence guard makes
sure a slow job for a previous vehicle/background can never overwrite a
newer preview.

## v1.1 — realism pass, branding frame, custom backgrounds (2026-10-22)

Matthew's verdict on v1 was "cheesy and fake": visible pillar bars at the
sides of the preview, a car that floated over a diffuse shadow blob, and
generated backgrounds whose lighting clashed with the car's photo. v1.1
attacks all four:

- **Full-bleed frame.** The preview frame is now exactly 4:3
  (`aspect-[4/3]`), matching the 1600×1200 canvas, and the preview image
  uses `object-fit: cover` — no letterbox/pillar bars in the modal, and the
  Download JPEG is the same full-bleed composite.
- **Defocused, graded background.** The background is drawn to an offscreen
  canvas and composited through `ctx.filter: blur(6px) brightness(1.02)
  contrast(0.98) saturate(0.96)` (guarded — browsers without `ctx.filter`
  get the sharp background). A slightly blurred backdrop hides the
  perspective mismatch between the car's original photo and the scene,
  which is the standard dealer-photo technique. The car is never blurred.
- **Tone harmonisation.** Average luminance/saturation are sampled from the
  background and from the cut-out (alpha-weighted, so the transparent
  surround doesn't count). The car layer is then drawn through a gentle,
  clamped `brightness()` (0.92–1.08) / `saturate()` (0.94–1.06) adjustment
  so a sunlit car on an overcast scene (and vice versa) sits closer in tone.
- **Two-layer ground shadow.** A wide, faint ambient-occlusion ellipse
  (alpha 0.18) plus a tight, dark contact patch (alpha 0.45, squashed to
  0.10) centred a hair above the car's bottom edge, so the tyres read as
  touching the floor. The car is scaled to ≤95% of frame width with its
  alpha-trimmed bottom on the 90% ground line.

### Branding frame (Moses-style)

A third tab in the photo-edits modal — **Branding** — stamps a dealer frame
onto every rendered photo, drawn last in the composite pipeline (and over
the original photo too when the preview falls back to it, via
`renderOriginalFramed`):

- **Top-left:** the dealer's logo (max height 11% of frame height, soft
  drop shadow). With no logo uploaded, the dealership name is drawn in
  bold white type instead.
- **Bottom strip:** a full-width band, 9% of frame height,
  `rgba(10,15,30,0.78)`, with centred white text
  "Dealership Name • Address • email" — only the non-empty parts, font
  shrunk to fit one line. The email is the signed-in account's email.
- Logo upload goes to the public Supabase Storage bucket **`branding`**
  at `<user_id>/logo.<ext>` (RLS: anyone can read; a user can only write
  inside their own folder). Settings live on `user_settings`:
  `dealer_logo_url`, `dealership_address`, `branding_frame_enabled`
  (plus the existing `dealership_name`). The address is also editable in
  Settings → Dealership. Everything restores on load, and the frame is
  included in the Download output.

### Custom backgrounds

The Showroom Backgrounds grid has a fourth tile, **Your photo**. First
click opens a file picker; the upload goes to the same `branding` bucket
at `<user_id>/background.<ext>`, the public URL is saved to
`user_settings.custom_bg_url`, and the tile becomes selectable with the
same blue ring as the built-ins (matched via a `data-bg-url` attribute).
A "Replace your photo" link re-opens the picker. Custom backgrounds flow
through the exact same defocus/grade/harmonisation pipeline as built-ins.
Restoring a saved choice (`ai_background_choice` = the custom URL) lights
up the custom tile, because the settings load restores the custom tile
before matching the selection.

## v1.2 — hi-res source, full-precision model, matte refinement (2026-10-22)

Matthew's verdict on v1.1 was still "looks like trash" — and the main
cause turned out not to be the compositing at all:

- **The engine was cutting out a thumbnail.** Inventory `image_url`s come
  from the DealerOn image service with a `width=500` parameter, so every
  photo the engine received was a 500×375 thumbnail (~50 KB), stretched
  3.2× onto the 1600×1200 canvas. A soft, low-detail car on a crisp
  generated background reads as pasted-on no matter how good the shadow,
  defocus, and harmonisation are. Verified directly: the same URL at
  `width=1600` returns the full 1600×1200 original (~372 KB), and
  `width=2048` is capped at 1600×1200 by the service.
- **Hi-res fetch (`hiResPhotoUrl` + `fetchPhotoBlob`).** Engine fetches
  now rewrite a small numeric `width`/`w` query param to 1600 and try, in
  order: hi-res direct → hi-res via photo-proxy → original direct →
  original via proxy → (in `getOrCreateCutout`) the library fetching the
  URL itself. The cut-out cache key stays the **original** photo URL —
  only the fetched bytes change. Display `<img>` tags everywhere else in
  the app keep using the fast thumbnail URL. `renderOriginalFramed` goes
  through the same `fetchPhotoBlob`, so branding-framed originals are
  full-res too.
- **Full-precision model.** v1/v1.1 used `model: "medium"`. In
  @imgly/background-removal 1.7.0 the config schema maps `large` →
  `isnet` (full precision, 176,149,806 bytes in the resources manifest),
  `medium` → `isnet_fp16` (88 MB), `small` → `isnet_quint8` (44 MB).
  Matte quality is the product, so the engine now requests `"large"`;
  the one-time download grows to ~176 MB and the guide note says so.
  The browser caches it exactly as before.
- **Matte edge refinement (`refineCutoutMatte`).** After removal, the
  alpha channel gets three deterministic passes at native resolution:
  erode ~1px (3×3 min filter) to choke the fringe the original
  background leaves around the silhouette, a levels adjustment (black
  point 12, white point 243) so leftover halo alpha goes to 0, and a
  ~1px feather (3×3 box blur) so the edge isn't crunchy. The alpha
  bounding box is computed after refinement, so placement uses the
  cleaned silhouette. Any failure falls back to the raw cut-out.

## Remaining wiring (v2 — explicitly out of scope for v1)

- **Persist composites:** upload the composite JPEG (and/or the cut-out PNG)
  to Supabase Storage at queue time and store the URL on the queue/inventory
  row, so an edit survives reloads and is shared across the user's devices.
- **Posting:** the Chrome extension's posting flow should prefer the
  composite photo (falling back to the original) when filling a Facebook
  Marketplace listing; same for the Instagram/TikTok syndication paths.
- **"All photos" mode:** v1 honors "First photo only" / "Disabled". Batch-
  processing every photo of a vehicle belongs with the queue-time wiring
  above, not in the settings modal.
- **Crop interplay:** the Adjust-crop focal point currently applies to
  original-photo previews; compositing with crops is a v2 decision.
