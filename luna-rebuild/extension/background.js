// AutoLaunch Vehicle Assistant — background service worker (v2)
//
// Phase 2 changes vs the original:
//  1. HANDSHAKE: the user id now arrives from bridge.js, a content script
//     on the AutoLaunch origin that forwards the app's
//     AUTOLAUNCH_EXT_LOGIN window message. (The old code waited for
//     onMessageExternal "SET_USER_ID", which the app never sent and could
//     not send — a web page cannot message an extension it cannot name.)
//     The external listener is kept as a secondary path.
//  2. POLLING: chrome.alarms instead of setInterval. MV3 service workers
//     are killed when idle, which silently killed the 20s interval.
//  3. STATUS VOCABULARY: one vocabulary everywhere, matching the web UI —
//     pending -> processing -> posted / failed. The old code wrote
//     "completed", which the UI does not know.
//  4. CLAIMING: a queue row is claimed with a conditional PATCH
//     (status must still be pending) so two polls can never take the
//     same car twice.
//  5. DAILY LIMIT: before claiming, count today's posts from
//     scraped_inventory.marketplace_posted_at against the user's saved
//     daily_post_limit (user_settings). At the cap, nothing is claimed.
//  6. POSTED MEANS POSTED: this worker never marks a row posted. Only the
//     content script can do that, and only after it has detected a real
//     publish success on Facebook. Unconfirmed = failed, with a reason.
//  7. SESSION TOKEN: the queue / settings / inventory tables are
//     RLS-locked to the `authenticated` role with auth.uid() owner
//     policies, so the publishable key alone can see and claim NOTHING.
//     The app now sends the signed-in user's Supabase access token
//     through the bridge with the user id; the worker stores it in
//     chrome.storage.local and sends it as Authorization: Bearer on
//     every REST call. A 401/403 marks the session expired and stops
//     claiming until a NEW token arrives — no retry hammering. The
//     token is never logged and never written into any error record.
//  8. PHOTO RELAY: the content script runs on facebook.com, so its direct
//     fetch of a dealer photo URL is page-CORS-bound — and dealer photo
//     servers (mosescars.com proven) send no Access-Control-Allow-Origin,
//     so the fetch dies and the job fails with photo_download_failed.
//     Fetches from this worker are extension fetches: with host
//     permission for the origin they are NOT page-CORS-bound. The
//     content script now asks the worker for the bytes
//     (AUTOLAUNCH_FETCH_PHOTO) and rebuilds the File itself; its
//     fallback is the photo-proxy Edge Function, and only if both fail
//     does the job fail honestly — a photoless car is never posted.
//  9. CDP TRUSTED INPUT (filler v3): Year/Make/Model/Price resisted two
//     generations of DOM fills — Facebook commits those fields only
//     through its suggestion-listbox selection / trusted input pipeline,
//     and React resets values set any other way. The content script's
//     last-resort rung now asks this worker to drive REAL input through
//     the DevTools protocol (AUTOLAUNCH_CDP: attach / click /
//     insertText / key / detach via chrome.debugger on the Facebook
//     tab). While attached Chrome shows a "…is debugging this browser"
//     infobar; it disappears on detach, which happens when the fill
//     sequence ends or the job finishes/fails. An attach failure (e.g.
//     the user has DevTools open on the tab) is a structured error, and
//     the content script's verify-or-report still decides the outcome.
//     Field diagnostics (AUTOLAUNCH_FIELD_DIAG) ride the same path into
//     autolaunch_failure_log when a field defeats every rung.
// 10. DIAG-TO-DB (v3.1, fourth live test): run 4's installed build WAS
//     2.1.0 (card verified) and both attempts failed honestly with
//     fields_unfilled:Year,Make,Model,Price — but the field_diag
//     forensics NEVER appeared in autolaunch_failure_log: Matthew pulled
//     exactly two bare {at, queueId, reason} entries. The separate
//     diag-message → storage path could not be trusted, so the records
//     now ride the AUTOLAUNCH_JOB_FAILED message itself, and this
//     worker compacts them into the queue row's error_message column
//     in the same PATCH that marks the row failed (outerHTML ≤160
//     chars per field, whole string ≤3500) — the evidence lives in the
//     database, readable with a plain SELECT, no console archaeology.
//     If the error_message write is rejected, the row still ends
//     failed via a status-only PATCH. logFailure's storage writes are
//     also serialized through a promise chain now: the old
//     get-modify-write cycles from near-simultaneous callers (four
//     field diags + the job failure) could overwrite each other. And a
//     CDP attach refused with "Another debugger is already attached"
//     is retried ONCE after 3s before the reason is recorded — a
//     transient DevTools attach shouldn't cost the rung.
// 11. FORM MAP RIDES ALONG (v3.2, fifth live test): run 5's
//     error_message stayed NULL under a working diag-to-DB — the
//     content script's jobDiags was empty because the four fields
//     were never LOCATED, so the ladder (and its diagnostics) never
//     ran for them. Location is fixed content-side (container label
//     text); here, compactDiagError now also preserves each record's
//     `note` and the one-per-job `formMap` entry (the failing step's
//     visible controls with their computed container labels), and
//     the cap rises to 6000 chars — formMap entries are shed first,
//     so the field records always survive.
// 12. STEP NOTES RIDE ALONG (v2.1.3, filler v3.3): the first
//     successful post still needed Matthew's hands for the step-2
//     color dropdowns and the clean-title box — best-effort fields
//     whose misses were silent. The content script now records a
//     non-fatal "step note" for each step-2 outcome (color requested
//     -> option chosen -> read-back; clean-title click path) on the
//     same diagnostic channels. Here, compactDiagError also
//     preserves each record's `detail` string (shed with readBack
//     under cap pressure), and the FIELD_DIAG handler stores `note`
//     + `detail` in autolaunch_failure_log alongside the forensics.
// 13. FULL AUTO + DELETE JOBS (v2.1.4): the claim loop now serves
//     the queue's `action` column. (a) FULL AUTO: user_settings is
//     fetched once per cycle (daily_post_limit + the new
//     full_auto_enabled); the flag rides the job payload
//     (current_posting_job.fullAuto) so the content script can turn
//     confirm mode off and click Publish itself. (b) DELETE JOBS
//     (action='delete', target_channel='facebook', queued by the
//     app's "Remove from Facebook"): claimed under the same
//     conditional-claim + session-token rules, but the daily POST
//     limit never blocks them (the limit counts posts, not
//     removals), the no-photo rule does not apply (a car whose
//     photos vanished is exactly the car you remove), and the tab
//     opened is the selling page, not the create form. A delete
//     whose inventory row is gone is still claimed — the payload
//     falls back to the queue row's own stamped year/make/model and
//     price (producers stamp all four at insert; the contract is
//     producer-agnostic, since an inventory-lifecycle auto-removal
//     rule will create these rows when a car leaves inventory).
//     Only a row stamped without a price leaves the strict matcher
//     nothing to match — and then it refuses (listing_not_found)
//     rather than guessing. Completion is a
//     third finish path (AUTOLAUNCH_JOB_DELETED ->
//     finishJobDeleted): the queue row ends "completed" (the table
//     has no status check constraint; the app's queue view renders
//     it) with executed_at set, and the car's
//     marketplace_posted_at is cleared — the same column the app
//     derives "Posted" from, so the car truthfully returns to
//     unposted. A mid-finish token death stashes outcome "deleted"
//     alongside "posted"/"failed". Delete failures compact their
//     diagnostics into error_message too, not just fields_unfilled
//     ones — the delete step notes are the evidence there.
// 14. VERIFY FAILURES + TAB AUTO-CLOSE (v2.1.7): (a) a post that
//     ends publish_unverified (the content script clicked Publish,
//     then could not find the listing on the Selling page after
//     repeated strict-match scans) compacts its diagnostics into
//     error_message too — the records are the verify scans, the
//     evidence the listing truly was not there. (b) TAB AUTO-CLOSE:
//     every job used to leave its Facebook tab behind, and they
//     piled up across a testing session. The claim now records the
//     opened tab's id on the job (current_posting_job.tabId), and
//     the two SUCCESS finishes (posted, deleted — including a
//     delete that finished goal-achieved) schedule that tab's
//     closure ~4s later, once the success banner has been readable.
//     Failures NEVER close — the tab is the user's evidence — and
//     neither does a token-stash replay (flushPendingFinish calls
//     the apply* writes directly; by replay time the moment has
//     passed). Only the exact tab this worker opened is ever
//     closed; a tab the user already closed is a no-op.
// 15. JOB-SLOT RECONCILIATION (v2.1.8): the current_posting_job
//     slot used to be cleared ONLY by a finish message from the
//     job's own content script. Stop a run any other way — cancel
//     the queue row in the app, close the job's tab — and the
//     finish never arrives: the slot stays occupied forever and
//     every claim cycle silently returns at `if (activeJob)`, with
//     a healthy awake worker, a valid token, and a pending row
//     nobody will ever claim. Proven live 2026-10-22 ~19:46 EDT:
//     storage held a job claimed at 23:14:48Z whose queue row the
//     user had deleted; a fresh pending row sat unclaimed 15+
//     minutes. claimedAt was written at claim time but never read.
//     checkQueue now reconciles the slot against its queue row
//     before honouring it (one lightweight read, only when a slot
//     is occupied): row gone, terminal (posted/failed/completed),
//     or pending again -> the run it belonged to is dead; clear
//     the slot and fall through to claim fresh work in the SAME
//     pass. Row still "processing" -> the slot is kept, UNLESS
//     claimedAt is older than 45 minutes — past every legitimate
//     run (the 10-minute confirm watch + the ~4-minute
//     verification cap, with generous margin) — in which case the
//     content script is certainly dead, so the row is failed
//     honestly as job_orphaned (diagnostics compacted into
//     error_message, token-death stash behaviour as in the other
//     finishes), the slot cleared, and the cycle continues. A
//     lookup that itself errors (network/auth) changes NOTHING:
//     the slot is kept and the cycle skips, so a transient failure
//     can never free a live job's slot or fail its row; auth
//     errors keep the session-expired semantics sbFetch already
//     records. Every reconciliation action is logged — the old
//     failure was invisible precisely because the skip was silent.
// 16. DELETE CLICK LADDER — CDP MOUSE SEQUENCE (v2.1.9): the
//     delete flow's menu-opening ladder gains a third rung above
//     the instantaneous press+release "click": action "clickSeq"
//     dispatches Input.dispatchMouseEvent mouseMoved, then
//     mousePressed, a brief pause, then mouseReleased at the
//     content-supplied coordinates — the hover/press timing some
//     Facebook menus arm on. Same contract as every CDP action:
//     {ok:true} / {ok:false, error}, and the cdp_not_attached
//     guard applies unchanged. Purely additive: claim logic, the
//     finish paths and every other action are untouched, and the
//     delete stage notes the content script records ride the
//     existing FIELD_DIAG / diag-compaction channels — no worker
//     change was needed for them (delete failures already compact
//     diagnostics into error_message, note 13).
// 17. SETUP-PAGE PING (v2.1.10): the app's Chrome Extension page asks,
//     through bridge.js, whether this worker is present and ready.
//     {type:"AUTOLAUNCH_PING"} is answered {hasToken} — true exactly
//     when a session token is currently stored under
//     autolaunch_access_token in chrome.storage.local (the key the
//     login handoff writes; read via storedAccessToken()). The token
//     value itself is never returned, logged, or otherwise exposed —
//     only the boolean. Purely additive: no claim, finish, CDP, photo
//     or diag behaviour changes.
// 18. BACKGROUND JOB TABS (v2.1.12, Matthew's request): navigating the
//     helper's Facebook tab away mid-fill destroys that attempt's page
//     and everything typed into it. Fully automated work therefore no
//     longer steals the user's place: Full Auto posts and all delete
//     jobs open with active:false, so the user can keep working in
//     their current tab while the helper works in its own background
//     tab, and the job tab is marked autoDiscardable:false so Chrome's
//     memory saver cannot discard it mid-run. Confirm-mode posts were
//     the deliberate exception in 2.1.12 (they opened in front because
//     the user personally has to click Publish there) — Matthew
//     overruled that on 2026-10-23 after his son's cross-account
//     test, so v2.1.13 opens EVERY job tab in the background; a
//     confirm-mode form waits, filled and bannered, until the user
//     clicks over to review and publish.
// 19. POST PACING + DEALER BLOCK (v2.1.42): two settings that live in
//     user_settings — and are promised by the app's UI copy — but
//     that no code ever read. (a) PACING: the claim cycle runs on a
//     1-minute alarm and used to claim the next POST the moment the
//     previous job's slot cleared, so a queued batch drained
//     back-to-back (proven live 2026-10-26: a post completed at
//     09:31 EDT and the next car was processing by 09:33, despite
//     post_delay_minutes = 15). userSettings now also reads
//     post_delay_minutes, and checkQueue refuses to claim a POST
//     until that many minutes have passed since the newest
//     scraped_inventory.marketplace_posted_at stamp — the stamp
//     applyPosted writes at completion, so the gap anchors on the
//     COMPLETED post, survives worker restarts, and needs no new
//     state. Deletes are NOT paced (a removal is not a post, the
//     same exemption the daily limit uses). An absent/zero delay
//     means no gate, and a failed last-post lookup fails OPEN (no
//     hold) — a flaky read must never wedge the queue. (b) DEALER
//     BLOCK: userSettings also reads dealership_name /
//     dealership_address, carried on the job payload like fullAuto,
//     so the content script can close the Marketplace description
//     with the dealership's name and address (Matthew's request,
//     2026-10-26). Either may be empty; the description appends
//     whatever exists and never blocks on a missing identity.
// 20. STOCK NUMBER IN DESCRIPTION (v2.1.43): the app's Posting
//     preferences have always saved an include_stock checkbox to
//     user_settings, but no code ever read it — the switch changed
//     nothing. userSettings now also reads include_stock and it
//     rides the job payload like the dealership identity, so the
//     content script can put a "Stock #:" line under the VIN in the
//     Marketplace description (Matthew's request, 2026-10-26).
//     Fail-open both ways: the preference off, or a car with no
//     stock number, leaves the description exactly as it was.
// 21. STOCK FALLBACK FROM INVENTORY (v2.1.44): 2.1.43 read the
//     stock number off the QUEUE row (stock_num) — but the app's
//     single-car enqueue never stamped it, so a hand-queued car's
//     queue row carried NULL and its listing shipped with no
//     Stock # line even though scraped_inventory knew the number
//     (proven live 2026-10-26: the Yukon VT60164B posted with the
//     dealership block but no stock line). The claim path already
//     holds the inventory row it fetched by VIN: jobCarWithStock
//     now stamps the payload car's stock_num from the queue row
//     first, then the inventory row's stock_number, so the content
//     script always sees the best-known value. Fail-open: no
//     stock anywhere still means no line, exactly as before.
// 22. AUTO-CREATE GATE (v2.1.46): the old Marketplace-only auto rule
//     keyed creation on the mere PRESENCE of a listing label — and
//     labels leak: a plain 1:1 Messenger chat about tires scraped
//     one, and a thread whose counterparty is the rep himself (a
//     Marketplace system/self thread) matched his own car's label.
//     On 2026-10-26 both became junk prospects on Matthew's account
//     the moment the app synced. Creation now runs through
//     autoCreateGate: a resolved participant name is mandatory (an
//     unresolved name NEVER auto-creates), a counterparty resolving
//     to the rep himself never creates, and at least one positive
//     seller-side signal must fire — the Marketplace inbox surface,
//     the seller's own thread controls ("View buyer"), or a label
//     matching one of the user's own posted cars. Snippet sync and
//     updates to known prospects are untouched: the gate decides
//     CREATION only, and it fails closed.
// 23. SELF BY IDENTITY + CAPTURE REASONS (v2.1.47): note 22's self
//     test matched the counterparty's NAME against the rep's —
//     but Matthew tests Marketplace chats from a second Facebook
//     account under the same display name ("Matthew DeMoss"), so
//     the name test blocked his own alt-account buyer threads, and
//     would block any real buyer who shares his name. The gate now
//     blocks as self ONLY on a proven Facebook-identity match: the
//     capture carries canonical identity tokens (buyerFbId /
//     selfFbId, scraped from profile links and the c_user cookie),
//     and a name match alone is no signal at all. Same release:
//     manual Capture stopped failing silently — the worker returns
//     a short error code (not_signed_in / no_buyer / save_failed)
//     and the button names the cause ("reload this Facebook tab"
//     for an orphaned script after a helper update, the bare
//     "Capture failed" case Matthew hit on 2026-10-26), and a
//     manual capture with no matched prospect and no resolvable
//     participant declines as no_buyer instead of filing a
//     nameless "Marketplace buyer" card.
// 24. SYNC REPAIR (v2.50): three fixes from Matthew's live
//     session, 2026-10-27. (a) CHROME NAMES: a half-rendered
//     thread paints the generic participant placeholder
//     "Facebook user" (plus "Compose" / "Conversation with
//     Facebook user" furniture); those strings were saved as
//     messages and even filed as a prospect NAME. chat_capture.js
//     now filters them everywhere, and autoCreateGate below
//     treats them as an unresolved name. (b) RENDER-SKIP RETRY:
//     gate skips for render-dependent reasons (unresolved_name /
//     no_seller_signal) are no longer final — chat_capture.js
//     tracks the worker's skip response per thread and re-sends
//     on later passes, bounded per page session. (c) TOMBSTONES:
//     deleting a prospect used to be undone by the next
//     auto-sync pass — the Facebook thread still exists, so
//     find-or-create simply re-created the card. A trigger now
//     records every deleted prospect's thread key in
//     prospect_tombstones; the auto path below checks it before
//     creating (skip reason deleted_by_user — terminal, never
//     retried) and a MANUAL Capture of the same thread removes
//     the tombstone (explicit undelete).
// 25. CAPTURE HYGIENE (v2.51): four fixes from Matthew's live
//     group thread, 2026-10-27. (a) GROUP CHROME: Marketplace
//     threads are group chats — Facebook's own narration ("…
//     named the group …", "… changed the group photo."), the
//     buyer card (participant's full name, ratings lines), the
//     listing label line and bare sender captions were all
//     stored as buyer messages; chat_capture.js now patterns
//     the whole family, not just yesterday's strings. (b)
//     DIRECTION: the scrape placed bubbles by center-vs-pane-
//     midpoint, but the pane spans nav + thread + info rail, so
//     a long rep bubble's center fell on the "buyer" side — the
//     rep's own delivered reply was re-filed as the buyer's.
//     The scrape now classifies by edge-hugging against the
//     bubble column itself and skips what it cannot place; and
//     handleCaptureChat refuses a long body already stored
//     under the OPPOSITE direction (same text, other side = the
//     same message mis-read; short echoes like "Yes" exempt —
//     both sides really say those). (c) TRANSIENT STATES:
//     "Sending" / "Delivered" / "Seen" / "Edited" / "You sent"
//     are delivery furniture, never message bodies, on every
//     storage path. (d) AUTO-PASS SILENCE: the content script
//     marked a thread's content hash before the worker
//     answered, so an errored pass (e.g. not_signed_in during a
//     session handover) silenced that thread until its text
//     changed; the hash now survives only a confirmed outcome.
// 26. OUTCOME TRUTH (v2.52 — the 2026-10-28 Passport incident;
//     content.js header note 26 carries the scan side): the
//     worker half of the same repairs. (a) CLAIM-TIME STAMP
//     CHECK: a POST row whose inventory record already carries
//     marketplace_posted_at is completed as posted at claim —
//     no tab, no second post; the existing stamp is the truth
//     and is left untouched, and the row's executed_at
//     fingerprints the path (applyPosted rows carry none).
//     (b) ORPHAN RECOVERY: a stale (>45 min) processing POST
//     row is no longer failed blind — the worker first arms
//     the stored job for Selling-page verification
//     (verifyPublished with orphanRecovery) and opens a
//     Selling tab to run the status-aware scan; the scan's
//     ordinary finish settles the row (live → posted, shells
//     → duplicate_rejected, nothing → job_orphaned). Only
//     when the scan cannot start, or produces no verdict
//     within 6 minutes, does the old blind fail land — with
//     the recovery outcome named in its diagnostics. Delete
//     rows keep the blind fail exactly as before. (c)
//     finishJobFailed now compacts diagnostics for
//     duplicate_rejected and job_orphaned too, so the scan
//     evidence rides error_message like every other honest
//     failure.

