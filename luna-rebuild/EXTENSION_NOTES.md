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

### manifest.json (v2.1.2)
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
- POSTED only on detected success: navigation to a marketplace item /
  selling URL, or on-page text like "your listing is now live". Timeout
  or anything else = FAILED with the reason. There is no timer that
  declares success.

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
