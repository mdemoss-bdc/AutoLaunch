# Extension — Phases 2 + 3 (test copy)

Owner: Matthew DeMoss — Private / confidential. Do not share.
Location: luna-rebuild/extension/ (rewritten copy of the repo's extension/).
The repo-root extension/ is untouched.

## What was broken (recap)

1. Handshake mismatch: the app sends window.postMessage
   ({type:"AUTOLAUNCH_EXT_LOGIN"}) into the page; the extension waited for
   chrome.runtime.onMessageExternal ({type:"SET_USER_ID"}) — a message a
   web page cannot even address to an extension — and the manifest had no
   content script on the AutoLaunch origin and no externally_connectable.
   Result: the extension never learned the user id; checkQueue always
   exited early. Nothing ever posted.
2. setInterval in an MV3 service worker: workers are killed when idle,
   so the 20s poll died silently.
3. Status mismatch: content.js wrote queue status "completed"; the UI
   knows pending / processing / posted.
4. Dishonest success: content.js waited a fixed 2s and marked the car
   posted regardless of what Facebook did, and set form values with plain
   .value, which React controlled inputs ignore.

## What changed

### manifest.json (v2.1.3)
- Added "alarms" permission.
- Added content script bridge.js on https://mdemoss-bdc.github.io/AutoLaunch/*
- Added externally_connectable for https://mdemoss-bdc.github.io/*
- host_permissions now include the AutoLaunch origin.
- Added host_permission "https://*/*" (photo relay, below): dealer photo
  CDNs live on whatever host each store's site uses, and the background
  worker needs host access to fetch their photos around CORS. The
  worker only fetches a URL when the Facebook content script asks for
  one photo, and only http(s) URLs at that.
- Added "debugger" permission (filler v3, rung 3 below): lets the
  background worker drive trusted CDP input on the Facebook tab when
  Facebook's four structured fields refuse every DOM technique. While
  attached, Chrome shows a "…is debugging this browser" infobar on the
  tab — it disappears when the worker detaches, which happens when the
  fill sequence ends or the job finishes/fails. It only ever appears
  during a posting run, never while idle.
- Version 2.1.2 (filler v3.2): the field-location fix below. No
  permission changes — the "debugger" note above still applies.
- Version 2.1.3 (filler v3.3): the step-2 colors + clean-title fix
  below (COLOR NORMALIZATION + STEP-2 VERIFY). No permission changes.
- Version 2.1.4: Full Auto posting via the user's setting, the real
  delete flow, and the preview-panel exclusion (see the v2.1.4
  section below). One manifest change: content.js is ALSO injected
  on https://www.facebook.com/marketplace/you/selling* (and
  you/dashboard*) so the delete routine can run where the listings
  live; in-script URL guards route post jobs to the create pages
  and delete jobs to the selling pages, so neither routine can fire
  on the other's page. No permission changes.

## v2.1.4 — Full Auto, real deletes, preview exclusion

DDL applied to the live database first (additive only; recorded in
supabase/migrations_draft/full_auto_APPLIED_2026-10-22.sql):
`user_settings.full_auto_enabled boolean DEFAULT false`;
`auto_posting_queue.action text DEFAULT 'post'`;
`auto_posting_queue.price integer` (mirrors scraped_inventory.price).
Schema cache reloaded (`notify pgrst, 'reload schema'`).

### FULL AUTO POSTING (Matthew asked for it directly)
- App: Settings → Automation gains a "Full Auto posting" toggle
  with honest helper text ("On: the helper clicks Next and Publish
  for you. Off: it fills everything and waits for your click."). It
  writes `user_settings.full_auto_enabled` immediately (the
  channel-switch pattern), is restored by loadUserStoreSettings,
  and is also included in the modal's main saveAllSettings upsert.
- Worker: user_settings is fetched once per claim cycle
  (daily_post_limit + full_auto_enabled together); the flag rides
  the job payload as `current_posting_job.fullAuto`.
- Content: confirm mode stays the default. When `job.fullAuto` is
  true, after the verify gate passes the filler clicks through any
  remaining Next steps itself (human-paced), clicks Publish with
  the realistic sequence, and retries ONCE with a trusted CDP click
  if the button is still there with no success state after a short
  watch. It reports POSTED only on the SAME detected success
  confirm mode demands (listing URL / "your listing is now live"
  text). Publish unreachable → honest failure
  `publish_button_not_found`; clicked but never confirmed → the
  existing 2-minute failure. Posted is never marked on a timer or
  a click alone.

### REAL DELETE FLOW ("Remove from Facebook")
- Why: the app button was local-only — it flipped the car's status
  in AutoLaunch and alerted "✓ Successfully removed … from
  Facebook!" while the live listing stayed up. Matthew caught it
  live (the Tucson remained Active on his Seller dashboard). That
  alert and the misleading confirm copy are gone.
- Posted state derivation (checked before building): the app
  derives "Posted" solely from `scraped_inventory.marketplace_posted_at`
  (`isPosted = !!car.marketplace_posted_at`). The delete completion
  therefore clears exactly that column — the car returns to
  unposted because Facebook actually dropped the listing.
- App: the button now (a) confirms with honest copy (the helper
  will open Facebook and delete the listing; can take a minute;
  the car stays marked Posted until the helper confirms it's
  gone); (b) inserts a queue row {user_id, vin,
  target_channel:'facebook', action:'delete', status:'pending',
  year/make/model/stock_num, price}; (c) shows a truthful
  "Removal queued" state (rose chip in both inventory renderers +
  the button disabled) while a delete for that VIN is
  pending/processing — marketplace_posted_at is NOT touched at
  click time; (d) never claims success at click time. The Post
  Queue shows delete jobs with an "Action: Delete listing from
  Facebook" line and their real status (completed renders as
  "🟢 Removed"); the no-photo block explicitly exempts deletes.
- Contract — producer-agnostic on purpose: ANY pending
  action='delete' row carrying vin + year/make/model/stock_num +
  price is executable. The Remove button creates them today; an
  inventory-lifecycle auto-removal rule (when a car leaves
  inventory its listing should auto-delete — approved follow-on)
  will create them tomorrow, typically AFTER the inventory row is
  gone. That is why price is stamped on the queue row: the
  worker's payload falls back to the row's own context, and the
  strict matcher stays executable without scraped_inventory.
- Worker: the claim query now takes target_channel IN
  ('marketplace','facebook'), oldest first (limit 5). Deletes are
  claimed under the same conditional-claim + session-token rules,
  but the daily limit gates POSTS ONLY (a removal is not a post —
  being at the cap must never strand a listing the user asked to
  take down), and the no-photo rule does not apply. The job payload
  is routed distinctly (action:'delete', car = inventory row, or
  the queue row's stamped context when the inventory row is gone;
  a stamped price also fills an inventory row whose price is
  null). The tab opened is marketplace/you/selling.