// 27. INTRO VIDEO ON MARKETPLACE (v2.1.53 — Intro Video Phase 4;
//     content.js header note 27 carries the composer side): the
//     composer test on Matthew's account (2026-10-28) proved the
//     vehicle composer takes ONE video (60 seconds max) through
//     a dedicated control alongside the photos, so Marketplace
//     is IN. userSettings now also reads intro_video_enabled /
//     intro_video_mode / intro_selected_video_id, and checkQueue
//     resolves the clip AT CLAIM TIME (resolveIntroVideo,
//     [PURE-INTRO-RESOLVE]): 'selected' uses the pinned row,
//     'random' picks one of the user's rows per post. The
//     resolved { url, videoId } rides the stored job only —
//     nothing is added to queue rows, per the spec's lookup-at-
//     use design — so the toggle and Delete take effect from
//     the very next post. STRICTLY FAIL-OPEN (spec invariant
//     2): disabled, an empty library, a vanished selection, or
//     a failed lookup each resolve to a named skip and the post
//     proceeds exactly as before this version. The worker also
//     relays the clip bytes to the content script (the AUTO
//     LAUNCH_FETCH_VIDEO message), mirroring the photo relay:
//     the page cannot fetch cross-origin itself.
// 28. BOUNDED VIDEO FETCH + JOB LIVENESS (v2.54 — the
//     2026-10-28 Accord wedge; content.js header note 28
//     carries the composer side): the relay fetcher below ran
//     a bare fetch + arrayBuffer() with no time limit, so a
//     stalled download never settled, the content script's
//     relay wait never answered, and the post wedged silently
//     behind the previous banner step. fetchVideoForContent
//     now aborts its fetch at 30s and answers the structured
//     refusal video_fetch_timeout; the content side races the
//     relay answer and bounds its own fallback, so a dead
//     download becomes the ordinary intro_video_download_
//     failed skip and the post proceeds without the clip.
//     The worker also answers AUTOLAUNCH_JOB_LIVENESS: the
//     content script asks, before filling, whether its stored
//     job is still the live slot — the same incident's second
//     half was a surviving tab re-driving a fill for a row
//     this worker had already settled. The verdict is
//     definitive-only: the slot holding a different job (or
//     no job), a missing queue row, or a row already in a
//     terminal state (or pending again, per reconcileActive
//     Job's reading) answers { live: false }; a matching slot
//     with a processing row answers { live: true }; and any
//     lookup failure answers { live: true } too — uncertainty
//     never blocks a fill.
// 29. SHARE TO FEED (v2.1.55 — Matthew's spec, 2026-10-29;
//     content.js header note 29 carries the Selling-page side):
//     two entry points, ONE mechanism. (a) The app's "Share to
//     my feed" button inserts an auto_posting_queue row with
//     action 'share' — the worker claims it exactly like a
//     delete (same Selling-page tab, same pacing/limit
//     exemption class, same missing-inventory-row fallback to
//     the row's stamped fields, same conditional claim), and
//     the content script shares the strictly matched listing
//     to the user's personal feed. A share NEVER touches
//     scraped_inventory.marketplace_posted_at: the listing
//     stays posted; the row settles 'completed'. (b) The
//     settings toggle (user_settings.share_to_feed, read at
//     claim time by userSettings exactly like the intro trio)
//     rides POST jobs as job.shareToFeed; when a post job
//     finalizes SUCCESSFULLY, finishJobPosted queues ONE share
//     row for the just-posted car through maybeQueueFeedShare
//     (dedupe-checked against live share rows for the VIN).
//     STRICTLY FAIL-OPEN, mirroring the intro-video skip
//     contract: the share insert is wrapped so it can never
//     throw into, fail, or delay the completed post — the post
//     is already final when it runs — and the share job itself
//     is an ordinary queue row whose own failure settles
//     'failed' with field_diag evidence, exactly like a delete.
//     Post failure never reaches finishJobPosted, so a failed
//     post never queues a share; toggle off queues nothing.
// 30. SHARE HARDENING (v2.1.56 — content.js header note 30
//     carries the incident and the two gates): share rows now
//     carry the listing's description text in the new
//     auto_posting_queue.share_text column, and the worker
//     carries it on share jobs as job.shareText for the
//     content script's composer placement. The worker-side
//     producer (maybeQueueFeedShare) stamps it with
//     buildShareTextForCar — a rebuild of the listing
//     description from the same inputs the posting composer
//     uses: the description TEXT is built in the content
//     script at post time and never reported back to the
//     worker, so the worker reconstructs it from the job's
//     car row plus the claim-time settings (dealership
//     identity + include_stock ride every job payload). The
//     auth-stash replay builds the same text: the stash's
//     shareCar now also carries trim / mileage / color /
//     transmission / condition and the stash carries the
//     identity + stock settings, so a replayed insert is
//     identical to the direct one. A claimed share whose row
//     predates the column simply carries shareText "" and the
//     content side fails it share_text_unplaced — a bare
//     share is never an acceptable outcome.
//
// 31. DEALERSHIP TAG ON FEED SHARES (v2.1.59 — content.js
//     header note 33 carries the design): the content
//     script now appends a best-effort Facebook @mention
//     of the dealership Page to the share composer's
//     details text. NO worker change was needed: the
//     dealership name has ridden every claimed job since
//     the description's closing block existed —
//     jobPayload sets dealershipName from the claim-time
//     settings (user_settings.dealership_name, read with
//     the settings block at claim) unconditionally, share
//     rows included, and the content script already binds
//     it at the top of every job. Both share producers
//     (app button + auto-share) claim through the same
//     path, so both arrive tagged-capable. This note is
//     the whole worker-side delta: comment only.
//
// 32. ONE ACTIVE HELPER — THE LEASE (v2.1.60 — Matthew's
//     spec, 2026-10-29; proven necessary the same night):
//     two helper workers holding the same user's session
//     raced one queue — an old pre-share build on Matthew's
//     home PC kept claiming rows, and its claim-time
//     already-posted shortcut closed SHARE rows "posted"
//     without ever opening Facebook (three shares eaten;
//     caught live by watching a row flip pending -> posted
//     in 5 seconds with the desk helper switched OFF).
//     Rule from this build: only ONE helper instance per
//     account may CLAIM queue jobs. The lease lives on the
//     user's own user_settings row (helper_lease_id /
//     helper_lease_expires_at — two nullable columns; the
//     own-row RLS policies already cover them). Each
//     instance owns a random UUID (al_instance_id in
//     chrome.storage.local, created on first need, stable
//     for the install — deliberately distinct from the
//     trial-abuse al_install_id). checkQueue reads the
//     lease with the claim cycle's existing settings fetch
//     (no extra round trip): empty, expired, or MINE ->
//     renew (one PATCH, expiry now + 10 min) and claim as
//     before; FOREIGN and unexpired -> claim NOTHING this
//     cycle and keep cycling (dormant) — the lease may
//     expire or be yielded. The lease gates NEW claims
//     only: job-slot reconciliation, every finish function,
//     the auth-stash replay (flushPendingFinish) and orphan
//     handling run exactly as before, so a job already in
//     flight settles its bookkeeping even if the lease is
//     lost mid-run — a row is never stranded by the lease.
//     If the lease write fails the cycle claims nothing
//     (fail closed; Supabase being unreachable already
//     blocks the queue reads, so this adds no new outage
//     class). Takeover is deliberate, never automatic: the
//     app's Extension page shows the lease state, and its
//     "Use this computer instead" button writes THIS
//     install's instance id (asked over the bridge —
//     AUTOLAUNCH_GET_INSTANCE_ID, app-origin senders only)
//     onto the row; the old holder sees a foreign lease on
//     its next cycle and stands down. Legacy builds know
//     nothing of the lease and ignore it — the lease
//     protects an account once its helpers run this build.

const SUPABASE_URL = "https://tdsipiltwajwhzgjsupx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";
const POLL_ALARM = "autolaunch-queue-poll";
const POLL_MINUTES = 1;

class SbAuthError extends Error {
  constructor(status) {
    super(`Supabase rejected the session token (${status})`);
    this.status = status;
  }
}

async function storedAccessToken() {
  const { autolaunch_access_token: token } =
    await chrome.storage.local.get(["autolaunch_access_token"]);
  return token || null;
}

// Trial-abuse install identifier (v2.1.45). ONE random UUID per helper
// install, kept in chrome.storage.local under al_install_id: created
// lazily on first request, then stable across restarts, updates, and
// site-data clears. It identifies the INSTALL, never a person or an
// account — uninstall/reinstall or a fresh Chrome profile starts over,
// which is accepted: this is a fence against casual trial farming,
// not a device fingerprint. The only reader is the
// AUTOLAUNCH_GET_INSTALL_ID bridge answer below, which goes solely to
// the AutoLaunch app origin; the app sends it to trial-start when a
// trial begins, and the server stores only a salted hash of it.
async function getOrCreateInstallId() {
  const { al_install_id: existing } =
    await chrome.storage.local.get(["al_install_id"]);
  if (existing) return existing;
  let id = null;
  try { id = crypto.randomUUID(); } catch (e) { /* fall through */ }
  if (!id) {
    id = "al-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
  }
  await chrome.storage.local.set({ al_install_id: id });
  return id;
}

// One-active-helper instance identity (v2.1.60, header note 32):
// ONE random UUID per helper install, kept in chrome.storage.local
// under al_instance_id — created lazily on first need, then stable
// across restarts and updates. It names the INSTALL for the helper
// lease only; it is deliberately NOT the trial-abuse al_install_id
// above (that fence has its own reader and lifecycle). The only
// outside reader is the AUTOLAUNCH_GET_INSTANCE_ID bridge answer,
// which goes solely to the AutoLaunch app origin so the Extension
// page's takeover button can write THIS install's id as the lease.
async function getOrCreateInstanceId() {
  const { al_instance_id: existing } =
    await chrome.storage.local.get(["al_instance_id"]);
  if (existing) return existing;
  let id = null;
  try { id = crypto.randomUUID(); } catch (e) { /* fall through */ }
  if (!id) {
    id = "al-inst-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
  }
  await chrome.storage.local.set({ al_instance_id: id });
  return id;
}

// [PURE-LEASE-DECISION-BEGIN] — extracted and unit-exercised by
// the test harness; keep free of DOM/chrome references.
// Lease decision (v2.1.60, header note 32): "take" when the lease
// is empty, expired, unreadable, or already mine — the caller
// renews and claims; "foreign" only when a DIFFERENT instance
// holds a lease whose expiry is still ahead — the caller stands
// down and claims nothing this cycle.
const HELPER_LEASE_TTL_MS = 10 * 60 * 1000;
function helperLeaseDecision(leaseId, leaseExpiresAt, myInstanceId, nowMs) {
  if (!leaseId || typeof leaseId !== "string") return "take";
  if (leaseId === myInstanceId) return "take";
  const exp = Date.parse(leaseExpiresAt || "");
  if (!isFinite(exp) || exp <= nowMs) return "take";
  return "foreign";
}
// [PURE-LEASE-DECISION-END]

async function sbHeaders(extra) {
  const token = await storedAccessToken();
  return Object.assign({
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${token || SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json"
  }, extra || {});
}

// Record (once per expiry) that the stored token died, in the same
// autolaunch_last_error record the failure logger uses. Reason strings
// only — the token value itself never lands in storage logs or errors.
async function markSessionExpired() {
  const { autolaunch_session_expired: already } =
    await chrome.storage.local.get(["autolaunch_session_expired"]);
  if (already) return;
  await chrome.storage.local.set({
    autolaunch_session_expired: true,
    autolaunch_last_error: {
      queueId: null,
      reason: "session_expired — reopen the AutoLaunch tab",
      at: new Date().toISOString()
    }
  });
  console.warn("[AutoLaunch] Session token expired — reopen the AutoLaunch tab to reconnect the extension.");
}

async function noteWaitingForLogin() {
  const { autolaunch_last_error: last } =
    await chrome.storage.local.get(["autolaunch_last_error"]);
  if (last && last.reason === "waiting_for_login") return;
  await chrome.storage.local.set({
    autolaunch_last_error: {
      queueId: null,
      reason: "waiting_for_login",
      at: new Date().toISOString()
    }
  });
}

async function sbFetch(path, options) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (res.status === 401 || res.status === 403) {
    await markSessionExpired();
    throw new SbAuthError(res.status);
  }
  if (!res.ok) {
    throw new Error(`Supabase ${(options && options.method) || "GET"} ${path} -> ${res.status}`);
  }
  return res.json();
}

async function sbGet(path) {
  return sbFetch(path, { headers: await sbHeaders() });
}

async function sbPatch(path, body) {
  return sbFetch(path, {
    method: "PATCH",
    headers: await sbHeaders({ "Prefer": "return=representation" }),
    body: JSON.stringify(body)
  });
}

async function sbDelete(path) {
  return sbFetch(path, { method: "DELETE", headers: await sbHeaders({}) });
}

async function sbPost(path, body) {
  return sbFetch(path, {
    method: "POST",
    headers: await sbHeaders({ "Prefer": "return=representation" }),
    body: JSON.stringify(body)
  });
}

// ---------------------------------------------------------------------
// AUTO-CREATE GATE (v2.1.46, header notes 22-23). Pure function:
// given an AUTO capture and the context handleCaptureChat assembled
// (the user's Marketplace-posted cars), decide whether the capture
// may CREATE a prospect. Manual captures never pass through here,
// and neither do captures for an already-known prospect (their
// message sync is not creation).
function autoCreateGate(capture, ctx) {
  var name = String((capture && capture.buyerName) || "").trim();
  // Hard rule: an unresolved participant name NEVER auto-creates —
  // the "Marketplace buyer" fallback card is exactly what this kills.
  if (!name) return { create: false, reason: "unresolved_name" };
  // Chrome placeholder names (v2.50, header note 24): "Facebook
  // user" and its furniture friends are what a half-rendered
  // thread shows INSTEAD of a participant — not a resolved name.
  if (/^(facebook user|compose|conversation with facebook user)$/i.test(name)) {
    return { create: false, reason: "unresolved_name" };
  }
  // Self test BY IDENTITY (v2.1.47, header note 23): block only when
  // the counterparty's Facebook identity PROVABLY equals the
  // signed-in account's — canonical tokens ("id:<digits>" /
  // "vanity:<name>") scraped by chat_capture.js. An id token never
  // equals a vanity token (unproven = not self), and a display-name
  // match is no signal at all: a second account under the same name
  // is a buyer, not the rep himself.
  var buyerId = String((capture && capture.buyerFbId) || "").trim();
  var selfId = String((capture && capture.selfFbId) || "").trim();
  if (buyerId && selfId && buyerId === selfId) {
    return { create: false, reason: "self_thread" };
  }
  var label = String((capture && capture.vehicleText) || "").trim();
  // Signal 1 — surface: the Marketplace inbox is commerce-only by
  // construction; a listing label must ride along so a bare system
  // row there still cannot create on surface alone.
  if (capture && capture.surface === "marketplace_inbox" && label) {
    return { create: true, signal: "marketplace_inbox" };
  }
  // Signal 2 — seller's thread: the open pane showed the seller's
  // own controls ("View buyer" renders only for the listing's
  // seller; a buyer-side thread shows "View seller" instead).
  if (capture && capture.sellerContext === true && label) {
    return { create: true, signal: "seller_thread" };
  }
  // Signal 3 — own listing: the label's year + make match one of
  // the user's own Marketplace-posted cars.
  if (label && labelMatchesPostedCar(label, (ctx && ctx.postedCars) || [])) {
    return { create: true, signal: "own_listing" };
  }
  return { create: false, reason: "no_seller_signal" };
}