- Content (selling page): login/checkpoint = honest failure,
  nothing touched. The listing card is the SMALLEST visible
  element whose text STRICTLY matches — year/make/model AND a
  dollar amount exactly equal to the car's price
  (listingTextMatches). Zero matches → fail `listing_not_found`;
  more than one → fail `listing_ambiguous`; either way NOTHING is
  deleted. On a unique match: open the card's ⋯ menu (the search
  climbs ancestors only while the level still contains exactly
  ONE matching listing, so a neighbour's menu can't open), click
  "Delete listing" (menu containers searched before the document),
  click the confirmation dialog's exact "Delete" button, then
  VERIFY — the card must be gone after a settle/poll window —
  before reporting AUTOLAUNCH_JOB_DELETED. Clicked but still
  present → `delete_not_verified`. Human pacing between clicks;
  step notes (delete_match_scan / listing_deleted) ride the same
  diagnostic channels, and the worker compacts them into
  error_message for delete failures too.
- Worker finish: `finishJobDeleted` patches the queue row to
  status **'completed'** with `executed_at` set (the queue table
  has NO check constraint on status — verified against the live
  schema — and the app's queue view renders the value), and clears
  the car's `marketplace_posted_at`. A token dying mid-finish
  stashes outcome 'deleted' and replays it on the next fresh
  token, exactly like posted/failed.
- Statuses after 2.1.4: post jobs pending → processing →
  posted/failed (unchanged); delete jobs pending → processing →
  completed/failed.

### PREVIEW-PANEL EXCLUSION (from the 2.1.3 live repost)
- Live evidence: the repost filled EVERYTHING correctly (both
  colors color_set on the real step-2 comboboxes) and then FAILED
  on the final audience step — the per-step scan matched
  Facebook's PREVIEW pane (its description prose contains
  "Price: $11,327" and "Exterior color: Beige"; the nearest
  clickable was the description's "See less" expander) and laddered
  a phantom Price against it, reading back "See less". Matthew
  clicked Publish himself on a perfect form.
- Fix: field location + verification consider the FORM REGION
  only. `isInPreview(el)` walks ancestors and rejects a candidate
  whose chain passes through the preview pane (leading text
  "Preview", aria-label "preview", or a direct "Preview" heading
  child — deliberately shallow checks, so the page root, which
  contains everything, is never flagged). Applied in findAnyField
  (all three strategies), fillSelectOrListbox's select scan,
  color option collection, the clean-title locators, the
  description locator, and the form-map snapshot. A generic
  clickable whose whole text is a UI chrome word ("See less",
  "See more", "Learn more", "Show more/less", "Read more",
  "See all") is never a field candidate at all (inputs/selects
  exempt by tag).
- The audience step has NO required vehicle fields: with preview
  candidates excluded, required-spec construction finds nothing
  there, fields verified on earlier steps stay verified, and the
  step simply completes into confirm/full-auto.
- Region bleed, second form (caught by the v2.1.4 harness): the
  nearby-text fallback climbs ancestors and appends their text —
  through a SHARED ancestor (page layout) that text includes the
  preview's prose, which "located" even the audience step's real
  Publish button as Price. nearbyText now stops climbing at the
  first ancestor whose subtree CONTAINS the preview pane.
- Verification (node, DOM-stub harness, 42 checks; v3.2 harness
  40/40 and v2.1.3 harness 50/50 still pass): pure strict-match
  cases; a three-step FB-variant flow WITH the preview pane
  present on every step — Full Auto walks steps 1→2→audience,
  sets both colors + clean title on the real form, never touches
  "See less", clicks Publish itself and posts on detected
  success; confirm mode on the same form never touches Publish
  (a simulated human click posts it, exactly once); Publish
  absent → publish_button_not_found with zero phantom attempts;
  delete scenarios (unique match deletes + verifies + the other
  listing untouched; price mismatch → listing_not_found with no
  menu ever opened; duplicates → listing_ambiguous); and a worker
  simulation (delete claimed at the daily post limit with the
  payload falling back to the queue row's stamped price; post at
  the limit not claimed; fullAuto=true riding a post claim;
  AUTOLAUNCH_JOB_DELETED → status 'completed' + executed_at +
  marketplace_posted_at cleared). It has NOT yet had a live
  Facebook run.

### bridge.js (NEW)
- Runs only on the AutoLaunch origin. Listens for the app's
  AUTOLAUNCH_EXT_LOGIN window message (same-window, same-origin only) and
  forwards the userId — and now the session accessToken too — to the
  background worker. The app side speaks first; the bridge meets it where
  it already speaks.

### background.js (rewritten)
- User id arrives via the bridge (onMessage); the legacy onMessageExternal
  SET_USER_ID path is kept as a secondary route.
- SESSION TOKEN (fixes the "queue sits pending forever" bug): the queue,
  settings and inventory tables are RLS-locked to the `authenticated`
  role with auth.uid() owner policies, so the worker's original
  anon-key-only calls could see and claim NOTHING. Flow now: the app
  includes its current Supabase access_token in AUTOLAUNCH_EXT_LOGIN
  (postExtLogin in index.html; re-posted on every TOKEN_REFRESHED /
  SIGNED_IN auth event), the bridge forwards it, and the worker stores
  it in chrome.storage.local and sends `Authorization: Bearer <token>`
  (alongside the publishable `apikey`) on EVERY Supabase REST call —
  queue select/claim, inventory select/update, settings select and the
  daily-limit count all go through sbGet/sbPatch, which build the header
  from storage each time. The token is never logged and never written
  into failure records.
- Expiry behavior: a 401/403 from any call records
  autolaunch_last_error = "session_expired — reopen the AutoLaunch tab"
  and stops claiming (the 1-minute alarm becomes a no-op) until a NEW
  token arrives through the bridge — the dead token is never retried.
  With no token stored yet, cycles skip quietly with a one-time
  "waiting_for_login" note. If a token dies mid-job and the content
  script's posted/failed report can't be written, the finish is stashed
  (autolaunch_pending_finish) and replayed when the fresh token arrives,
  so a confirmed listing is never lost and the row never wedges in
  "processing".
- Polling via chrome.alarms (1 minute) created on install/startup, plus an
  immediate check on install/startup and whenever a user id arrives.
- One status vocabulary with the UI: pending -> processing -> posted/failed.
- Claiming is conditional (PATCH only while status=pending, using
  return=representation) so duplicate claims cannot happen.
- Daily limit enforced in the worker too: counts today's
  marketplace_posted_at on scraped_inventory vs user_settings.daily_post_limit
  before claiming anything (999 = unlimited, matching the app convention).
- One job at a time; human-paced tab opening (1.5–4s jitter).
- The worker NEVER marks posted. Only the content script's confirmed
  success can (via AUTOLAUNCH_JOB_POSTED). Failures are recorded
  (status=failed) with a reason kept in chrome.storage
  (autolaunch_last_error / autolaunch_failure_log). Since v3.1 a
  fields_unfilled failure ALSO writes its per-field diagnostics into
  the queue row's error_message column (see DIAG-TO-DB below).
- Queue rows whose inventory row has vanished are marked failed instead
  of pending forever.
- PHOTO RELAY (fixes the first live test's only failure): the content
  script's direct fetch of dealer photo URLs was CORS-blocked from the
  facebook.com page — dealer photo servers send no
  Access-Control-Allow-Origin (verified for mosescars.com; the same
  wall the web app's photo-proxy Edge Function was built for). The
  content script now sends {type:"AUTOLAUNCH_FETCH_PHOTO", url} here;
  the worker's fetches are extension fetches (host-permitted, not
  page-CORS-bound). Replies are structured: {ok:true, base64,
  contentType} (chunked base64; ~15MB cap; non-200, non-image and empty
  bodies are structured errors), and the handler only serves senders on
  facebook.com. A failed relay falls through to the photo-proxy in the
  content script; only if both fail does the job fail, as before.
- CDP TRUSTED INPUT (filler v3): {type:"AUTOLAUNCH_CDP", action} from the
  Facebook content script drives chrome.debugger on the sender's own
  tab. Actions: attach (protocol "1.3"), click {x, y} (mousePressed +
  mouseReleased at content-supplied element-center coordinates),
  insertText {text}, key {key, code, text?, modifiers?} (keyDown +
  keyUp), detach. Every reply is structured ({ok:true} /
  {ok:false, error}) — an attach failure (another debugger is attached,
  e.g. the user's own DevTools on that tab) comes back as
  cdp_attach_failed with the browser's reason instead of throwing, and
  the content script's verify-or-report decides what happens next.
  Sessions are tracked per tab and cleaned up on chrome.debugger
  onDetach / tab close.
- FIELD DIAGNOSTICS (filler v3): {type:"AUTOLAUNCH_FIELD_DIAG", queueId,
  diag} from the Facebook content script is written into
  autolaunch_failure_log as reason "field_diag:<Field>" with the
  element snapshot (tag/type/role/aria-label/outerHTML head), the rungs
  attempted, the value read back, and any CDP attach error — so a field
  that defeats every fill technique leaves evidence, not a mystery.
- DIAG-TO-DB (v3.1 — the run-4 evidence fix): the storage path above
  failed live (run 4's log held only the two bare job entries), so the
  diagnostics now ALSO ride the AUTOLAUNCH_JOB_FAILED message itself.
  For a fields_unfilled failure the worker compacts them — per field:
  tag, type, role, ariaLabel, outerHTML (≤160 chars), rungsAttempted,
  readBack, cdpError; the whole string ≤3500 chars — into the queue
  row's error_message in the same PATCH that marks it failed. Read the
  evidence with a plain SELECT on auto_posting_queue; no console
  archaeology. If the error_message write is rejected, the row still
  ends failed (status-only PATCH); an auth failure keeps the
  stash-and-replay behavior, diagnostics included. logFailure's
  storage writes are serialized through a promise chain (concurrent
  get-modify-write cycles from the diag + failure writes landing
  together could overwrite each other). CDP attach refused with
  "Another debugger is already attached" is retried ONCE after 3s —
  the browser's exact reason is preserved in cdpError either way.

### content.js (rewritten)
- React-safe fill: native prototype value setter + input/change events.
- Fields attempted, by label/aria text with a combobox path for
  Facebook's dropdown fields: photos (first), year, make, model, price,
  mileage, condition (New / Certified / Used mapped to FB's labels),
  transmission, body style, description (includes title, price, miles,
  color, transmission, VIN).
- Photos: all known URL fields on the car (image_url, photos, images,
  image_urls, photo_urls; max 10). An upload only counts if a preview
  image actually appears. Failure = banner + job FAILED with reason.
  No more silent continue, and no posting photoless cars by accident.
- Photo BYTES arrive via a two-stage path, never a direct fetch from
  this page (CORS — see the relay note under background.js): stage 1,
  the background relay returns the photo base64 and it is rebuilt into
  a File locally; stage 2, on relay error, the photo-proxy Edge
  Function (same publishable apikey the app uses; returns CORS *).
  The DataTransfer/input.files upload and preview check after that are
  unchanged.
- Visible banner at the top of the page narrates every step.
- Login wall / checkpoint / "confirm your identity" = immediate FAILED
  with a plain-language reason. The script never types into a checkpoint.
- CONFIRM MODE (default ON): fills everything, then stops. The human
  reviews and clicks Publish; the script watches up to 10 minutes for a
  real success state. Full-auto: set autolaunch_confirm_mode=false in the
  extension's chrome.storage; then the script clicks Publish itself.
  BOTH modes now walk the form's steps with "Next" — advancing a step
  is navigation, not publishing; confirm mode stops only at Publish.
- MULTI-STEP FLOW + STEP-2 FIELDS: Facebook's vehicle form is stepped.
  Step 1 carries VIN, vehicle type, photos, year/make/model, price and
  a description; step 2 ("Vehicle appearance and features" / "Vehicle
  details") carries body style, exterior/interior color, clean-title
  checkbox, condition, fuel, transmission — and a SECOND description
  box that starts EMPTY even though step 1's was filled. The filler is
  presence-guarded per step and fills whichever fields the current step
  shows, re-filling the description wherever it appears.
- THE VIN TRAP: the VIN is filled FIRST, then the filler waits ~3s for
  Facebook's VIN decoder auto-populate to settle, then overwrites
  year/make/model (and everything else) with payload values. (Observed
  live: the decoder rewrote a 2016 Hyundai Tucson as a 2020 Honda
  Accord.) The final read-back compares DOM values against the payload,
  so a decoder lie that survives refills fails the job honestly.
- VERIFY-OR-REPORT: after filling, every REQUIRED field — Photos ≥1,
  Year, Make, Model, Price, Description (at the final step) — is read
  back from the DOM and compared to the payload (year by digits, price
  by parsed amount, text by containment). A mismatch gets ONE re-fill
  and a re-verify; the whole verification runs AGAIN as the last step
  before confirm-watch, so a mid-fill React re-render that wiped a
  field is caught and repaired. Only when everything verifies may the
  banner say "Everything is filled in". Otherwise the banner names the
  fields ("Stopped — could not fill: Price, Model.") and the job fails
  with reason fields_unfilled:<comma-list>. Step-2 extras (body style,
  colors, condition, fuel, clean title) are best-effort and never
  job-fatal. Clean title is checked only when the user's
  include_clean_title preference (if it ever reaches the job payload)
  or the payload itself says the title is clean; otherwise untouched.
- PHOTOS UP TO 12, SINGLE-SHOT (v3.1): the filler uploads up to 12
  photos (payload `photos` array first-class). Run 4 exposed a
  multiplication bug in the old one-at-a-time flow: Facebook MERGES
  every input.files assignment into its uploader's internal list, so
  assigning a growing DataTransfer per photo re-added earlier photos
  on every pass (1+2+…+12 ≈ 70 attachments). URLs are now deduped by
  normalized key — the width parameter is ignored, so the same image
  at width=500 (image_url) and width=1600 (photos[]) counts once and
  the widest variant is kept — all bytes are fetched first (a URL that
  fails both fetch stages is skipped, not fatal), and the finished set
  is assigned to input.files EXACTLY ONCE. The preview-tile count
  (distinct blob srcs) is verified afterwards: ≥1 real preview remains
  required; more previews than were sent (merge leftovers) is a banner
  warning, not a failure; past Facebook's 20-photo ceiling the filler
  clicks the tiles' remove buttons to trim, or fails honestly with
  photo_overflow.
- ESCALATION LADDER (filler v3 — the third live test's fix): Year, Make,
  Model and Price are Facebook's stubborn fields — on the current form
  variant they render as plain inputs / a chevron dropdown, yet values
  set by DOM techniques don't stick; Facebook commits them only through
  its suggestion-listbox selection / trusted input pipeline (and the
  price input validates per keystroke). Those four fields' refill is
  now an escalation ladder, with a read-back check after every rung —
  a rung only "worked" when the DOM value matches the payload, and the
  verify-or-report gate remains the final arbiter:
  Rung 1: the v2 native-setter / cascade combobox logic, unchanged.
  Rung 2: synthetic keyboard — focus, select-all + Delete dispatched as
  keyboard events, document.execCommand('insertText') (a real edit in
  Chrome), then a per-character keydown/keypress/beforeinput/input/
  keyup flurry committing each character via the native setter; if a
  suggestion listbox is open, the exact-match option is clicked with a
  full pointer/mouse sequence (that click is the commit). Listbox-
  trigger fields (non-input dropdowns) are opened and their exact
  option clicked; native selects get a type-ahead key flurry.
  Rung 3: CDP trusted input via the background worker — real mouse
  click at the element's center (focus), select-all + Backspace,
  Input.insertText, then the exact-match suggestion option clicked
  with trusted mouse input (keyboard ArrowDown/Enter fallback for
  comboboxes); native selects get trusted digit keys + Enter. Chrome
  shows a "…is debugging this browser" infobar while attached; the
  worker detaches when the fill sequence ends or the job
  finishes/fails, and the infobar goes with it. If attach fails, the
  error is recorded and read-back still governs the outcome.
  Cooperative forms never leave rung 1 — no CDP, no infobar.
- FIELD DIAGNOSTICS (filler v3, hardened v3.1): when a stubborn field
  exhausts the ladder, the filler records — once per field per job —
  its tag, type, role, aria-label and the first 200 chars of its
  outerHTML, the rungs attempted, the value read back and any CDP
  error. Three records are kept: ONE JSON line on the page console
  ("[AutoLaunch] field_diag {...}"), the AUTOLAUNCH_FIELD_DIAG message
  into autolaunch_failure_log, and — the reliable channel since v3.1 —
  the record rides the AUTOLAUNCH_JOB_FAILED message so the worker can
  write it into the queue row's error_message (see DIAG-TO-DB under
  background.js). Run 4 proved the storage-only path could silently
  lose them; the database copy cannot.
- FIELD LOCATION (filler v3.2 — the run-5 root cause): fieldLabel()
  only ever read an element's OWN attributes (aria-label, placeholder,
  label[for]). Facebook's current variant carries the Year / Make /
  Model / Price labels as SIBLING TEXT inside a container div — the
  controls themselves are bare — so findAnyField returned null for
  exactly those four fields across all five live runs: fieldPresent
  was false, the fillers skipped them, the required-spec excluded
  them, the ladder and its diagnostics never ran, and the aggregation
  failed them honestly with an EMPTY jobDiags (which is why run 5's
  error_message stayed NULL under a working diag-to-DB — there was
  nothing to carry). Location now tries, IN ORDER: (a) the element's
  own label — the v2 behaviour, so fields that located before resolve
  to the same elements; (b) CONTAINER label text among VISIBLE
  candidates — an ancestor's (≤5 levels) leading text segment or
  label-ish child (first element child with no form control in its
  subtree and 1–40 chars of text), matched exactly or as a
  word-boundary prefix; (c) the wider nearby-text context, last
  resort. Clickable divs ([role="button"], [aria-haspopup]) are
  candidates too — this variant's Year control is a chevron div, and
  the existing open → click-option machinery (rung 1 select/listbox,
  rungs 2/3) operates on whatever element location returns. The pure
  helpers (subtreeHasFormControl / labelishChildText /
  containerLeadingText / containerLabel / labelTextMatches) live in a
  [PURE-LOCATE] block and are unit-exercised like the others.
- NEVER-EMPTY DIAGNOSTICS (filler v3.2): at the final aggregation,
  EVERY failed required field now leaves a record. Ladder-exhausted
  fields keep theirs; a located-but-never-laddered field (e.g.
  Description) gets one with its real element; a field that was
  NEVER LOCATED gets a synthesized record — element null,
  rungsAttempted [], note "field_not_located" — plus ONE "__form_map__"
  record per job: the first 12 visible controls on the failing step
  with tag/type/role/aria-label and the container label computed for
  each, so the next Facebook label change is legible from the
  database row of the FIRST failed run. The worker's compactDiagError
  preserves `note` and `formMap` and its cap rises to 6000 chars,
  shedding formMap entries (halve, then drop) before outerHTML /
  readBack, so the field records always survive.
- COLOR NORMALIZATION + STEP-2 VERIFY (filler v3.3 / v2.1.3 — from
  the FIRST SUCCESSFUL live run): the Tucson posted, but Matthew had
  to pick the colors by hand ("i had to pick colors") and the
  clean-title box stayed unchecked. The old step-2 code explains all
  three misses: the color fillers got the RAW dealer string ("Mojave
  Sand") as their only candidate and matched it literally against
  Facebook's fixed option list; the listbox path used a bare .click()
  and a fixed wait; the combobox fallback only locates <input>s (the
  color control is a div); and the result was discarded unread — no
  read-back, no retry, no record. Colors now have a dedicated path:
  (1) the dealer string is ranked against the options ACTUALLY
  offered at runtime by a synonym table (sand/tan/khaki/mojave/
  desert -> Beige then Tan; charcoal/graphite/granite -> Gray then
  Silver; silver family -> Silver then Gray; crimson/burgundy/ruby
  -> Red; hue words beat finish words, so "Pearl White" -> White;
  the metallic/pearl -> Gray/Silver fallback fires only when no hue
  was named at all — a named-but-unoffered hue ranks nothing rather
  than a wrong color); (2) the dropdown opens with the realistic
  click (trusted CDP click as fallback — and cdpClickEl now attaches
  the debugger session itself, since the worker refuses clicks on
  unattached tabs, a gap the harness caught), options are collected
  document-wide (they render in a portal outside the field's
  container), and the chosen option is scrolled into view and
  clicked; (3) the pick is READ BACK from the trigger, and a miss
  retries once with the next-best candidate. Clean title: the
  locator now also accepts the labelled clickable row (this
  variant's control is a custom div, not an input), clicks with the
  same machinery, and verifies aria-checked/checked afterwards —
  with a hard rule that an unreadable state earns exactly ONE click,
  never a blind second toggle. Step-2 fields remain best-effort and
  can never fail a job — but every outcome is now recorded as a
  non-fatal STEP NOTE on the diagnostic channel (field ExteriorColor
  / InteriorColor / CleanTitle, a note code — color_set,
  color_no_option_match, color_readback_mismatch,
  clean_title_checked, ... — the requested/chosen values in
  `detail`, and the read-back). The worker's compactDiagError
  preserves `detail` (shed with readBack under cap pressure) and the
  FIELD_DIAG handler stores note + detail in the failure log, so a
  step-2 miss is visible in the database / log instead of silent.
  Verification (node, DOM-stub harness, 50 checks; the v3.2 harness
  also still passes 40/40): the pure ranking (Mojave Sand -> Beige,
  Granite Crystal Metallic -> Gray, Pearl White -> White, Titanium
  Silver -> Silver — no "tan"-in-"titanium" trap, Desert Tan ->
  Beige over verbatim Tan, Passion Purple Pearl -> nothing when
  purple isn't offered, no wrong Gray); a two-step FB-variant flow
  with portal-rendered color options — Mojave Sand -> Beige chosen
  and read back, interior Beige chosen, clean-title div checked,
  all three notes riding the job payload; the unmatchable color
  degrading to a note with the fill continuing; synthetic-proof
  controls driven entirely by the CDP fallback (notes record the
  CDP path); and the native-<select> + real-checkbox variant.
  It has NOT yet had a live Facebook run.
- POSTED only on detected success: navigation to a marketplace item /
  selling URL, or on-page text like "your listing is now live". Timeout
  or anything else = FAILED with the reason. There is no timer that
  declares success.

## v2.1.5 — structural field gating (the ghost's third mask)

The 2.1.4 Full Auto live run (queue row cab322f1, 2026-10-22
~18:41 EDT) filled everything correctly — both colors color_set
again — reached the final audience step, and FAILED on the preview
panel AGAIN, in a new mask. The diag records, verbatim: an
ExteriorColor attempt against a div[role=button] with aria-label
"View listing location" (note color_options_never_opened,
readBack ""), and Price laddered through all three rungs against
THE SAME element, expected "11327", readBack "". That element is
the preview card's location-map button. Full Auto never reached
its Publish click; Matthew published by hand on a perfect form.

**The live structure lesson:** the "Preview" heading on the real
page is a small label rendered ABOVE the preview card — a SIBLING
of the card, not an ancestor of the card's contents — and the card
is nested deep enough that the 8-level ancestor climb in
isInPreview never reaches any "Preview"-labelled container (the
card's own leading text is the car title). The 2.1.4 harness had
modelled the pane as a text-labelled ancestor container, so it
passed while live failed. nearbyText then aggregated the card's
prose (it contains "Exterior color: Beige" and the description's
"Price: $11,327") and landed on the map button as the "clickable
candidate"; the UI-chrome guard checked only the element's OWN
text ("See less") — the map button's own text is EMPTY, so the
guard waved it through. Text heuristics are therefore DEMOTED to
backstops. The primary defenses are now structural, all in the
field-location layer of content.js (header note 16):

1. **Real-control gating (the deterministic kill).** A step's
   required/best-effort spec — and ALL field location (fillers,
   ladder rungs, diagnostic snapshots draw through the single
   findAnyField choke point) — only exists when the step contains
   at least one REAL form control in the form region: a text-like
   input (not checkbox/radio/file/hidden), a textarea, a native
   select, a [role="combobox"]/[role="textbox"], a listbox
   dropdown trigger ([aria-haspopup="listbox"] — a value-carrying
   control, unlike a plain button), or a [contenteditable]. The
   audience step's left column is group checkboxes + Previous /
   Publish buttons: zero real controls, so its spec is EMPTY BY
   CONSTRUCTION, no field location runs at all, the step completes
   cleanly, and Full Auto clicks Publish. Clickable divs are
   eligible as select-like fields ONLY on steps where real
   controls exist.
2. **Media/chrome exclusion.** An element is never a field when
   its aria-label starts with "View " (View listing location,
   View photo, …), when its own text OR aria-label is a known
   chrome phrase (See more / See less / Learn more / …), or when
   its subtree contains media — an <img> or <canvas> at any size,
   or an <svg> with a declared size ≥48px (maps and photos; a
   16px chevron icon inside a real dropdown trigger declares 16
   and stays eligible). Applied in findField/findAnyField, the
   color locators, the clean-title locator, the description
   locator, option pickers and the form map.
3. **Preview identification by structure.** Once per step, the
   pane is tagged by what it IS: the card is the smallest
   ancestor of the "Seller information" block whose subtree also
   carries the car's static formatted price ("$11,327") AND a
   photo <img> (degraded anchor: the first photo-holding
   ancestor). Candidates inside a tagged card are excluded
   everywhere, and the nearby-text climb stops at any ancestor
   that contains a tagged card. 2.1.4's label-based isInPreview
   checks remain as backstops.
4. **Fallback discipline.** The nearbyText strategy can never
   select an element inside a tagged preview subtree, nor a
   div[role=button] whose subtree contains media. If the
   own-label and container strategies find nothing and the
   fallback only finds excluded elements, the outcome is an
   honest field_not_located — chrome elements are never laddered.

Untouched, per the run's evidence: color normalization + verify,
clean title, verify-gate semantics for real fields, the photo
flow, Full Auto publish logic, the delete flow, confirm mode.
Verification (node, DOM-stub harnesses): a NEW v35 harness whose
audience step reproduces the LIVE structure (sibling "Preview"
heading, card nested six wrappers deep, map button with empty
text + map <img> + "View listing location" aria-label, "Seller
information" block, group-checkbox left column with zero real
controls) — 22/22: Full Auto walks the real form (Year/Make/
Model/Price set, both colors color_set, clean title checked),
never clicks the map button or "See more", records no Price diag
and no color_options_never_opened, clicks Publish itself and
posts on detection; confirm mode reaches the verified state and
the human's single click publishes; Full Auto with no Publish
anywhere still fails honestly as publish_button_not_found.
Fidelity check: the SAME harness run against the 2.1.4 build
reproduces the live failure exactly (fields_unfilled:Price, the
map button clicked, a diag naming "View listing location").
Regressions: v2.1.4 harness 42/42, v2.1.3 harness 50/50, v3.2
harness 40/40 — 154 checks total, node --check clean. (One
harness-driven refinement during the build: a step whose only
controls are listbox dropdown triggers — the v2.1.3 stub's step
2 — must still count as a form step, so [aria-haspopup="listbox"]
is a real control; plain [role="button"] is not.)

## v2.1.6 — the VIN help-modal swatter (a papercut, closed)

The 2.1.5 live run filled cleanly — no ghost — but one papercut
remained: Facebook's "Finding your vehicle's VIN" informational
modal (heading, a paragraph about dashboards and door jambs, a
blue Close button and an X) kept popping up over the form around
the VIN step, and Matthew had to keep clicking Close himself
(his photo of the modal is the spec). On an unattended Full Auto
run that modal would sit over the form intercepting clicks.
Two changes, both in content.js (header note 17):

1. **Stop summoning it.** The VIN fill now targets the input
   element itself, never the labelled wrapper around it — in
   this variant the wrapper carries the ⓘ help icon, and poking
   the container is what opens the modal. If location returns a
   wrapper, the fill descends to the input/textarea inside it.
   The fill otherwise behaves exactly as before (native setter,
   decoder settle wait, payload overwrites the decoder's guess).
2. **Swat it on sight.** `dismissInfoModals()` runs before each
   step's fill, immediately after the VIN fill + settle wait
   (when the modal appears), and once more before the final
   verify/Publish phase. Dismissal is by whitelist, default-deny:
   a dialog qualifies ONLY when it contains no form inputs, none
   of its buttons is a primary/destructive action (Publish /
   Delete / Confirm / Post / Submit / Save / Continue / Next /
   Send / Mark as sold / Mark as pending), AND its heading or
   opening text matches a known informational pattern (today:
   "Finding your vehicle…"). It is then closed via its "Close"
   button, falling back to the X (aria-label "Close"), and each
   dismissal is recorded as a non-fatal step note
   (info_modal_dismissed, the heading in `detail`). Unknown
   dialogs are never touched — the delete flow's confirmation
   dialog fails every gate and is left exactly alone, and the
   delete routine never calls the swatter at all.

Verification (node, DOM-stub harnesses): new v36 harness — an
FB-variant details step where focusing/filling the VIN input
raises the modal and advancing to step 2 raises it again, with
a delete-confirmation dialog and an unknown Close-button dialog
sitting in the document the whole time: 19/19 — both modal
instances dismissed (two info_modal_dismissed notes, heading in
detail), the delete-confirm dialog never clicked and still
present at the end, the unknown dialog left alone, and the run
still completes the full fill + verify and publishes itself in
Full Auto mode. Regressions: v2.1.5 harness 22/22, v2.1.4
42/42, v2.1.3 50/50, v3.2 40/40 — 173 checks total, node
--check clean. No dedicated live test is needed for this one:
it proves itself on the next post run (a run with zero
info_modal_dismissed notes where Matthew also never saw the
modal is the other good outcome — it means the input narrowing
stopped it appearing at all).

## v2.1.7 — the success detector verifies actively, deletes accept
## "already gone", and finished tabs close themselves

Built 2026-10-22 after the Full Auto live run (job c8405f83,
19:04 EDT) exposed a blind detector, and the hand-deleted Tucson
(job 3dfef826, 19:07 EDT) exposed wrong delete semantics.

**The live failure:** Full Auto filled everything and clicked
Publish itself; Facebook DID post the Tucson (live, "in review")
— but the passive success detector never saw a state it knew, so
after 2 minutes the job FAILED with "Clicked Publish but Facebook
never showed a success state within 2 minutes — NOT marked
posted. Check Marketplace drafts." Both halves were wrong: the
car was live (not in drafts), and Luna had to reconcile the queue
row + marketplace_posted_at by hand. In confirm mode the same
passive detector HAS worked live, so post-publish screens vary
by path/timing — the passive vocabulary alone can't be the only
witness.

**Fix 1 — active post-publish verification (both modes).** The
passive signals stay, but they're a hint now, not the verdict:

- Full Auto: after clicking Publish, the passive watch runs ~15s;
  if the Publish button is still on screen, one trusted-input
  retry click; then a second passive window (~45s). If nothing
  fires, instead of failing, the filler ESCALATES — it records a
  `posted_verify_escalated` step note, persists a verify flag on
  the stored job, and navigates the tab to the Selling page.
- Confirm mode: the 10-minute watch for the human's click is
  unchanged. If the watch expires and a click was evident (the
  Publish button vanished or the URL moved), it escalates the
  same way instead of failing. If the human truly never clicked,
  the original honest failure stands.
- On the Selling page the verifier runs the DELETE flow's strict
  matcher (year+make+model AND price) in a read-only scan, with
  the same lazy-load patience. Found → step note
  `posted_verified_on_selling_page` (match count included) and
  the normal posted completion path (queue posted +
  marketplace_posted_at stamped by the worker). Absent → rescan
  on a fresh page load up to 2 more times, ~30s apart, inside a
  4-minute wall-clock cap (a fresh listing can lag while "in
  review"). Still absent → honest fail, reason
  `publish_unverified`, banner: "Publish was clicked but the
  listing could not be found on your Selling page — NOT marked
  posted." The drafts advice is gone. A login wall / checkpoint
  during verification fails as `facebook_checkpoint`, as before.
  The worker now compacts `publish_unverified` diagnostics into
  error_message too, so the verify scans are the evidence on the
  row.

**Fix 2 — goal-achieved deletes.** The delete scan's zero-match
branch now asks one more question before failing: does any card
match the car's TITLE (year+make+model, price ignored), and did
the listings region actually render ("Your listings"/empty-state
markers or the listings search box)? If the page rendered, the
strict scan ran, and the car isn't there at ANY price, the goal
— no live listing — is already met: the job finishes through the
SAME completion path as a verified delete (status completed,
executed_at, marketplace_posted_at cleared) with a step note
`delete_already_gone`. That's exactly the job 3dfef826 case
(Matthew had deleted the listing by hand first; Luna had to clear
the stamp by hand). Deliberately NOT goal-achieved: a title
match at a different price (the car is still live — stays
`listing_not_found`), a page that didn't render, a login wall
(`facebook_checkpoint`), or duplicate strict matches
(`listing_ambiguous`, unchanged).

**Fix 3 — tab auto-close on success (Matthew's add, same
evening).** Jobs no longer leave a pile of finished Facebook
tabs: the worker records the id of the tab it opened for each
job, and after a SUCCESS finish — posted (passive, verified, or
confirm-mode), delete completed, or a goal-achieved delete — it
closes exactly that tab ~4 seconds later (long enough to read
the success banner). Failures never close (the tab is the
evidence), a token-stash replay doesn't close (the moment has
passed), and a tab the user already closed is a no-op.

Unchanged: field gating, color normalization, clean title, the
VIN swatter, the photo flow, delete matching strictness, the
claim/limit/session machinery.

Verification (node, DOM-stub harnesses): new v37 harness with a
multi-boot session driver (navigation + reloads reboot the
content script against fresh pages over one shared storage
store, like a real tab): 46/46 — Full Auto with a blind passive
detector rescued by the Selling-page scan (posted +
posted_verified_on_selling_page); a truly-absent car failing
publish_unverified after the initial scan + 2 rescans with the
new banner copy; confirm mode rescued after the human's click;
delete present → deleted; delete absent on a rendered page →
completed + delete_already_gone; delete on an unrendered page
and behind a login wall → honest fails; a title match at the
wrong price still failing listing_not_found; unit checks for
the title matcher; and worker checks for the tab rules (claim
records the tab id, success closes exactly that tab after the
delay, failures never close, a job without a tab id closes
nothing) plus publish_unverified diag compaction. Regressions:
v36 19/19, v35 22/22, v34 42/42, v33 50/50, v32 40/40 — 219
checks total, node --check clean.

## How to test it (Matthew)

1. In Chrome: chrome://extensions -> Developer mode ON -> Load unpacked ->
   select this folder once it is in your local clone of the repo
   (luna-rebuild/extension/).
2. Open the AutoLaunch TEST app (…/AutoLaunch/luna-rebuild/) and sign in
   (or, after reloading the extension, hard-refresh the app tab). The
   bridge hands your user id AND your Supabase session token to the
   extension automatically — the worker can't see your queue without
   the token, and it re-receives a fresh one whenever yours rotates.
   If the extension ever reports "session_expired", reopening /
   refreshing this tab is the fix.
3. Queue one car (marketplace channel). Within about a minute a Facebook
   "Create vehicle" tab opens and the filler runs with the blue banner.
4. Review the filled form. In confirm mode, click Publish yourself; the
   queue row should flip to Posted only after Facebook confirms, and the
   car gets marketplace_posted_at in the app.
5. To see failures honestly: queue a car while logged out of Facebook —
   the job should end Failed with the login reason, never Posted.
6. FULL AUTO (v2.1.4): Settings → Automation → turn "Full Auto
   posting" ON, Save. Queue a car and touch NOTHING: the helper
   should walk the steps, click Publish itself, and the queue row
   should end Posted (car shows Posted in the app). Turn the switch
   OFF and repeat: it should stop at the amber banner and wait for
   your Publish click, as before.
7. DELETE (v2.1.4): with a car Posted (from step 6 or any earlier
   run), press "Remove from Facebook" in the app and confirm. The
   car shows "Removal queued"; within about a minute a Facebook
   selling-page tab opens, the helper deletes that exact listing,
   and afterwards the listing is gone from Facebook's Your
   listings, the queue row reads Removed (completed), and the car
   is back to Not Posted in the app. If two identical cars were
   listed at the same price, it should refuse (listing_ambiguous)
   and delete nothing.
8. v2.1.5 RETEST (Full Auto, the run-7 scenario): Reload the
   extension (card must read version 2.1.5), hard-refresh the app
   tab, make sure Settings → Automation → "Full Auto posting" is
   ON, queue the Tucson, and touch NOTHING. Expected: it walks
   every step, sets the colors itself, passes the audience step
   without a glance at the preview card, clicks Publish itself,
   and the queue row ends Posted. Then run the step-7 delete test
   on that same listing.

## Live test log

- 2026-10-22, first end-to-end run: handshake, session token, queue
  claim, Facebook tab and form fill all worked. The job failed at
  exactly one step — photo upload, "photo_download_failed" — because
  the content script's direct fetch of the dealer photo was
  CORS-blocked (root cause verified, see the photo relay notes). The
  relay → photo-proxy path above is the fix; it is the one piece of
  this build that has NOT yet had a live Facebook run. Re-test: reload
  the extension at the same folder (Reload on its card; same folder =
  same extension ID), hard-refresh the app tab, re-queue the car (a
  FAILED row can be queued again).
- 2026-10-22, second run (relay build): photos attached ✓, description
  ✓, location ✓, transmission ✓ — but Year, Make, Model and Price were
  left EMPTY (preview showed placeholder "Title"/"Price", Next stayed
  disabled) while the banner falsely claimed "Everything is filled in".
  Matthew's hand-exploration of the same form then mapped the current
  multi-step variant (see Multi-step flow / VIN trap above) — including
  the VIN decoder rewriting the car as a different year/make/model. The
  verify-or-report + multi-step + VIN-safe build is the fix; it has NOT
  yet had a live Facebook run. Its pure helpers were unit-exercised in
  node against hand-built element stubs (29 checks), including a
  VIN-corruption simulation (form pre-corrupted to 2020/Honda/Accord →
  refill → read-back year equals the payload year) and the stubborn-
  failure path producing reason fields_unfilled:Year,Price. Re-test:
  overwrite the extension folder with the fresh copy at the SAME path,
  Reload on the card, hard-refresh the app tab, re-queue the car. On
  the Facebook tab expect: VIN + a short settle pause, photos, details
  filled, the filler clicking Next ITSELF to step 2 (colors / condition
  / description again), a final "this step verified ✓" banner, and
  only then the amber "Everything is filled in. Review it, then click
  Publish" banner — if anything can't be filled, the banner names it
  and the queue row goes Failed instead of lying.
- 2026-10-22, third run (verify-or-report build): the honesty layer
  worked PERFECTLY — 12+ photos attached (carousel full), description
  rich and correct ($11,327 Moses Price, Mojave Sand color, VIN), and
  the banner failed the job in plain language: "could not fill: Year,
  Make, Model, Price". Those same four structured fields resisted the
  v2 techniques (native-setter fills, cascade combobox handling): on
  this form variant Year renders as a chevron dropdown and Make/Model/
  Price as plain inputs, but Facebook commits them only through its
  suggestion-listbox selection / trusted input pipeline and resets
  DOM-set values (the currency input also validates per keystroke).
  The escalation-ladder build (this version) is the fix; it has NOT yet
  had a live Facebook run. Its pieces were unit-exercised in node:
  the rung-2 event-plan + CDP message builders (26 checks), the
  background CDP protocol against a mocked chrome.debugger —
  attach → Input commands in order → detach, attach-failure and
  foreign-sender handling, diagnostic writes landing in
  autolaunch_failure_log (28 checks), and a full content-script flow
  against React-stubborn fake fields whose setters ignore every write:
  all four fields climbed rung1 → rung2 → rung3, each left exactly one
  forensic record, CDP detached before the failure report, and the job
  failed with fields_unfilled:Year,Make,Model,Price (34 checks), plus a
  cooperative-form flow that fills at rung 1, never touches CDP and
  posts on detected success (5 checks). Re-test: overwrite the
  extension folder with the fresh copy at the SAME path (card should
  now read version 2.1.0), Reload, hard-refresh the app tab, re-queue
  the Tucson. Expect an extra sight this time: if any of the four
  fields resists the DOM rungs, Chrome shows a "…is debugging this
  browser" infobar while the trusted-input rung works — it disappears
  on its own when filling finishes. If a field still fails, its
  autolaunch_failure_log entry (field_diag:<Field>) now carries the
  element's outerHTML and the rungs attempted.
- 2026-10-22, fourth run (escalation-ladder build, v2.1.0 — card
  version verified on chrome://extensions): both attempts failed
  honestly again, fields_unfilled:Year,Make,Model,Price — the ladder
  did not crack the four fields either. Two NEW facts: (1) the
  field_diag forensics NEVER appeared in autolaunch_failure_log
  (Matthew pulled it from the worker console: exactly two bare
  {at, queueId, reason} entries, no diag extras) — the evidence
  channel itself was broken, so the failure stayed blind; (2) ~70
  photos attached — Facebook's uploader merges every input.files
  assignment, and the sequential cumulative assignment multiplied
  them (compounded by w500/w1600 dedupe misses). The v3.1 build
  (2.1.1) is the fix for both: single-shot photo assignment after
  normalized dedupe, and diagnostics riding the JOB_FAILED message
  into the queue row's error_message (plus a serialized storage log
  and a one-time 3s retry when CDP attach is refused with "Another
  debugger is already attached" — DevTools open on the Facebook tab
  is the prime suspect for rung 3 never engaging). Unit-exercised in
  node: photo dedupe (w500 vs w1600 → 1, widest kept, cap 12) and a
  single-assignment attach against a mocked file input (exactly one
  files assignment, overshoot = warning, overflow = photo_overflow or
  trimmed to 20) — 14 checks; diag compaction (≤3500 chars, outerHTML
  ≤160, cdpError carried) — within 28 pure checks; and a full worker
  simulation with mocked chrome/fetch: a fields_unfilled JOB_FAILED
  carrying four diag records produces exactly one queue PATCH whose
  error_message contains the field_diag data for all four fields
  including the cdpError string, four concurrent FIELD_DIAG writes
  all survive in the log, and the CDP attach retry waits ~3s and
  preserves the browser's exact refusal reason (20 checks). Re-test:
  overwrite the extension folder with the fresh copy at the SAME path
  (card must read version 2.1.1), Reload, hard-refresh the app tab,
  re-queue — and do NOT open DevTools/F12 on the Facebook tab while
  it runs: an attached DevTools is itself a debugger and blocks the
  trusted-input rung (that may be exactly what run 4 measured). The
  results — including the full per-field diagnostics on any failure —
  land in the database (auto_posting_queue.error_message), where Luna
  reads them directly.
- 2026-10-22, fifth run (v3.1 build, 2.1.1): photos PERFECT this time —
  exactly 12, single-shot (the v3.1 photo fix confirmed live). Still
  fields_unfilled:Year,Make,Model,Price — and the decisive clue:
  error_message stayed NULL under a WORKING diag-to-DB, meaning
  jobDiags was empty, meaning the ladder and its diagnostics never
  ran at all. Reading the shipped code found it: fieldLabel() only
  checks an element's own aria-label / placeholder / label[for], and
  this form variant carries those four labels as sibling text inside
  a container div. findAnyField returned null → fieldPresent false →
  fillers skipped them, the spec excluded them, the aggregation
  failed them. (Location / Description / Transmission always worked —
  the fields locatable by own attributes or a fallback.) The v3.2
  build (2.1.2) is the fix: container-text location (see FIELD
  LOCATION above), clickable-div candidates for the dropdown fields,
  and never-empty diagnostics (a never-located field synthesizes a
  "field_not_located" record + a one-per-job form_map of the step's
  visible controls with their computed container labels; the worker's
  compaction cap rises to 6000 and preserves both). It has NOT yet
  had a live Facebook run. Verification (node, DOM-stub harness, 40
  checks): the pure location helpers (span label, leading text node,
  nested label element, control-bearing-child decisiveness, 5-level
  climb cap, own-wrapper-beats-group, word-boundary matching); a
  full-flow run against a stub of THIS variant (container divs with
  sibling label text, bare inputs, a div-dropdown Year whose options
  appear on click) — all four fields LOCATED and filled via rung 1,
  verified, zero diagnostics (the terminal failure was only the
  photoless car's honest Photos stop); a variant with Model truly
  absent — fields_unfilled:Model,Photos plus the field_not_located
  record (null element) and a form_map carrying the computed labels
  (Location/Year/Make/Price/Description); and the old own-attribute
  variant as a regression check (same elements, clean fills).
  Re-test: overwrite the extension folder with the fresh copy at the
  SAME path (card must read version 2.1.2), Reload, hard-refresh the
  app tab, re-queue the Tucson — and do NOT open DevTools/F12 on the
  Facebook tab while it runs (an attached DevTools blocks the
  trusted-input rung). If a field still fails, its record — or its
  field_not_located record + the form_map — will be sitting in the
  queue row's error_message for Luna to read directly.

- 2026-10-22, seventh run (v2.1.4, 2.1.4 — the Full Auto test,
  queue row cab322f1): everything filled correctly AGAIN (both
  colors color_set on the real comboboxes) and the job still
  FAILED on the final audience step — on the preview AGAIN, in a
  new mask. The diag names the element precisely: a
  div[role=button] with aria-label "View listing location" — the
  preview card's location-map button. ExteriorColor was attempted
  against it (color_options_never_opened) and Price was laddered
  through all three rungs against it (expected "11327", readBack
  ""). Screenshots showed why 2.1.4's isInPreview never fired: the
  "Preview" heading is a small label ABOVE the card (a sibling,
  not an ancestor of the card's contents), too far up a deep
  ancestor chain; the card's own leading text is the car title;
  and the map button's own text is EMPTY, so the own-text chrome
  guard ("See less") missed it. Matthew published by hand on a
  perfect form; Full Auto never reached its Publish click. The
  v2.1.5 build (structural gating — see the v2.1.5 section above)
  is the fix; its harness reproduces this exact failure against
  the 2.1.4 build on a live-structure stub and passes on 2.1.5.
  It has NOT yet had a live Facebook run. Re-test: Reload (card
  must read 2.1.5), hard-refresh the app tab, Full Auto ON, queue
  the Tucson, touch nothing.

## Honest limits (untested overnight)

- Not run against live Facebook: DOM selectors/labels are best-effort
  heuristics against Facebook's current vehicle-create flow, which changes
  often. First real test may need selector tweaks — the failure reasons
  and banner will say exactly where it got stuck.
- RESOLVED (was: "Supabase calls use the publishable key without a user
  JWT"): the session-token flow described under background.js above is
  live — app → bridge → worker storage → Authorization header on every
  call, refresh re-posts from the app's auth listener, and a dead token
  stops claiming instead of silently failing against RLS. One residual
  truth: the token is the user's own short-lived Supabase session token
  (rotated roughly hourly by Supabase); it lives only in the extension's
  chrome.storage.local on the user's machine, never on a server of ours.
- Facebook may treat any automation as a policy risk. Confirm mode +
  daily caps + human pacing reduce, not eliminate, that risk.
- The "debugger" permission (rung 3) is the heaviest permission an
  extension can carry: Chrome warns about it at install, the
  debugging infobar is visible during fills, and a future Web Store
  listing would need a strong justification for it. It is engaged only
  when the two DOM rungs have demonstrably failed on a field, and the
  worker detaches as soon as filling ends. If a fourth live run shows
  rung 2 alone cracking the fields, rung 3 — and the permission — can
  be removed.