// Does a listing label ("$26,159 - 2026 Volkswagen Jetta", "2026
// Volkswagen Jetta") name one of the user's posted cars? Token-based
// contains on year + make, so multi-word makes ("Land Rover") work
// the same way. postedCars rows come from scraped_inventory with
// marketplace_posted_at set — cars this user actually listed.
function labelMatchesPostedCar(label, postedCars) {
  var text = " " + String(label || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") + " ";
  for (var i = 0; i < postedCars.length; i++) {
    var car = postedCars[i] || {};
    var year = parseInt(car.year, 10);
    var make = String(car.make || "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim();
    if (!year || !make) continue;
    if (text.indexOf(" " + year + " ") === -1) continue;
    if (text.indexOf(" " + make + " ") !== -1) return true;
  }
  return false;
}

// Luca chat capture (Phase 2): a chat_capture.js scrape of an open
// Messenger/Marketplace thread lands here. Find-or-create the buyer as
// a Prospect, then store only the messages we don't already have.
// Runs on the rep's own stored session, so RLS keeps every row theirs.
async function handleCaptureChat(capture) {
  const { autolaunch_user_id: userId } = await chrome.storage.local.get(["autolaunch_user_id"]);
  if (!userId) {
    const e = new Error("not_signed_in — open AutoLaunch and sign in first");
    e.code = "not_signed_in";
    throw e;
  }
  const norm = (s) => (s || "").trim().toLowerCase();
  const name = (capture.buyerName || "").trim() || "Marketplace buyer";
  const vehicleText = (capture.vehicleText || "").trim();
  const threadRef = (capture.threadUrl || "").slice(0, 300);
  // Tombstone key (v2.50, header note 24): the thread's numeric
  // /t/<id> when the ref carries one, else the normalized ref —
  // MUST stay in step with prospect_tombstone_key() in the
  // database, which keys the rows the delete trigger writes.
  const threadKey = (() => {
    const m = String(threadRef || "").match(/\/t\/(\d+)/);
    return m ? m[1] : norm(threadRef);
  })();

  // Match order (auto-capture, v2.1.31): the THREAD is the identity —
  // the same conversation must never become two prospects just because
  // a list-row name or a listing label scraped differently this time.
  // Name+label matching stays as the fallback for captures with no URL.
  const rows = await sbGet(`prospects?user_id=eq.${userId}&select=id,name,vehicle_label,thread_ref&order=created_at.desc&limit=200`);
  let prospect = null;
  if (threadRef) prospect = rows.find(r => r.thread_ref && norm(r.thread_ref) === norm(threadRef));
  if (!prospect) {
    prospect = rows.find(r => norm(r.name) === norm(name) && (!vehicleText || norm(r.vehicle_label) === norm(vehicleText)));
  }
  // Marketplace-only auto rule (Matthew, 2026-10-25; tightened
  // v2.1.46, header note 22): creating a prospect from an AUTO
  // capture requires a resolved participant name AND a positive
  // seller-side signal — see autoCreateGate. Merely opening a
  // Messenger chat must never create a prospect or save its
  // messages; the manual Capture button (no auto flag) is how a rep
  // adds anything else, and it never passes through the gate. Auto
  // updates to an already-known prospect's thread still flow.
  if (capture.auto && !prospect) {
    // Tombstone (v2.50, header note 24): a prospect the rep
    // deleted must STAY deleted — the thread still exists on
    // Facebook, so without this check the next pass re-creates
    // the card. Terminal: never created, never retried.
    if (threadKey) {
      try {
        const tombs = await sbGet(`prospect_tombstones?user_id=eq.${userId}&thread_ref=eq.${encodeURIComponent(threadKey)}&select=id&limit=1`);
        if (tombs && tombs.length) {
          return { prospectName: null, added: 0, skipped: "deleted_by_user" };
        }
      } catch (e) { /* read failed — the gate below still guards creation */ }
    }
    const gateCtx = { postedCars: [] };
    try {
      gateCtx.postedCars = await sbGet(
        `scraped_inventory?user_id=eq.${userId}` +
        `&marketplace_posted_at=not.is.null&select=year,make,model&limit=300`) || [];
    } catch (e) { /* no inventory signal this pass */ }
    const gate = autoCreateGate(capture, gateCtx);
    if (!gate.create) {
      return { prospectName: null, added: 0, skipped: gate.reason };
    }
  }
  // Manual Capture, no matched prospect, no resolvable participant
  // (v2.1.47): decline with a reason the button can name instead of
  // filing a nameless "Marketplace buyer" card. Auto captures never
  // reach here (the gate already decided), and a thread-matched
  // prospect captures fine without a name.
  if (!capture.auto && !prospect && !String(capture.buyerName || "").trim()) {
    const e = new Error("no_buyer — no buyer found in this chat");
    e.code = "no_buyer";
    throw e;
  }
  if (!prospect) {
    const created = await sbPost("prospects", {
      user_id: userId,
      name: name,
      vehicle_label: vehicleText || null,
      stage: "new",
      source: "marketplace",
      thread_ref: threadRef || null,
      notes: capture.stub
        ? "Found in your Messenger inbox by Luca auto-sync. Open the chat and Luca will capture the conversation."
        : "Captured from a Marketplace chat by Luca."
    });
    prospect = created[0];
    // Manual Capture of a previously deleted thread is an
    // explicit undelete (v2.50, header note 24): clear its
    // tombstone so the thread lives as a normal prospect again.
    if (!capture.auto && threadKey) {
      try { await sbDelete(`prospect_tombstones?user_id=eq.${userId}&thread_ref=eq.${encodeURIComponent(threadKey)}`); } catch (e) { /* cosmetic */ }
    }
  } else {
    // Self-heal older/rougher captures: backfill a placeholder name, a
    // missing label, or a missing thread link when this capture has
    // better data. Never overwrite good data with rougher data.
    const patch = {};
    if (norm(prospect.name) === "marketplace buyer" && norm(name) !== "marketplace buyer") patch.name = name;
    if (!prospect.vehicle_label && vehicleText) patch.vehicle_label = vehicleText;
    if (!prospect.thread_ref && threadRef) patch.thread_ref = threadRef;
    if (Object.keys(patch).length) {
      try { await sbPatch(`prospects?id=eq.${prospect.id}`, patch); Object.assign(prospect, patch); } catch (e) { /* cosmetic */ }
    }
  }

  const existing = await sbGet(`closer_messages?user_id=eq.${userId}&prospect_id=eq.${prospect.id}&select=id,body,direction&order=created_at.desc&limit=200`);
  const seen = new Set(existing.map(m => m.direction + "|" + m.body));
  // Cross-direction guard (v2.51, header note 25): a scrape that
  // misplaces a bubble files the SAME body under the opposite
  // direction, and the direction-keyed dedupe above waves it
  // through as new — that is how the rep's own delivered reply
  // ("I'll actually be here until 8 tonight…", already stored
  // out/rep) was re-filed as the buyer's on Matthew's shared-name
  // group thread. A long body already stored under the other
  // direction is the same message mis-read: drop the copy. Short
  // bodies are exempt — both sides genuinely say "Yes" / "Ok",
  // and dropping a real echo would lose a real message.
  const storedDirs = new Map();
  existing.forEach(m => {
    const b = norm(m.body);
    if (!storedDirs.has(b)) storedDirs.set(b, new Set());
    storedDirs.get(b).add(m.direction);
  });
  const fresh = (capture.messages || []).filter(m => {
    if (!m || !m.body) return false;
    if (seen.has(m.direction + "|" + m.body)) return false;
    if (String(m.body).trim().length >= 20) {
      const dirs = storedDirs.get(norm(m.body));
      if (dirs) {
        const mine = m.direction === "out" ? "out" : "in";
        const other = mine === "out" ? "in" : "out";
        if (dirs.has(other) && !dirs.has(mine)) return false;
      }
    }
    return true;
  });
  if (fresh.length) {
    // Sequential created_at stamps (v2.1.40): one bulk insert shares
    // a single transaction timestamp, which scrambled the thread
    // order in the conversation view (Matthew: "texts come in out
    // of order"). Stamping each row +1ms in scrape order makes
    // created_at a faithful chronology.
    const baseTs = Date.now();
    await sbPost("closer_messages", fresh.map((m, idx) => ({
      user_id: userId,
      prospect_id: prospect.id,
      thread_ref: (capture.threadUrl || "").slice(0, 300) || null,
      direction: m.direction === "out" ? "out" : "in",
      origin: m.direction === "out" ? "rep" : "buyer",
      body: String(m.body).slice(0, 2000),
      created_at: new Date(baseTs + idx).toISOString()
    })));
    // Snippet-partial cleanup (v2.1.33): a full capture supersedes the
    // truncated one-line rows the inbox-list snippet sync saved for the
    // same message. An existing row counts as a partial when a fresh
    // full body (same direction, longer) starts with its text.
    const partialIds = existing.filter(e => {
      const core = String(e.body || "").replace(/[…]+$/, "").replace(/\.\.\.$/, "");
      if (core.length >= 20 && fresh.some(f => f.direction === e.direction
        && String(f.body).length > core.length
        && String(f.body).indexOf(core.slice(0, 40)) === 0)) return true;
      // Composite rows (v2.1.41): a list-row snippet sometimes fuses
      // the listing label + sender name onto the message ("2026
      // Volkswagen Jetta Matthew: Hahahah shush"). When a fresh full
      // body matches the existing row's TAIL with a real prefix in
      // front of it, the fused row is the same message — drop it.
      const eBody = String(e.body || "");
      return fresh.some(f => f.direction === e.direction
        && String(f.body).length >= 3
        && eBody.length > String(f.body).length + 8
        && eBody.endsWith(String(f.body)));
    }).map(e => e.id).filter(Boolean);
    if (partialIds.length) {
      try { await sbDelete(`closer_messages?id=in.(${partialIds.join(",")})`); } catch (e) { /* cosmetic */ }
    }
  }
  return { prospectName: prospect.name || name, added: fresh.length };
}

// Snippet sync (v2.1.33): the inbox LIST only shows each conversation's
// newest line — but that line updates live when a buyer writes, with no
// click from anyone. chat_capture.js sends those lines here; a line is
// stored ONLY for a thread that already belongs to a known prospect
// (personal chats are never pulled in), and only when it is genuinely
// new against what we already hold for that prospect.
async function handleChatSnippets(snippets) {
  const { autolaunch_user_id: userId } = await chrome.storage.local.get(["autolaunch_user_id"]);
  if (!userId || !Array.isArray(snippets) || !snippets.length) return { stored: 0 };
  const norm = (s) => (s || "").trim().toLowerCase();
  const rows = await sbGet(`prospects?user_id=eq.${userId}&select=id,thread_ref&order=created_at.desc&limit=200`);
  const byThread = new Map();
  rows.forEach(r => { if (r.thread_ref) byThread.set(norm(r.thread_ref), r); });
  let stored = 0;
  for (const sn of snippets.slice(0, 15)) {
    const prospect = byThread.get(norm(sn.threadRef || ""));
    const body = String(sn.snippet || "").trim();
    if (!prospect || body.length < 2) continue;
    const direction = sn.direction === "out" ? "out" : "in";
    const recent = await sbGet(`closer_messages?user_id=eq.${userId}&prospect_id=eq.${prospect.id}&select=body,direction&order=created_at.desc&limit=30`);
    const covered = recent.some(m => {
      const b = norm(m.body);
      const s = norm(body);
      return b === s || b.indexOf(s.slice(0, 30)) === 0 || s.indexOf(b.slice(0, 30)) === 0;
    });
    if (covered) continue;
    await sbPost("closer_messages", [{
      user_id: userId,
      prospect_id: prospect.id,
      thread_ref: (sn.threadRef || "").slice(0, 300) || null,
      direction,
      origin: direction === "out" ? "rep" : "buyer",
      body: body.slice(0, 500)
    }]);
    stored++;
  }
  return { stored };
}

// --- Outbound replies (Prospects inbox step 2, v2.1.32) -------------------
// The app queues a reply as a closer_messages row (status "queued").
// This engine claims one at a time, hands it to a Facebook tab via a
// storage pending-slot (the tab's chat_capture script does the typing
// and verification), and records the result. No Facebook tab open ->
// the reply simply stays queued (the hub rule). A delivery in flight
// for over 3 minutes is marked failed rather than retried blindly —
// a half-sent state must never resend itself.
let outboundBusy = false;
async function checkOutboundReplies() {
  if (outboundBusy) return;
  outboundBusy = true;
  try {
    const { autolaunch_user_id: userId } = await chrome.storage.local.get(["autolaunch_user_id"]);
    if (!userId) return;
    const { luca_pending_delivery: pending } = await chrome.storage.local.get(["luca_pending_delivery"]);
    if (pending) {
      if (Date.now() - (pending.at || 0) > 3 * 60 * 1000) {
        try { await sbPatch(`closer_messages?id=eq.${pending.messageId}&status=eq.sending`, { status: "failed", delivery_error: "timeout_no_result" }); } catch (e) { /* best effort */ }
        await chrome.storage.local.remove(["luca_pending_delivery"]);
      }
      return; // one delivery at a time
    }
    const rows = await sbGet(`closer_messages?user_id=eq.${userId}&status=eq.queued&select=id,prospect_id,thread_ref,body&order=created_at.asc&limit=1`);
    const row = rows && rows[0];
    if (!row || !row.thread_ref) return;
    const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*"] });
    if (!tabs.length) return; // no hub tab — stays queued
    const key = (String(row.thread_ref).match(/\/t\/(\d+)/) || [])[1] || "";
    const tab = tabs.find(t => key && (t.url || "").includes("/t/" + key))
      || tabs.find(t => (t.url || "").includes("/messages"))
      || tabs.find(t => (t.url || "").includes("/marketplace"))
      || tabs[0];
    if (!tab || tab.id == null) return;
    const claimed = await sbPatch(`closer_messages?id=eq.${row.id}&status=eq.queued`, { status: "sending" });
    if (!claimed || !claimed.length) return; // someone else took it
    await chrome.storage.local.set({
      luca_pending_delivery: { messageId: row.id, threadRef: row.thread_ref, body: row.body, tabId: tab.id, at: Date.now() }
    });
    if (key && (tab.url || "").includes("/t/" + key)) {
      // Poke — but demand an ACK (v2.1.35). A tab whose capture script
      // died (the classic case: the helper was updated while the tab
      // sat open) never answers; reloading that tab re-injects the
      // current script, which picks the pending delivery up from
      // storage on load. Without this, a dead tab silently eats the
      // reply until the 3-minute timeout fails it (seen live
      // 2026-10-25 on the first reply attempt).
      const acked = await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 6000);
        try {
          chrome.tabs.sendMessage(tab.id, { type: "AUTOLAUNCH_DELIVER_NOW" }, resp => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(!chrome.runtime.lastError && !!(resp && resp.accepted));
          });
        } catch (e) {
          if (!done) { done = true; clearTimeout(timer); resolve(false); }
        }
      });
      if (!acked) {
        try { await chrome.tabs.reload(tab.id); } catch (e) { /* the timeout sweep fails it honestly */ }
      }
    } else {
      await chrome.tabs.update(tab.id, { url: row.thread_ref });
    }
  } catch (e) { /* next tick retries */ } finally {
    outboundBusy = false;
  }
}

async function finishOutboundReply(messageId, ok, error) {
  const { luca_pending_delivery: pending } = await chrome.storage.local.get(["luca_pending_delivery"]);
  if (!pending || pending.messageId !== messageId) return;
  try {
    await sbPatch(`closer_messages?id=eq.${messageId}`, {
      status: ok ? "sent" : "failed",
      delivery_error: ok ? null : String(error || "unknown").slice(0, 200)
    });
  } catch (e) { /* best effort */ }
  await chrome.storage.local.remove(["luca_pending_delivery"]);
  checkOutboundReplies(); // chain the next queued reply, if any
}

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function todaysPostCount(userId) {
  const rows = await sbGet(
    `scraped_inventory?user_id=eq.${userId}` +
    `&marketplace_posted_at=gte.${encodeURIComponent(startOfTodayISO())}` +
    `&select=vin`
  );
  return rows.length;
}

// One settings fetch per claim cycle (v2.1.4): the daily post
// limit AND the Full Auto switch both live on user_settings.
// v2.1.42: the same fetch also carries the post pacing delay
// (post_delay_minutes) and the dealership identity (name/address)
// for the description's closing block — see header note 19.
// v2.1.43: it also carries include_stock for the description's
// Stock # line — see header note 20.
// v2.1.53: it also carries the intro-video preference trio
// (enabled / mode / selected id) — see header note 27.
// v2.1.55: it also carries share_to_feed for the post-success
// feed share — see header note 29. Opt-in: anything but an
// explicit true reads as off.
// v2.1.60: it also carries the one-active-helper lease
// (helper_lease_id / helper_lease_expires_at) — see header
// note 32. The claim cycle's gate reads them from THIS fetch;
// no extra round trip.
async function userSettings(userId) {
  const rows = await sbGet(
    `user_settings?user_id=eq.${userId}&select=daily_post_limit,full_auto_enabled,post_delay_minutes,dealership_name,dealership_address,include_stock,intro_video_enabled,intro_video_mode,intro_selected_video_id,share_to_feed,helper_lease_id,helper_lease_expires_at`);
  const row = (rows && rows.length) ? rows[0] : {};
  return {
    limit: typeof row.daily_post_limit === "number" ? row.daily_post_limit : 10,
    fullAuto: row.full_auto_enabled === true,
    delayMinutes: (typeof row.post_delay_minutes === "number" && row.post_delay_minutes > 0)
      ? row.post_delay_minutes : 0,
    dealershipName: typeof row.dealership_name === "string" ? row.dealership_name.trim() : "",
    dealershipAddress: typeof row.dealership_address === "string" ? row.dealership_address.trim() : "",
    includeStock: row.include_stock === true,
    introEnabled: row.intro_video_enabled === true,
    introMode: typeof row.intro_video_mode === "string" ? row.intro_video_mode : "selected",
    introSelectedId: typeof row.intro_selected_video_id === "string" ? row.intro_selected_video_id : null,
    shareToFeed: row.share_to_feed === true,
    leaseId: (typeof row.helper_lease_id === "string" && row.helper_lease_id)
      ? row.helper_lease_id : null,
    leaseExpiresAt: typeof row.helper_lease_expires_at === "string"
      ? row.helper_lease_expires_at : null
  };
}

// [PURE-INTRO-RESOLVE-BEGIN] — extracted and unit-exercised by
// the test harness; keep free of DOM/chrome references.
// Intro-video claim-time resolution (v2.1.53, header note 27):
// decide, from the settings trio and the user's video rows,
// which single video (if any) rides this post. Every non-answer
// is a NAMED skip — the caller logs it and posts exactly as
// before this feature existed. rng is injectable so the harness
// can pin 'random' mode; production passes Math.random. Any
// mode other than 'random' follows the app's default semantics
// ('selected'), exactly as the app's own reader normalizes it.
function resolveIntroVideo(settings, rows, rng) {
  if (!settings || settings.introEnabled !== true) {
    return { skip: "intro_disabled" };
  }
  const list = (Array.isArray(rows) ? rows : []).filter(r =>
    r && typeof r.video_url === "string" && r.video_url.trim());
  if (!list.length) return { skip: "intro_library_empty" };
  if (settings.introMode === "random") {
    const roll = (typeof rng === "function" ? rng : Math.random)();
    const idx = Math.min(list.length - 1, Math.max(0, Math.floor(roll * list.length)));
    const pick = list[idx];
    return { url: pick.video_url, videoId: pick.id || null, mode: "random" };
  }
  const wanted = settings.introSelectedId;
  if (!wanted) return { skip: "intro_no_selection" };
  const hit = list.find(r => r.id === wanted);
  if (!hit) return { skip: "intro_selected_missing" };
  return { url: hit.video_url, videoId: hit.id || null, mode: "selected" };
}
// [PURE-INTRO-RESOLVE-END]

// Claim-time wrapper (v2.1.53): fetch the user's intro-video
// rows ONLY when the preference is on (everyone else's claim
// path is untouched), resolve, and log the outcome. Any failure
// resolves to a named skip — never a throw into the claim loop.
async function introVideoForJob(userId, settings) {
  if (!settings || settings.introEnabled !== true) return null;
  try {
    const rows = await sbGet(
      `user_intro_videos?user_id=eq.${userId}&select=id,video_url&order=created_at.asc`);
    const resolved = resolveIntroVideo(settings, rows, Math.random);
    if (resolved.skip) {
      console.log(`[AutoLaunch] Intro video skipped at claim (${resolved.skip}).`);
      return null;
    }
    console.log(`[AutoLaunch] Intro video resolved at claim (mode ${resolved.mode}, video ${resolved.videoId}).`);
    return { url: resolved.url, videoId: resolved.videoId };
  } catch (e) {
    console.log("[AutoLaunch] Intro video skipped at claim (intro_resolve_failed).");
    return null;
  }
}

// Newest completed-post stamp for this user (v2.1.42): the pacing
// gate's anchor. applyPosted stamps scraped_inventory.marketplace_
// posted_at at the moment a post completes, so the newest non-null
// value IS the last completed post — no separate state to maintain.
// Returns epoch ms, or null when the user has never posted or the
// lookup failed; callers treat null as "no hold" (fail open), so a
// flaky read can never wedge the queue behind a phantom delay.
async function lastPostedAt(userId) {
  try {
    const rows = await sbGet(
      `scraped_inventory?user_id=eq.${userId}` +
      `&marketplace_posted_at=not.is.null` +
      `&order=marketplace_posted_at.desc&select=marketplace_posted_at&limit=1`
    );
    const ts = rows && rows.length ? Date.parse(rows[0].marketplace_posted_at || "") : NaN;
    return isFinite(ts) ? ts : null;
  } catch (e) {
    return null;
  }
}

// Stock number for the job payload (v2.1.44, header note 21): the
// queue row's stamped stock_num wins; when it is empty/null/
// whitespace, fall back to the inventory row's stock_number (the
// row checkQueue already fetched by the job's VIN). Returns the
// car row unchanged when it already carries a usable stock_num
// or when no source has one — the description then simply omits
// the Stock # line, exactly as before this fix.
function jobCarWithStock(carRow, queueItem) {
  if (!carRow) return carRow;
  const usable = v => (v != null && String(v).trim()) ? String(v).trim() : "";
  if (usable(carRow.stock_num)) return carRow;
  const stock = usable(queueItem && queueItem.stock_num) || usable(carRow.stock_number);
  if (!stock) return carRow;
  return Object.assign({}, carRow, { stock_num: stock });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

// Job-slot reconciliation (v2.1.8, header note 15). A claimed job
// may legitimately run long — confirm mode waits up to 10 minutes
// for a human Publish click, and the v2.1.7 post-publish
// verification adds up to ~4 minutes of Selling-page rescans —
// but no legitimate run approaches 45 minutes, so a "processing"
// row older than that has no living content script behind it.
const JOB_STALE_MS = 45 * 60 * 1000;
// Orphan recovery (v2.52, header note 26): how long a stale POST
// row's recovery scan may run before the watchdog falls back to
// the blind fail. The scan's own budget is ~4 minutes of rescans
// (verifyPublished's wall-clock cap) plus render patience — six
// minutes leaves honest headroom without wedging the slot.
const ORPHAN_RECOVERY_TIMEOUT_MS = 6 * 60 * 1000;
const SELLING_PAGE_URL = "https://www.facebook.com/marketplace/you/selling";
const TERMINAL_ROW_STATUSES = ["posted", "failed", "completed"];

// Returns true when the stored job slot must be KEPT (a run is
// genuinely in flight, or this cycle could not verify either
// way), false when the slot was dead and has been cleared — the
// caller then falls through and claims fresh work in the same
// pass. Runs at most one lightweight queue-row read per cycle,
// and only when a slot is occupied.
// Arm a stale POST job for orphan-recovery verification and
// open the Selling tab that runs the scan (v2.52, header
// note 26). The stored job gains verifyPublished with
// orphanRecovery set — the content script's existing routing
// takes it from there — plus an orphanRecovery bookkeeping
// record the watchdog reads on later cycles. Returns false
// when the tab could not be opened; the caller then fails
// blind, exactly as before this fix.
async function startOrphanRecovery(job) {
  try {
    const nowIso = new Date().toISOString();
    const armed = Object.assign({}, job, {
      verifyPublished: { tries: 0, startedAt: nowIso, orphanRecovery: true },
      orphanRecovery: { requestedAt: nowIso, tabId: null }
    });
    await chrome.storage.local.set({ current_posting_job: armed });
    const tab = await chrome.tabs.create({ active: false, url: SELLING_PAGE_URL });
    if (!tab || tab.id == null) return false;
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) { /* non-fatal: the scan still runs, just unprotected */ }
    const { current_posting_job: cur } =
      await chrome.storage.local.get(["current_posting_job"]);
    if (cur && cur.queueId === job.queueId && cur.orphanRecovery) {
      cur.orphanRecovery.tabId = tab.id;
      await chrome.storage.local.set({ current_posting_job: cur });
    }
    console.log(`[AutoLaunch] Orphan recovery: verifying queue item ${job.queueId} on the Selling page before failing it.`);
    return true;
  } catch (e) {
    return false;
  }
}

// Job liveness (v2.54, header note 28): the content script
// asks, before filling, whether the job its tab loaded from
// storage is still this worker's live job. Definitive-only:
// "no" requires positive evidence — the slot holds a
// different job (or no job), the queue row is gone, or the
// row already sits in a state reconcileActiveJob would call
// dead (terminal, or pending again). A matching slot over a
// processing row is live, and ANY failure to check (storage
// or database) answers live too — uncertainty never blocks.
async function jobLivenessVerdict(queueId) {
  if (!queueId) return { live: true };
  let slot = null;
  try {
    const stored = await chrome.storage.local.get(["current_posting_job"]);
    slot = stored && stored.current_posting_job;
  } catch (e) {
    return { live: true };
  }
  if (!slot || slot.queueId !== queueId) {
    return { live: false, reason: "slot_moved_on" };
  }
  let rows;
  try {
    rows = await sbGet(`auto_posting_queue?id=eq.${queueId}&select=id,status`);
  } catch (e) {
    return { live: true };
  }
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) return { live: false, reason: "row_missing" };
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    return { live: false, reason: "row_" + row.status };
  }
  if (row.status === "pending") {
    return { live: false, reason: "row_pending" };
  }
  return { live: true };
}

async function reconcileActiveJob(job) {
  const queueId = job && job.queueId;
  if (!queueId) {
    // A slot with no queue id can never be finished or verified —
    // it is dead by construction.
    await chrome.storage.local.remove(["current_posting_job"]);
    console.log("[AutoLaunch] Job slot cleared (slot carried no queue id).");
    return false;
  }
  let rows;
  try {
    rows = await sbGet(`auto_posting_queue?id=eq.${queueId}&select=id,status`);
  } catch (err) {
    // The lookup itself failed (network, or auth — sbFetch has
    // already recorded a session expiry if it was one). Believe
    // nothing, change nothing: keep the slot and let this cycle
    // skip, exactly as conservative as the rest of the worker.
    return true;
  }
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const clearSlot = async reason => {
    await chrome.storage.local.remove(["current_posting_job"]);
    console.log(`[AutoLaunch] Job slot cleared (${reason}) for queue item ${queueId}.`);
  };
  if (!row) {
    // The user cancelled the job in the app (the queue row is
    // deleted there) — the run it belonged to can never report
    // back, so the slot it wedged is dead.
    await clearSlot("queue row no longer exists");
    return false;
  }
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    await clearSlot(`queue row already ${row.status}`);
    return false;
  }
  if (row.status === "pending") {
    // Re-queued externally (or the claim write never landed):
    // the stored run is dead either way. Clearing the slot lets
    // THIS cycle's claim pass pick the row up fresh below.
    await clearSlot("queue row is pending again");
    return false;
  }
  if (row.status === "processing") {
    const claimedAtMs = Date.parse(job.claimedAt || "");
    // A claim that cannot prove it is fresh (no readable
    // claimedAt) does not get to wedge the queue forever.
    const ageMs = isFinite(claimedAtMs) ? Date.now() - claimedAtMs : Infinity;
    if (ageMs <= JOB_STALE_MS) return true; // genuinely running
    // Orphan recovery (v2.52, header note 26): a stale POST row
    // is verified against Facebook BEFORE it may be failed —
    // the Prius lesson (2026-10-28) is that "processing" past
    // the watchdog can mean the Publish already landed and
    // only the bookkeeping died. The recovery scan settles the
    // row through the ordinary finish messages; while it is in
    // flight the slot is KEPT (returning true). Only a scan
    // that cannot start, or that produces no verdict within
    // ORPHAN_RECOVERY_TIMEOUT_MS, falls through to the blind
    // fail below — with the recovery outcome in its detail.
    let recoveryNote = "";
    if (job.action === "post") {
      const rec = job.orphanRecovery;
      if (!rec) {
        if (await startOrphanRecovery(job)) return true;
        recoveryNote = " Orphan recovery scan could not be started (no Selling tab) — failed blind.";
      } else {
        const recAgeMs = Date.now() - (Date.parse(rec.requestedAt || "") || 0);
        if (isFinite(recAgeMs) && recAgeMs <= ORPHAN_RECOVERY_TIMEOUT_MS) {
          return true; // scan in flight — its finish settles the row
        }
        recoveryNote = " Orphan recovery scan produced no verdict within 6 min — failed blind.";
      }
    }
    // Orphaned: still "processing" far beyond any legitimate
    // run, so the content script is certainly dead (its tab was
    // closed, or it crashed). Fail the row honestly — the
    // diagnostics ride error_message like every other failure —
    // clear the slot, and let the cycle continue to fresh work.
    console.warn(`[AutoLaunch] Job orphaned: queue item ${queueId} still processing ${Math.round(ageMs / 60000)} min after claim — failing it and clearing the slot.`);
    const errorMessage = compactDiagError([{
      field: "Job",
      note: "job_orphaned",
      detail: `claimed ${job.claimedAt || "unknown"}, still "processing" after 45+ min — content script presumed dead (tab closed or crashed).${recoveryNote}`
    }]);
    try {
      await applyFailed(queueId, errorMessage);
    } catch (err) {
      if (err instanceof SbAuthError) {
        // Same stash-and-replay as finishJobFailed, so the
        // failure lands when the next fresh token arrives instead
        // of being lost with the dead token.
        await chrome.storage.local.set({
          autolaunch_pending_finish: { outcome: "failed", queueId, errorMessage }
        });
      } else {
        throw err;
      }
    }
    await logFailure(queueId, "job_orphaned");
    await clearSlot("orphaned processing row failed");
    return false;
  }
  // A status vocabulary this build does not know: change nothing.
  return true;
}

let isChecking = false;

async function checkQueue() {
  if (isChecking) return;
  isChecking = true;
  try {
    const {
      autolaunch_user_id: userId,
      autolaunch_access_token: accessToken,
      autolaunch_session_expired: sessionExpired,
      current_posting_job: activeJob
    } = await chrome.storage.local.get([
      "autolaunch_user_id", "autolaunch_access_token",
      "autolaunch_session_expired", "current_posting_job"
    ]);
    if (!userId) return;               // not signed in to AutoLaunch yet
    if (sessionExpired) return;        // dead token — wait for a fresh one via the bridge
    if (!accessToken) {                // bridge hasn't delivered a session yet
      await noteWaitingForLogin();
      return;
    }
    if (activeJob) {
      // One car at a time, always — but verify the stored job is
      // still a live run before honouring the slot (v2.1.8): a
      // run stopped out-of-band (row cancelled in the app, tab
      // closed) never sends its finish, and an unreconciled slot
      // would wedge every future claim behind it, silently.
      const slotKept = await reconcileActiveJob(activeJob);
      if (slotKept) return;
      // The slot was dead and has been cleared — fall through and
      // claim fresh work in this same pass.
    }

    const settings = await userSettings(userId);

    // One-active-helper lease (v2.1.60, header note 32): only
    // ONE helper instance per account may claim. The lease rode
    // this cycle's settings fetch — no extra round trip. Foreign
    // + unexpired -> claim nothing and stay dormant (the cycle
    // keeps polling; the lease may expire or be yielded).
    // Otherwise renew — ONE PATCH, expiry now + TTL — and claim
    // as before. A failed renew throws into the cycle's catch:
    // no claim happens on an unproven lease (fail closed). The
    // gate sits AFTER job-slot reconciliation on purpose: the
    // lease gates NEW claims only, never the bookkeeping of a
    // job already in flight.
    const myInstanceId = await getOrCreateInstanceId();
    if (helperLeaseDecision(settings.leaseId, settings.leaseExpiresAt, myInstanceId, Date.now()) === "foreign") {
      console.log("[AutoLaunch] Another computer holds this account's helper lease — standing by, no claims this cycle.");
      return;
    }
    await sbPatch(`user_settings?user_id=eq.${userId}`, {
      helper_lease_id: myInstanceId,
      helper_lease_expires_at: new Date(Date.now() + HELPER_LEASE_TTL_MS).toISOString()
    });

    // The claim set (v2.1.4): Marketplace POST rows (target_channel
    // 'marketplace') and Facebook DELETE rows (target_channel
    // 'facebook', action 'delete') — the jobs this helper runs.
    // v2.1.55 adds Facebook SHARE rows (target_channel 'facebook',
    // action 'share') to the same set. Other channels' rows belong
    // to other workers; never touch them.
    const queueItems = await sbGet(
      `auto_posting_queue?user_id=eq.${userId}&status=eq.pending` +
      `&target_channel=in.(marketplace,facebook)&order=created_at.asc&limit=5`
    );
    if (!queueItems.length) return;

    // Daily safety limit — enforced here too, not just in the UI,
    // and it gates POSTS only: a removal is not a post, and being at
    // the cap must never strand a listing the user asked to take down.
    let atLimit = false;
    if (settings.limit < 999) {
      const postedToday = await todaysPostCount(userId);
      atLimit = postedToday >= settings.limit;
      if (atLimit) {
        console.log(`[AutoLaunch] Daily limit reached (${postedToday}/${settings.limit}). Posts wait; deletes and shares still run.`);
      }
    }
    // Post pacing (v2.1.42, header note 19): post_delay_minutes is
    // the minimum gap between a COMPLETED post and claiming the
    // next POST row. Deletes are exempt, exactly like the daily
    // limit — pacing spaces posts, never removals. No configured
    // delay (0) means no gate; a missing last-post stamp (never
    // posted, or the lookup failed) also means no gate.
    let pacingHeld = false;
    if (settings.delayMinutes > 0 && queueItems.some(q => q.action !== "delete" && q.action !== "share")) {
      const lastPost = await lastPostedAt(userId);
      if (lastPost !== null) {
        const sinceMin = (Date.now() - lastPost) / 60000;
        if (sinceMin < settings.delayMinutes) {
          pacingHeld = true;
          console.log(`[AutoLaunch] Post pacing: last post ${Math.floor(sinceMin)} min ago; holding posts ~${Math.ceil(settings.delayMinutes - sinceMin)} more min (delay ${settings.delayMinutes} min). Deletes and shares still run.`);
        }
      }
    }
    let item = null;
    for (const q of queueItems) {
      if (q.action === "delete" || q.action === "share") { item = q; break; }
      if (!atLimit && !pacingHeld) { item = q; break; }
    }
    if (!item) return; // only posts waiting, and the cap (or pacing) says wait
    const isDelete = item.action === "delete";
    const isShare = item.action === "share";

    const cars = await sbGet(
      `scraped_inventory?vin=eq.${encodeURIComponent(item.vin)}&user_id=eq.${userId}&limit=1`
    );
    let carRow = cars.length ? cars[0] : null;
    if (!carRow && !isDelete && !isShare) {
      // Queue row points at a car that no longer exists: fail it loudly
      // instead of leaving it pending forever.
      await sbPatch(`auto_posting_queue?id=eq.${item.id}&status=eq.pending`, { status: "failed" });
      await logFailure(item.id, "inventory_row_missing");
      return;
    }
    if (!carRow && (isDelete || isShare)) {
      // A delete can outlive its inventory row — by design: the
      // delete-job contract is producer-agnostic (the Remove button
      // today; an inventory-lifecycle auto-removal rule later, which
      // fires exactly when the car LEAVES inventory). The payload
      // therefore falls back to the queue row's own year/make/model
      // AND price, which producers stamp on the row at insert. Only a
      // row stamped without a price leaves the matcher nothing strict
      // to match — and then it refuses (listing_not_found) rather
      // than guessing at a twin.
      carRow = {
        vin: item.vin,
        year: item.year != null ? item.year : null,
        make: item.make || null,
        model: item.model || null,
        stock_num: item.stock_num || null,
        price: item.price != null ? Number(item.price) : null
      };
    }
    if (carRow && (isDelete || isShare) && carRow.price == null && item.price != null) {
      // Inventory row exists but carries no price; the row's stamped
      // price is the better evidence for the strict match.
      carRow = Object.assign({}, carRow, { price: Number(item.price) });
    }

    // NO-PHOTO RULE (mirrors hasRealPhoto in the web app): a vehicle with
    // no real photos is never posted — its photos may have vanished after
    // it was queued. Fail the row loudly, same as a missing car, instead
    // of handing a photo-less listing to Facebook. POSTS ONLY: a delete
    // removes a listing, and a car whose photos vanished is exactly the
    // car whose listing should come down.
    if (!isDelete && !isShare) {
      // Fallback placeholders are never real photos: the old hotlinked
      // Unsplash URL (rows stored before 2.1.11 may still carry it), the
      // local fallback asset in both the absolute Pages form a stored
      // row could carry and the relative form the app now uses.
      const FALLBACK_PHOTOS = [
        "https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=800&auto=format&fit=crop&q=80",
        "https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/assets/no-photo.png",
        "assets/no-photo.png"
      ];
      const usablePhoto = u => {
        if (!u || typeof u !== "string") return false;
        let s = u.trim();
        if (s.startsWith("//")) s = "https:" + s;
        return /^https?:\/\//i.test(s) && !s.includes("/static/") && !FALLBACK_PHOTOS.includes(s);
      };
      const hasPhoto = usablePhoto(carRow.image_url) ||
        (Array.isArray(carRow.custom_photo_urls) && carRow.custom_photo_urls.some(usablePhoto));
      if (!hasPhoto) {
        await sbPatch(`auto_posting_queue?id=eq.${item.id}&status=eq.pending`, { status: "failed" });
        await logFailure(item.id, "no_photos");
        return;
      }
    }

    // Conditional claim: only succeeds while the row is still pending.
    const claimed = await sbPatch(
      `auto_posting_queue?id=eq.${item.id}&status=eq.pending`,
      { status: "processing" }
    );
    if (!claimed.length) return; // someone/something else took it

    // Claim-time stamp check (v2.52, header note 26): the car
    // already carries marketplace_posted_at — an earlier run
    // reached Facebook and only its bookkeeping was lost (the
    // false-failure class behind the 2026-10-28 Passport
    // duplicates). Complete the row as posted WITHOUT storing
    // a job or opening a tab, and WITHOUT touching the stamp:
    // the existing value is the truth. The row's executed_at
    // fingerprints this path (applyPosted rows carry none).
    if (!isDelete && !isShare && carRow.marketplace_posted_at) {
      await sbPatch(`auto_posting_queue?id=eq.${item.id}`,
        { status: "posted", executed_at: new Date().toISOString() });
      console.log(`[AutoLaunch] already_posted_at_claim: queue item ${item.id} (VIN ${item.vin}) already carries marketplace_posted_at ${carRow.marketplace_posted_at} — completed without posting.`);
      return;
    }

    const jobPayload = {
      queueId: item.id,
      userId,
      car: jobCarWithStock(carRow, item),
      action: isDelete ? "delete" : isShare ? "share" : "post",
      fullAuto: settings.fullAuto,
      dealershipName: settings.dealershipName,
      dealershipAddress: settings.dealershipAddress,
      includeStock: settings.includeStock,
      shareToFeed: settings.shareToFeed === true,
      // Share details text (v2.1.56, header note 30): the row's
      // share_text rides SHARE jobs only; the content script
      // places it in the share composer before confirming.
      // Absent (a pre-column row) the job carries "" and the
      // share fails honestly rather than posting bare.
      shareText: isShare && typeof item.share_text === "string" ? item.share_text : "",
      claimedAt: new Date().toISOString()
    };
    // Intro video (v2.1.53, header note 27): resolved at claim
    // time and carried on the job; posts only — a delete has no
    // composer to attach to. Absent = the post runs exactly as
    // before this version.
    if (!isDelete && !isShare) {
      const intro = await introVideoForJob(userId, settings);
      if (intro) jobPayload.introVideo = intro;
    }
    await chrome.storage.local.set({ current_posting_job: jobPayload });

    await jitter(1500, 4000); // human pacing, never machine-gun tabs
    // Background-tab rule (v2.1.12, extended v2.1.13): EVERY job now
    // works in an inactive tab so the helper never pulls the user
    // away from what they are doing (and the user browsing elsewhere
    // can't disturb the form). v2.1.12 kept confirm-mode posts in
    // front because a human must click Publish; Matthew overruled
    // that after watching his son's test — the filled tab simply
    // waits in the background with its review banner, and the user
    // clicks over to it when they are ready to publish.
    const jobTab = await chrome.tabs.create({
      active: false,
      url: (isDelete || isShare)
        ? "https://www.facebook.com/marketplace/you/selling"
        : "https://www.facebook.com/marketplace/create/vehicle"
    });
    if (jobTab && jobTab.id != null && chrome.tabs.update) {
      try {
        // A background tab must not be discarded by Memory Saver
        // while the content script is mid-run.
        await chrome.tabs.update(jobTab.id, { autoDiscardable: false });
      } catch (e) { /* non-fatal: the job still runs, just unprotected */ }
    }
    // Record the tab THIS worker opened for THIS job (note 14):
    // a successful finish closes exactly that tab ~4s after the
    // success banner lands. Written as a follow-up merge because
    // the job record was stored (and the pacing jitter spent)
    // before the tab existed.
    if (jobTab && jobTab.id != null) {
      const { current_posting_job: j } =
        await chrome.storage.local.get(["current_posting_job"]);
      if (j && j.queueId === item.id) {
        j.tabId = jobTab.id;
        await chrome.storage.local.set({ current_posting_job: j });
      }
    }
  } catch (err) {
    console.error("[AutoLaunch] Queue check error:", err);
  } finally {
    isChecking = false;
  }
}

// --- Photo relay --------------------------------------------------------
// The content script (on facebook.com) cannot fetch dealer photo URLs
// itself — page CORS. This worker can: extension fetches backed by host
// permissions are not page-CORS-bound. Returns the bytes base64-encoded
// (chunked conversion — String.fromCharCode on a whole 15MB buffer would
// blow the argument limit) with the content type; every failure is a
// structured { ok:false, error } so the content script can fall through
// to the photo-proxy and, failing that, the honest job failure.
const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // ~15MB — dealer photos are ~50KB

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchPhotoForContent(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "photo_url_not_http" };
  }
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return { ok: false, error: "photo_fetch_threw" };
  }
  if (!res.ok) return { ok: false, error: `photo_http_${res.status}` };
  const contentType = res.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    return { ok: false, error: "photo_not_an_image" };
  }
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) return { ok: false, error: "photo_empty" };
  if (buffer.byteLength > PHOTO_MAX_BYTES) {
    return { ok: false, error: "photo_too_large" };
  }
  return {
    ok: true,
    base64: arrayBufferToBase64(buffer),
    contentType: contentType || "image/jpeg"
  };
}

// --- Video relay (v2.1.53, header note 27) ----------------------
// The intro-video twin of the photo relay above: the content
// script cannot fetch the storage URL itself (page CORS), this
// worker can. The app's own upload cap is 50 MB, so the relay
// cap matches it; anything larger is a structured refusal, and
// the content script skips the attach and posts without it.
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // the app's intro upload cap
const VIDEO_FETCH_TIMEOUT_MS = 30 * 1000; // abort budget (v2.54, note 28)

async function fetchVideoForContent(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "video_url_not_http" };
  }
  // Bounded (v2.54, header note 28): the fetch and the body
  // read share one 30s abort budget. In 2.53 this was a bare
  // fetch whose promise could hang unsettled forever — and
  // did, wedging a post behind the previous banner step. A
  // stall now answers the structured refusal below.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch (e) { /* no-op */ }
  }, VIDEO_FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        return { ok: false, error: "video_fetch_timeout" };
      }
      return { ok: false, error: "video_fetch_threw" };
    }
    if (!res.ok) return { ok: false, error: `video_http_${res.status}` };
    const contentType = res.headers.get("content-type") || "";
    const ct = contentType.toLowerCase();
    if (ct && !ct.startsWith("video/") && !ct.includes("octet-stream")) {
      return { ok: false, error: "video_not_a_video" };
    }
    let buffer;
    try {
      buffer = await res.arrayBuffer();
    } catch (e) {
      if (controller.signal.aborted) {
        return { ok: false, error: "video_fetch_timeout" };
      }
      throw e; // as before: the relay handler answers video_relay_failed
    }
    if (!buffer.byteLength) return { ok: false, error: "video_empty" };
    if (buffer.byteLength > VIDEO_MAX_BYTES) {
      return { ok: false, error: "video_too_large" };
    }
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      contentType: contentType || "video/mp4"
    };
  } finally {
    clearTimeout(timer);
  }
}


// --- CDP trusted input (filler v3) ---------------------------------------
// Minimal protocol the content script drives:
//   { type: "AUTOLAUNCH_CDP", action: "attach" }
//   { type: "AUTOLAUNCH_CDP", action: "click", x, y }
//   { type: "AUTOLAUNCH_CDP", action: "clickSeq", x, y }  (v2.1.9)
//   { type: "AUTOLAUNCH_CDP", action: "insertText", text }
//   { type: "AUTOLAUNCH_CDP", action: "key", key, code, text?, modifiers? }
//   { type: "AUTOLAUNCH_CDP", action: "detach" }
// Every reply is { ok: true, ... } or { ok: false, error } — an attach
// failure (another debugger, e.g. the user's own DevTools, is attached)
// surfaces as an error, never a throw, so the caller's verify-or-report
// remains the arbiter. Sessions are tracked per tab; Chrome's own
// onDetach (tab closed, user cancels the infobar) cleans the map.
const cdpSessions = new Map(); // tabId -> protocol version

function cdpAttachOnce(tabId) {
  return new Promise(resolve => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: "cdp_attach_failed: " + (err.message || "unknown") });
        return;
      }
      cdpSessions.set(tabId, "1.3");
      resolve({ ok: true });
    });
  });
}

async function cdpAttach(tabId) {
  if (cdpSessions.has(tabId)) return { ok: true, already: true };
  let res = await cdpAttachOnce(tabId);
  // The classic refusal is the user having DevTools (or another
  // debugger) on the same tab. That can be transient — retry ONCE
  // after a pause before giving the rung up; the error string keeps
  // the browser's exact reason either way (v3.1).
  if (!res.ok && /another debugger is already attached/i.test(res.error || "")) {
    await sleep(3000);
    res = await cdpAttachOnce(tabId);
  }
  return res;
}

function cdpSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || "cdp_command_failed"));
      else resolve(result);
    });
  });
}

function cdpDetach(tabId) {
  if (!cdpSessions.has(tabId)) return Promise.resolve({ ok: true, already: false });
  return new Promise(resolve => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // detaching a dead session is fine
      cdpSessions.delete(tabId);
      resolve({ ok: true });
    });
  });
}

async function handleCdp(message, tabId) {
  switch (message.action) {
    case "attach":
      return cdpAttach(tabId);
    case "detach":
      return cdpDetach(tabId);
    case "click": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      const x = Number(message.x), y = Number(message.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, error: "cdp_bad_coordinates" };
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return { ok: true };
    }
    case "clickSeq": {
      // v2.1.9 (header note 16): a full mouse SEQUENCE — move,
      // press, brief pause, release — for menus that arm on
      // hover/press timing and shrug off the instantaneous
      // press+release pair above.
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      const x = Number(message.x), y = Number(message.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, error: "cdp_bad_coordinates" };
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y });
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(90);
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return { ok: true };
    }
    case "insertText": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      await cdpSendCommand(tabId, "Input.insertText", { text: String(message.text || "") });
      return { ok: true };
    }
    case "key": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      if (!message.key) return { ok: false, error: "cdp_key_missing" };
      const base = {
        key: String(message.key),
        code: String(message.code || message.key),
        modifiers: Number(message.modifiers) || 0
      };
      // `text` makes printable keys actually produce characters in
      // fields that read it from the key event (native selects do).
      if (message.text) base.text = String(message.text);
      await cdpSendCommand(tabId, "Input.dispatchKeyEvent",
        Object.assign({ type: "keyDown" }, base));
      await cdpSendCommand(tabId, "Input.dispatchKeyEvent",
        Object.assign({ type: "keyUp" }, base));
      return { ok: true };
    }
    default:
      return { ok: false, error: "cdp_unknown_action" };
  }
}

chrome.debugger.onDetach.addListener(source => {
  if (source && source.tabId != null) cdpSessions.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  cdpSessions.delete(tabId);
});

// Failure-log writes are serialized through this chain (v3.1): the
// get-modify-write cycle is not atomic, and near-simultaneous callers
// (four field diags landing alongside the job failure) could read the
// same base log and overwrite each other's entries.
let failureLogChain = Promise.resolve();
function logFailure(queueId, reason, extra) {
  const run = failureLogChain.then(() => logFailureNow(queueId, reason, extra));
  failureLogChain = run.catch(() => {});
  return run;
}

async function logFailureNow(queueId, reason, extra) {
  const { autolaunch_failure_log: log = [] } = await chrome.storage.local.get(["autolaunch_failure_log"]);
  const entry = Object.assign(
    { queueId, reason, at: new Date().toISOString() },
    extra || {}
  );
  log.unshift(entry);
  await chrome.storage.local.set({
    autolaunch_failure_log: log.slice(0, 25),
    autolaunch_last_error: { queueId, reason, at: entry.at }
  });
}

// [PURE-DIAG-BEGIN] — extracted and unit-exercised by the test harness;
// keep free of chrome/fetch references.
// Compact the content script's per-field forensic records into the
// JSON string stored in the queue row's error_message (diag-to-DB,
// v3.1; form map v3.2; step notes v2.1.3): per field {field, tag,
// type, role, ariaLabel, outerHTML (≤160 chars), rungsAttempted,
// readBack, cdpError, note, detail (≤200 chars)}, plus the form_map
// entry whose formMap lists the failing step's visible controls
// {tag, type, role, ariaLabel, containerLabel (≤120 chars)}. The
// whole string is capped at 6000 chars — shed formMap entries first
// (halve, then drop), then outerHTML, then readBack + detail, then
// hard-truncate, so the field names + rungs + cdpError + notes
// survive.
function compactDiagError(diags) {
  if (!Array.isArray(diags) || !diags.length) return null;
  const fields = diags.map(d => {
    const el = (d && d.element) || {};
    return {
      field: (d && d.field) || null,
      tag: el.tag || null,
      type: el.type || null,
      role: el.role || null,
      ariaLabel: el.ariaLabel || null,
      outerHTML: el.outerHTML ? String(el.outerHTML).slice(0, 160) : null,
      rungsAttempted: (d && Array.isArray(d.rungsAttempted)) ? d.rungsAttempted.slice() : [],
      readBack: (d && d.readBack != null) ? String(d.readBack).slice(0, 120) : null,
      cdpError: (d && d.cdpError) || null,
      note: (d && d.note) || null,
      detail: (d && d.detail != null) ? String(d.detail).slice(0, 200) : null,
      formMap: (d && Array.isArray(d.formMap))
        ? d.formMap.slice(0, 12).map(m => ({
            tag: (m && m.tag) || null,
            type: (m && m.type) || null,
            role: (m && m.role) || null,
            ariaLabel: (m && m.ariaLabel) || null,
            containerLabel: (m && m.containerLabel != null)
              ? String(m.containerLabel).slice(0, 120) : null
          }))
        : null
    };
  });
  let out = JSON.stringify({ field_diag: fields });
  if (out.length > 6000) {
    fields.forEach(f => { if (Array.isArray(f.formMap)) f.formMap = f.formMap.slice(0, 6); });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.formMap = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.outerHTML = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.readBack = null; f.detail = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) out = out.slice(0, 6000);
  return out;
}
// [PURE-DIAG-END]

// The DB writes that end a job, split out so a finish that collides with
// a dead token can be stashed and replayed when a fresh token arrives
// (see autolaunch_pending_finish below) instead of being lost.
async function applyPosted(queueId, vin, userId) {
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`, { status: "posted" });
  await sbPatch(
    `scraped_inventory?vin=eq.${encodeURIComponent(vin)}&user_id=eq.${userId}`,
    { marketplace_posted_at: new Date().toISOString() }
  );
}

// Delete completion (v2.1.4): the queue row ends "completed" —
// there is no check constraint on status (verified against the live
// schema), and the app's queue view renders the value — with
// executed_at stamped, and the car's marketplace_posted_at cleared.
// That column is the app's ONLY derivation of "Posted", so clearing
// it is what truthfully returns the car to unposted once the listing
// is verifiably gone from Facebook.
async function applyDeleted(queueId, vin, userId) {
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`,
    { status: "completed", executed_at: new Date().toISOString() });
  await sbPatch(
    `scraped_inventory?vin=eq.${encodeURIComponent(vin)}&user_id=eq.${userId}`,
    { marketplace_posted_at: null }
  );
}

// Share completion (v2.1.55, header note 29): the queue row ends
// "completed" with executed_at stamped — and NOTHING else. A
// share never touches scraped_inventory: the listing stays
// posted and marketplace_posted_at keeps its value.
async function applyShared(queueId) {
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`,
    { status: "completed", executed_at: new Date().toISOString() });
}

// The share row's details text (v2.1.56, header note 30): a
// worker-side rebuild of the listing description from the same
// inputs the posting composer's buildDescription uses — the
// description TEXT itself is built in the content script at
// post time and never reported back to the worker, so the
// worker reconstructs it from the job's car row and the
// claim-time settings riding the job (dealership identity,
// include_stock). Mirrors buildDescription + listingMileage
// line for line; the app carries the third copy of this
// builder (buildShareDetailsText) — keep all three in step.
function buildShareTextForCar(car, job) {
  if (!car) return "";
  const norm = v => String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
  const stored = car.mileage != null && car.mileage !== "" ? Number(car.mileage) : null;
  const isNew = /^new$/i.test(String(car.condition || "").trim());
  const lm = (stored !== null && stored >= 300)
    ? { miles: stored, defaulted: isNew && stored === 1000, isNew }
    : { miles: 1000, defaulted: true, isNew };
  const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"} ${car.trim || ""}`.trim();
  const stockRaw = (car.stock_num != null && String(car.stock_num).trim())
    ? car.stock_num : car.stock_number;
  const stock = stockRaw != null ? String(stockRaw).trim() : "";
  let desc =
    `${title}\n` +
    `Price: $${(car.price || 0).toLocaleString()}\n` +
    (lm.miles != null ? `Mileage: ${lm.miles.toLocaleString()} miles\n` : "") +
    (car.color && norm(car.color) !== "standard" ? `Exterior: ${car.color}\n` : "") +
    (car.transmission ? `Transmission: ${car.transmission}\n` : "") +
    (car.vin ? `VIN: ${car.vin}\n` : "") +
    (job && job.includeStock === true && stock ? `Stock #: ${stock}\n` : "") +
    (lm.defaulted
      ? (lm.isNew
        ? `\nBrand new vehicle — the mileage shown is a listing default; actual miles may be less.`
        : `\nMileage shown is a listing default — exact miles were not published for this vehicle; ask us for the current odometer reading.`)
      : "") +
    `\nInspected and frontline ready. Message to set up a test drive!`;
  const dealerLines = [
    job && typeof job.dealershipName === "string" ? job.dealershipName.trim() : "",
    job && typeof job.dealershipAddress === "string" ? job.dealershipAddress.trim() : ""
  ].filter(s => s);
  if (dealerLines.length) desc += `\n\n${dealerLines.join("\n")}`;
  return desc;
}

// Post-success feed share (v2.1.55, header note 29): when the
// job's claim-time settings carried shareToFeed, queue ONE share
// row for the just-posted car — the producer contract the app's
// "Share to my feed" button writes (target_channel 'facebook',
// action 'share', the car's year/make/model/stock/price stamped
// on the row for the strict matcher). Dedupe-checked against
// live share rows for the VIN first, exactly like the app's
// producer. STRICTLY FAIL-OPEN: called only after the post is
// already final, wrapped so nothing it does can throw into,
// fail, or delay the completed post — worst case the share is
// skipped and the skip is logged.
async function maybeQueueFeedShare(job) {
  try {
    if (!job || job.shareToFeed !== true || !job.car || !job.car.vin || !job.userId) return;
    const car = job.car;
    const existing = await sbGet(
      `auto_posting_queue?user_id=eq.${job.userId}&vin=eq.${encodeURIComponent(car.vin)}&action=eq.share&status=in.(pending,processing)&select=id&limit=1`);
    if (existing && existing.length) {
      console.log(`[AutoLaunch] share_to_feed: a share for VIN ${car.vin} is already queued — not queueing another.`);
      return;
    }
    await sbPost("auto_posting_queue", {
      user_id: job.userId,
      vin: car.vin,
      target_channel: "facebook",
      action: "share",
      status: "pending",
      year: car.year != null ? car.year : null,
      make: car.make || null,
      model: car.model || null,
      stock_num: car.stock_num || car.stock_number || null,
      price: car.price != null ? Number(car.price) : null,
      // The details text (v2.1.56, header note 30) rides the
      // row so the share can carry the listing's description
      // into the feed post.
      share_text: buildShareTextForCar(car, job) || null,
      created_at: new Date().toISOString()
    });
    console.log(`[AutoLaunch] share_to_feed: queued a feed share for VIN ${car.vin} (posted car, toggle on).`);
  } catch (e) {
    console.warn("[AutoLaunch] share_to_feed: queueing the feed share failed and was skipped — the post itself is unaffected.", e && e.message || e);
  }
}

async function applyFailed(queueId, errorMessage) {
  if (errorMessage) {
    try {
      await sbPatch(`auto_posting_queue?id=eq.${queueId}`,
        { status: "failed", error_message: errorMessage });
      return;
    } catch (err) {
      // An auth failure would doom the retry too — rethrow so the
      // caller stashes the finish for the next token. Any other
      // rejection (e.g. the diagnostics write itself) must NOT cost
      // the failure state: fall through to the status-only write.
      if (err instanceof SbAuthError) throw err;
      console.warn("[AutoLaunch] error_message write rejected; failing the row without diagnostics.");
    }
  }
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`, { status: "failed" });
}

async function flushPendingFinish() {
  const { autolaunch_pending_finish: pending } =
    await chrome.storage.local.get(["autolaunch_pending_finish"]);
  if (!pending) return;
  try {
    if (pending.outcome === "posted") {
      await applyPosted(pending.queueId, pending.vin, pending.userId);
      // The share the post earned rides the stash (v2.1.55):
      // queued on replay, still fail-open.
      await maybeQueueFeedShare({ userId: pending.userId, shareToFeed: pending.shareToFeed, car: pending.shareCar, includeStock: pending.includeStock === true, dealershipName: pending.dealershipName || "", dealershipAddress: pending.dealershipAddress || "" });
    } else if (pending.outcome === "shared") {
      await applyShared(pending.queueId);
    } else if (pending.outcome === "deleted") {
      await applyDeleted(pending.queueId, pending.vin, pending.userId);
    } else {
      await applyFailed(pending.queueId, pending.errorMessage || null);
    }
    await chrome.storage.local.remove(["autolaunch_pending_finish"]);
    console.log("[AutoLaunch] Replayed a job finish that was waiting on a fresh session token.");
  } catch (e) {
    // Still can't write — sbFetch already marked the session expired if
    // that's the cause. Leave the record; the next new token retries it.
  }
}

// Tab auto-close on success (v2.1.7, header note 14): ~4s after a
// successful finish — long enough for the success banner to be
// read — close the tab this worker opened for the job. Called
// ONLY from the two success finishes; finishJobFailed never calls
// it (a failed job's tab stays open as evidence), and a tab the
// user already closed is a silent no-op.
function scheduleJobTabClose(job) {
  if (!chrome.tabs || typeof chrome.tabs.remove !== "function") return;
  // The job's own tab, plus the orphan-recovery tab when this
  // finish came from a recovery scan (v2.52, header note 26).
  const ids = [];
  if (job && job.tabId != null) ids.push(job.tabId);
  if (job && job.orphanRecovery && job.orphanRecovery.tabId != null &&
      !ids.includes(job.orphanRecovery.tabId)) {
    ids.push(job.orphanRecovery.tabId);
  }
  if (!ids.length) return;
  setTimeout(() => {
    for (const tabId of ids) {
      try {
        const p = chrome.tabs.remove(tabId);
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (e) { /* the tab is already gone — nothing to do */ }
    }
  }, 4000);
}

// The ONLY two ways a job ends. Called by the content script via message.
async function finishJobPosted(queueId, listingUrl) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  try {
    await applyPosted(queueId, job.car.vin, job.userId);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // The listing really is live; only the bookkeeping failed. Stash
      // the finish and replay it on the next token rather than losing
      // the confirmation (or wedging every future check behind a job
      // whose browser-side work is already done).
      await chrome.storage.local.set({
        autolaunch_pending_finish: {
          outcome: "posted", queueId,
          vin: job.car.vin, userId: job.userId,
          listingUrl: listingUrl || null,
          shareToFeed: job.shareToFeed === true,
          // v2.1.56: the settings the share text is built from
          // ride the stash too, so a replayed share row is
          // identical to the direct one.
          includeStock: job.includeStock === true,
          dealershipName: job.dealershipName || "",
          dealershipAddress: job.dealershipAddress || "",
          shareCar: {
            vin: job.car.vin,
            year: job.car.year != null ? job.car.year : null,
            make: job.car.make || null,
            model: job.car.model || null,
            stock_num: job.car.stock_num || job.car.stock_number || null,
            price: job.car.price != null ? Number(job.car.price) : null,
            // v2.1.56: the remaining buildShareTextForCar
            // inputs, so the replay builds the same text.
            trim: job.car.trim || null,
            mileage: job.car.mileage != null ? job.car.mileage : null,
            color: job.car.color || null,
            transmission: job.car.transmission || null,
            condition: job.car.condition || null
          }
        }
      });
      await chrome.storage.local.remove(["current_posting_job"]);
      console.warn("[AutoLaunch] Posted confirmed on Facebook; the queue update is waiting on a fresh session token.");
      scheduleJobTabClose(job);
      return;
    }
    throw err;
  }
  await chrome.storage.local.remove(["current_posting_job"]);
  console.log("[AutoLaunch] Posted confirmed for queue item", queueId, listingUrl || "");
  scheduleJobTabClose(job);
  // Feed share (v2.1.55, header note 29): the post is final —
  // queue the share its toggle earned. Never throws.
  await maybeQueueFeedShare(job);
}

// The delete counterpart of finishJobPosted (v2.1.4). Called by the
// content script ONLY after it verified the listing card is gone
// from the selling page — never on a click alone.
async function finishJobDeleted(queueId) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  try {
    await applyDeleted(queueId, job.car.vin, job.userId);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // The listing really is deleted; only the bookkeeping failed.
      // Stash + replay on the next fresh token, like the posted path.
      await chrome.storage.local.set({
        autolaunch_pending_finish: {
          outcome: "deleted", queueId,
          vin: job.car.vin, userId: job.userId
        }
      });
      await chrome.storage.local.remove(["current_posting_job"]);
      console.warn("[AutoLaunch] Delete confirmed on Facebook; the queue update is waiting on a fresh session token.");
      scheduleJobTabClose(job);
      return;
    }
    throw err;
  }
  await chrome.storage.local.remove(["current_posting_job"]);
  console.log("[AutoLaunch] Delete confirmed for queue item", queueId);
  scheduleJobTabClose(job);
}

// The share counterpart of finishJobDeleted (v2.1.55, header
// note 29). Called by the content script ONLY after the share
// dialog completed — never on a click alone. Settles the row
// "completed"; the car's posted stamp is untouched.
async function finishJobShared(queueId) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  try {
    await applyShared(queueId);
  } catch (err) {
    if (err instanceof SbAuthError) {
      await chrome.storage.local.set({
        autolaunch_pending_finish: {
          outcome: "shared", queueId,
          vin: job.car.vin, userId: job.userId
        }
      });
      await chrome.storage.local.remove(["current_posting_job"]);
      console.warn("[AutoLaunch] Share confirmed on Facebook; the queue update is waiting on a fresh session token.");
      scheduleJobTabClose(job);
      return;
    }
    throw err;
  }
  await chrome.storage.local.remove(["current_posting_job"]);
  console.log("[AutoLaunch] Share confirmed for queue item", queueId);
  scheduleJobTabClose(job);
}

async function finishJobFailed(queueId, reason, diags) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  // Diag-to-DB (v3.1): the content script's forensic records arrive in
  // this message; for a fields_unfilled failure they are compacted
  // into the row's error_message in the same write that fails it.
  // Delete jobs (v2.1.4) compact too — there the records are the
  // delete step notes (match scan, outcome), the evidence that says
  // WHY nothing was deleted. A publish_unverified failure (v2.1.7)
  // compacts as well: its records are the Selling-page verify scans,
  // the evidence that the listing truly was not there. v2.52:
  // duplicate_rejected and job_orphaned (the orphan-recovery
  // verdicts) compact too — the same scan records are the evidence
  // for those honest failures.
  const errorMessage =
    ((typeof reason === "string" && reason.startsWith("fields_unfilled")) ||
     reason === "publish_unverified" ||
     reason === "publish_button_not_found" ||
     reason === "duplicate_rejected" ||
     reason === "job_orphaned" ||
     (job && (job.action === "delete" || job.action === "share")))
      ? compactDiagError(diags)
      : null;
  try {
    await applyFailed(queueId, errorMessage);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // Same stash-and-replay as the posted path, so the row doesn't
      // sit in "processing" forever behind a dead token. The compacted
      // diagnostics ride the stash so the replay keeps them.
      await chrome.storage.local.set({
        autolaunch_pending_finish: { outcome: "failed", queueId, errorMessage }
      });
    } else {
      throw err; // the finally below still logs + clears, as before
    }
  } finally {
    await logFailure(queueId, reason || "unknown");
    await chrome.storage.local.remove(["current_posting_job"]);
    console.warn("[AutoLaunch] Job failed:", queueId, reason);
  }
}

// --- Wiring ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  checkQueue();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  checkQueue();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) { checkQueue(); checkOutboundReplies(); }
});

// The app is served from two first-party origins: the custom domain
// and the GitHub Pages mirror (the rebuild preview rides the mirror).
// The bridge handshake is accepted from either, and from nowhere else.
// v2.1.49: autolaunch.org added — before this the worker trusted only
// the mirror, so on the custom domain the app could never hand over
// the session token and the queue poller stayed parked.
function isAppUrl(url) {
  const u = url || "";
  return u.startsWith("https://autolaunch.org/") ||
         u.startsWith("https://mdemoss-bdc.github.io/");
}

// Handshake path 1 (the real one): bridge.js on the AutoLaunch origin.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "AUTOLAUNCH_PING") {
    // Setup-page liveness/readiness ping (header note 17). Only the
    // bridge on the AutoLaunch origin may ask — same sender discipline
    // as the login handoff below — and the answer is a boolean about
    // the stored session token, never the token itself.
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    (async () => {
      const token = await storedAccessToken();
      // v2.1.24: report our own version so the setup page can say
      // "out of date" instead of a bare "ready" for an old helper.
      let version = null;
      try { version = chrome.runtime.getManifest().version || null; } catch (e) { /* keep null */ }
      sendResponse({ hasToken: !!token, version });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_GET_INSTALL_ID") {
    // Trial-abuse install id (v2.1.45): only the bridge on the
    // AutoLaunch origin may ask — same sender discipline as the ping
    // above. The answer is the install UUID itself (never a user id,
    // never the session token).
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    (async () => {
      const installId = await getOrCreateInstallId();
      sendResponse({ installId });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_GET_INSTANCE_ID") {
    // One-active-helper instance id (v2.1.60, header note 32):
    // only the bridge on the AutoLaunch origin may ask — same
    // sender discipline as the install id above. The Extension
    // page's takeover button writes this id onto the user's own
    // settings row as the lease holder; the answer is the
    // instance UUID itself (never a user id, never the token).
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    (async () => {
      const instanceId = await getOrCreateInstanceId();
      sendResponse({ instanceId });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_CAPTURE_CHAT" && message.capture) {
    // Only the capture script on facebook.com may hand us a chat —
    // same sender discipline as the ping above.
    const fromFb = (sender.tab && sender.tab.url || "").startsWith("https://www.facebook.com/");
    if (!fromFb) return;
    (async () => {
      try {
        const result = await handleCaptureChat(message.capture);
        sendResponse(Object.assign({ ok: true }, result));
      } catch (err) {
        console.warn("[AutoLaunch] chat capture failed:", err && err.message ? err.message : err);
        sendResponse({ ok: false, error: (err && err.code) || "save_failed" });
      }
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_CHAT_SNIPPETS" && Array.isArray(message.snippets)) {
    const fromFbSnip = (sender.tab && sender.tab.url || "").startsWith("https://www.facebook.com/");
    if (!fromFbSnip) return;
    (async () => {
      try { await handleChatSnippets(message.snippets); } catch (e) { /* next pass retries */ }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_REPLY_RESULT" && message.messageId) {
    // Only a Facebook tab may report a delivery (same discipline as
    // the job-finish messages). The result flips the queued reply's
    // status in the database — that status is the rep's receipt.
    const senderUrl = (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    (async () => {
      await finishOutboundReply(message.messageId, !!message.ok, message.error || null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_SET_USER_ID" && message.userId) {
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    (async () => {
      const updates = { autolaunch_user_id: message.userId };
      let freshToken = false;
      if (message.accessToken) {
        const { autolaunch_access_token: oldToken } =
          await chrome.storage.local.get(["autolaunch_access_token"]);
        if (message.accessToken !== oldToken) {
          // A NEW token revives an expired session: store it, clear the
          // expired stop, and (below) replay any stashed job finish
          // before resuming claims. The token value is never logged.
          updates.autolaunch_access_token = message.accessToken;
          updates.autolaunch_session_expired = false;
          freshToken = true;
        }
      }
      await chrome.storage.local.set(updates);
      sendResponse({ status: "connected" });
      if (freshToken) await flushPendingFinish();
      checkQueue();
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_SYNC_REQUEST") {
    // App-driven inbound sync (v2.1.38): the Prospects screen asks for
    // a capture pass NOW because the Facebook tab's own timers are
    // throttled while it sits in the background. Only the bridge on
    // the AutoLaunch origin may ask. We drive the best Facebook tab's
    // capture script and answer only when it confirms the writes.
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    (async () => {
      let synced = false;
      try {
        const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*"] });
        // Ask EVERY Facebook tab (v2.1.39): each one captures what
        // IT can see — a list tab contributes snippets, the thread's
        // own tab the full conversation. The first version stopped at
        // the first tab that answered, which starved the thread tab
        // whenever another tab replied first.
        const attempts = tabs.slice(0, 3).map(t => new Promise(resolve => {
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 8000);
          try {
            chrome.tabs.sendMessage(t.id, { type: "AUTOLAUNCH_SYNC_NOW" }, resp => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(!chrome.runtime.lastError && !!(resp && resp.ok));
            });
          } catch (e) {
            if (!done) { done = true; clearTimeout(timer); resolve(false); }
          }
        }));
        const results = await Promise.all(attempts);
        synced = results.some(Boolean);
      } catch (e) { /* answer what we have */ }
      sendResponse({ ok: synced });
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_NUDGE_OUTBOUND") {
    // Only the bridge on the AutoLaunch origin may nudge (same sender
    // discipline as the login handoff). Runs the outbound claim
    // immediately — the 1-minute alarm stays as the safety net.
    const fromApp = isAppUrl(sender.tab && sender.tab.url);
    if (!fromApp) return;
    checkOutboundReplies();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AUTOLAUNCH_FETCH_PHOTO") {
    // Only the Facebook content script may use the relay (it is the one
    // CORS-blocked from dealer photo servers), and only real URLs — the
    // http(s) check lives in fetchPhotoForContent.
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    fetchPhotoForContent(message.url)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "photo_relay_failed" }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_FETCH_VIDEO") {
    // Intro-video relay (v2.1.53, header note 27): same sender
    // discipline as the photo relay — only the Facebook content
    // script may use it, and only real URLs (the http(s) check
    // lives in fetchVideoForContent).
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    fetchVideoForContent(message.url)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "video_relay_failed" }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_LIVENESS") {
    // Job liveness (v2.54, header note 28): same sender
    // discipline as the relays above — only the Facebook
    // content script may ask. The verdict is definitive-only
    // (jobLivenessVerdict); even a handler-level failure
    // answers live, never an abort.
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    jobLivenessVerdict(message.queueId)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ live: true }));
    return true;
  }


  if (message.type === "AUTOLAUNCH_CDP") {
    // Only the Facebook content script may drive trusted input, and only
    // on its own tab (sender.tab is authoritative — content scripts
    // cannot spoof another tab's id).
    const tabId = sender && sender.tab && sender.tab.id;
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (tabId == null || !senderUrl.startsWith("https://www.facebook.com/")) return;
    handleCdp(message, tabId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: "cdp_error: " + (err && err.message || "unknown") }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_FIELD_DIAG") {
    // A required field defeated every fill rung. Record the forensics
    // (element identity, rungs attempted, value read back) in the same
    // failure log the job reasons land in, so the NEXT failure is never
    // a guessing game. Reason strings + element metadata only.
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    const diag = message.diag || {};
    logFailure(message.queueId || null, "field_diag:" + (diag.field || "unknown"), {
      field: diag.field || null,
      element: diag.element || null,
      rungsAttempted: Array.isArray(diag.rungsAttempted) ? diag.rungsAttempted : [],
      readBack: diag.readBack != null ? String(diag.readBack) : null,
      expected: diag.expected != null ? String(diag.expected) : null,
      cdpError: diag.cdpError || null,
      note: diag.note || null,
      detail: diag.detail != null ? String(diag.detail) : null
    })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_POSTED") {
    finishJobPosted(message.queueId, message.listingUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_DELETED") {
    // Only the Facebook content script reports deletes (same sender
    // discipline as the other job-finish messages' storage contract —
    // finishJobDeleted additionally requires the id to match the
    // currently claimed job).
    // v2.1.16 second witness: a delete may only be CLAIMED from the
    // Selling page. Facebook's SPA can drift the job tab elsewhere
    // (Friend Requests, 2026-10-23) without a reload, and a report
    // from any other page is a scan of the wrong room — refuse it
    // and fail the job honestly instead of clearing the stamp.
    const senderUrl = (sender && sender.tab && sender.tab.url) ||
      (sender && sender.url) || "";
    if (!/^https:\/\/www\.facebook\.com\/marketplace\/you\/(selling|dashboard)/.test(senderUrl)) {
      finishJobFailed(message.queueId,
        "delete_reported_from_wrong_page:" + senderUrl.slice(0, 80), [])
        .then(() => sendResponse({ ok: false }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    finishJobDeleted(message.queueId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_SHARED") {
    // Same Selling-page sender discipline as AUTOLAUNCH_JOB_DELETED
    // (v2.1.55): a share may only be CLAIMED from the Selling page —
    // a report from anywhere else is a scan of the wrong room.
    const senderUrl = (sender && sender.tab && sender.tab.url) ||
      (sender && sender.url) || "";
    if (!/^https:\/\/www\.facebook\.com\/marketplace\/you\/(selling|dashboard)/.test(senderUrl)) {
      finishJobFailed(message.queueId,
        "share_reported_from_wrong_page:" + senderUrl.slice(0, 80), [])
        .then(() => sendResponse({ ok: false }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    finishJobShared(message.queueId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_FAILED") {
    finishJobFailed(message.queueId, message.reason, message.diags)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Handshake path 2 (legacy, kept for compatibility): a page that knows the
// extension id can still set the user id externally. manifest.json limits
// this to the AutoLaunch origin via externally_connectable.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SET_USER_ID" && message.userId) {
    chrome.storage.local.set({ autolaunch_user_id: message.userId }, () => {
      sendResponse({ status: "connected" });
      checkQueue();
    });
    return true;
  }
});
