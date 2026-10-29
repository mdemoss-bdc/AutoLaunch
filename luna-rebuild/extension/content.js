// AutoLaunch Vehicle Assistant — Marketplace form filler (v3)
//
// Phase 3 changes vs the original:
//  1. REACT-SAFE VALUES: the old code set element.value directly, which
//     React controlled inputs ignore. This version uses the native
//     prototype value setter + input/change events React actually tracks.
//  2. MORE FIELDS: year, make, model, trim (title), price, mileage,
//     condition, fuel, transmission, body style and description — matched
//     by label/aria text, with a combobox path for Facebook's dropdown
//     style fields. The old code filled price, mileage and one textarea.
//  3. PHOTOS ARE CHECKED: an upload that does not produce a preview is a
//     loud failure (banner + job marked failed), never a silent continue.
//  4. POSTED MEANS POSTED: the old code waited a fixed 2 seconds and then
//     wrote "completed" no matter what happened. This version NEVER marks
//     posted on a timer. It reports POSTED only after detecting a real
//     success state on Facebook (listing URL or "your listing is live"
//     style confirmation). Anything else — timeout, checkpoint, missing
//     Publish button — reports FAILED with a reason.
//  5. CONFIRM MODE (default ON): fill everything, then stop and let the
//     human review and click Publish. Detection keeps watching, so the
//     human click still produces a real posted confirmation. Turn it off
//     in chrome.storage (autolaunch_confirm_mode = false) for full-auto.
//     Since v2.1.4 the user-facing switch is the app's Settings →
//     Automation → "Full Auto posting" toggle, which reaches this
//     script as job.fullAuto (header note 14); the storage flag
//     remains only as a local override when the setting is off.
//     Confirm mode still advances "Next" steps itself — navigation is
//     not publishing; it stops only before the actual Publish button.
//  6. CHECKPOINTS STOP THE JOB: a Facebook login wall or identity
//     checkpoint fails the job immediately. Never type into one.
//  7. PHOTO FETCH GOES AROUND CORS: this script runs on facebook.com, so
//     a direct fetch of a dealer photo URL is cross-origin — and dealer
//     photo servers send no Access-Control-Allow-Origin, so the fetch
//     died and every job failed with photo_download_failed (proven in
//     the first live test). Photos are now fetched two ways, in order:
//     (a) relayed through the background worker (extension fetches are
//     not page-CORS-bound; bytes come back base64), then (b) the
//     photo-proxy Edge Function, which returns CORS *. Only if BOTH fail
//     does the job fail honestly — a photoless car is never posted.
//  8. VERIFY-OR-REPORT (second live test): photos, description, location
//     and transmission filled fine, but Year/Make/Model/Price were left
//     EMPTY while the banner claimed "Everything is filled in". Never
//     again: after filling, every required field is READ BACK from the
//     DOM and compared to the payload; a mismatch gets one re-fill and a
//     re-verify; anything still wrong fails the job with reason
//     fields_unfilled:<list> and a banner naming the fields. The banner
//     may only claim "everything is filled" when verification passed.
//  9. MULTI-STEP FORM + THE VIN TRAP: Facebook's vehicle flow is now
//     stepped (step 1: VIN, vehicle type, photos, year/make/model,
//     price, description; step 2: body style, colors, condition, fuel,
//     transmission, clean title, and a SECOND description box that
//     starts empty). The filler walks the steps itself. And entering a
//     VIN makes Facebook auto-populate from its decoder — observed live
//     rewriting a 2016 Hyundai Tucson as a "2020 Honda Accord" — so the
//     VIN goes in FIRST, the decoder is given time to settle, and every
//     other field is then set from the payload and verified against it.
// 10. ESCALATION LADDER + DIAGNOSTICS (third live test): verify-or-
//     report worked exactly as designed — the photos (12) and the rich
//     description landed, and the job FAILED honestly because Year,
//     Make, Model and Price STILL would not stick: Facebook commits
//     those four only through its suggestion-listbox selection /
//     trusted input pipeline, and React resets DOM-set values. Those
//     fields now climb a ladder until a read-back matches — rung 1: the
//     v2 native-setter / combobox logic; rung 2: synthetic keyboard
//     (select-all + Delete, execCommand insertText, then a per-character
//     keydown/keypress/beforeinput/input/keyup flurry, with comboboxes
//     committed by clicking the exact-match suggestion option); rung 3:
//     CDP trusted input driven by the background worker
//     (chrome.debugger: real mouse clicks, Input.insertText, real key
//     events). Verify-or-report remains the final arbiter after the
//     ladder. A field that defeats all three rungs leaves a forensic
//     record — element tag/type/role/aria-label + outerHTML head, the
//     rungs attempted, the value read back — in autolaunch_failure_log
//     (via AUTOLAUNCH_FIELD_DIAG), so a fourth failure can never be
//     blind. While rung 3 is attached, Chrome shows a "…is debugging
//     this browser" infobar; it disappears on detach, which happens
//     when the fill sequence ends or the job finishes/fails.
// 11. DIAG-TO-DB + SINGLE-SHOT PHOTOS (v3.1, fourth live test): run 4
//     proved the installed build really was 2.1.0 (extensions card) and
//     the honesty layer held — yet the field_diag records NEVER
//     surfaced in autolaunch_failure_log where Matthew went to read
//     them (two bare {at, queueId, reason} entries, no diag extras),
//     so the failure stayed blind. The records now also ride the
//     AUTOLAUNCH_JOB_FAILED message itself, and the worker writes them
//     into the queue row's error_message column — evidence readable
//     straight from the database, no console archaeology. Each record
//     is also printed as ONE JSON line to this page's console:
//     "[AutoLaunch] field_diag {...}".
// 12. FIELD LOCATION + NEVER-EMPTY DIAGNOSTICS (v3.2, fifth live test):
//     run 5 was the giveaway — error_message stayed NULL under a
//     working diag-to-DB, meaning jobDiags was EMPTY: the ladder and
//     its forensics never ran at all. Root cause: fieldLabel() only
//     read an element's OWN aria-label / placeholder / label[for], and
//     Facebook's current variant carries the labels ("Year", "Make",
//     "Model", "Price") as sibling text inside a container div — the
//     controls themselves are bare. findAnyField therefore returned
//     null for exactly those four fields: fieldPresent was false, the
//     fillers skipped them, requiredSpecForStep excluded them, and
//     the aggregation failed them honestly with nothing to report.
//     (The fields that always worked — Location, Description,
//     Transmission — are the ones locatable by own attributes or a
//     fallback.) Location now also scores CONTAINER label text: an
//     ancestor's leading text segment or label-ish child, matched
//     exactly or as a prefix, among VISIBLE candidates — tried only
//     AFTER the own-label match, so nothing that located before moves.
//     Clickable divs ([role="button"], [aria-haspopup]) join the
//     candidate set for the select-like fields (the Year control in
//     this variant is a chevron div). And the diagnostics can no
//     longer be empty: a required field that fails WITHOUT ever being
//     located gets a synthesized record (note "field_not_located")
//     plus ONE "form_map" record — the first ~12 visible controls on
//     the failing step with their computed container labels — so any
//     future Facebook label change is visible in the DB on the first
//     failed run, not the fifth.
//     And the photo step (also v3.1) had a multiplication bug:
//     Facebook MERGES every input.files assignment
//     into its uploader's internal list, and the old code assigned a
//     GROWING DataTransfer once per photo — 1+2+…+12 ≈ 70 photos —
//     compounded by dedupe treating the same image at width=500
//     (image_url) and width=1600 (photos[]) as two different photos.
//     Photos are now deduped by normalized URL (the width parameter is
//     ignored; the widest variant wins), all bytes are fetched first,
//     and the finished set is assigned EXACTLY ONCE. The preview count
//     is verified afterwards: more previews than intended is a banner
//     warning, not a failure; past Facebook's 20-photo ceiling the
//     filler removes extras via the tiles' remove buttons, or fails
//     honestly with photo_overflow.
// 13. STEP-2 COLORS + CLEAN TITLE (v2.1.3 / filler v3.3, sixth live
//     test — the FIRST SUCCESSFUL POST): the Tucson went live, but
//     Matthew had to pick the colors by hand and the clean-title box
//     stayed unchecked. Root causes, all in the old step-2 code: the
//     color fillers received the RAW dealer string ("Mojave Sand") as
//     the only candidate and matched it literally against Facebook's
//     fixed option list — a name that isn't verbatim in the list can
//     never match; the listbox path clicked with a bare .click() and
//     a fixed wait; the combobox fallback only locates <input>s; and
//     the result was discarded with no read-back, so the misses were
//     silent by construction. Colors now go through a dedicated path:
//     the string is normalized against the options ACTUALLY offered
//     at runtime (a synonym table ranks candidates — sand/tan/khaki/
//     mojave/desert → Beige/Tan, graphite/granite/charcoal → Gray,
//     pearl-with-a-hue → the hue), the dropdown is opened with the
//     realistic-click machinery (CDP click fallback), options are
//     collected document-wide (they render in a portal), the pick is
//     READ BACK from the trigger, and a miss retries once with the
//     next-best candidate. Clean title: the locator now also accepts
//     the labelled clickable row (this variant's control is a custom
//     div), clicks with the same machinery, and verifies the checked
//     state. Step-2 fields stay best-effort — they can never fail a
//     job — but every outcome is now recorded as a non-fatal step
//     note on the diagnostic channel (field name, note code, the
//     requested/chosen values in `detail`, the read-back), so a
//     silent miss is impossible from here on.
// 14. FULL AUTO VIA SETTING + DELETE JOBS (v2.1.4): two features ride
//     this script now, routed by the job payload the worker builds at
//     claim time. (a) FULL AUTO: Matthew asked for hands-free posting
//     — user_settings.full_auto_enabled is read by the worker and
//     carried as job.fullAuto; when true, confirm mode is OFF and,
//     after the verify gate passes, this script clicks through any
//     remaining Next steps and clicks Publish itself, then demands
//     the SAME success detection confirm mode uses before reporting
//     posted. Absent/false keeps the long-standing default (confirm
//     mode, human clicks Publish). (b) DELETE JOBS (job.action ===
//     "delete", from the app's "Remove from Facebook"): the script
//     now also runs on marketplace/you/selling, where a dedicated
//     routine finds the ONE listing card matching the car's
//     year/make/model AND price (strict — both required; zero or
//     multiple matches delete NOTHING and fail honestly), deletes it
//     through its ⋯ menu + Facebook's confirmation dialog, and only
//     reports AUTOLAUNCH_JOB_DELETED after the card is verifiably
//     gone. URL guards route the two routines: a post job never runs
//     off the create pages, a delete job never runs off the selling
//     pages.
// 15. PREVIEW-PANEL EXCLUSION (v2.1.4 — from the 2.1.3 live repost):
//     the Tucson filled PERFECTLY (both colors color_set on the real
//     step-2 comboboxes) and then FAILED on the final audience step:
//     the per-step scan matched elements inside Facebook's PREVIEW
//     pane — its description text contains "Price: $11,327" and
//     "Exterior color: Beige", and the nearest clickable is the
//     description's "See less" expander — so Price was laddered
//     against a div[role=button] reading back "See less", a phantom
//     field. Matthew had to click Publish himself on a perfect form.
//     Field location and verification now consider the FORM REGION
//     ONLY: isInPreview walks a candidate's ancestors and rejects it
//     when the chain passes through the preview pane (a container
//     labelled "Preview" by its leading text, an aria-label, or a
//     direct "Preview" heading child), and a generic clickable whose
//     whole text is a UI chrome word ("See less", "See more",
//     "Learn more", …) is treated as not-a-field at all. The
//     audience step presents NO required fields in the form region,
//     so required-spec construction finds nothing there and the step
//     is simply complete — fields verified on earlier steps stay
//     verified; nothing is resurrected from preview text. The same
//     region discipline applies to the nearby-text fallback: it
//     stops climbing at the first ancestor that CONTAINS the preview
//     pane, because a shared ancestor's aggregated text spans both
//     regions — the v2.1.4 harness caught the audience step's own
//     Publish button being "located" as Price through exactly that
//     bleed and laddered (it survived only because read-back kept
//     failing honestly).
// 16. STRUCTURAL FIELD GATING (v2.1.5 — the ghost's third mask, the
//     2.1.4 Full Auto live run): the form filled perfectly AGAIN
//     (both colors color_set), reached the audience step — and
//     failed on the preview AGAIN, wearing a new face. This time the
//     matched element was the preview card's LOCATION-MAP button
//     (div[role=button], aria-label "View listing location"): the
//     diag shows ExteriorColor attempted against it
//     (color_options_never_opened) and Price laddered through all
//     three rungs against it, expected "11327", readBack "". Why
//     note 15's defenses missed: on the live page the "Preview"
//     heading is a small label rendered ABOVE the card — a SIBLING
//     of the card, not an ancestor of its contents — and the card
//     is nested too deep for the 8-level ancestor climb to reach
//     any "Preview"-labelled container; the card's own leading text
//     is the car title. nearbyText then aggregated the card's prose
//     (it contains "Exterior color: Beige" and the description's
//     "Price: $11,327") and landed on the map button, and the
//     chrome guard only checked the element's OWN text ("See less")
//     — the map button's own text is EMPTY, so the guard passed it.
//     (The 2.1.4 harness passed because its stub modelled the pane
//     as a text-labelled ancestor container; live structure
//     differs.) Text heuristics are therefore DEMOTED to backstops.
//     The primary defenses are now structural:
//       (1) REAL-CONTROL GATING: a step's field spec — and ALL
//           field location — only exists when the step contains at
//           least one REAL form control (input / textarea / select
//           / [role=combobox] / [role=textbox] / a listbox dropdown
//           trigger / [contenteditable])
//           in the form region. The audience step has none (its
//           left column is checkboxes and buttons), so its spec is
//           EMPTY BY CONSTRUCTION: no location runs, nothing can be
//           resurrected, the step completes, and Full Auto clicks
//           Publish. Clickable divs are eligible as select-like
//           fields only on steps where real controls exist.
//       (2) MEDIA/CHROME EXCLUSION: an element is never a field
//           when its aria-label starts with "View " (View listing
//           location, View photo, …), when its own text OR
//           aria-label is a known chrome phrase, or when its
//           subtree contains media (an <img>, a <canvas>, or an
//           <svg> with a declared size of 48px or more — maps and
//           photos, not 16px chevron icons).
//       (3) PREVIEW BY STRUCTURE: the pane is identified ONCE per
//           step by what it IS, not by its label — the card is the
//           smallest ancestor of the "Seller information" block
//           whose subtree also carries the car's static formatted
//           price AND a photo <img>. Candidates inside a tagged
//           card are excluded everywhere; the nearby-text climb
//           also stops at any ancestor containing a tagged card.
// 17. THE VIN HELP MODAL (v2.1.6 — the 2.1.5 live run's papercut):
//     the first fully-clean run (everything set, both colors, the
//     audience step walked with no phantom) still needed Matthew's
//     hand: Facebook's "Finding your vehicle's VIN" informational
//     modal — a heading, a paragraph about dashboards and door
//     jambs, a blue Close button and an X — kept popping up over
//     the form around the VIN step, and he closed it himself every
//     time. On an unattended Full Auto run that modal would sit
//     over the form intercepting clicks. Two changes: (a) the VIN
//     fill now targets the input element itself, never the labelled
//     wrapper that carries the ⓘ help icon — poking the container
//     is what summons the modal; (b) a modal swatter —
//     dismissInfoModals() — runs before each step's fill, right
//     after the VIN fill + decoder settle, and once more before
//     the final verify/Publish phase. It dismisses ONLY whitelisted
//     informational dialogs: the text must match a known pattern
//     ("Finding your vehicle…"), the dialog must contain no form
//     inputs, and none of its buttons may be a primary or
//     destructive action (Publish / Delete / Confirm / …). Unknown
//     dialogs are never touched — the delete flow's confirmation
//     dialog fails every gate and is left exactly alone. Each
//     dismissal is recorded as a non-fatal step note
//     (info_modal_dismissed, the heading in `detail`).
// 18. ACTIVE POST-PUBLISH VERIFICATION + GOAL-ACHIEVED DELETES
//     (v2.1.7 — two live lessons from 2026-10-22 evening):
//     (a) THE BLIND DETECTOR (the first true Full Auto run, 19:04):
//     the filler filled everything, clicked Publish ITSELF, and
//     Facebook DID post the car (live, "in review") — but the
//     passive success detector never saw a state it knew within
//     2 minutes, so the job was marked FAILED and Luna reconciled
//     the record by hand; the banner's "Check Marketplace drafts"
//     was wrong on top of it (the car was live, not drafted). In
//     confirm mode the same passive vocabulary HAS worked live —
//     post-publish screens evidently vary by path and timing, so a
//     fixed vocabulary is the wrong arbiter. Posted is now decided
//     ACTIVELY: when the passive signals don't fire within a short
//     window (~60s after a Publish click in Full Auto; on expiry
//     of the confirm watch when a click evidently happened), the
//     tab navigates to the Selling page and the DELETE flow's
//     strict matcher (year/make/model AND price, note 14) scans
//     for the listing, read-only. Found (≥1) → posted through the
//     normal completion path (note posted_verified_on_selling_
//     page). Absent → up to 2 rescans ~30s apart (a fresh listing
//     can lag in review); still absent → honest fail with reason
//     publish_unverified and copy that no longer mentions drafts.
//     The continuation rides the stored job (verifyPublished
//     {tries, startedAt}) across the navigation; a 4-minute
//     wall-clock cap makes a reload loop impossible.
//     (b) GOAL-ACHIEVED DELETES (19:07): Matthew deleted the live
//     listing BY HAND, then the queued Remove ran — the scan found
//     zero matches and the job FAILED listing_not_found, leaving
//     marketplace_posted_at set for Luna to clear by hand. But
//     the desired end state — no live listing — was TRUE. A delete
//     scan that ran on a demonstrably-rendered Selling page and
//     found zero strict matches AND zero title-only matches now
//     finishes exactly like a verified delete (JOB_DELETED →
//     completed + stamp cleared; note delete_already_gone). The
//     title-only guard matters: a card carrying this car's title
//     at a DIFFERENT price means the car is still live at another
//     price — that stays an honest listing_not_found failure and
//     the stamp stays set. A page that never rendered its
//     listings region (no markers) proves nothing and also stays
//     a failure, as do login walls and ambiguous matches.
// 19. DELETE STAGE DIAGNOSTICS + CLICK LADDER + EMPTY-STATE FIX
//     (v2.1.9 — two live lessons from 2026-10-22 evening):
//     (a) THE BLIND DELETE (twice, same evening): the delete flow
//     found exactly 1 strict match, then failed with NOTHING in the
//     queue diag past delete_match_scan — every post-scan stage
//     (menu button, menu open, item click, confirm, verify) wrote
//     no step notes, so a failure there was invisible by
//     construction. It succeeded on another machine; the card's
//     ⋯ menu DOES contain "Delete listing" (screenshot-verified:
//     Mark as pending / View listing / List in more places / Edit
//     listing / Delete listing / View messages). The post-scan
//     section now records a step note at EVERY stage —
//     menu_button_found (+ ancestor depth and the matched
//     aria/text descriptor, element snapshot attached) /
//     menu_button_not_found, menu_opened (winning strategy +
//     poll time) / menu_never_opened, menu_items_seen (the actual
//     visible item texts), delete_item_clicked (strategy),
//     confirm_found / confirm_clicked / confirm_dialog_dump (the
//     dialogs that DO exist when the confirm never appears), and
//     verify_passes (one per pass, remaining strict count). A
//     menu that opens without a Delete entry now fails with the
//     NEW reason delete_item_not_found (the dumped item texts
//     ride the diag) instead of the misleading
//     delete_menu_not_found. The interaction is hardened to
//     match: the card is scrolled into view with a settle before
//     its menu is touched; the menu opens via a strategy ladder
//     — realisticClick, cdpClickEl, then a NEW CDP mouse
//     sequence (clickSeq: mouseMoved/mousePressed/pause/
//     mouseReleased via cdpMouseSeqClickEl) — POLLING up to ~3s
//     after EACH rung for a visible [role="menu"] or a found
//     delete item instead of the old fixed 1.2s sleeps; the
//     Delete item gets realisticClick first, a ~2s confirm poll,
//     one cdpClickEl fallback, then a ~4s confirm poll. Strict
//     matching, goal-achieved semantics, the price guard, the
//     checkpoint guard and the verify loop's shape (8 × ~1.5s)
//     are unchanged.
//     (b) THE EMPTY-STATE FALSE FAILURE (~21:03 EDT): Matthew
//     deleted a listing BY HAND, then a cleanup delete job ran on
//     the now-EMPTY selling page and FAILED listing_not_found
//     instead of completing delete_already_gone — even though the
//     page showed the zero-listings empty state ("When you start
//     selling, your listings will appear here.") with the Selling
//     sidebar fully rendered. Root cause (code-provable): the
//     rendered guard was NOT the blocker — that empty-state text
//     matches the pre-existing "when you start selling" signal.
//     The OTHER conjunct failed: the title-only scan counted a
//     hit, and the only element GUARANTEED to carry the car's
//     full title on an empty page is this script's OWN banner —
//     say() had just set it to "Looking for your 2021 Chevrolet
//     Silverado 1500 listing…", the banner is a visible <div>,
//     and listingCardsIn scans every div in the document, so the
//     banner satisfied listingTitleMatches and vetoed
//     goal-achieved. Fixes: the banner carries an id and
//     listingCardsIn excludes it (both scans — a banner that
//     ever named a price could poison the strict scan too);
//     sellingPageRendered() is rebuilt on an explicit signal set
//     (sellingChromeSignals: sidebar/heading labels + listings
//     search + empty-state text variants) so the empty state is
//     POSITIVELY a rendered page while a bare loading page still
//     proves nothing; and the zero-match branch records a
//     delete_zero_match_probe note (strict count, title count,
//     which signals fired, final verdict) BEFORE deciding, so
//     the branch decision itself is diagnosable from
//     error_message alone if it ever misjudges again.
// 26. OUTCOME TRUTH (v2.52 — the 2026-10-28 Passport incident):
//     a post job's recorded outcome disagreed with Facebook three
//     times in three days (failed-but-live Bronco and Passport,
//     orphaned-but-live Prius), and the Passport was then posted
//     TWICE more into "Needs attention" duplicate shells, which
//     the old existence scan cheerfully verified as "posted".
//     Four repairs: (a) verification is STATUS-AWARE — strict-
//     match cards are classified live vs shell (listingCardIs
//     Shell), only a live card satisfies posted, shells alone
//     fail honestly as duplicate_rejected; (b) a persisted
//     publishAttemptedAt marker is stamped before the first
//     Publish click — any flow re-entry with it set skips the
//     fill and goes straight to Selling-page verification, so
//     one job can never submit twice; (c) the Full Auto CDP
//     retry click now requires positive evidence the first
//     click did not submit (publishRetryEvidence: button idle,
//     no navigation, no dialog) — "button still present" alone
//     no longer earns a second click; (d) this same scan serves
//     the worker's orphan recovery (verifyPublished carries
//     orphanRecovery): its "not there" outcomes collapse back
//     to job_orphaned, shells stay duplicate_rejected, and a
//     live card posts the job truthfully.
// 27. INTRO VIDEO ATTACH (v2.1.53 — Intro Video Phase 4;
//     background.js header note 27 carries the claim side):
//     when the job carries a resolved introVideo (the worker
//     looked it up in settings at claim time — nothing was
//     added to queue rows), the fill attaches it AFTER the
//     photos, through the composer's dedicated video input
//     ("Add video", 1 max, 60 seconds max — proven on
//     Matthew's account 2026-10-28), and waits for Facebook's
//     processing to finish before the step walk continues.
//     The clip's duration is probed from the downloaded bytes
//     when the browser will say; over 60s is a skip, not a
//     gamble. STRICTLY FAIL-OPEN: every failure — no input,
//     download failure, over-length, processing timeout —
//     logs a named intro_* skip and the post proceeds exactly
//     as before this version; a stalled processing state is
//     REMOVED first, because the form will not proceed while
//     a video is still loading.
// 28. BOUNDED VIDEO FETCH + JOB LIVENESS (v2.54 — the
//     2026-10-28 Accord wedge): the first live 2.53 post
//     stalled forever at the note-27 attach. The clip download
//     had NO time limit at any layer — the worker relay's bare
//     fetch could hang unsettled, the content-side relay wait
//     inherited the hang, and the banner only changed AFTER
//     the download returned, so the wedge sat silently under
//     "Uploading 20 photo(s)…" for ~55 minutes while the form
//     looked like a photo problem. Three repairs, all
//     fail-open: (a) every stage of the clip download is now
//     bounded — the worker aborts its fetch at 30s (header
//     note 28 there), this script races the relay answer at
//     35s and bounds its direct-fetch fallback at 30s, and
//     the duration probe gives up at 10s (unreadable = proceed,
//     as before); a dead download lands in the EXISTING
//     intro_video_download_failed skip and the post continues
//     without the clip. (b) The banner and console announce
//     "Adding your intro video…" BEFORE the download starts,
//     so any future stall is visibly a video stall. (c) JOB
//     LIVENESS: a tab can outlive its job — the same incident
//     re-drove this fill from the stored job after the worker
//     had already failed the row, because the fill never
//     re-checked anything. Before filling, this script now
//     asks the worker (AUTOLAUNCH_JOB_LIVENESS) whether its
//     stored job is still the live one; ONLY a definitive
//     "no" (the slot moved on, or the queue row is already
//     settled) aborts the fill with a banner note. Any error,
//     timeout or ambiguity proceeds exactly as before.
// 29. SHARE TO FEED (v2.1.55 — Matthew's spec, 2026-10-29;
//     background.js header note 29 carries the worker side):
//     a job with action 'share' runs ONLY on the Selling page
//     and reuses the delete flow's machinery wholesale — the
//     same strict title+price matcher (findListingCards), the
//     same settled-list scan, the same card-menu ladder, the
//     same click-target audit before the confirming click, the
//     same recordStepNote evidence trail (field "Share"). The
//     share itself: open the matched card's menu, click its
//     Share entry, drive Facebook's share dialog — choosing
//     the FEED destination when the dialog offers destinations
//     (a submenu-style feed entry gets the same treatment) —
//     and confirm with the dialog's Post / Share now / Share
//     button. The honest success signal is DIALOG COMPLETION:
//     the dialog must close after the confirm; a dialog still
//     open when the bounded wait ends is share_unverified,
//     never a claimed share. A menu offering no Share entry
//     fails share_item_not_found with menu_items_seen as the
//     evidence — the listing itself is never touched, and the
//     car's posted stamp is never this job's business.
// 30. SHARE HARDENING (v2.1.56 — the 2026-10-29 live proof of
//     note 29 failed two ways; both are fixed here):
//     (a) WRONG LISTING SHARED. Matthew queued a share for a
//     2014 Beetle; his feed received a 2022 Sentra. The strict
//     card match was not the hole — everything after it was:
//     listingMenuButton climbs ancestors, and its per-level
//     trust check counts cards matching THIS job's car, not
//     cards in total, so a wrapper holding several listings
//     passes with the target's neighbours inside it, and the
//     first menu-ish button in document order at that level
//     can be a NEIGHBOUR's ⋯. findShareMenuItem then searches
//     the whole document unanchored, and the share dialog's
//     listing identity was never read at all — "dialog
//     closed" proved A share happened, never WHICH listing
//     was shared. Two gates now stand in the way: before the
//     Share entry is clicked, the strict scan is re-run and
//     the menu button must re-resolve, from the freshly
//     matched card, to the very element this run clicked
//     (menu_anchor_recheck); and inside the dialog phase
//     (driveShareDialog), the identity the dialog itself
//     presents — title tokens + price — is compared with the
//     job's stamped year/make/model + price BEFORE any
//     destination or confirm click, and again on the dialog
//     that reaches the confirm. ANY readable mismatch aborts
//     with share_target_mismatch, the dialog closed
//     unconfirmed. A dialog presenting no readable identity
//     is recorded (share_identity_unreadable) and the share
//     rides on the pre-dialog anchor gate alone — the honest
//     boundary of the guarantee.
//     (b) NO DETAILS IN THE FEED POST. The shared post carried
//     only the listing attachment (photos, price, city,
//     title). The share row now carries the listing's
//     description text (auto_posting_queue.share_text,
//     stamped by both producers from the same builder inputs
//     the posting composer uses), the worker carries it on
//     the job as shareText, and the dialog phase places it in
//     the share composer's text field BEFORE any destination
//     or confirm click, verified by read-back. No text on the
//     job, no field in the dialog, or a failed read-back
//     fails the share share_text_unplaced — a bare share is
//     the bug, never a fallback. The submenu variant (the
//     Share entry opening destination entries directly — no
//     dialog, no identity to verify, no composer) can no
//     longer complete a share, for the same reason.
// 31. SHARE ENTRY + COMPOSER HUNT (v2.1.57 — the 2.1.56
//     live proof failed a second time, and the failed
//     row's own field_diag trail named both causes):
//     (a) THE MENU IS THE WRONG TREE FOR SHARING. The
//     strict match found the Beetle's card and the anchor
//     gate passed on the Beetle's own ⋯ button — but the
//     Beetle's menu contains NO Share entry (its items:
//     Mark as pending / View listing / List in more places
//     / Edit listing / Delete listing / View messages),
//     its item texts were not even readable to the finder,
//     and the document-wide Share search then clicked the
//     dedicated per-card Share button of the Sentra card
//     sitting above it in DOM order ("Share 2022 Nissan
//     Sentra"). Every Selling-page card carries that
//     button, and its aria-label NAMES its listing.
//     runShareListing now clicks the matched card's own
//     Share button: found inside the card (climbing only
//     single-strict-match wrappers, the listingMenuButton
//     discipline), and label-verified against the job
//     before the click — a label carrying the job's year +
//     make + model proceeds, a bare "Share" inside the
//     card proceeds on containment, a label naming a
//     different car aborts share_target_mismatch with the
//     label recorded as evidence. The menu-open ladder and
//     the document-wide share-item search are GONE from
//     the share path. The delete path keeps its menu
//     choreography untouched: "Delete listing" really does
//     live in the menu. Identity assurance now rests on,
//     in order: the strict card match → the label-verified
//     in-card Share click → the dialog identity gate
//     (note 30, unchanged: a readable mismatch still
//     aborts; an identity-free dialog is still recorded
//     share_identity_unreadable and proceeds ONLY because
//     the click that opened it was verified in-card).
//     (b) THE COMPOSER HUNT LOOKED IN ONE DIALOG. After
//     the (wrong) feed destination was clicked, the run
//     found no text field: placeShareText only ever
//     searched the FIRST dialog. The hunt now polls the
//     whole open-dialog stack (bounded settle window),
//     topmost dialog first — Facebook stacks the post
//     composer over the share sheet — accepting textarea /
//     any-contenteditable / textbox fields under a wider
//     hint set, and re-runs after a destination transition
//     (only a placement in the CURRENT stack counts). The
//     confirm is likewise sought in the composer's dialog
//     first. And share_text_unplaced's evidence now
//     carries the topmost dialog's own text (≤600 chars)
//     plus an inventory of every candidate field in the
//     stack, so a further live miss is diagnosable in one
//     round. The mandatory-text rule is unchanged — no
//     placed text, no share — and it is what stopped the
//     2.1.56 incident from becoming a second wrong-car
//     share: the job failed with the Sentra unshared.
// 32. COMPOSER PLACEMENT, ROUND THREE (v2.1.58 — the
//     2.1.57 live proof of note 31 got the BUTTON right:
//     share_button_found recorded "Share 2014 Volkswagen
//     Beetle", verdict match, and that button was clicked.
//     The dialog that opened carried the caption placeholder
//     in its own text — "Share Matthew DeMoss Feed Public
//     Say something about this... Share now Send in
//     Messenger ..." — yet placeShareText found nothing
//     placeable and the job failed share_text_unplaced
//     again, safely, nothing shared. Two defects, both
//     fixed here):
//     (a) THE FINDER ONLY RECOGNISED LIVE EDITORS. The
//     caption surface in this dialog variant is a
//     placeholder shell: an element carrying the hint in
//     an aria-placeholder / data-placeholder attribute
//     (or wearing the placeholder line as its own text)
//     that is NOT yet an editable — Facebook's Lexical
//     editor wakes on a click, or the editable root is
//     the shell's ancestor with the placeholder rendered
//     inside it. The candidate selector now includes
//     placeholder-attribute bearers, and the finder
//     separates INVITING from EDITABLE: an inviting
//     element that is not editable is an ACTIVATION
//     target, never an insert target (writing textContent
//     into a shell would read back as placed while
//     nothing real happened — a false placement, worse
//     than an honest failure). placeShareText's new
//     activation arm resolves the placeholder's editable
//     host (the element itself, else the nearest editable
//     ancestor) and places the text there directly; with
//     no host it clicks the placeholder realistically and
//     re-polls (≤1.5s) for an editable — or the element
//     the click focused — to take the text. And the
//     contenteditable INSERT gains the posting ladder's
//     rung-2 edit: when a raw textContent assignment does
//     not read back (a React/Lexical editor can reconcile
//     it away), the text goes in through execCommand
//     insertText, the browser's real editing pipeline.
//     Read-back still decides every rung.
//     (b) THE 2.1.57 EVIDENCE DIED IN COMPACTION.
//     shareComposerDiag packed the dialog excerpt (≤600
//     chars) and the field inventory into ONE ~1100-char
//     step-note detail, excerpt first — but the worker's
//     compactDiagError slices every record's detail at
//     200 chars, so the stored row kept the excerpt's
//     first ~187 chars and the inventory after them was
//     amputated whole. The diag is now emitted as step
//     notes chunked to ≤185 chars per record (dialog text
//     chunks, then candidate-field chunks), each safely
//     inside the per-record budget; the placeholder
//     element and the post-click focused element join the
//     inventory. The compaction budget is a global
//     contract the other flows' diagnostics are tuned
//     around, so the fix lives here at the producer, not
//     in the worker — the control delta stays content.js
//     + manifest.
//
// 33. DEALERSHIP @MENTION TAG ON FEED SHARES (v2.1.59 —
//     Matthew approved 2026-10-29, after 2.1.58 live-
//     proved the details text): with the proven details
//     text placed and read back, driveShareDialog makes
//     ONE best-effort attempt to append a REAL Facebook
//     mention of the user's dealership Page as the
//     composer's final line, so the shared post carries
//     a clickable tag, not plain text. The name needs no
//     new plumbing: the worker has always carried
//     user_settings.dealership_name on EVERY claimed job
//     (job.dealershipName, line ~1463 — the description's
//     closing block reads it), so share jobs from both
//     producers arrive with it; an empty name means NO
//     tag attempt and a byte-identical 2.1.58 share.
//     Mechanics: the composer field already holding the
//     details text is re-located by content, then the
//     mention line is TYPED through the trusted CDP key
//     pipeline (Ctrl+End, Enter, then "@" + name one real
//     key event per character) — Facebook's mention
//     typeahead only wakes for genuinely typed input,
//     never for whole-value assignment. The typeahead is
//     polled for up to ~2.5s; an option is clicked ONLY
//     when its visible name (its own text or any
//     descendant's, whitespace-normalized, case-
//     insensitive) is an EXACT full-name match — a near
//     match like "Moses Honda" for "Moses Auto Group" is
//     never clicked. The options seen ride the step
//     notes either way. Conversion is verified honestly:
//     a mention/link-marked element inside the composer
//     whose whole text is the name (mention_node), or —
//     the honest fallback for an editor that hides the
//     node shape — the name occurring once MORE than the
//     details text alone contains it, with no raw
//     "@name" residue and the typeahead closed
//     (text_state). Anything else — no typeahead, no
//     exact match, a failed click, unverifiable
//     conversion, trusted typing unavailable, any
//     exception — restores the composer to exactly the
//     proven details text (insertShareTextIntoField
//     gains an optional force flag that skips its
//     already-placed early exit) and the share confirms
//     untagged, exactly like 2.1.58. The tag is garnish:
//     tryShareDealershipTag NEVER calls fail/report, is
//     fully fail-open, and the share's outcome never
//     depends on it. Notes: share_tag_placed /
//     share_tag_option_clicked / share_tag_unmatched /
//     share_tag_skipped, details ≤185 chars like the
//     2.1.58 diag chunks. CDP attach discipline: the
//     attempt detaches only a session it attached.


(async function () {
  const stored = await chrome.storage.local.get([
    "current_posting_job", "autolaunch_confirm_mode"
  ]);
  const job = stored.current_posting_job;
  if (!job || !job.car) return;

  const { queueId, car } = job;

  // Dealership identity for the description's closing block
  // (v2.1.42): the worker reads user_settings.dealership_name /
  // dealership_address at claim time and carries both on the job
  // payload, exactly like fullAuto below. Either may be empty —
  // buildDescription appends whatever exists and never blocks the
  // post on a missing identity.
  const dealershipName = typeof job.dealershipName === "string" ? job.dealershipName.trim() : "";
  const dealershipAddress = typeof job.dealershipAddress === "string" ? job.dealershipAddress.trim() : "";

  // Stock-number preference (v2.1.43): the worker reads
  // user_settings.include_stock at claim time and carries it on the
  // job payload, exactly like the dealership identity above. On,
  // buildDescription adds a "Stock #:" line under the VIN; off (or
  // absent on an older job), the description is unchanged.
  const includeStock = job.includeStock === true;

  // Intro video (v2.1.53, header note 27): the worker resolved
  // the user's preference at claim time and carried the clip on
  // the job payload, exactly like the dealership identity above.
  // Absent (preference off, library empty, lookup failed) means
  // the fill below never touches the video control — the post is
  // byte-identical to before this version.
  const introVideo = (job.introVideo && typeof job.introVideo.url === "string" &&
    job.introVideo.url) ? job.introVideo : null;

  // Share details text (v2.1.56, header note 30): the worker
  // carries the queue row's share_text on share jobs, and the
  // share flow must place it in the share composer before
  // confirming. Absent (a row queued before the column
  // existed, or a producer that could not build it) the share
  // fails honestly rather than posting a bare listing.
  const shareText = typeof job.shareText === "string" ? job.shareText : "";

  // ---- job routing (v2.1.4, header notes 14–15) -----------------------
  // This script is injected on BOTH the create pages and the selling
  // page now. A delete job runs only on the selling page; a post job
  // runs only on the create pages. Without the guards, a leftover job
  // of one kind would fire its routine on the other kind's page.
  const jobAction = job.action === "delete" ? "delete"
    : job.action === "share" ? "share" : "post";
  const pageUrl = window.location.href;
  if ((jobAction === "delete" || jobAction === "share") &&
      !/facebook\.com\/marketplace\/you\/(selling|dashboard)/.test(pageUrl)) return;
  // A post job normally lives only on the create pages — EXCEPT a
  // job in post-publish verification (v2.1.7, header note 18): its
  // tab was navigated to the Selling page to settle posted-vs-not
  // actively, and this script must be allowed to run there (and on
  // the create pages, where the verify routine routes it back).
  if (jobAction === "post" && !job.verifyPublished &&
      !/facebook\.com\/marketplace\/create\//.test(pageUrl)) return;

  // Full Auto (v2.1.4): job.fullAuto is the user's
  // user_settings.full_auto_enabled, read by the worker at claim time.
  // True turns confirm mode OFF — the filler clicks Publish itself.
  // Absent/false keeps the long-standing default: confirm mode unless
  // the chrome.storage override says otherwise.
  const fullAuto = job.fullAuto === true;
  const confirmMode = !fullAuto && stored.autolaunch_confirm_mode !== false; // default ON

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const humanPause = () => sleep(900 + Math.random() * 1600);

  // ---- visible status banner -------------------------------------------
  const banner = document.createElement("div");
  // The id matters beyond styling (v2.1.9, header note 19b): the
  // banner's own text names the car ("Looking for your <title>
  // listing…"), and listingCardsIn excludes this element by id —
  // otherwise the title-only scan matches OUR OWN banner on an
  // empty selling page and vetoes the goal-achieved delete.
  banner.id = "autolaunch-status-banner";
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1d4ed8;" +
    "color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;" +
    "padding:10px 16px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.3)";
  document.documentElement.appendChild(banner);
  const say = (text, color) => {
    banner.textContent = "AutoLaunch: " + text;
    if (color) banner.style.background = color;
  };

  const report = (type, payload) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type, queueId }, payload || {}), () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) { resolve(); }
  });
  // fail(bannerText) or fail(bannerText, storedReason) — the stored
  // reason defaults to the banner text, but machine-readable reasons
  // (fields_unfilled:…) can differ from the human wording.
  const fail = async (bannerText, storedReason) => {
    await cdpDetach(); // a trusted-input session never outlives its job
    say("Stopped — " + bannerText + " This car was marked FAILED in your queue, not posted.", "#b91c1c");
    // The per-field forensic records ride THIS message (v3.1): the
    // worker writes them into the queue row's error_message, where
    // they can be read from the database. jobDiags is declared with
    // the ladder state below and filled by recordFieldDiagnostic —
    // fail() only ever runs after those declarations execute.
    await report("AUTOLAUNCH_JOB_FAILED", {
      reason: storedReason || bannerText,
      diags: jobDiags.slice()
    });
  };
  const failUnfilled = async names => {
    await fail(
      "could not fill: " + names.join(", ") + ".",
      "fields_unfilled:" + names.join(",")
    );
  };

  // ---- pure verification helpers ---------------------------------------
  // [PURE-VERIFY-BEGIN] — extracted and unit-exercised by the test
  // harness; keep these free of DOM/chrome references (element-likes in,
  // values out).
  function normText(v) {
    return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
  }
  function extractValue(el) {
    if (!el) return "";
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      const opts = el.options || [];
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].selected) return String(opts[i].text || opts[i].value || "");
      }
      return String(el.value || "");
    }
    if (typeof el.value === "string") return el.value;
    if (typeof el.value === "number") return String(el.value);
    return String(el.textContent || "");
  }
  function moneyNumber(v) {
    const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? null : n;
  }
  function valueMatches(actual, expected, kind) {
    if (expected == null || expected === "") return true; // nothing to prove
    if (kind === "year") {
      const a = String(actual || "").replace(/\D/g, "");
      const e = String(expected).replace(/\D/g, "");
      return a !== "" && a === e;
    }
    if (kind === "price" || kind === "number") {
      const a = moneyNumber(actual), e = moneyNumber(expected);
      return a !== null && e !== null && a === e;
    }
    if (kind === "contains") {
      return normText(actual).includes(normText(expected));
    }
    const a = normText(actual), e = normText(expected);
    if (!a || !e) return false;
    return a === e || a.includes(e) || e.includes(a);
  }
  // spec: [{ name, kind, expected, read(), refill() }] — read every field;
  // the mismatches get ONE refill each, then a re-read. Resolves to the
  // names still missing/wrong. This is the verify-or-report core.
  async function verifyFieldsWithRefill(spec) {
    const first = {};
    for (const f of spec) {
      try { first[f.name] = f.read(); } catch (e) { first[f.name] = ""; }
    }
    const bad = spec.filter(f => !valueMatches(first[f.name], f.expected, f.kind));
    for (const f of bad) {
      try { await f.refill(); } catch (e) { /* re-read decides */ }
    }
    const missing = [];
    for (const f of bad) {
      let now = "";
      try { now = f.read(); } catch (e) { now = ""; }
      if (!valueMatches(now, f.expected, f.kind)) missing.push(f.name);
    }
    return missing;
  }
  function vehicleTypeCandidates(carLike) {
    const hay = normText(
      (carLike.body_type || carLike.body_style || "") + " " +
      (carLike.make || "") + " " + (carLike.model || ""));
    if (hay.includes("motorcycle")) return ["Motorcycle"];
    if (hay.includes("rv") || hay.includes("camper")) return ["RV/Camper", "RV", "Camper"];
    if (hay.includes("trailer")) return ["Trailer"];
    if (hay.includes("boat")) return ["Boat"];
    // Cars, SUVs and pickups all live under Facebook's Car/Truck type.
    return ["Car/Truck", "Car", "Truck"];
  }
  function bodyStyleCandidates(carLike) {
    const raw = normText(carLike.body_style || carLike.body_type || "");
    const model = normText(carLike.model || "");
    const has = s => raw.includes(s) || model.includes(s);
    if (has("pickup") || has("truck")) return ["Pickup truck", "Truck", "Pickup"];
    if (has("suv") || has("crossover")) return ["SUV", "Crossover"];
    if (has("sedan")) return ["Sedan"];
    if (has("coupe")) return ["Coupe"];
    if (has("hatchback")) return ["Hatchback"];
    if (has("convertible")) return ["Convertible"];
    if (has("minivan")) return ["Minivan", "Van"];
    if (has("van")) return ["Van"];
    if (has("wagon")) return ["Wagon"];
    return raw ? [String(carLike.body_style || carLike.body_type)] : [];
  }
  function cleanTitleWanted(jobLike, carLike) {
    const settings = (jobLike && jobLike.settings) || {};
    if (settings.include_clean_title !== undefined) return !!settings.include_clean_title;
    if (carLike.include_clean_title !== undefined) return !!carLike.include_clean_title;
    if (carLike.clean_title === true) return true;
    if (typeof carLike.title_status === "string" &&
        normText(carLike.title_status).includes("clean")) return true;
    return false;
  }
  // [PURE-VERIFY-END]

  // [PURE-LADDER-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of DOM/chrome
  // references (element-likes and plain values in, plain values out).
  function keyEventInitForChar(ch) {
    let code = "";
    if (/[a-zA-Z]/.test(ch)) code = "Key" + ch.toUpperCase();
    else if (/[0-9]/.test(ch)) code = "Digit" + ch;
    else if (ch === " ") code = "Space";
    return { key: ch, code };
  }
  // The per-character event flurry of rung 2, as data: for each char —
  // keydown, keypress, beforeinput, input, keyup (the order a real
  // keystroke produces, and the one per-keystroke validators expect).
  function typingEventPlan(text) {
    const plan = [];
    for (const ch of String(text)) {
      const init = keyEventInitForChar(ch);
      plan.push({ type: "keydown", key: init.key, code: init.code });
      plan.push({ type: "keypress", key: init.key, code: init.code });
      plan.push({ type: "beforeinput", inputType: "insertText", data: ch });
      plan.push({ type: "input", inputType: "insertText", data: ch });
      plan.push({ type: "keyup", key: init.key, code: init.code });
    }
    return plan;
  }
  // Forensic snapshot of a field element for the failure log.
  function describeElement(el) {
    if (!el) return { tag: null, type: null, role: null, ariaLabel: null, outerHTML: null };
    const get = n => (typeof el.getAttribute === "function" ? el.getAttribute(n) : null);
    return {
      tag: String(el.tagName || "").toLowerCase() || null,
      type: get("type"),
      role: get("role"),
      ariaLabel: get("aria-label"),
      outerHTML: String(el.outerHTML || "").slice(0, 200) || null
    };
  }
  // The CDP wire protocol with the background worker, as data.
  function buildCdpAttach() { return { action: "attach" }; }
  function buildCdpDetach() { return { action: "detach" }; }
  function buildCdpClick(x, y) { return { action: "click", x, y }; }
  function buildCdpClickSeq(x, y) { return { action: "clickSeq", x, y }; }
  function buildCdpInsertText(text) { return { action: "insertText", text: String(text) }; }
  function buildCdpKey(key, code, opts) {
    const cmd = { action: "key", key: String(key), code: String(code || key) };
    if (opts && opts.text) cmd.text = String(opts.text);
    if (opts && opts.modifiers) cmd.modifiers = Number(opts.modifiers) || 0;
    return cmd;
  }
  // [PURE-LADDER-END]

  // [PURE-LOCATE-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of
  // chrome/fetch references (element-likes in, plain values out —
  // parentElement / childNodes / nodeType / tagName / getAttribute /
  // textContent are the only surface used). See header note 12: on
  // Facebook's current variant the label of Year/Make/Model/Price is
  // SIBLING TEXT inside a container div, not an attribute of the
  // control, so location must be able to read the container.
  // Does a subtree contain a form control? (Manual walk, node-capped,
  // so a label-ish child can be recognised by having none.)
  function subtreeHasFormControl(root, cap) {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen++ > (cap || 250)) continue;
      const tag = String(n.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (typeof n.getAttribute === "function") {
        const role = n.getAttribute("role");
        if (role === "combobox" || role === "textbox" || role === "listbox") return true;
      }
      const kids = n.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return false;
  }
  // The label-ish child of a container: its first element child whose
  // subtree holds NO form control and whose text is short (1..40
  // chars) — Facebook renders field labels as exactly such an
  // element. A control-bearing first element child is decisive: the
  // label is not here (""), never a deeper sibling's text.
  function labelishChildText(container) {
    const kids = (container && container.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (!n || n.nodeType !== 1) continue;
      if (subtreeHasFormControl(n)) return "";
      const t = String(n.textContent || "").trim();
      return t.length >= 1 && t.length <= 40 ? t : "";
    }
    return "";
  }
  // A container's leading text: its first non-empty text node, else
  // its label-ish child. Deliberately NOT the container's whole
  // textContent — that would make every ancestor "labelled" with
  // whatever field happens to be listed first inside it.
  function containerLeadingText(container) {
    if (!container) return "";
    const kids = container.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (!n) continue;
      if (n.nodeType === 3) {
        const t = String(n.nodeValue || "").trim();
        if (t) return t.slice(0, 60);
        continue;
      }
      if (n.nodeType === 1) break; // element children: helper below
    }
    return labelishChildText(container);
  }
  // The label a container gives its field: climb up to 5 ancestors
  // and take the first non-empty leading text. The field's own
  // wrapper is met first, so a shared form-group higher up only
  // labels a field when no closer container does.
  function containerLabel(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const t = containerLeadingText(node);
      if (t) return t;
    }
    return "";
  }
  // A container text labels a field when it EQUALS a keyword or
  // STARTS with it at a word boundary ("Price" ✓, "Price in USD" ✓,
  // "Priceless" ✗). Case-insensitive via normText.
  function labelTextMatches(text, keywords) {
    const lt = normText(text);
    if (!lt) return false;
    return (keywords || []).some(k => {
      const nk = normText(k);
      if (!nk) return false;
      if (lt === nk) return true;
      return lt.startsWith(nk) &&
        " :·•-/".includes(lt.charAt(nk.length));
    });
  }
  // [PURE-LOCATE-END]

  // [PURE-COLOR-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of
  // DOM/chrome references (strings in, plain values out). See header
  // note 13: dealer color names ("Mojave Sand", "Granite Crystal
  // Metallic") almost never appear verbatim in Facebook's fixed color
  // list, so the ranking runs against the options ACTUALLY offered at
  // runtime — this block only decides the ORDER to try them in.
  // Each rule: dealer tokens -> Facebook standard names in preference
  // order. Tokens match on word boundaries, or as a word PREFIX for
  // tokens of 4+ chars — so "sand" hits "sandstone" but "tan" never
  // hits "titanium". Hue/family rules come first; the finish-only
  // rule (metallic/pearl) is LAST and applies only when NO family
  // rule matched at all — so "Pearl White" ranks White, not Gray,
  // and "Passion Purple Pearl" with no purple on offer ranks nothing
  // (a known hue, honestly unmatched) instead of a wrong Gray.
  const COLOR_RULES = [
    { tokens: ["mojave", "sandstone", "sand", "desert", "khaki", "tan", "beige", "cashmere", "almond", "dune", "sahara", "camel", "parchment"], prefer: ["Beige", "Tan"] },
    { tokens: ["charcoal", "graphite", "granite", "carbon", "slate", "gunmetal", "anthracite", "magnetic", "ash", "stone", "flint", "boulder", "grigio", "pebble"], prefer: ["Gray", "Silver"] },
    { tokens: ["silver", "platinum", "chrome", "steel", "pewter", "tungsten"], prefer: ["Silver", "Gray"] },
    { tokens: ["gray", "grey"], prefer: ["Gray", "Silver"] },
    { tokens: ["white", "ivory", "cream", "arctic", "alpine", "glacier", "snow", "frost", "linen", "bone"], prefer: ["White", "Beige"] },
    { tokens: ["black", "onyx", "ebony", "jet", "obsidian"], prefer: ["Black"] },
    { tokens: ["crimson", "burgundy", "maroon", "ruby", "wine", "cherry", "garnet", "claret", "red"], prefer: ["Red"] },
    { tokens: ["navy", "sapphire", "cobalt", "azure", "aqua", "sky", "royal", "blue"], prefer: ["Blue", "Teal"] },
    { tokens: ["teal"], prefer: ["Teal", "Blue", "Green"] },
    { tokens: ["emerald", "forest", "olive", "sage", "mint", "green"], prefer: ["Green", "Teal"] },
    { tokens: ["chocolate", "espresso", "mocha", "coffee", "walnut", "cocoa", "bronze", "copper", "brown", "cognac", "truffle", "mahogany"], prefer: ["Brown", "Beige"] },
    { tokens: ["champagne", "gold"], prefer: ["Gold", "Beige", "Tan"] },
    { tokens: ["tangerine", "sunset", "orange"], prefer: ["Orange", "Red"] },
    { tokens: ["violet", "plum", "lavender", "eggplant", "purple"], prefer: ["Purple", "Pink"] },
    { tokens: ["magenta", "fuchsia", "rose", "pink"], prefer: ["Pink", "Purple"] },
    { tokens: ["lemon", "yellow"], prefer: ["Yellow", "Gold"] },
    { tokens: ["metallic", "pearl", "pearlescent", "mica", "tricoat", "clearcoat"], prefer: ["Gray", "Silver"], finish: true }
  ];
  function colorTokenHit(rawNorm, token) {
    const tok = normText(token);
    if (!tok || !rawNorm) return false;
    if (tok.includes(" ")) return rawNorm.includes(tok);
    return rawNorm.split(/[^a-z0-9]+/).some(w =>
      w === tok || (tok.length >= 4 && w.startsWith(tok)));
  }
  // Rank the options Facebook is ACTUALLY offering for a dealer color
  // string, best first. Returns option texts verbatim, as offered.
  // Order: (1) an option exactly equal to the raw string; (2) the
  // synonym rules in table order, each preferred standard name matched
  // against the offered options (exact, then containment); (3) an
  // offered option whose name appears as a word inside the raw string
  // (a hue the table missed). Empty array = nothing offered is a
  // defensible match — the caller records that and moves on.
  function rankColorOptions(rawColor, optionTexts) {
    const raw = normText(rawColor);
    if (!raw || !Array.isArray(optionTexts)) return [];
    const offered = [];
    for (const t of optionTexts) {
      const text = String(t == null ? "" : t);
      const norm = normText(text);
      if (norm && !offered.some(o => o.norm === norm)) offered.push({ text, norm });
    }
    const ranked = [];
    const push = text => { if (text && !ranked.includes(text)) ranked.push(text); };
    const exact = offered.find(o => o.norm === raw);
    if (exact) push(exact.text);
    let familyMatched = false;
    for (const rule of COLOR_RULES) {
      if (!rule.tokens.some(tok => colorTokenHit(raw, tok))) continue;
      if (rule.finish) {
        if (familyMatched) continue; // a hue was named; finish can't speak for it
      } else {
        familyMatched = true;
      }
      for (const pref of rule.prefer) {
        const pn = normText(pref);
        const hit = offered.find(o => o.norm === pn) ||
          offered.find(o => o.norm.includes(pn) || pn.includes(o.norm));
        if (hit) push(hit.text);
      }
    }
    const rawWords = raw.split(/[^a-z0-9]+/);
    for (const o of offered) {
      if (rawWords.includes(o.norm)) push(o.text);
    }
    return ranked;
  }
  // v2.1.19 — last-resort coordinating default. rankColorOptions
  // returning [] used to leave the color UNSET, and Facebook keeps
  // the form's Next button disabled while a required color is
  // unset: the 2026-10-23 Focus post filled perfectly, then died
  // at "could not reach the Publish button" because the dealer's
  // interior name ("Medium Light Stone") matched no rule. When the
  // name carries no recognizable hue at all — or the car has NO
  // color recorded — Matthew's call is to default to a coordinating
  // neutral rather than lose the post: Gray when offered, else
  // Charcoal, else the first offered option. The caller records a
  // color_defaulted step note whenever this fires, so a defaulted
  // color is never a silent one.
  function defaultColorOption(optionTexts) {
    if (!Array.isArray(optionTexts)) return null;
    const offered = [];
    for (const t of optionTexts) {
      const text = String(t == null ? "" : t);
      if (normText(text) && !offered.some(o => normText(o) === normText(text))) offered.push(text);
    }
    if (!offered.length) return null;
    for (const pref of ["gray", "charcoal"]) {
      const hit = offered.find(t => normText(t) === pref);
      if (hit) return hit;
    }
    return offered[0];
  }
  // [PURE-COLOR-END]

  // [PURE-DELETE-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of
  // DOM/chrome references (strings/plain values in, plain values
  // out). See header note 14: a "Remove from Facebook" delete job may
  // only ever delete the ONE listing that is certainly the queued
  // car, so the match is STRICT — the card's text must carry the
  // year/make/model AND a dollar amount exactly equal to the car's
  // price. No price on the payload = no match, ever.
  function priceAmountsIn(text) {
    const out = [];
    const re = /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
    let m;
    const s = String(text == null ? "" : text);
    while ((m = re.exec(s)) !== null) {
      const n = moneyNumber(m[1]);
      if (n !== null) out.push(n);
    }
    return out;
  }
  function listingTextMatches(text, carLike) {
    if (!text || !carLike) return false;
    const t = normText(text);
    const year = String(carLike.year || "").replace(/\D/g, "");
    const make = normText(carLike.make);
    const model = normText(carLike.model);
    if (!year || !make || !model) return false;
    const joined = normText(
      `${carLike.year || ""} ${carLike.make || ""} ${carLike.model || ""}`);
    const titleOk = t.includes(joined) ||
      (t.includes(year) && t.includes(make) && t.includes(model));
    if (!titleOk) return false;
    const price = moneyNumber(carLike.price);
    if (price === null || price <= 0) return false; // strict: no price, no match
    return priceAmountsIn(text).some(n => n === price);
  }
  // Title half of the strict match, alone (v2.1.7): used by the
  // delete flow's goal-achieved semantics — a card carrying this
  // car's year/make/model at ANY price proves the car is still
  // listed (at another price), which is NOT the same as gone.
  function listingTitleMatches(text, carLike) {
    if (!text || !carLike) return false;
    const t = normText(text);
    const year = String(carLike.year || "").replace(/\D/g, "");
    const make = normText(carLike.make);
    const model = normText(carLike.model);
    if (!year || !make || !model) return false;
    const joined = normText(
      `${carLike.year || ""} ${carLike.make || ""} ${carLike.model || ""}`);
    return t.includes(joined) ||
      (t.includes(year) && t.includes(make) && t.includes(model));
  }
  // Shell classification (v2.52, header note 26): a strict-match
  // card is NOT necessarily a listing. When Facebook refuses a
  // duplicate submission it still renders a card for the car on
  // the Selling page — under "Needs attention", carrying the
  // banner "This looks like a duplicate so we didn't post it.
  // Delete it and try again." (screenshot-verified 2026-10-28,
  // the Passport incident). The card's own status line still
  // reads "Active · Listed on …", so the rejection wording is
  // the only truthful discriminator. A card is a SHELL when its
  // text carries any of these signals; verification may only
  // ever be satisfied by a NON-shell card.
  const SHELL_TEXT_SIGNALS = [
    "looks like a duplicate",
    "didn't post it",
    "did not post it",
    "delete it and try again",
    "needs attention"
  ];
  function listingCardIsShell(text) {
    if (!text) return false;
    const t = normText(text).replace(/[\u2019\u2018]/g, "'");
    return SHELL_TEXT_SIGNALS.some(sig => t.includes(sig));
  }
  // Split strict-match cards into live listings vs rejected
  // shells (element-likes in, element-likes out; reads only
  // textContent, which the scan already relies on).
  function classifyListingCards(cards) {
    const live = [], shells = [];
    for (const el of cards || []) {
      const text = (el && el.textContent) || "";
      (listingCardIsShell(text) ? shells : live).push(el);
    }
    return { live, shells };
  }
  // [PURE-DELETE-END]

  // ---- React-safe value setting -----------------------------------------
  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fieldLabel(el) {
    const aria = el.getAttribute("aria-label") || "";
    const ph = el.getAttribute("placeholder") || "";
    let lab = "";
    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`);
      if (l) lab = l.textContent || "";
    }
    // aria-labelledby (v2.1.22): Facebook's current dropdown
    // controls are <label role="combobox" aria-labelledby="…">
    // elements whose visible field name ("Exterior color", and by
    // the same pattern "Year") lives in the referenced node — not
    // in aria-label, placeholder, or a label[for]. Without
    // resolving it, the control's own-label strategy is blind and
    // location falls through to weaker strategies.
    let labelledby = "";
    const lb = typeof el.getAttribute === "function"
      ? el.getAttribute("aria-labelledby") : null;
    if (lb) {
      for (const id of String(lb).split(/\s+/)) {
        if (!id) continue;
        const n = document.getElementById ? document.getElementById(id) : null;
        if (n) labelledby += " " + (n.textContent || "");
      }
    }
    return (aria + " " + ph + " " + lab + " " + labelledby).toLowerCase();
  }

  // Does a subtree contain the preview pane? (Node-capped walk; the
  // tests mirror isInPreview's: a "Preview"-labelled container or a
  // whole-text "Preview" heading with no form control inside.)
  function subtreeContainsPreview(root) {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen++ > 400) continue;
      if (n.nodeType === 1) {
        if (normText(n.textContent) === "preview" && !subtreeHasFormControl(n)) return true;
        if (labelTextMatches(containerLeadingText(n), ["preview"])) return true;
      }
      const kids = n.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return false;
  }

  // Wider label context for elements whose label lives in an ancestor
  // (Facebook wraps fields in labelled containers; checkboxes especially).
  function nearbyText(el) {
    let text = fieldLabel(el);
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      // REGION-BLEED STOP (v2.1.4, header note 15): an ancestor that
      // CONTAINS the preview pane aggregates the preview's prose
      // ("Price: $11,327", "Exterior color: Beige") together with the
      // form's text — its text is evidence about the whole page, not
      // about this element. The first harness run proved the bleed is
      // real even for form-region elements: on the audience step the
      // Publish button itself was "located" as Price through a shared
      // ancestor's text and laddered. Stop before such an ancestor;
      // everything above it spans the preview too.
      if (subtreeContainsPreview(node) || containsTaggedPreview(node)) break;
      text += " " + (node.textContent || "").slice(0, 160);
    }
    return text.toLowerCase();
  }

  // Candidate controls for field location (v3.2). The select-like
  // fields add clickable divs — [role="button"] / [aria-haspopup] —
  // because the Year control in Facebook's current variant is a
  // chevron div, not an input or a native select.
  const FIELD_SELECTOR =
    'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], ' +
    '[role="button"], [aria-haspopup]';

  function isVisibleEl(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    if (typeof el.getClientRects === "function" && el.getClientRects().length) return true;
    return false;
  }

  // ---- preview identification BY STRUCTURE (v2.1.5, header note 16) -----
  // The live lesson of the 2.1.4 Full Auto run: the "Preview" heading
  // is a SIBLING label above the card, too far up a deep ancestor
  // chain for label-based detection to reach from inside the card.
  // So the pane is found by what it IS: Facebook's preview card
  // always carries a "Seller information" block (seller avatar +
  // name) next to the listing's STATIC title/price and a photo. The
  // card is the smallest ancestor of that block whose subtree also
  // holds the car's formatted price as text AND an <img>. Roots are
  // tagged once per step (cached per URL, re-derived when a cached
  // root leaves the document) and every candidate inside a tagged
  // subtree is excluded from field location.
  function subtreeHasImg(root, cap) {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen++ > (cap || 600)) continue;
      if (n.nodeType === 1 && String(n.tagName || "").toUpperCase() === "IMG") return true;
      const kids = n.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return false;
  }
  function findPreviewRoots() {
    const roots = [];
    const priceText = car && car.price
      ? "$" + Number(car.price).toLocaleString("en-US") : "";
    const labels = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3, h4, h5, li, a"));
    for (const lab of labels) {
      if (normText(containerLeadingText(lab)) !== "seller information") continue;
      let root = null;
      let node = lab;
      for (let depth = 0; depth < 10 && !root; depth++) {
        node = node.parentElement;
        if (!node) break;
        const text = String(node.textContent || "");
        if (subtreeHasImg(node) && (!priceText || text.includes(priceText))) root = node;
      }
      if (!root) {
        // Degraded anchor: the first ancestor holding any photo is
        // still the preview's side of the page, never the form's.
        node = lab;
        for (let depth = 0; depth < 10 && !root; depth++) {
          node = node.parentElement;
          if (!node) break;
          if (subtreeHasImg(node)) root = node;
        }
      }
      if (root && !roots.includes(root)) roots.push(root);
    }
    return roots;
  }
  let previewTagCache = null; // { href, roots } — one tagging per step
  function previewRoots() {
    const href = window.location.href;
    if (previewTagCache && previewTagCache.href === href &&
        previewTagCache.roots.every(r =>
          !document.body || (typeof document.body.contains === "function" &&
            document.body.contains(r)))) {
      return previewTagCache.roots;
    }
    const roots = findPreviewRoots();
    previewTagCache = { href, roots };
    return roots;
  }
  function isInTaggedPreview(el) {
    if (!el) return false;
    return previewRoots().some(r =>
      r === el || (typeof r.contains === "function" && r.contains(el)));
  }
  // For the nearby-text bleed stop: does this ancestor CONTAIN a
  // tagged preview card (making its aggregated text cross-region)?
  function containsTaggedPreview(node) {
    if (!node) return false;
    return previewRoots().some(r =>
      r === node || (typeof node.contains === "function" && node.contains(r)));
  }

  // ---- media exclusion (v2.1.5, header note 16) --------------------------
  // A field never CONTAINS media: the preview's map button wraps a
  // map <img>, photo tiles wrap the photos themselves. Walk the
  // candidate's subtree for an <img> or <canvas> (any size — a real
  // control never holds one) or an <svg> with a DECLARED size of
  // 48px or more (maps/photos; a 16px chevron icon inside a real
  // dropdown trigger declares 16 and stays eligible).
  function subtreeHasMedia(root) {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen++ > 300) continue;
      if (n.nodeType === 1) {
        const tag = String(n.tagName || "").toUpperCase();
        if (tag === "IMG" || tag === "CANVAS") return true;
        if (tag === "SVG" && typeof n.getAttribute === "function") {
          const w = parseInt(n.getAttribute("width") || "", 10);
          const h = parseInt(n.getAttribute("height") || "", 10);
          if ((isFinite(w) && w >= 48) || (isFinite(h) && h >= 48)) return true;
        }
      }
      const kids = n.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return false;
  }
  function isMediaChrome(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    return subtreeHasMedia(el);
  }

  // ---- real-control gating (v2.1.5, header note 16) ----------------------
  // THE deterministic kill for the audience-step ghost: field
  // location — and with it spec construction, filling, verification
  // and the ladder — only exists on steps that hold at least one
  // REAL form control in the form region. "Real" = a control that
  // can carry one of our field values: a text-like input (NOT
  // checkbox/radio/file/hidden — a step whose only inputs are group
  // checkboxes has no fields), a textarea, a native select, a
  // combobox/textbox role, a listbox dropdown trigger
  // ([aria-haspopup="listbox"] — a value-carrying control, unlike a
  // plain button), or a contenteditable. The audience step's
  // left column is checkboxes + Previous/Publish buttons: zero real
  // controls, so its spec is empty BY CONSTRUCTION and clickable
  // divs are not eligible as fields there at all.
  const REAL_FIELD_SELECTOR =
    'input, textarea, select, [role="combobox"], [role="textbox"], ' +
    '[aria-haspopup="listbox"], [contenteditable="true"]';
  function isRealFieldControl(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      const t = String(
        typeof el.getAttribute === "function" ? el.getAttribute("type") || "text" : "text"
      ).toLowerCase();
      return !["checkbox", "radio", "file", "hidden", "submit", "button", "image", "reset"]
        .includes(t);
    }
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
    if (role === "combobox" || role === "textbox") return true;
    // A listbox dropdown trigger is a genuine value-carrying
    // control (the step-2 color triggers in some variants are
    // exactly this, with no combobox role and no other control on
    // the step) — distinct from a plain [role="button"], which is
    // eligible as a FIELD only once a real control exists.
    if (typeof el.getAttribute === "function" &&
        el.getAttribute("aria-haspopup") === "listbox") return true;
    const ce = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
    return ce === "true" || ce === "";
  }
  function stepHasRealControls() {
    return Array.from(document.querySelectorAll(REAL_FIELD_SELECTOR))
      .some(el => isRealFieldControl(el) && isFormCandidate(el) && isVisibleEl(el));
  }

  // ---- form region vs preview pane (v2.1.4, header note 15) ------------
  // Facebook renders a live PREVIEW of the listing beside the form on
  // every step. The preview is NOT form: its text repeats the values
  // ("Price: $11,327", "Exterior color: Beige") inside prose, and its
  // only clickable is the description's "See less" expander — in the
  // 2.1.3 live repost the scan located BOTH as fields and failed a
  // perfect form on a phantom Price. A candidate is in the preview
  // when an ancestor is the preview pane: labelled "Preview" by its
  // leading text or aria-label, or carrying a direct child whose
  // whole text is the "Preview" heading. The heading checks stay
  // shallow on purpose — a deep descendant search would flag the
  // whole page (form included) as preview, since the page contains
  // the pane.
  function hasPreviewHeadingChild(node) {
    const kids = (node && node.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (!k || k.nodeType !== 1) continue;
      if (normText(k.textContent) === "preview" && !subtreeHasFormControl(k)) return true;
    }
    return false;
  }
  function isInPreview(el) {
    // Structural first (v2.1.5, header note 16): inside a tagged
    // preview card is decisive, wherever the "Preview" label sits.
    if (el && isInTaggedPreview(el)) return true;
    let node = el ? el.parentElement : null;
    for (let depth = 0; depth < 8 && node; depth++) {
      if (labelTextMatches(containerLeadingText(node), ["preview"])) return true;
      const aria = typeof node.getAttribute === "function"
        ? node.getAttribute("aria-label") : null;
      if (aria && normText(aria) === "preview") return true;
      if (hasPreviewHeadingChild(node)) return true;
      node = node.parentElement;
    }
    return false;
  }
  // A generic clickable whose WHOLE text is a UI chrome word is page
  // furniture, never a field — the second half of the run-6 trap (the
  // "See less" expander was laddered as Price). v2.1.5 (note 16): the
  // check now covers the aria-label too, and any "View …" label —
  // the run-7 map button's own text was EMPTY, so the text-only
  // check waved it through while its aria-label announced exactly
  // what it was ("View listing location"). Real inputs, textareas
  // and selects are exempt by tag: their text is their value.
  const UI_CHROME_TEXTS = new Set([
    "see less", "see more", "learn more", "show more", "show less",
    "read more", "view more", "see all"
  ]);
  function isChromeButton(el) {
    const tag = (el && el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    const own = normText(el && el.textContent);
    if (UI_CHROME_TEXTS.has(own)) return true;
    if (own.startsWith("view ")) return true;
    const aria = normText(
      el && typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : "");
    if (!aria) return false;
    return UI_CHROME_TEXTS.has(aria) || aria.startsWith("view ");
  }
  // Page chrome is never form (v2.1.21, header note 27): Facebook's
  // top navigation lives in a role="banner" subtree (or a <header>),
  // and on 2026-10-23 the nearby-text strategy located "Year" as the
  // header's notifications button ("Manage … notification
  // settings", aria-haspopup="dialog") — DOM-first, label-plausible
  // through an ancestor's text, and completely outside the form.
  // No field has ever lived in the banner; exclude its whole
  // subtree from candidacy.
  function isInPageChrome(el) {
    let node = el;
    for (let depth = 0; depth < 12 && node; depth++) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "HEADER") return true;
      if (typeof node.getAttribute === "function" &&
          node.getAttribute("role") === "banner") return true;
      node = node.parentElement;
    }
    return false;
  }

  // A control whose popup is a DIALOG or a MENU is page/app
  // chrome, never a form field (v2.1.22): the header notifications
  // button that got laddered as "Year" twice carries
  // aria-haspopup="dialog"; a field's popup is a listbox (or the
  // attribute is absent). Deterministic, shape-based — unlike the
  // banner-ancestor test, it does not depend on how Facebook
  // happens to structure its header.
  function hasNonFieldPopup(el) {
    if (!el || typeof el.getAttribute !== "function") return false;
    const hp = el.getAttribute("aria-haspopup");
    return !!hp && hp !== "listbox";
  }

  // One gate for every field-location candidate (v2.1.4; media
  // exclusion added v2.1.5; page-chrome exclusion v2.1.21;
  // non-field-popup exclusion v2.1.22).
  function isFormCandidate(el) {
    return !!el && !isChromeButton(el) && !isMediaChrome(el) &&
      !isInPreview(el) && !isInPageChrome(el) && !hasNonFieldPopup(el);
  }

  // Locate a field in three tries, in an order that cannot move a
  // field that already located (header note 12):
  //   (a) the element's OWN label — aria-label / placeholder /
  //       label[for] — the v2 behaviour, unchanged winners;
  //   (b) CONTAINER label text among VISIBLE candidates — the v3.2
  //       fix for labels that live as sibling text in a wrapper div;
  //   (c) the wider nearby-text context, as a last resort.
  // Every strategy draws from the FORM REGION only (v2.1.4, header
  // note 15): preview-pane candidates and UI-chrome clickables are
  // filtered out up front, so the audience step — which has no form
  // fields at all — locates nothing instead of resurrecting fields
  // from preview prose.
  // And the structural cap (v2.1.5, header note 16): on a step with
  // NO real form control there is nothing to locate — return null
  // before any strategy runs, whatever the page's prose contains.
  // This one choke point gates the fillers, the spec builders, the
  // ladder rungs and the diagnostic snapshots alike.
  function findAnyField(keywords, selector) {
    if (!stepHasRealControls()) return null;
    const all = Array.from(document.querySelectorAll(selector || FIELD_SELECTOR))
      .filter(isFormCandidate);
    // Tiered search (v2.1.21, header note 27): the label-precise
    // strategies (own label, then container label) run over REAL
    // controls first (inputs, selects, comboboxes, listbox
    // triggers), then over the wider clickable set. The fuzzy
    // nearby-text strategy runs ONLY in the wide tier, after both
    // label strategies there: an ancestor's aggregated text
    // mentions every field on the page, so letting it speak for
    // a real control is how the header's notifications button
    // got laddered as "Year" (and how a Price input could be).
    // A plain [role="button"] whose neighbourhood merely
    // MENTIONS the keyword can no longer beat the form's actual
    // dropdown trigger just by sitting earlier in the DOM.
    const tiers = [all.filter(isRealFieldControl), all];
    for (let t = 0; t < tiers.length; t++) {
      const tier = tiers[t];
      const own = tier.find(el => keywords.some(k => fieldLabel(el).includes(k)));
      if (own) return own;
      const byContainer = tier.filter(isVisibleEl)
        .find(el => labelTextMatches(containerLabel(el), keywords));
      if (byContainer) return byContainer;
      if (t === tiers.length - 1) {
        const near = tier.find(el => keywords.some(k => nearbyText(el).includes(k)));
        if (near) return near;
      }
    }
    return null;
  }

  function findField(keywords, selector) {
    return findAnyField(keywords, selector || 'input, textarea, select');
  }

  function fieldPresent(keywords) {
    return !!findAnyField(keywords);
  }

  function readField(keywords) {
    return extractValue(findAnyField(keywords));
  }

  // ---- fill escalation ladder (v3, see header note 10) ------------------
  // State is per-job: which rungs each stubborn field has climbed, and
  // whether the forensic record for it has already been written.
  const fieldAttempts = {};   // name -> { rungs: [...], cdpError: null }
  const diagRecorded = new Set();
  const jobDiags = [];        // forensic records, sent with JOB_FAILED (v3.1)
  let formMapRecorded = false; // the form_map record is one per job (v3.2)
  let cdpAttached = false;

  function attemptsFor(name) {
    return (fieldAttempts[name] = fieldAttempts[name] || { rungs: [], cdpError: null });
  }
  function noteRung(name, rung) {
    const att = attemptsFor(name);
    if (!att.rungs.includes(rung)) att.rungs.push(rung);
  }

  function dispatchKeyboard(el, type, init) {
    el.dispatchEvent(new KeyboardEvent(type, Object.assign(
      { bubbles: true, cancelable: true, composed: true }, init || {})));
  }

  // A bare .click() is easy for React wrappers to shrug off; walk the
  // full pointer/mouse sequence a real press produces.
  function realisticClick(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    };
    try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", init));
    try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  }

  // The suggestion option Facebook would commit: exact text first,
  // then prefix, then containment.
  function findOptionExact(value) {
    const wanted = normText(value);
    if (!wanted) return null;
    const opts = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(isFormCandidate);
    return opts.find(o => normText(o.textContent) === wanted) ||
      opts.find(o => normText(o.textContent).startsWith(wanted)) ||
      opts.find(o => normText(o.textContent).includes(wanted)) || null;
  }

  // Rung 2's typing engine: follow typingEventPlan literally, committing
  // each character with the native setter between beforeinput and input
  // (synthetic key events alone never mutate a value — but the flurry
  // around the mutation is what per-keystroke validators listen to).
  async function rung2TypeText(el, text) {
    let acc = "";
    try { acc = extractValue(el); } catch (e) { acc = ""; }
    for (const stepEv of typingEventPlan(text)) {
      if (stepEv.type === "keydown" || stepEv.type === "keypress" || stepEv.type === "keyup") {
        dispatchKeyboard(el, stepEv.type, { key: stepEv.key, code: stepEv.code });
      } else {
        if (stepEv.type === "input") {
          acc += stepEv.data;
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, acc);
        }
        el.dispatchEvent(new InputEvent(stepEv.type, {
          inputType: stepEv.inputType, data: stepEv.data,
          bubbles: true, cancelable: true, composed: true
        }));
      }
      if (stepEv.type === "keyup") await sleep(30);
    }
  }

  async function rung2Fill(field) {
    const el = findAnyField(field.keywords);
    if (!el) return false;
    const value = String(field.expected);
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      // Type-ahead by trusted-looking key flurry; best-effort (the CDP
      // rung is the one with real keys) — read-back decides.
      el.focus();
      for (const ch of value) {
        const init = keyEventInitForChar(ch);
        dispatchKeyboard(el, "keydown", init);
        dispatchKeyboard(el, "keyup", init);
        await sleep(40);
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(400);
      return true;
    }
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      // Listbox trigger (a div/button that opens options): open it and
      // pick the exact option — the click is the commit.
      realisticClick(el);
      await sleep(900);
      const opt = findOptionExact(value);
      if (opt) { realisticClick(opt); await sleep(500); }
      return true;
    }
    el.focus();
    // Clear first: select-all + Delete through the keyboard pipeline,
    // with execCommand doing the actual edit where it can.
    dispatchKeyboard(el, "keydown", { key: "a", code: "KeyA", ctrlKey: true });
    try { document.execCommand("selectAll"); } catch (e) {}
    dispatchKeyboard(el, "keyup", { key: "a", code: "KeyA", ctrlKey: true });
    dispatchKeyboard(el, "keydown", { key: "Delete", code: "Delete" });
    try { document.execCommand("delete"); } catch (e) {}
    dispatchKeyboard(el, "keyup", { key: "Delete", code: "Delete" });
    // execCommand insertText performs a REAL edit in Chrome (proper
    // beforeinput/input with inputType=insertText) — try it before the
    // manual per-character climb.
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, value); } catch (e) {}
    if (!inserted || !valueMatches(extractValue(el), field.expected, field.kind)) {
      if (extractValue(el)) { try { nativeSetValue(el, ""); } catch (e) {} }
      await rung2TypeText(el, field.kind === "price" ? value.replace(/\D/g, "") : value);
    }
    await sleep(300);
    // Combobox commit: if a suggestion listbox is open, clicking the
    // exact-match option is what Facebook actually records.
    const opt = findOptionExact(value);
    if (opt) { realisticClick(opt); await sleep(500); }
    return true;
  }

  // ---- rung 3: CDP trusted input via the background worker --------------
  function cdpRequest(payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: "AUTOLAUNCH_CDP" }, payload),
          resp => {
            void chrome.runtime.lastError;
            resolve(resp && typeof resp === "object" ? resp
              : { ok: false, error: "cdp_no_response" });
          });
      } catch (e) { resolve({ ok: false, error: "cdp_send_failed" }); }
    });
  }

  async function cdpEnsure(fieldName) {
    if (cdpAttached) return true;
    const res = await cdpRequest(buildCdpAttach());
    if (res && res.ok) { cdpAttached = true; return true; }
    // Remember WHY rung 3 could not run — it lands in the diagnostics.
    attemptsFor(fieldName).cdpError = (res && res.error) || "cdp_attach_failed";
    return false;
  }

  async function cdpDetach() {
    if (!cdpAttached) return;
    cdpAttached = false;
    await cdpRequest(buildCdpDetach());
  }

  async function cdpClickEl(el) {
    // The worker refuses click commands on a tab with no debugger
    // session (cdp_not_attached) — the ladder attaches inside rung 3,
    // but direct callers (step-2 color/clean-title fallbacks, v2.1.3)
    // must attach first. cdpEnsure is a no-op when already attached,
    // and the session still ends at the usual detach points.
    if (!(await cdpEnsure("CDP"))) {
      return { ok: false, error: attemptsFor("CDP").cdpError || "cdp_attach_failed" };
    }
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(150);
    const r = el.getBoundingClientRect();
    return cdpRequest(buildCdpClick(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2)));
  }

  // Trusted mouse SEQUENCE at the element's center (v2.1.9, header
  // note 19): the worker's clickSeq action dispatches mouseMoved,
  // mousePressed, a brief pause, mouseReleased — some Facebook
  // menus arm on hover/press timing that the instantaneous
  // press+release pair in "click" never reproduces. Mirrors
  // cdpClickEl exactly (attach first, scroll into view, center
  // coordinates); the delete flow's menu ladder uses it as rung 3.
  async function cdpMouseSeqClickEl(el) {
    if (!(await cdpEnsure("CDP"))) {
      return { ok: false, error: attemptsFor("CDP").cdpError || "cdp_attach_failed" };
    }
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(150);
    const r = el.getBoundingClientRect();
    return cdpRequest(buildCdpClickSeq(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2)));
  }

  async function rung3Fill(field) {
    const el = findAnyField(field.keywords);
    if (!el) return false;
    if (!(await cdpEnsure(field.name))) return false;
    const value = String(field.expected);
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      // Trusted keys: click to focus/open, type-ahead the digits, Enter.
      await cdpClickEl(el);
      await sleep(300);
      for (const ch of value.replace(/\D/g, "")) {
        await cdpRequest(buildCdpKey(ch, "Digit" + ch, { text: ch }));
        await sleep(60);
      }
      await cdpRequest(buildCdpKey("Enter", "Enter"));
      await sleep(400);
      return true;
    }
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      // Listbox trigger: trusted click opens it, trusted click commits.
      await cdpClickEl(el);
      await sleep(900);
      const opt = findOptionExact(value);
      if (opt) { await cdpClickEl(opt); await sleep(500); }
      return true;
    }
    // Text/combobox input: trusted click focuses, select-all + delete,
    // then Input.insertText injects the text through the trusted
    // pipeline React actually listens to.
    await cdpClickEl(el);
    await sleep(250);
    await cdpRequest(buildCdpKey("a", "KeyA", { modifiers: 2 })); // Ctrl+A
    await cdpRequest(buildCdpKey("Backspace", "Backspace"));
    await cdpRequest(buildCdpInsertText(
      field.kind === "price" ? value.replace(/\D/g, "") : value));
    await sleep(900); // let a suggestion listbox render, if this field has one
    const opt = findOptionExact(value);
    if (opt) { await cdpClickEl(opt); await sleep(500); }
    else if (el.getAttribute("role") === "combobox") {
      // No clickable option materialised — keyboard commit instead.
      await cdpRequest(buildCdpKey("ArrowDown", "ArrowDown"));
      await cdpRequest(buildCdpKey("Enter", "Enter"));
      await sleep(400);
    }
    return true;
  }

  // ---- ladder driver + diagnostics ---------------------------------------
  function recordFieldDiagnostic(field, readBack, note) {
    if (diagRecorded.has(field.name)) return;
    diagRecorded.add(field.name);
    const att = attemptsFor(field.name);
    // The element snapshot: via the field's keywords when it has
    // them; the Description spec carries none — it locates through
    // findDescriptionField instead. A field that was never located
    // snapshots null (describeElement(null) → all-null descriptor),
    // which is exactly the evidence its "field_not_located" note
    // (v3.2) needs next to it.
    let el = null;
    try {
      el = field.keywords ? findAnyField(field.keywords)
        : (field.name === "Description" ? findDescriptionField() : null);
    } catch (e) { el = null; }
    const entry = {
      field: field.name,
      element: describeElement(el),
      rungsAttempted: att.rungs.slice(),
      readBack: String(readBack == null ? "" : readBack).slice(0, 200),
      expected: field.expected == null ? null : String(field.expected),
      cdpError: att.cdpError || null,
      note: note || null
    };
    // Three records of the same evidence (v3.1): (1) ONE JSON line on
    // this page's console, greppable as "field_diag"; (2) the job-level
    // array that rides the AUTOLAUNCH_JOB_FAILED message into the
    // queue row's error_message in the database — the channel that
    // cannot be lost; (3) the storage-log message, kept as before.
    console.log("[AutoLaunch] field_diag " + JSON.stringify(entry));
    jobDiags.push(entry);
    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_FIELD_DIAG", queueId, diag: entry },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* the console + job-payload records above still stand */ }
  }

  // Non-fatal step notes (v2.1.3): step-2 fields (colors, clean
  // title) are best-effort and never fail a job — but their outcomes
  // are no longer silent. Each one rides the same three channels as a
  // field diagnostic: a console line, the jobDiags array (compacted
  // by the worker into the queue row's error_message if the job
  // fails for any reason), and the FIELD_DIAG storage stream. The
  // specifics (requested value, option chosen, click path) ride in
  // `detail`; `note` is the machine-readable outcome code.
  function recordStepNote(fieldName, note, detail, readBack, el) {
    const entry = {
      field: fieldName,
      element: describeElement(el || null),
      rungsAttempted: [],
      readBack: String(readBack == null ? "" : readBack).slice(0, 200),
      expected: null,
      cdpError: null,
      note: note || null,
      detail: detail || null
    };
    console.log("[AutoLaunch] step_note " + JSON.stringify(entry));
    jobDiags.push(entry);
    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_FIELD_DIAG", queueId, diag: entry },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* the console + job-payload records above still stand */ }
  }

  // ---- informational-modal swatter (v2.1.6, header note 17) ----------
  // Facebook hangs an informational modal off the VIN field —
  // "Finding your vehicle's VIN": a heading, a paragraph about
  // dashboards and door jambs, a blue Close button and an X. During
  // the 2.1.5 live run it kept re-appearing over the form and
  // Matthew closed it by hand each time; unattended, it would sit
  // there intercepting clicks. WHITELIST DISCIPLINE: a dialog is
  // dismissed ONLY when (1) it contains no form inputs, (2) none of
  // its buttons is a primary/destructive action, and (3) its
  // heading or opening text matches a known informational pattern.
  // Unknown dialogs are never touched — the delete flow's
  // confirmation dialog (a "Delete" button under a delete heading)
  // fails every gate and is left exactly alone, as is any dialog
  // either flow uses on purpose.
  const INFO_MODAL_PATTERNS = [/finding your vehicle/];
  const PROTECTED_DIALOG_ACTIONS = [
    "publish", "delete", "confirm", "post", "submit", "save",
    "continue", "next", "send", "mark as sold", "mark as pending"
  ];
  function dialogHeadingText(d) {
    try {
      const heads = Array.from(d.querySelectorAll(
        "h1, h2, h3, h4, h5, h6, [role='heading']"));
      for (const h of heads) {
        const t = String(h.textContent || "").trim();
        if (t) return t;
      }
    } catch (e) { /* fall through to the leading-text probe */ }
    const lead = containerLeadingText(d);
    if (lead) return lead;
    return String((d && d.textContent) || "").trim().slice(0, 120);
  }
  // {heading, closeBtn} when d is a dismissible informational
  // dialog, else null. Pure gate-keeping — the caller clicks.
  function infoDialogDismissal(d) {
    if (!d || !isVisibleEl(d)) return null;
    // Gate 1: an informational dialog never asks for input.
    try {
      if (typeof d.querySelector === "function" &&
          d.querySelector('input, textarea, select, [contenteditable="true"]')) {
        return null;
      }
    } catch (e) { return null; }
    const btns = Array.from(typeof d.querySelectorAll === "function"
      ? d.querySelectorAll('[role="button"], button, a') : []);
    // Gate 2: no primary/destructive action among its buttons.
    const btnTexts = btns.map(b => normText(b.textContent));
    if (btnTexts.some(t => PROTECTED_DIALOG_ACTIONS.some(p =>
        t === p || t.startsWith(p + " ")))) return null;
    // Gate 3: the whitelist itself — a known informational pattern
    // in the heading or the dialog's opening text.
    const heading = dialogHeadingText(d);
    const opening = normText(String(d.textContent || "").slice(0, 200));
    if (!INFO_MODAL_PATTERNS.some(re =>
        re.test(normText(heading)) || re.test(opening))) return null;
    // Dismissal control: the "Close" button first, the X (aria-label
    // "Close") second — the two shapes the VIN modal ships.
    const closeBtn = btns.find(b => normText(b.textContent) === "close") ||
      btns.find(b => normText((typeof b.getAttribute === "function" &&
        b.getAttribute("aria-label")) || "") === "close");
    if (!closeBtn) return null;
    return { heading, closeBtn };
  }
  async function dismissInfoModals() {
    let dismissed = 0;
    // A dismissed modal can be replaced by a sibling (Facebook
    // stacks these), so re-scan a few times; the cap keeps a
    // pathological page from looping the filler forever.
    for (let round = 0; round < 3; round++) {
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
      let target = null, info = null;
      for (const d of dialogs) {
        const r = infoDialogDismissal(d);
        if (r) { target = d; info = r; break; }
      }
      if (!target) break;
      realisticClick(info.closeBtn);
      recordStepNote("InfoModal", "info_modal_dismissed",
        info.heading, "", target);
      dismissed++;
      await sleep(500);
    }
    return dismissed;
  }

  // ---- form map (v3.2): the never-empty-diagnostics companion -------
  // When a required field fails without ever being located, a bare
  // "not found" teaches nothing. The form map snapshots the first ~12
  // VISIBLE controls on the failing step — tag / type / role /
  // aria-label plus the container label location computed for each —
  // so the NEXT Facebook label change is legible from the database
  // row of the first failed run. It rides the same three channels as
  // a field diagnostic (console line, JOB_FAILED payload, storage).
  const FORM_MAP_SELECTOR =
    'input, textarea, select, [role="combobox"], [role="button"], ' +
    '[aria-haspopup], [contenteditable="true"]';
  function formMapEntries(limit) {
    // The map is evidence about the FORM — preview-pane controls are
    // excluded (v2.1.4) so a future label change reads cleanly.
    return Array.from(document.querySelectorAll(FORM_MAP_SELECTOR))
      .filter(el => isVisibleEl(el) && isFormCandidate(el))
      .slice(0, limit || 12)
      .map(el => {
        const d = describeElement(el);
        return {
          tag: d.tag, type: d.type, role: d.role, ariaLabel: d.ariaLabel,
          containerLabel: String(containerLabel(el) || "").slice(0, 120)
        };
      });
  }
  function recordFormMap() {
    if (formMapRecorded) return;
    formMapRecorded = true;
    const entry = {
      field: "__form_map__",
      element: null,
      rungsAttempted: [],
      readBack: "",
      expected: null,
      cdpError: null,
      note: "form_map",
      formMap: formMapEntries(12)
    };
    console.log("[AutoLaunch] field_diag " + JSON.stringify(entry));
    jobDiags.push(entry);
    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_FIELD_DIAG", queueId, diag: entry },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* the console + job-payload records above still stand */ }
  }

  // Climb the ladder for one stubborn field; true only when a READ-BACK
  // matches the payload (verify-or-report stays the arbiter). On total
  // exhaustion the forensic record is written here, once per field.
  async function escalatedRefill(field) {
    const readNow = () => { try { return field.read(); } catch (e) { return ""; } };
    const settled = () => valueMatches(readNow(), field.expected, field.kind);

    noteRung(field.name, "rung1");
    try { await field.rung1(); } catch (e) {}
    if (settled()) return true;

    noteRung(field.name, "rung2");
    try { await rung2Fill(field); } catch (e) {}
    if (settled()) return true;

    noteRung(field.name, "rung3");
    try { await rung3Fill(field); } catch (e) {}
    if (settled()) return true;

    recordFieldDiagnostic(field, readNow());
    return false;
  }

  // Combobox/dropdown-style fields: open, type the value, then click the
  // option that matches. Returns true when an option was picked or the
  // input itself holds the value afterwards.
  async function fillCombobox(keywords, value) {
    const el = findField(keywords, 'input[role="combobox"], input');
    if (!el || !value) return false;
    el.focus();
    el.click();
    nativeSetValue(el, String(value));
    await sleep(1200);
    const wanted = String(value).toLowerCase();
    const options = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] *'));
    const match = options.find(o =>
      (o.textContent || "").trim().toLowerCase() === wanted ||
      (o.textContent || "").trim().toLowerCase().startsWith(wanted));
    if (match) { match.click(); await sleep(500); return true; }
    return normText(el.value) === wanted;
  }

  async function fillSelectOrListbox(keywords, candidates) {
    // Native <select> first — located by its own label, or (v3.2) by
    // container text when the select itself is bare. Form region
    // only (v2.1.4): a <select> rendered inside the preview pane is
    // not a field.
    const sels = Array.from(document.querySelectorAll("select")).filter(isFormCandidate);
    const sel = sels.find(s => keywords.some(k => fieldLabel(s).includes(k))) ||
      sels.find(s => labelTextMatches(containerLabel(s), keywords));
    if (sel) {
      for (const cand of candidates) {
        if (!cand) continue;
        const opt = Array.from(sel.options).find(o =>
          (o.textContent || "").toLowerCase().includes(String(cand).toLowerCase()) ||
          (o.value || "").toLowerCase().includes(String(cand).toLowerCase()));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }
    }
    // Listbox-style (Facebook custom dropdowns): open, then click option
    const trigger = findAnyField(keywords);
    if (trigger) {
      trigger.click();
      await sleep(900);
      for (const cand of candidates) {
        if (!cand) continue;
        const opt = Array.from(document.querySelectorAll('[role="option"]'))
          .filter(isFormCandidate)
          .find(o => (o.textContent || "").toLowerCase().includes(String(cand).toLowerCase()));
        if (opt) { opt.click(); await sleep(400); return true; }
      }
    }
    return false;
  }

  // ---- step-2 colors + clean title (v2.1.3, header note 13) --------------
  // The color options render in a portal listbox OUTSIDE the field's
  // container, so they are collected document-wide, like everywhere
  // else in this file.
  function colorOptionElements() {
    return Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]'))
      .filter(el => isVisibleEl(el) && isFormCandidate(el));
  }
  async function waitForColorOptions(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 2500);
    let opts = colorOptionElements();
    while (!opts.length && Date.now() < deadline) {
      await sleep(400);
      opts = colorOptionElements();
    }
    return opts;
  }
  function colorReadBackOk(readBack, chosenText) {
    const rb = normText(readBack), ch = normText(chosenText);
    if (!rb || !ch) return false;
    return rb === ch || rb.includes(ch) || ch.includes(rb);
  }

  // Fill one of Facebook's fixed-list color dropdowns. The dealer
  // string is normalized against the options ACTUALLY offered
  // (rankColorOptions); the pick is READ BACK from the trigger and,
  // on a miss, retried once with the next-best candidate. Clicks use
  // the realistic sequence with the trusted CDP click as fallback.
  // Every outcome lands in a step note; returns true only when the
  // read-back shows the intended color. Never throws, never fatal.
  async function fillColorDropdown(fieldName, keywords, rawColor) {
    const requested = String(rawColor || "");
    let trigger = null;
    try {
      trigger = findAnyField(keywords);
      if (!trigger) {
        recordStepNote(fieldName, "color_field_not_present",
          "requested '" + requested + "'", "");
        return false;
      }
      // Native <select> variant: rank against its real options and
      // set it directly (the same native-setter path as rung 1).
      if ((trigger.tagName || "").toUpperCase() === "SELECT") {
        const optTexts = Array.from(trigger.options || [])
          .map(o => String(o.text || o.value || ""));
        let rankedSel = rankColorOptions(requested, optTexts);
        let defaultedSel = false;
        if (!rankedSel.length) {
          const dflt = defaultColorOption(optTexts);
          if (dflt) { rankedSel = [dflt]; defaultedSel = true; }
        }
        if (!rankedSel.length) {
          recordStepNote(fieldName, "color_no_option_match",
            "requested '" + requested + "'; options: " + optTexts.join(" / "),
            extractValue(trigger), trigger);
          return false;
        }
        const opt = Array.from(trigger.options || [])
          .find(o => normText(o.text || o.value) === normText(rankedSel[0]));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(trigger, opt.value);
          trigger.dispatchEvent(new Event("change", { bubbles: true }));
          trigger.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const rbSel = extractValue(trigger);
        const goodSel = colorReadBackOk(rbSel, rankedSel[0]);
        recordStepNote(fieldName,
          goodSel && defaultedSel ? "color_defaulted" : (goodSel ? "color_set" : "color_readback_mismatch"),
          "requested '" + requested + "' -> option '" + rankedSel[0] + "'" +
            (defaultedSel ? " (defaulted: no coordinating match)" : ""),
          rbSel, trigger);
        return goodSel;
      }
      // Already showing a defensible color (a re-run, or an earlier
      // step pass set it)? Don't churn the dropdown.
      const before = extractValue(trigger);
      if (before && (rankColorOptions(requested, [before]).length || !normText(requested))) {
        recordStepNote(fieldName, "color_already_set",
          "requested '" + requested + "'", before, trigger);
        return true;
      }
      // Open it: realistic click first, trusted CDP click as fallback.
      let options = [];
      realisticClick(trigger);
      options = await waitForColorOptions(2000);
      if (!options.length) {
        await cdpClickEl(trigger);
        options = await waitForColorOptions(2000);
      }
      if (!options.length) {
        recordStepNote(fieldName, "color_options_never_opened",
          "requested '" + requested + "'", extractValue(trigger), trigger);
        return false;
      }
      const ranked = rankColorOptions(requested,
        options.map(o => String(o.textContent || "")));
      let defaulted = false;
      if (!ranked.length) {
        const dflt = defaultColorOption(options.map(o => String(o.textContent || "")));
        if (dflt) { ranked.push(dflt); defaulted = true; }
      }
      if (!ranked.length) {
        recordStepNote(fieldName, "color_no_option_match",
          "requested '" + requested + "'; options: " +
            options.map(o => String(o.textContent || "").trim()).slice(0, 16).join(" / "),
          extractValue(trigger), trigger);
        try { dispatchKeyboard(trigger, "keydown", { key: "Escape", code: "Escape" }); } catch (e) {}
        return false;
      }
      // Best candidate first; a failed read-back earns ONE retry with
      // the next-best candidate. Per attempt: realistic click, then a
      // trusted CDP click if the option is still on screen and the
      // value still hasn't taken.
      let lastRead = "";
      const attempts = Math.min(2, ranked.length);
      for (let attempt = 0; attempt < attempts; attempt++) {
        const wanted = ranked[attempt];
        let opt = colorOptionElements()
          .find(o => normText(o.textContent) === normText(wanted));
        if (!opt) {
          // The list closed after the previous attempt — reopen it.
          const t2 = findAnyField(keywords);
          if (t2) trigger = t2;
          realisticClick(trigger);
          await waitForColorOptions(2000);
          opt = colorOptionElements()
            .find(o => normText(o.textContent) === normText(wanted));
          if (!opt) continue;
        }
        try { opt.scrollIntoView({ block: "center" }); } catch (e) {}
        await sleep(150);
        realisticClick(opt);
        await sleep(600);
        const t3 = findAnyField(keywords);
        if (t3) trigger = t3;
        lastRead = extractValue(trigger);
        if (colorReadBackOk(lastRead, wanted)) {
          recordStepNote(fieldName, defaulted ? "color_defaulted" : "color_set",
            "requested '" + requested + "' -> option '" + wanted + "'" +
              (defaulted ? " (defaulted: no coordinating match)" : ""),
            lastRead, trigger);
          return true;
        }
        if (isVisibleEl(opt)) {
          await cdpClickEl(opt);
          await sleep(600);
          const t4 = findAnyField(keywords);
          if (t4) trigger = t4;
          lastRead = extractValue(trigger);
          if (colorReadBackOk(lastRead, wanted)) {
            recordStepNote(fieldName, defaulted ? "color_defaulted" : "color_set",
              "requested '" + requested + "' -> option '" + wanted + "' (cdp click)" +
                (defaulted ? " (defaulted: no coordinating match)" : ""),
              lastRead, trigger);
            return true;
          }
        }
      }
      recordStepNote(fieldName, "color_readback_mismatch",
        "requested '" + requested + "'; tried: " + ranked.slice(0, attempts).join(" / "),
        lastRead, trigger);
      return false;
    } catch (e) {
      try {
        recordStepNote(fieldName, "color_error",
          "requested '" + requested + "': " + (e && e.message ? e.message : "unknown"),
          "", trigger);
      } catch (e2) { /* a note about a note — nothing left to do */ }
      return false;
    }
  }

  // Clean title. In Facebook's current variant the control is a
  // custom clickable div — the old locator only knew real inputs and
  // [role="checkbox"], and its bare .click() was never verified, so
  // the box silently stayed unchecked (first successful live run).
  // Locate by checkbox semantics first, then by the labelled row;
  // click with the real machinery (realistic, then CDP); verify the
  // checked state afterwards and record the outcome.
  function findCleanTitleControl() {
    const boxes = Array.from(document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"]')).filter(isFormCandidate);
    const box = boxes.find(b =>
      nearbyText(b).includes("clean title") || fieldLabel(b).includes("clean"));
    if (box) return { stateEl: box, clickEl: box };
    const labelled = Array.from(document.querySelectorAll("div, label, span"))
      .filter(el => isVisibleEl(el) && isFormCandidate(el))
      .find(elm => {
        if (String(elm.textContent || "").length > 300) return false;
        return normText(containerLeadingText(elm)).includes("clean title") ||
          labelTextMatches(containerLabel(elm), ["clean title"]);
      });
    if (labelled) {
      let inner = null;
      try {
        inner = labelled.querySelector('input[type="checkbox"], [role="checkbox"]');
      } catch (e) { inner = null; }
      return { stateEl: inner || labelled, clickEl: labelled };
    }
    return null;
  }
  function cleanTitleState(el) {
    if (!el) return null;
    if ((el.tagName || "").toUpperCase() === "INPUT") return el.checked === true;
    const aria = typeof el.getAttribute === "function" ? el.getAttribute("aria-checked") : null;
    if (aria === "true") return true;
    if (aria === "false") return false;
    if (el.checked === true) return true;
    return null;
  }
  async function fillCleanTitle() {
    try {
      const found = findCleanTitleControl();
      if (!found) {
        // Nothing to record when this step doesn't even mention a
        // clean title (it lives on step 2; step 1 stays silent) —
        // but a page that TALKS about a clean title without giving
        // us a clickable control is worth a note.
        const pageMentions = normText(
          (document.body && document.body.innerText) || "").includes("clean title");
        if (pageMentions) {
          recordStepNote("CleanTitle", "clean_title_not_found",
            "page mentions clean title; no clickable control resolved", "");
        }
        return false;
      }
      const state0 = cleanTitleState(found.stateEl);
      if (state0 === true) {
        recordStepNote("CleanTitle", "clean_title_already_checked", "", "checked", found.clickEl);
        return true;
      }
      realisticClick(found.clickEl);
      await sleep(500);
      let state = cleanTitleState(found.stateEl);
      if (state === true) {
        recordStepNote("CleanTitle", "clean_title_checked", "via dom click", "checked", found.clickEl);
        return true;
      }
      if (state === null && state0 === null) {
        // The state was never readable — one click is all we dare:
        // a second could toggle an already-checked box back OFF.
        recordStepNote("CleanTitle", "clean_title_state_unreadable",
          "clicked once; checked state could not be read back", "", found.clickEl);
        return false;
      }
      // Readably still unchecked — the trusted click decides.
      await cdpClickEl(found.clickEl);
      await sleep(500);
      state = cleanTitleState(found.stateEl);
      if (state === true) {
        recordStepNote("CleanTitle", "clean_title_checked", "via cdp click", "checked", found.clickEl);
        return true;
      }
      recordStepNote("CleanTitle", "clean_title_still_unchecked",
        "dom + cdp clicks landed; state still reads unchecked", "", found.clickEl);
      return false;
    } catch (e) {
      try {
        recordStepNote("CleanTitle", "clean_title_error",
          (e && e.message) ? e.message : "unknown", "");
      } catch (e2) { /* nothing left to do */ }
      return false;
    }
  }

  // Year/Make/Model are cascading on Facebook: Make options only enable
  // once Year is set, Model once Make is. Poll briefly for the next
  // field to become usable before filling it.
  async function waitForEnabled(keywords, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      const el = findAnyField(keywords);
      if (el && !el.disabled && el.getAttribute("aria-disabled") !== "true") return el;
      await sleep(500);
    }
    return findAnyField(keywords);
  }

  async function fillYearMakeModel() {
    if (fieldPresent(["year"]) && car.year) {
      await fillSelectOrListbox(["year"], [String(car.year)]) ||
        await fillCombobox(["year"], car.year);
      await sleep(700);
    }
    if (fieldPresent(["make"]) && car.make) {
      await waitForEnabled(["make"]);
      await fillSelectOrListbox(["make"], [car.make]) ||
        await fillCombobox(["make"], car.make);
      await sleep(700);
    }
    if (fieldPresent(["model"]) && car.model) {
      await waitForEnabled(["model"]);
      await fillSelectOrListbox(["model"], [car.model]) ||
        await fillCombobox(["model"], car.model);
      await sleep(700);
    }
  }

  // ---- photo fetching (see note 7 in the header) -----------------------
  // Same project URL + publishable key the background worker uses; the
  // photo-proxy is an Edge Function on that project that streams dealer
  // photos back with CORS * (built for the web app, reused here).
  const PHOTO_PROXY_URL = "https://tdsipiltwajwhzgjsupx.supabase.co/functions/v1/photo-proxy";
  const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";

  function base64ToBlob(base64, contentType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType || "image/jpeg" });
  }

  function relayPhoto(url) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_FETCH_PHOTO", url }, resp => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // One photo, two stages: background relay first (no CORS wall), then
  // the photo-proxy. Throws only when both stages failed, so the caller
  // can skip to the next photo exactly like the old direct fetch did.
  async function fetchPhotoBlob(url) {
    const relayed = await relayPhoto(url);
    if (relayed && relayed.ok && relayed.base64) {
      return base64ToBlob(relayed.base64, relayed.contentType);
    }
    const res = await fetch(PHOTO_PROXY_URL + "?url=" + encodeURIComponent(url), {
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    if (!res.ok) throw new Error("photo_proxy_" + res.status);
    return res.blob();
  }

  // [PURE-PHOTOS-BEGIN] — extracted and unit-exercised by the test
  // harness; keep these free of DOM/chrome references.
  // The same dealer photo arrives at several sizes (image_url is the
  // width=500 variant, photos[] entries are width=1600). The dedupe key
  // therefore ignores the width parameter entirely: origin + pathname
  // (+ any remaining query) identifies the photo; among variants of
  // one photo the WIDEST wins (no width parameter = original = widest).
  function photoUrlKey(u) {
    try {
      const url = new URL(u);
      url.searchParams.delete("width");
      const rest = url.searchParams.toString();
      return url.origin + url.pathname + (rest ? "?" + rest : "");
    } catch (e) {
      return String(u).replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/, "");
    }
  }
  function photoUrlWidth(u) {
    try {
      const w = new URL(u).searchParams.get("width");
      return w == null ? Infinity : (parseInt(w, 10) || 0);
    } catch (e) {
      const m = /[?&]width=(\d+)/.exec(String(u));
      return m ? parseInt(m[1], 10) : Infinity;
    }
  }
  function dedupePhotoUrls(urls, cap) {
    const byKey = new Map(); // key -> best URL, in first-seen order
    for (const u of urls) {
      if (typeof u !== "string" || !u.startsWith("http")) continue;
      const key = photoUrlKey(u);
      const prev = byKey.get(key);
      if (prev === undefined || photoUrlWidth(u) > photoUrlWidth(prev)) {
        byKey.set(key, u);
      }
    }
    return [...byKey.values()].slice(0, cap || 12);
  }
  // [PURE-PHOTOS-END]

  function photoUrls() {
    const urls = [];
    if (car.image_url) urls.push(car.image_url);
    for (const key of ["photos", "images", "image_urls", "photo_urls"]) {
      if (Array.isArray(car[key])) {
        car[key].forEach(u => { if (typeof u === "string" && u.startsWith("http")) urls.push(u); });
      }
    }
    if (Array.isArray(car.custom_photo_urls)) {
      car.custom_photo_urls.forEach(u => { if (typeof u === "string" && u.startsWith("http")) urls.push(u); });
    }
    // Matthew's target: up to 20 photos per listing — Facebook's
    // ceiling, and what the scraper already stores (raised from 12
    // on 2026-10-23 at his request). Counted AFTER normalization
    // dedupe, so a photo at two sizes counts once (v3.1).
    return dedupePhotoUrls(urls, 20);
  }

  // Preview tiles = the distinct photo previews Facebook rendered.
  // The same object URL is reused across a tile and the big preview,
  // so count distinct srcs, not <img> elements.
  function photoPreviewCount() {
    const srcs = new Set();
    document.querySelectorAll('img[src^="blob:"], img[src^="data:"]')
      .forEach(im => { if (im.src) srcs.add(im.src); });
    return srcs.size;
  }

  // The remove (×) button of the LAST photo tile: a "remove"-labelled
  // button sitting in a container that also holds a blob preview img.
  function lastPhotoRemoveButton() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
      const lab = (b.getAttribute("aria-label") || "").toLowerCase();
      if (!lab.includes("remove")) return false;
      let node = b;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (node && node.querySelector && node.querySelector('img[src^="blob:"]')) return true;
      }
      return false;
    });
    return btns[btns.length - 1] || null;
  }

  // Facebook caps vehicle listings at 20 photos. If its uploader merged
  // in leftovers (a prior attempt in the same tab), trim back to the cap
  // with the tiles' own remove buttons. False = could not get under it.
  async function trimPhotoPreviews(max) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (photoPreviewCount() <= max) return true;
      const btn = lastPhotoRemoveButton();
      if (!btn) return false;
      realisticClick(btn);
      await sleep(700);
    }
    return photoPreviewCount() <= max;
  }

  async function attachPhotos(urls) {
    const input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
    if (!input) return { ok: false, reason: "photo_input_not_found" };
    const before = photoPreviewCount();
    // Fetch EVERY photo first (relay → photo-proxy per URL; a URL dead
    // both ways costs one skip, exactly as before). A direct fetch of
    // the dealer URL from this page is CORS-blocked by design of the
    // photo servers — never add one back here.
    const files = [];
    for (const url of urls) {
      let blob;
      try { blob = await fetchPhotoBlob(url); } catch (e) { continue; }
      const name = (url.split("/").pop() || `photo-${files.length}.jpg`).split("?")[0];
      files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
    }
    if (!files.length) return { ok: false, reason: "photo_download_failed" };
    // Assign the finished set EXACTLY ONCE (v3.1): Facebook MERGES
    // every input.files assignment into its uploader's internal list,
    // so the old per-photo cumulative assignment re-added earlier
    // photos on every pass (1+2+…+12 ≈ 70 attachments in run 4).
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Verify via preview tiles: wait for the count to show up and
    // settle (two equal reads in a row), capped at ~16s.
    let count = before, stableReads = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(800);
      const now = photoPreviewCount();
      if (now === count && now > before) { stableReads++; if (stableReads >= 2) break; }
      else stableReads = 0;
      count = now;
      if (count - before >= files.length && i >= 2) break;
    }
    const attached = count - before;
    if (attached <= 0) return { ok: false, reason: "photo_preview_never_appeared" };
    if (count > 20) {
      // Over Facebook's hard ceiling — trim, or fail honestly.
      const trimmed = await trimPhotoPreviews(20);
      count = photoPreviewCount();
      if (!trimmed || count > 20) return { ok: false, reason: "photo_overflow" };
    }
    const result = { ok: true, count: Math.max(attached, 0) };
    if (attached > files.length) {
      // Facebook kept extras (merge leftovers) but we are within its
      // limits — a warning for the banner, not a failure.
      result.warning = "photo_overshoot:" + attached + "_of_" + files.length;
      result.shownCount = count;
    }
    return result;
  }

  // [PURE-INTRO-VIDEO-BEGIN] — extracted and unit-exercised by
  // the test harness; keep these free of DOM/chrome references.
  // Intro-video attach decisions (v2.1.53, header note 27).
  // Facebook's vehicle composer caps a listing video at 60
  // seconds; the duration probe answers in float seconds, and
  // only a duration the browser actually reported can convict —
  // an unreadable duration (0/NaN) proceeds and lets Facebook's
  // own processing be the judge, exactly like the app's upload
  // probe treats unreadable as 0.
  const INTRO_VIDEO_MAX_SECONDS = 60;
  function introDurationSkip(durationSec) {
    if (typeof durationSec === "number" && isFinite(durationSec) &&
        durationSec > INTRO_VIDEO_MAX_SECONDS) {
      return "intro_video_too_long";
    }
    return null;
  }
  // One poll of the composer's video area, decided purely:
  // stillLoading = the "must finish loading" notice is up;
  // removePresent = the "Remove video" control exists (the
  // processed state's signature); counterAttached = the Videos
  // counter reads 1/1. Done requires the processed signature
  // AND the loading notice gone. A video that vanishes on its
  // own mid-wait (counter lost, nothing loading, nothing to
  // remove) was rejected by Facebook — a skip, not a timeout.
  function introProcessingVerdict(obs) {
    const o = obs || {};
    if (o.removePresent && !o.stillLoading) return "done";
    if (!o.stillLoading && !o.removePresent && !o.counterAttached &&
        o.everAttached) return "rejected";
    if (o.elapsedMs >= o.timeoutMs) return "timeout";
    return "wait";
  }
  // [PURE-INTRO-VIDEO-END]

  // [PURE-LIVENESS-BEGIN] — extracted and unit-exercised by
  // the test harness; keep these free of DOM/chrome references.
  // Job-liveness verdict (v2.54, header note 28). The worker
  // answers the AUTOLAUNCH_JOB_LIVENESS ask with { live: true }
  // or { live: false, reason }. ONLY a well-formed, explicit
  // "not live" verdict may abort a fill — a missing, malformed,
  // errored or timed-out answer is uncertainty, and uncertainty
  // always proceeds exactly as the fill did before this check
  // existed. Returns the worker's reason string when the fill
  // must abort, null when it may proceed.
  function livenessAbortReason(resp) {
    if (resp && resp.live === false &&
        typeof resp.reason === "string" && resp.reason) {
      return resp.reason;
    }
    return null;
  }
  // [PURE-LIVENESS-END]

  // Every wait for the worker is raced against a clock
  // (v2.54, header note 28): a service worker that never
  // answers must read as an ordinary failure, never as a hang.
  // The relay gets 35s — just past the worker's own 30s fetch
  // abort, so a healthy-but-slow relay answer still lands.
  const VIDEO_RELAY_TIMEOUT_MS = 35 * 1000;
  const VIDEO_DIRECT_TIMEOUT_MS = 30 * 1000;
  const JOB_LIVENESS_TIMEOUT_MS = 5 * 1000;

  function relayVideo(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), VIDEO_RELAY_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_FETCH_VIDEO", url }, resp => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          finish(resp || null);
        });
      } catch (e) { clearTimeout(timer); finish(null); }
    });
  }

  // The job-liveness ask (v2.54, header note 28): is the job
  // this tab loaded from storage still the worker's live job?
  // Resolves with the worker's verdict object, or null on any
  // transport failure/timeout — the caller treats null as
  // "unknown", and unknown always proceeds (livenessAbortReason).
  function askJobLiveness(queueId) {
    return new Promise(resolve => {
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), JOB_LIVENESS_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_JOB_LIVENESS", queueId }, resp => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          finish(resp || null);
        });
      } catch (e) { clearTimeout(timer); finish(null); }
    });
  }

  // The clip bytes, two stages like the photos: the worker relay
  // first (no CORS wall), then a direct fetch — the intro bucket
  // is our own public storage, the one origin a page fetch may
  // legitimately reach. Throws only when both stages failed.
  // Both stages are time-bounded (v2.54, header note 28): the
  // relay answer is raced at 35s above, and the direct fetch
  // aborts at 30s — a stall in either reads as the ordinary
  // download failure the caller already skips on.
  async function fetchVideoBlob(url) {
    const relayed = await relayVideo(url);
    if (relayed && relayed.ok && relayed.base64) {
      return base64ToBlob(relayed.base64, relayed.contentType || "video/mp4");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (e) { /* no-op */ }
    }, VIDEO_DIRECT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error("video_direct_" + res.status);
      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  // Duration probe (mirrors the app's own upload probe): a
  // throwaway <video> reads metadata off an object URL. Answers
  // 0 when the browser won't say — introDurationSkip treats 0
  // as "unproven", never as a conviction. Bounded at 10s
  // (v2.54, header note 28): metadata that never arrives
  // answers 0 (proceed) instead of waiting forever.
  const INTRO_PROBE_TIMEOUT_MS = 10 * 1000;
  function probeVideoDuration(blob) {
    return new Promise(resolve => {
      let url = null;
      let finished = false;
      try {
        url = URL.createObjectURL(blob);
        const probe = document.createElement("video");
        probe.preload = "metadata";
        const done = d => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* no-op */ } }
          resolve(isFinite(d) ? d : 0);
        };
        const timer = setTimeout(() => done(0), INTRO_PROBE_TIMEOUT_MS);
        probe.onloadedmetadata = () => done(probe.duration);
        probe.onerror = () => done(0);
        probe.src = url;
      } catch (e) { resolve(0); }
    });
  }

  // The composer's dedicated video input: an accept that names
  // video wins outright; otherwise any file input whose accept
  // mentions mp4/quicktime/webm, or whose nearby labelling says
  // video.
  function findVideoInput() {
    const direct = document.querySelector('input[type="file"][accept*="video"]');
    if (direct) return direct;
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find(i => {
      const accept = (i.getAttribute("accept") || "").toLowerCase();
      if (accept.includes("mp4") || accept.includes("quicktime") ||
          accept.includes("webm")) return true;
      let node = i;
      for (let d = 0; d < 4 && node; d++) {
        node = node.parentElement;
        const lab = (node && node.getAttribute &&
          node.getAttribute("aria-label")) || "";
        if (/add video|video/i.test(lab)) return true;
      }
      return false;
    }) || null;
  }

  function videoLoadingNotice() {
    const t = (document.body.innerText || "").toLowerCase();
    return t.includes("must finish loading");
  }

  function removeVideoButton() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    return btns.find(b => {
      const lab = ((b.getAttribute("aria-label") || "") + " " +
        (b.textContent || "")).toLowerCase();
      return lab.includes("remove") && lab.includes("video");
    }) || null;
  }

  function videoCounterAttached() {
    const t = (document.body.innerText || "");
    return /videos?\s*[·•]\s*1\s*\/\s*1/i.test(t);
  }

  // Attach the job's intro video (v2.1.53). Returns true when
  // the clip is on the listing and processed; false for EVERY
  // skip — and each skip names itself in the console. The
  // caller continues the post identically either way.
  const INTRO_PROCESS_TIMEOUT_MS = 120 * 1000;
  async function attachIntroVideo() {
    if (!introVideo) return false;
    // Announce BEFORE the download (v2.54, header note 28):
    // in 2.53 the banner only changed after the fetch
    // returned, so a stalled download sat silently under the
    // photo banner and looked like a photo-upload hang.
    say("Adding your intro video…");
    console.log("[AutoLaunch] Intro video: downloading the clip…");
    const input = findVideoInput();
    if (!input) {
      console.log("[AutoLaunch] Intro video skipped (intro_video_input_not_found).");
      return false;
    }
    let blob;
    try {
      blob = await fetchVideoBlob(introVideo.url);
    } catch (e) {
      console.log("[AutoLaunch] Intro video skipped (intro_video_download_failed).");
      return false;
    }
    if (!blob || !blob.size) {
      console.log("[AutoLaunch] Intro video skipped (intro_video_empty).");
      return false;
    }
    const duration = await probeVideoDuration(blob);
    const durSkip = introDurationSkip(duration);
    if (durSkip) {
      console.log(`[AutoLaunch] Intro video skipped (${durSkip}: ${Math.round(duration)}s > ${INTRO_VIDEO_MAX_SECONDS}s).`);
      return false;
    }
    // (The banner already reads "Adding your intro video…" —
    // it was set before the download, v2.54 header note 28.)
    const name = (introVideo.url.split("/").pop() || "intro.mp4").split("?")[0];
    const file = new File([blob], name, { type: blob.type || "video/mp4" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Wait for Facebook to take it, then to finish processing
    // it: the form refuses to proceed while a video loads, so
    // Publish must never race a half-processed clip. The wait
    // is bounded — a stall costs the video (removed below),
    // never the post.
    const startedAt = Date.now();
    let everAttached = false;
    for (;;) {
      await sleep(1500);
      const obs = {
        stillLoading: videoLoadingNotice(),
        removePresent: !!removeVideoButton(),
        counterAttached: videoCounterAttached(),
        everAttached,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: INTRO_PROCESS_TIMEOUT_MS
      };
      if (obs.removePresent || obs.counterAttached || obs.stillLoading) {
        everAttached = true;
        obs.everAttached = true;
      }
      const verdict = introProcessingVerdict(obs);
      if (verdict === "done") {
        console.log("[AutoLaunch] Intro video attached and processed.");
        return true;
      }
      if (verdict === "rejected") {
        console.log("[AutoLaunch] Intro video skipped (intro_video_rejected).");
        return false;
      }
      if (verdict === "timeout") {
        console.log("[AutoLaunch] Intro video skipped (intro_video_processing_timeout) — removing the half-attached clip.");
        const rm = removeVideoButton();
        if (rm) {
          realisticClick(rm);
          await sleep(1200);
        }
        return false;
      }
    }
  }

  function publishButton() {
    const btns = Array.from(document.querySelectorAll('[role="button"], button'));
    return btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t === "publish" || t === "post" || t.startsWith("publish");
    }) || null;
  }

  // May the Full Auto tail click Publish a SECOND time? (v2.52,
  // header note 26). The old rule — "the button is still there"
  // — clicked again even when Facebook had accepted the first
  // click and was merely still rendering it, manufacturing the
  // duplicate shells of 2026-10-28. A retry now requires
  // POSITIVE evidence the first click never submitted: the page
  // never navigated, the button is enabled and carries no busy
  // state or spinner, and no dialog is up. Anything unknown
  // answers no — the Selling-page verification is the arbiter,
  // never a second blind click.
  function publishRetryEvidence(urlBefore, btn) {
    try {
      if (!btn) return false;
      if (window.location.href !== urlBefore) return false;
      if (btn.disabled) return false;
      if (typeof btn.getAttribute === "function") {
        if (btn.getAttribute("aria-disabled") === "true") return false;
        if (btn.getAttribute("aria-busy") === "true") return false;
      }
      if (typeof btn.querySelector === "function" &&
          btn.querySelector('[role="progressbar"], [aria-busy="true"]')) return false;
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (dialog && isVisibleEl(dialog)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function nextButton() {
    const btns = Array.from(document.querySelectorAll('[role="button"], button'));
    return btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t !== "next") return false;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      return true;
    }) || null;
  }

  function detectPublished() {
    const url = window.location.href;
    if (/facebook\.com\/marketplace\/item\//.test(url)) return url;
    if (/marketplace\/you\/selling|commerce\/listing/.test(url)) return url;
    const text = (document.body.innerText || "").toLowerCase();
    if (text.includes("your listing is now live") ||
        text.includes("your listing has been published") ||
        text.includes("listed on marketplace")) {
      return url;
    }
    return null;
  }

  async function watchForPublish(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = detectPublished();
      if (hit) return hit;
      await sleep(3000);
    }
    return null;
  }

  // Confirm-mode watch (v2.1.7): same passive detection, but it
  // also tracks whether the human evidently clicked Publish — the
  // button disappearing (the flow navigated, or Facebook replaced
  // it with a progress state) or the URL moving. Expiry then forks:
  // clicked-but-unconfirmed escalates to active Selling-page
  // verification instead of a blind failure; never-clicked keeps
  // the long-standing honest failure.
  async function watchForPublishClick(timeoutMs) {
    const startUrl = window.location.href;
    const deadline = Date.now() + timeoutMs;
    let clickLikely = false;
    while (Date.now() < deadline) {
      const hit = detectPublished();
      if (hit) return { hit, clickLikely: true };
      if (!publishButton()) clickLikely = true;
      if (window.location.href !== startUrl) clickLikely = true;
      await sleep(3000);
    }
    return { hit: null, clickLikely };
  }

  function checkpointShowing() {
    const t = (document.body.innerText || "").toLowerCase();
    return t.includes("checkpoint") || t.includes("confirm your identity");
  }

  // ---- listing mileage (Matthew, 2026-10-23; floor generalized
  // v2.1.23) -------------------------------------------------------
  // Facebook's vehicle form refuses mileage under 300 — a form
  // carrying 0 (or an empty mileage) keeps its Next button
  // disabled, so the job can fill and verify every required field
  // and still never reach Publish. That is exactly what stopped
  // the 2027 Sentra on 2.1.22: stored miles 0, everything else
  // perfect, Next greyed. The original rule covered NEW cars
  // (brand-new cars legitimately have almost no miles; the
  // scraper defaults unpublished new-car miles to 1,000).
  // v2.1.23 generalizes the floor to ANY car: stored miles missing
  // or under 300 → the form gets 1,000 and the description
  // discloses the default (the brand-new wording for new cars, an
  // ask-us wording otherwise). Real published miles (300+) always
  // post as-is; a stored 1,000 on a NEW car is the scraper's own
  // default, so its disclosure still applies.
  function listingMileage() {
    const stored = car.mileage != null && car.mileage !== "" ? Number(car.mileage) : null;
    const isNew = /^new$/i.test(String(car.condition || "").trim());
    if (stored !== null && stored >= 300) {
      return { miles: stored, defaulted: isNew && stored === 1000, isNew };
    }
    return { miles: 1000, defaulted: true, isNew };
  }

  // ---- description ------------------------------------------------------
  function buildDescription() {
    const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"} ${car.trim || ""}`.trim();
    const lm = listingMileage();
    // Stock number (v2.1.43, Matthew's request): with the user's
    // include_stock preference on, the description names the stock
    // number directly under the VIN — the pair a buyer reads off the
    // lot tag. Fail-open both ways: preference off, or no stock
    // number on the car, and the line simply isn't there — the
    // description stays byte-identical to before this change.
    // v2.1.44: the value may arrive as stock_num (queue-row stamp,
    // or the worker's inventory fallback — see background note 21)
    // or as the inventory row's own stock_number; first usable
    // value wins.
    const stockRaw = (car.stock_num != null && String(car.stock_num).trim())
      ? car.stock_num : car.stock_number;
    const stock = stockRaw != null ? String(stockRaw).trim() : "";
    let desc = (
      `${title}\n` +
      `Price: $${(car.price || 0).toLocaleString()}\n` +
      (lm.miles != null ? `Mileage: ${lm.miles.toLocaleString()} miles\n` : "") +
      (car.color && normText(car.color) !== "standard" ? `Exterior: ${car.color}\n` : "") +
      (car.transmission ? `Transmission: ${car.transmission}\n` : "") +
      (car.vin ? `VIN: ${car.vin}\n` : "") +
      (includeStock && stock ? `Stock #: ${stock}\n` : "") +
      (lm.defaulted
        ? (lm.isNew
          ? `\nBrand new vehicle — the mileage shown is a listing default; actual miles may be less.`
          : `\nMileage shown is a listing default — exact miles were not published for this vehicle; ask us for the current odometer reading.`)
        : "") +
      `\nInspected and frontline ready. Message to set up a test drive!`
    );
    // Dealership closing block (v2.1.42, Matthew's request): the
    // listing's About text ends with the dealership's name and
    // address on their own lines, so a buyer reading the post knows
    // whose car it is and where it sits. Fail-open: append whichever
    // of name/address the user has saved; when both are empty the
    // description is exactly what it was before this change.
    const dealerLines = [dealershipName, dealershipAddress].filter(s => s);
    if (dealerLines.length) {
      desc += `\n\n${dealerLines.join("\n")}`;
    }
    return desc;
  }

  function findDescriptionField() {
    // No real controls on the step = no editor exists (v2.1.5).
    if (!stepHasRealControls()) return null;
    // Form region only (v2.1.4): the preview pane repeats the whole
    // description as prose — it is not an editor and must never be
    // "filled" or read back as one.
    const textareas = Array.from(document.querySelectorAll("textarea"))
      .filter(isFormCandidate);
    const byLabel = textareas.find(t => fieldLabel(t).includes("description"));
    if (byLabel) return byLabel;
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(isFormCandidate);
    const ed = editables.find(t => fieldLabel(t).includes("description") || nearbyText(t).includes("description"));
    if (ed) return ed;
    return textareas[0] || null;
  }

  function descriptionExpectedSnippet() {
    const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"}`.trim();
    return title;
  }

  async function fillDescription() {
    const field = findDescriptionField();
    if (!field) return;
    const want = buildDescription();
    if (normText(extractValue(field)).includes(normText(descriptionExpectedSnippet()))) return;
    if (field.tagName === "TEXTAREA" || field.tagName === "INPUT") {
      nativeSetValue(field, want);
    } else {
      field.focus();
      field.textContent = want;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await humanPause();
  }

  // ---- step field filling ------------------------------------------------
  // Everything here is presence-guarded: Facebook serves layout variants
  // and steps, so each filler only acts when its field is on this step.
  async function fillCurrentStepFields(isFirstStep) {
    // Swat any informational modal Facebook hung over the form (the
    // VIN help modal, v2.1.6 header note 17) BEFORE touching fields —
    // it overlays the form and eats clicks. This runs ahead of the
    // real-controls gate: an overlay matters even on a step with
    // nothing to fill.
    await dismissInfoModals();
    // A step with no real form control has nothing to fill (v2.1.5,
    // header note 16) — the audience step is the case that matters:
    // prose, checkboxes and the preview card, but no fields. Skip
    // the whole pass; the step walker still finds Publish/Next.
    if (!stepHasRealControls()) return;
    // VIN FIRST on step 1, before anything it can corrupt: Facebook's
    // VIN decoder auto-populates (badly, observed live), so give it time
    // to fire and settle, THEN overwrite with payload truth below.
    if (isFirstStep && car.vin && fieldPresent(["vin"])) {
      const vinField = findAnyField(["vin"]);
      // Fill the INPUT element itself, never the labelled wrapper
      // around it: in this variant the wrapper carries the ⓘ help
      // icon, and poking the container is what summons Facebook's
      // "Finding your vehicle's VIN" modal (v2.1.6).
      const vinInput = !vinField ? null
        : (vinField.tagName === "INPUT" || vinField.tagName === "TEXTAREA")
          ? vinField
          : (typeof vinField.querySelector === "function"
              ? vinField.querySelector("input, textarea") : null);
      if (vinInput && !valueMatches(extractValue(vinInput), car.vin, "text")) {
        nativeSetValue(vinInput, String(car.vin));
        say("VIN entered — waiting for Facebook's auto-fill to settle, then setting the real details…");
        await sleep(3000); // decoder settles inside this window
      }
      // The modal typically appears as the decoder engages — clear
      // it before the cascade below starts clicking (v2.1.6).
      await dismissInfoModals();
    }

    // Vehicle type (step 1): Car/Truck for cars/SUVs/pickups.
    if (fieldPresent(["vehicle type"])) {
      await fillSelectOrListbox(["vehicle type"], vehicleTypeCandidates(car));
      await humanPause();
    }

    // Year → Make → Model cascade (payload values overwrite anything
    // the VIN decoder guessed).
    if (fieldPresent(["year"]) || fieldPresent(["make"]) || fieldPresent(["model"])) {
      say("Filling in vehicle details…");
      await fillYearMakeModel();
      await humanPause();
    }

    const priceField = findField(["price"]);
    if (priceField && car.price) { nativeSetValue(priceField, String(car.price)); await humanPause(); }

    const mileageField = findField(["mileage", "odometer"]);
    const lmFill = listingMileage();
    if (mileageField && lmFill.miles != null) { nativeSetValue(mileageField, String(lmFill.miles)); await humanPause(); }

    // Step-2 fields — best-effort, never job-fatal (see verify set).
    const bodyCands = bodyStyleCandidates(car);
    if (bodyCands.length && fieldPresent(["body style", "body type"])) {
      await fillSelectOrListbox(["body style", "body type"], bodyCands);
      await humanPause();
    }
    // Colors (v2.1.3): dealer names are normalized against the
    // options Facebook actually offers, the pick is read back, and
    // the outcome is recorded as a step note. Best-effort still —
    // a color miss never fails the job. "Standard" in the data
    // means "we don't know" — never try to post it as a color.
    // v2.1.26: fill whenever the FIELD is present, even when the car
    // has no color recorded (or only "Standard" = unknown). The
    // v2.1.19 last-resort default inside fillColorDropdown exists for
    // exactly that case, but these callers used to skip the call
    // entirely when the data was missing — leaving a required color
    // unset, Facebook's Next disabled, and the job dead at "could
    // not reach the Publish button" (2026-10-25 HR-V, interior null).
    if (fieldPresent(["exterior color", "exterior"])) {
      await fillColorDropdown("ExteriorColor", ["exterior color", "exterior"], car.color);
      await humanPause();
    }
    if (fieldPresent(["interior color", "interior"])) {
      await fillColorDropdown("InteriorColor", ["interior color", "interior"], car.interior_color);
      await humanPause();
    }

    const conditionMap = {
      "New": ["New"],
      "Certified Pre-Owned": ["Certified pre-owned", "Certified", "Used - Excellent", "Excellent"],
      "Certified": ["Certified pre-owned", "Certified", "Used - Excellent", "Excellent"],
      "Used": ["Used - Good", "Used", "Good"]
    };
    if (fieldPresent(["condition"])) {
      await fillSelectOrListbox(["condition"], conditionMap[car.condition] || ["Used - Good", "Used"]);
      await humanPause();
    }
    if (car.fuel_type && fieldPresent(["fuel"])) {
      await fillSelectOrListbox(["fuel"], [car.fuel_type]);
      await humanPause();
    }
    if (car.transmission && fieldPresent(["transmission"])) {
      await fillSelectOrListbox(["transmission"], [car.transmission]);
      await humanPause();
    }
    if (car.body_type && car.body_type !== "Other" &&
        !fieldPresent(["body style"]) && fieldPresent(["style"])) {
      await fillSelectOrListbox(["style"], bodyStyleCandidates(car));
      await humanPause();
    }

    // Clean title: only when the user's preference or the payload says
    // the title is clean; when in doubt, leave it unchecked. Optional —
    // never part of the required verification set. The click is now
    // verified and the outcome recorded (v2.1.3).
    if (cleanTitleWanted(job, car)) {
      await fillCleanTitle();
    }

    // Description: present on step 1 AND again (empty) on step 2 — fill
    // whichever instance this step shows; verification re-checks it at
    // the final step.
    if (findDescriptionField()) {
      await fillDescription();
    }
  }

  // ---- required-field verification ---------------------------------------
  // Required set (verify-or-report): Photos ≥1, Year, Make, Model,
  // Price, Description. Everything else is best-effort.
  function requiredSpecForStep() {
    // EMPTY BY CONSTRUCTION on a step with no real form control
    // (v2.1.5, header note 16): the audience step can never demand
    // Year/Price from its preview card again. Fields verified on
    // earlier steps stay verified via the flow's verifiedEver set.
    if (!stepHasRealControls()) return [];
    const spec = [];
    // The four stubborn fields (Year/Make/Model/Price) refill via the
    // escalation ladder; their `refill` only reports success when a
    // read-back matches, and verifyFieldsWithRefill re-checks anyway.
    if (fieldPresent(["year"]) && car.year) {
      const f = {
        name: "Year", kind: "year", expected: car.year, keywords: ["year"],
        read: () => readField(["year"]),
        rung1: async () => {
          await fillSelectOrListbox(["year"], [String(car.year)]) ||
            await fillCombobox(["year"], car.year);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["make"]) && car.make) {
      const f = {
        name: "Make", kind: "text", expected: car.make, keywords: ["make"],
        read: () => readField(["make"]),
        rung1: async () => {
          await waitForEnabled(["make"]);
          await fillSelectOrListbox(["make"], [car.make]) ||
            await fillCombobox(["make"], car.make);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["model"]) && car.model) {
      const f = {
        name: "Model", kind: "text", expected: car.model, keywords: ["model"],
        read: () => readField(["model"]),
        rung1: async () => {
          await waitForEnabled(["model"]);
          await fillSelectOrListbox(["model"], [car.model]) ||
            await fillCombobox(["model"], car.model);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["price"]) && car.price) {
      const f = {
        name: "Price", kind: "price", expected: car.price, keywords: ["price"],
        read: () => readField(["price"]),
        rung1: async () => {
          const pf = findField(["price"]);
          if (pf) nativeSetValue(pf, String(car.price));
          await sleep(400);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (findDescriptionField()) {
      spec.push({
        name: "Description", kind: "contains", expected: descriptionExpectedSnippet(),
        read: () => extractValue(findDescriptionField()),
        refill: async () => {
          const f = findDescriptionField();
          if (f) {
            if (f.tagName === "TEXTAREA" || f.tagName === "INPUT") nativeSetValue(f, buildDescription());
            else { f.focus(); f.textContent = buildDescription(); f.dispatchEvent(new Event("input", { bubbles: true })); }
          }
          await sleep(400);
        }
      });
    }
    return spec;
  }

  // For the never-empty diagnostics (v3.2): the location keywords and
  // the payload value per required-field name, so a field that failed
  // WITHOUT ever entering a spec can still get a synthesized record.
  const REQUIRED_FIELD_KEYWORDS = {
    Year: ["year"], Make: ["make"], Model: ["model"], Price: ["price"]
  };
  function expectedForFieldName(name) {
    switch (name) {
      case "Year": return car.year;
      case "Make": return car.make;
      case "Model": return car.model;
      case "Price": return car.price;
      case "Description": return descriptionExpectedSnippet();
      default: return null;
    }
  }
  function locateRequiredField(name) {
    if (name === "Description") return findDescriptionField();
    const kw = REQUIRED_FIELD_KEYWORDS[name];
    return kw ? findAnyField(kw) : null;
  }

  // ---- delete flow (v2.1.4, header note 14) ------------------------------
  // Runs only on the selling page, only for job.action === "delete".
  // The listing card is the SMALLEST visible element whose text
  // strictly matches title + price (listingTextMatches): ancestors
  // aggregate many listings (their price sets would false-match), and
  // a title-only or price-only fragment proves nothing.
  function listingCardsIn(rootEl, matcher) {
    const matches = matcher || listingTextMatches;
    const scope = rootEl
      ? [rootEl].concat(Array.from(
          rootEl.querySelectorAll ? rootEl.querySelectorAll("div, article, li, section") : []))
      : Array.from(document.querySelectorAll("div, article, li, section"));
    const hits = scope.filter(el => {
      if (!isVisibleEl(el)) return false;
      // NEVER our own banner (v2.1.9, header note 19b): its text
      // names the car being looked for, so it satisfies the
      // title-only matcher on ANY page — on an empty selling page
      // it was the ONLY "title card" and vetoed goal-achieved.
      if (el === banner) return false;
      try { if (el.id === "autolaunch-status-banner") return false; } catch (e) {}
      const text = el.textContent || "";
      if (!text || text.length > 1500) return false;
      return matches(text, car);
    });
    // Minimal elements only: a hit that contains another hit is a
    // wrapper (list, column), not the card.
    return hits.filter(el => !hits.some(o =>
      o !== el && typeof el.contains === "function" && el.contains(o)));
  }
  function findListingCards() {
    return listingCardsIn(null);
  }
  // Title-only cards (v2.1.7): same minimal-card discipline, but
  // the matcher ignores price — a hit proves this car is listed at
  // SOME price, which is what separates "already gone" from "live
  // at a different price" in the delete flow's zero-match branch.
  function findListingCardsByTitle() {
    return listingCardsIn(null, listingTitleMatches);
  }
  // Did the Selling page actually render? Goal-achieved delete
  // semantics (note 18) may only conclude "gone" from a page that
  // demonstrably loaded. v2.1.9 (header note 19b): the check is
  // now an explicit SIGNAL SET, so the zero-match branch can log
  // exactly which evidence fired. The routing guard already
  // confines this script to /marketplace/you/selling|dashboard,
  // so page context is given; what must be proven POSITIVELY is
  // selling chrome — sidebar/heading labels or the listings
  // search box (a POPULATED page) — or the zero-listings empty
  // state (an EMPTY page: "When you start selling, your listings
  // will appear here." + Create new listing, with NO listings
  // container at all). The pre-2.1.9 signals ("your listings",
  // "when you start selling", listings search) are all kept. A
  // bare still-loading page carries NONE of these and proves
  // nothing — conservatism preserved.
  function sellingChromeSignals() {
    const text = (document.body.innerText || "")
      .toLowerCase().replace(/[’‘]/g, "'");
    const inputs = Array.from(document.querySelectorAll("input"));
    return {
      yourListings: text.includes("your listings"),
      sellerDashboard: text.includes("seller dashboard"),
      yourPayouts: text.includes("your payouts"),
      createNewListing: text.includes("create new listing"),
      listingsSearch: inputs.some(i =>
        String((typeof i.getAttribute === "function" && i.getAttribute("placeholder")) || "")
          .toLowerCase().includes("listings")),
      emptyStartSelling: text.includes("when you start selling"),
      emptyWillAppear: text.includes("your listings will appear here"),
      emptyDontHave: text.includes("you don't have any listings"),
      emptyNoListingsYet: text.includes("no listings yet")
    };
  }
  function sellingRenderedFromSignals(signals) {
    return Object.keys(signals).some(k => signals[k]);
  }
  function sellingPageRendered() {
    return sellingRenderedFromSignals(sellingChromeSignals());
  }
  // One "Mark as sold" (or "Mark as available") button per listing
  // card — a cheap census of how many cards the page has actually
  // rendered, used to tell a settled list from a still-loading one.
  function countSellingCards() {
    const btns = Array.from(document.querySelectorAll('[role="button"], button'));
    return btns.filter(b => isVisibleEl(b) &&
      /^\s*mark as (sold|available)\b/i.test(b.textContent || "")).length;
  }
  // Scroll the selling list end to end (bounded) so lazy cards
  // enter the DOM, repeating until the card census is stable across
  // a round. The delete flow's scans are only trustworthy on a
  // settled list (v2.1.13 delete-verification hardening: on
  // 2026-10-23 a delete declared a live, under-review listing
  // "already gone" from one early scan of a still-loading page).
  async function settleSellingList() {
    // Trimmed in v2.1.15: on a long list the original 5 rounds x 16
    // steps scrolled so much the user noticed and worried. Three
    // rounds with an early exit on a stable census settles every
    // list seen so far; the fresh-load proof (note: runDeleteProof)
    // is the real correctness backstop now, not scroll volume.
    let last = -1;
    for (let round = 0; round < 3; round++) {
      const h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0);
      const steps = Math.max(2, Math.min(10, Math.ceil(h / 1100) + 1));
      for (let s = 0; s < steps; s++) {
        try { window.scrollTo(0, Math.floor((h * s) / Math.max(1, steps - 1))); } catch (e) {}
        await sleep(180);
      }
      try { window.scrollTo(0, 0); } catch (e) {}
      await sleep(1100);
      const c = countSellingCards();
      if (c === last) break;
      last = c;
    }
  }
  // The card's ⋯ (options) button. Searched inside the card first,
  // then up the ancestor chain — but a level is only trusted while it
  // still contains exactly ONE matching listing, so a neighbouring
  // card's menu can never be opened by mistake.
  function listingMenuButton(cardEl) {
    let node = cardEl;
    for (let depth = 0; depth < 6 && node; depth++) {
      if (listingCardsIn(node).length !== 1) return null;
      const btns = Array.from(
        node.querySelectorAll ? node.querySelectorAll('[role="button"], button') : []);
      const hit = btns.find(b => {
        const lab = ((typeof b.getAttribute === "function" && b.getAttribute("aria-label")) || "") +
          " " + (b.textContent || "");
        const t = lab.trim();
        return /more|options|menu/i.test(lab) || t === "⋯" || t === "..." || t === "•••";
      });
      if (hit) return hit;
      node = node.parentElement;
    }
    return null;
  }
  // Facebook's delete entry, after the card menu opens. Menu/listbox
  // containers are searched before the whole document, so a stray
  // "Delete" elsewhere on the page is never the first resort.
  function findDeleteMenuItem() {
    const inContainers = [];
    for (const c of Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"]'))) {
      inContainers.push(...Array.from(
        c.querySelectorAll ? c.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], button, a') : []));
    }
    const isDeleteEntry = el => {
      const t = normText(el.textContent);
      return t === "delete" || t.startsWith("delete ") || t.includes("delete listing");
    };
    const scoped = inContainers.filter(el => isVisibleEl(el) && isDeleteEntry(el));
    if (scoped.length) return scoped[0];
    const anywhere = Array.from(document.querySelectorAll(
      '[role="menuitem"], [role="option"], [role="button"], button, a'));
    return anywhere.filter(el => isVisibleEl(el) && isDeleteEntry(el))[0] || null;
  }
  // Facebook's confirmation: a dialog whose button reads exactly
  // "Delete" (the menu entry says "Delete listing" — the exact text
  // is what separates the two steps). No dialog, no click: failing
  // honestly beats guessing at a bare button.
  // A confirm button is only usable when a human could click it
  // (v2.1.17): Facebook keeps hidden, disabled dialog TEMPLATES in
  // the DOM, and the pre-2.1.17 finder returned one of those in
  // ~0ms — the "confirm click" then landed on whatever actually
  // sat at the template's coordinates, the card obligingly
  // vanished from the page, and the server never deleted anything
  // (both 2.1.16 test deletes died exactly there).
  function isUsableConfirmButton(b) {
    if (!b || !isVisibleEl(b)) return false;
    if (b.disabled) return false;
    if (typeof b.getAttribute === "function") {
      if (b.getAttribute("aria-disabled") === "true") return false;
      if (b.getAttribute("aria-hidden") === "true") return false;
    }
    if (typeof b.closest === "function" && b.closest('[aria-hidden="true"]')) return false;
    const r = typeof b.getBoundingClientRect === "function"
      ? b.getBoundingClientRect() : null;
    if (!r || r.width < 4 || r.height < 4) return false;
    return true;
  }

  function findDeleteConfirmButton() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of dialogs) {
      if (!isVisibleEl(d)) continue;
      if (typeof d.getAttribute === "function" &&
          d.getAttribute("aria-hidden") === "true") continue;
      const btns = Array.from(
        d.querySelectorAll ? d.querySelectorAll('[role="button"], button') : []);
      const hit = btns.find(b => normText(b.textContent) === "delete" &&
        isUsableConfirmButton(b));
      if (hit) return hit;
    }
    return null;
  }

  // ---- share-to-feed finders (v2.1.55, header note 29;
  // entry reworked v2.1.57, header note 31) ----------------------------
  // The matched card's OWN Share button: every Selling-page
  // card carries a dedicated Share control whose aria-label
  // NAMES its listing ("Share 2014 Volkswagen Beetle"). The
  // 2.1.56 runner instead opened the card's ⋯ menu — which
  // contains no Share entry at all — and a document-wide
  // "Share" search then clicked the Sentra card's own Share
  // button, first in DOM order. The search is now CONFINED
  // to the strictly matched card (climbing only through
  // wrappers that still hold exactly one strict match, the
  // listingMenuButton discipline), and each candidate's
  // label is verified against the job before any click.
  // Label verdicts: "match" — the label carries the job's
  // year + make + model token; "mismatch" — the label
  // carries A year, and it is not this car's (it names a
  // different listing); "unlabeled" — the label is the bare
  // action ("Share", "Share listing") and names no car.
  function shareButtonLabel(el) {
    const aria = (typeof el.getAttribute === "function" &&
      el.getAttribute("aria-label")) || "";
    return String(aria).trim() || normText(el.textContent);
  }
  function shareLabelVerdict(label) {
    const t = normText(label);
    if (!/^share\b/.test(t)) return null;
    const yearHit = !!car.year && t.includes(String(car.year));
    const makeHit = !!car.make && t.includes(normText(car.make));
    const modelToken = normText(car.model || "").split(" ")[0];
    const modelHit = !!modelToken && t.includes(modelToken);
    if (yearHit && makeHit && modelHit) return "match";
    if (/\b(?:19|20)\d\d\b/.test(t)) return "mismatch";
    return "unlabeled";
  }
  function findCardShareButton(card) {
    if (!card) return null;
    let node = card;
    let firstMismatch = null;
    for (let depth = 0; depth < 6 && node; depth++) {
      // A level is trusted only while it still contains
      // exactly ONE strictly matching listing.
      if (listingCardsIn(node).length !== 1) break;
      const btns = Array.from(
        node.querySelectorAll ? node.querySelectorAll('[role="button"], button, a') : []);
      let inCardUnlabeled = null;
      for (const b of btns) {
        if (!isVisibleEl(b)) continue;
        const verdict = shareLabelVerdict(shareButtonLabel(b));
        if (!verdict) continue;
        const inCard = depth === 0 ||
          (typeof card.contains === "function" && card.contains(b));
        if (verdict === "match") {
          return { el: b, label: shareButtonLabel(b), verdict, depth };
        }
        if (verdict === "unlabeled" && inCard && !inCardUnlabeled) {
          inCardUnlabeled = { el: b, label: shareButtonLabel(b), verdict, depth };
        }
        if (verdict === "mismatch" && !firstMismatch) {
          firstMismatch = { el: b, label: shareButtonLabel(b), verdict, depth };
        }
      }
      if (inCardUnlabeled) return inCardUnlabeled;
      node = node.parentElement;
    }
    // Only different-car candidates (or none): the runner
    // fails share_target_mismatch on a mismatch, or
    // share_item_not_found on null.
    return firstMismatch;
  }
  // Facebook's share dialog: a visible dialog whose text is
  // about sharing to a destination (feed / timeline / story /
  // group) or posting the share. A bare dialog that never
  // mentions any of it is not assumed to be the share sheet.
  function isShareDialogEl(d) {
    if (!isVisibleEl(d)) return false;
    if (typeof d.getAttribute === "function" &&
        d.getAttribute("aria-hidden") === "true") return false;
    const t = normText(d.textContent);
    return t.includes("share") &&
      (t.includes("feed") || t.includes("post") ||
       t.includes("your timeline") || t.includes("story") ||
       t.includes("group"));
  }
  function findShareDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .filter(isShareDialogEl);
  }
  function findShareDialog() {
    return findShareDialogs()[0] || null;
  }
  // The TOPMOST share dialog: when Facebook stacks the post
  // composer over the share sheet, the composer dialog is
  // the LAST one in document order — the dialog that
  // reaches the confirm (v2.1.57, header note 31).
  function lastShareDialog() {
    const ds = findShareDialogs();
    return ds.length ? ds[ds.length - 1] : null;
  }
  // Every dialog currently open, share-shaped or not: the
  // composer hunt and the closed-check look at the whole
  // stack, because the post composer a share transitions
  // into need not carry the word "share" at all.
  function openShareDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .filter(d => isVisibleEl(d) &&
        !(typeof d.getAttribute === "function" &&
          d.getAttribute("aria-hidden") === "true"));
  }
  async function pollForShareDialog(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const d = findShareDialog();
      if (d) return { dialog: d, elapsed: Date.now() - t0 };
      if (Date.now() - t0 >= timeoutMs) return { dialog: null, elapsed: Date.now() - t0 };
      await sleep(300);
    }
  }
  const isFeedDestination = el => {
    const t = normText(el.textContent);
    return t === "your feed" || t === "feed" || t === "share to your feed" ||
      t === "your timeline" || t.startsWith("your feed ");
  };
  // A FEED destination inside the share dialog, when the
  // dialog offers destinations at all. The composer may
  // preselect the feed (then nothing matches and the confirm
  // is the whole flow); a story/group choice is NEVER clicked.
  function findShareFeedOption(dialog) {
    if (!dialog) return null;
    const els = Array.from(dialog.querySelectorAll(
      '[role="radio"], [role="option"], [role="button"], button, label'));
    return els.find(el => isVisibleEl(el) && isFeedDestination(el)) || null;
  }
  // The share dialog's confirm: a usable button whose text is an
  // explicit commit — "Post" (the feed composer's wording),
  // "Share now", or "Share" (the share sheet's), in that
  // preference order, so a stray Share label elsewhere in the
  // dialog never wins over the real commit.
  function findShareConfirmButton(dialog) {
    if (!dialog) return null;
    const btns = Array.from(dialog.querySelectorAll('[role="button"], button'));
    const usable = btns.filter(b => isUsableConfirmButton(b));
    for (const want of ["post", "share now", "share"]) {
      const hit = usable.find(b => normText(b.textContent) === want);
      if (hit) return hit;
    }
    return null;
  }

  // ---- share identity + details-text gates (v2.1.56, note 30) --------
  // The listing identity a share DIALOG presents, read from its
  // own text: every $ amount it shows, whether any year shows,
  // and the normalized text the token checks run against.
  function shareIdentityFromText(rawText) {
    const text = normText(rawText || "");
    const prices = [];
    const re = /\$\s?(\d[\d,]*(?:\.\d{2})?)/g;
    let m;
    while ((m = re.exec(String(rawText || ""))) !== null) {
      const n = moneyNumber(m[1]);
      if (n != null && !prices.includes(n)) prices.push(n);
    }
    return { text, prices, hasYear: /\b(?:19|20)\d\d\b/.test(text) };
  }
  // The verdict on the dialog's identity vs the job's stamped
  // car. "match": the dialog presents this car's year + make +
  // model token + price. "mismatch": the dialog DID present a
  // readable identity (a price, or any year) and it is not this
  // car — the Sentra case; the share aborts before any confirm.
  // "unreadable": no price and no year anywhere — the dialog
  // shows nothing to compare, and the share rides on the
  // pre-dialog anchor gate alone (note 30 states the boundary).
  function shareIdentityVerdict(dialog) {
    const seen = { prices: [], yearHit: false, makeHit: false, modelHit: false, priceHit: false };
    if (!dialog) return { status: "unreadable", seen };
    const info = shareIdentityFromText(dialog.textContent || "");
    seen.prices = info.prices;
    seen.yearHit = !!car.year && info.text.includes(String(car.year));
    seen.makeHit = !!car.make && info.text.includes(normText(car.make));
    const modelToken = normText(car.model || "").split(" ")[0];
    seen.modelHit = !!modelToken && info.text.includes(modelToken);
    const expPrice = car.price != null && car.price !== "" ? Number(car.price) : null;
    seen.priceHit = expPrice != null && info.prices.some(p => Math.abs(p - expPrice) < 1);
    const readable = info.prices.length > 0 || info.hasYear;
    if (!readable) return { status: "unreadable", seen };
    const match = seen.yearHit && seen.makeHit && seen.modelHit &&
      (expPrice == null || seen.priceHit);
    return { status: match ? "match" : "mismatch", seen };
  }
  // Seen-vs-expected, in the field_diag detail style — this is
  // the evidence a share_target_mismatch row carries.
  function shareIdentityDetail(verdict) {
    const exp = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim() +
      (car.price != null ? ` @ $${Number(car.price).toLocaleString()}` : "");
    const s = (verdict && verdict.seen) || {};
    const seenPrices = (s.prices || []).map(p => "$" + Number(p).toLocaleString()).join(", ") || "(none)";
    return `expected [${exp}]; dialog showed prices [${seenPrices}], ` +
      `year:${s.yearHit ? "hit" : "miss"} make:${s.makeHit ? "hit" : "miss"} ` +
      `model:${s.modelHit ? "hit" : "miss"} price:${s.priceHit ? "hit" : "miss"}`;
  }
  // Close a dialog WITHOUT confirming (the mismatch / no-text
  // abort): its own Close control when one exists, else an
  // Escape key. Best-effort and never throws — the abort's
  // honesty lives in the failure record, not in whether
  // Facebook tidied up after it.
  function dismissShareDialog(dialog) {
    try {
      if (dialog) {
        const btns = Array.from(dialog.querySelectorAll('[role="button"], button'));
        const close = btns.find(b => isVisibleEl(b) &&
          /^(close|dismiss|cancel)$/i.test(String(
            (typeof b.getAttribute === "function" && b.getAttribute("aria-label")) ||
            b.textContent || "").trim()));
        if (close) { realisticClick(close); return; }
      }
      document.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    } catch (e) { /* best-effort */ }
  }
  // The caption hints, one matcher (v2.1.58, header note
  // 32): the vocabulary that marks the share composer's
  // caption field — or the placeholder line standing in
  // for it before the editor wakes.
  function shareHintMatches(s) {
    return /say something|write something|what['’]s on your mind|say anything|add a caption|share your thoughts/i
      .test(String(s || ""));
  }
  // Is this element itself a surface the details text may
  // be inserted into? A textarea, or an element Facebook
  // has made editable — a contenteditable attribute with
  // any value but "false" (Facebook ships bare and
  // plaintext-only variants), the textbox role, or the
  // live isContentEditable property. Elements failing this
  // test may still be placeholder shells: ACTIVATION
  // targets (note 32), never insert targets.
  function isShareEditableEl(el) {
    if (!el || typeof el.getAttribute !== "function") return false;
    if (String(el.tagName || "").toUpperCase() === "TEXTAREA") return true;
    const ce = el.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
    if (el.getAttribute("role") === "textbox") return true;
    if (el.isContentEditable === true) return true;
    return false;
  }
  // The share composer's text field inside ONE dialog,
  // preferring one whose placeholder or label invites the
  // caption ("Say something…"). v2.1.57 (header note 31):
  // the contenteditable arm no longer demands the exact
  // ="true" value, and "What's on your mind" joins the
  // inviting hints. v2.1.58 (header note 32): the
  // candidate selector also admits elements bearing a
  // caption placeholder ATTRIBUTE (aria-placeholder /
  // data-placeholder) with no editor surface at all —
  // the click-to-wake shells — and the priority separates
  // inviting from editable: an inviting EDITABLE wins;
  // an inviting shell comes next (placeShareText routes
  // it to activation, never to insertion); then any
  // editable; invitingOnly still lets the stack-wide
  // search below prefer a caption field over a bare one
  // anywhere.
  function findShareTextField(dialog, invitingOnly) {
    if (!dialog) return null;
    const els = Array.from(dialog.querySelectorAll(
      'textarea, [contenteditable], [contenteditable="true"], [role="textbox"], ' +
      '[aria-placeholder], [data-placeholder]'))
      .filter(isVisibleEl);
    if (!els.length) return null;
    const hintOf = elm => {
      const g = n => (typeof elm.getAttribute === "function" && elm.getAttribute(n)) || "";
      return g("placeholder") + " " + g("aria-label") + " " +
        g("aria-placeholder") + " " + g("data-placeholder") + " " + fieldLabel(elm);
    };
    const inviting = els.filter(elm => shareHintMatches(hintOf(elm)));
    const invitingEditable = inviting.find(isShareEditableEl);
    if (invitingEditable) return invitingEditable;
    if (inviting.length) return inviting[0];
    if (invitingOnly) return null;
    const editable = els.find(isShareEditableEl);
    if (editable) return editable;
    return els[0];
  }
  // The composer may live in ANY open dialog — in the
  // 2026-10-29 v2.1.56 live run the search only ever looked
  // inside the first dialog, while Facebook's post composer
  // is stacked over the share sheet as the TOPMOST dialog.
  // Search the whole stack, topmost first, caption-inviting
  // fields before bare ones. Returns { field, dialog }.
  function findShareComposerField() {
    const stack = openShareDialogs().slice().reverse();
    for (const invitingOnly of [true, false]) {
      for (const d of stack) {
        const f = findShareTextField(d, invitingOnly);
        if (f) return { field: f, dialog: d };
      }
    }
    return null;
  }
  // Insert the details text into a located field with the
  // posting composer's own discipline (fillDescription:
  // whole-value assignment, never per-character typing, so a
  // full description lands in one step). True only when the
  // field reads back carrying the text's opening line.
  // v2.1.58 (header note 32): a contenteditable whose raw
  // textContent assignment does not read back gets a second
  // rung — execCommand insertText, the browser's real
  // editing pipeline (the posting ladder's rung-2 edit) —
  // because a React/Lexical editor can reconcile the raw
  // assignment out of its model while adopting text that
  // arrives as a genuine edit. Read-back decides both rungs.
  function insertShareTextIntoField(field, text, force) {
    if (!field) return false;
    const snippet = normText(String(text).split("\n")[0]);
    const readsBack = () => {
      try { return normText(extractValue(field)).includes(snippet); }
      catch (e) { return false; }
    };
    // force (v2.1.59): the dealership-tag cleanup restores
    // the details text over a field that still CONTAINS
    // it (plus the raw mention tail) — the already-placed
    // early exit would keep the tail, so the tag cleanup
    // passes force to run the real rungs.
    if (!force && readsBack()) return true;
    try {
      if (field.tagName === "TEXTAREA" || field.tagName === "INPUT") {
        nativeSetValue(field, text);
      } else {
        field.focus();
        field.textContent = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (e) { return false; }
    if (readsBack()) return true;
    try {
      if (field.tagName !== "TEXTAREA" && field.tagName !== "INPUT") {
        field.focus();
        try { document.execCommand("selectAll"); } catch (e) {}
        try { document.execCommand("delete"); } catch (e) {}
        let ok = false;
        try { ok = document.execCommand("insertText", false, text); } catch (e) {}
        if (ok) field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (e) { /* read-back decides */ }
    return readsBack();
  }
  // The element whose OWN text is the caption placeholder
  // line ("Say something about this...") — the visible
  // shell Facebook renders before (or inside) the real
  // editor (v2.1.58, header note 32). Manual walk over
  // element children: the shortest visible element whose
  // whole text is short and matches a caption hint wins;
  // a large container that merely CONTAINS the line among
  // other text (the whole dialog, an attachment block)
  // never qualifies.
  function findSharePlaceholderEl(dialog) {
    if (!dialog) return null;
    let best = null;
    const walk = (node, depth) => {
      if (!node || depth > 8) return;
      const kids = node.children ? Array.from(node.children) : [];
      for (const k of kids) {
        const t = normText(k.textContent);
        if (t && t.length <= 80 && shareHintMatches(t) && isVisibleEl(k)) {
          if (!best || t.length < best.len) best = { el: k, len: t.length };
        }
        walk(k, depth + 1);
      }
    };
    walk(dialog, 0);
    return best ? best.el : null;
  }
  // The editable host for a placeholder element: itself
  // when editable, else the nearest editable ancestor —
  // the Lexical pattern, the placeholder rendered INSIDE
  // the editor root — else null (a click must wake the
  // editor first).
  function shareEditableHost(ph) {
    if (!ph) return null;
    if (isShareEditableEl(ph)) return ph;
    let node = ph.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      if (isShareEditableEl(node)) return node;
      node = node.parentElement;
    }
    return null;
  }
  function safeActiveElement() {
    try {
      const a = document.activeElement;
      return (a && a !== document.body &&
        typeof a.getAttribute === "function") ? a : null;
    } catch (e) { return null; }
  }
  // PLACEHOLDER ACTIVATION (v2.1.58, header note 32): the
  // dialog shows the caption placeholder but no editable
  // surface. Resolve the placeholder (by its own text, or
  // the finder's non-editable inviting candidate), place
  // the text in its editable HOST when it already has one,
  // else click it realistically and re-poll (≤1.5s) for an
  // editable — or the element the click focused — to take
  // the text. Returns the dialog the text landed in, or
  // null; every step leaves a step note, and the
  // placeholder element / focused element ride the notes'
  // element snapshots into the failure evidence.
  async function trySharePlaceholderActivation(text) {
    let target = null, targetDlg = null;
    const stack = openShareDialogs().slice().reverse();
    for (const d of stack) {
      const ph = findSharePlaceholderEl(d);
      if (ph) { target = ph; targetDlg = d; break; }
    }
    if (!target) {
      const found = findShareComposerField();
      if (found && !isShareEditableEl(found.field)) {
        target = found.field; targetDlg = found.dialog;
      }
    }
    if (!target) return null;
    const phHint = (typeof target.getAttribute === "function" &&
      (target.getAttribute("aria-placeholder") ||
       target.getAttribute("data-placeholder") ||
       target.getAttribute("placeholder"))) ||
      normText(target.textContent).slice(0, 60);
    recordStepNote("Share", "share_placeholder_found",
      `caption placeholder "${String(phHint).slice(0, 60)}" — waking its editor`.slice(0, 200),
      "", target);
    const host = shareEditableHost(target);
    if (host && insertShareTextIntoField(host, text)) {
      recordStepNote("Share", "share_placeholder_host",
        "the placeholder's editable host took the text without a click", "1", host);
      return targetDlg;
    }
    realisticClick(target);
    recordStepNote("Share", "share_placeholder_clicked",
      "clicked the caption placeholder to wake the composer; re-polling for its editor",
      "", target);
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      await sleep(250);
      const f2 = findShareComposerField();
      if (f2 && isShareEditableEl(f2.field) &&
          insertShareTextIntoField(f2.field, text)) {
        recordStepNote("Share", "share_placeholder_activated",
          "an editable composer appeared after the placeholder click and took the text",
          "1", safeActiveElement() || f2.field);
        return f2.dialog;
      }
      const foc = safeActiveElement();
      if (foc && isShareEditableEl(foc) &&
          openShareDialogs().some(d => typeof d.contains === "function" && d.contains(foc)) &&
          insertShareTextIntoField(foc, text)) {
        recordStepNote("Share", "share_placeholder_activated",
          "the element focused by the placeholder click took the text", "1", foc);
        return targetDlg;
      }
    }
    recordStepNote("Share", "share_placeholder_no_editor",
      "no editable composer appeared within 1.5s of the placeholder click",
      "0", safeActiveElement() || target);
    return null;
  }
  // Place the job's details text in the share composer,
  // polling the open-dialog stack for a bounded settle window
  // — the composer can render a beat after the destination
  // click, or inside a dialog stacked over the share sheet.
  // Only an EDITABLE field is ever inserted into (v2.1.58:
  // a non-editable inviting element routes to the
  // activation arm instead — once per call). Returns the
  // dialog the text landed in, or null.
  async function placeShareText(budgetMs) {
    const text = String(shareText || "");
    if (!text.trim()) return null;
    const budget = budgetMs == null ? 3500 : budgetMs;
    const t0 = Date.now();
    let activationTried = false;
    for (;;) {
      const found = findShareComposerField();
      if (found && isShareEditableEl(found.field) &&
          insertShareTextIntoField(found.field, text)) return found.dialog;
      if (!activationTried && Date.now() - t0 < budget) {
        activationTried = true;
        const viaActivation = await trySharePlaceholderActivation(text);
        if (viaActivation) return viaActivation;
      }
      if (Date.now() - t0 >= budget) return null;
      await sleep(300);
    }
  }
  // ---------- dealership @mention tag (v2.1.59) ---------
  // Best-effort garnish on the proven details text (header
  // note 33): append a REAL Facebook mention of the user's
  // dealership Page as the composer's final line. Every
  // failure restores the details-only text and the share
  // proceeds exactly like 2.1.58; nothing in this section
  // may throw out of tryShareDealershipTag, fail the job,
  // or report an outcome.
  //
  // The editable composer field that currently HOLDS the
  // details text: scan the dialog stack topmost-first and
  // require the details text's first line in the field's
  // own value, so the mention is typed into the proven
  // composer and never into some other editor on the page.
  function shareTagFieldHoldingDetails() {
    const snippet = normText(String(shareText || "").split("\n")[0]);
    const stack = openShareDialogs().slice().reverse();
    for (const d of stack) {
      const cands = Array.from(d.querySelectorAll(
        'textarea, [contenteditable], [contenteditable="true"], ' +
        '[role="textbox"], [aria-placeholder], [data-placeholder]'))
        .filter(isVisibleEl).filter(isShareEditableEl);
      for (const f of cands) {
        if (!snippet) return { field: f, dialog: d };
        let v = "";
        try { v = normText(extractValue(f)); } catch (e) {}
        if (v.includes(snippet)) return { field: f, dialog: d };
      }
    }
    const found = findShareComposerField();
    return found && isShareEditableEl(found.field)
      ? { field: found.field, dialog: found.dialog } : null;
  }
  // Every name a typeahead option presents: the option's
  // full text (avatar + name + subtitle aggregated) plus
  // each descendant's own text — the Page name is its own
  // node in the row, and matching runs against all of them.
  function shareTagOptionNames(opt) {
    const names = new Set();
    const add = s => { const n = normText(s); if (n) names.add(n); };
    add(opt && opt.textContent);
    const walk = (node, depth) => {
      if (!node || depth > 5) return;
      const kids = node.children ? Array.from(node.children) : [];
      for (const k of kids) { add(k.textContent); walk(k, depth + 1); }
    };
    walk(opt, 0);
    return names;
  }
  // The name a note reports for an option: its shortest
  // candidate (the name line, not the aggregated row).
  function shareTagOptionDisplayName(opt) {
    const names = Array.from(shareTagOptionNames(opt));
    if (!names.length) return "";
    names.sort((a, b) => a.length - b.length);
    return names[0];
  }
  // Visible mention-typeahead options anywhere on the
  // page: Facebook renders the typeahead as a listbox of
  // option rows, often in a portal outside the dialog.
  function shareTagVisibleOptions() {
    const boxes = Array.from(document.querySelectorAll('[role="listbox"]'))
      .filter(isVisibleEl);
    const out = [];
    for (const b of boxes) {
      const opts = Array.from(b.querySelectorAll('[role="option"]'))
        .filter(isVisibleEl);
      for (const o of opts) out.push(o);
    }
    return out;
  }
  // Poll for the typeahead: exit early only on an EXACT
  // match (results can stream in, so a non-matching first
  // paint is not final); otherwise ride out the window
  // and return the last options seen.
  async function pollShareTagOptions(timeoutMs, wantedNorm) {
    const t0 = Date.now();
    let last = [];
    for (;;) {
      const opts = shareTagVisibleOptions();
      if (opts.length) {
        last = opts;
        if (opts.some(o => shareTagOptionNames(o).has(wantedNorm))) {
          return last;
        }
      }
      if (Date.now() - t0 >= timeoutMs) return last;
      await sleep(200);
    }
  }
  // A CONVERTED mention inside the composer: an element
  // whose whole text is exactly the dealership name and
  // which Facebook marks as a mention or link — an
  // anchor, a link role, an href, or any mention-named
  // attribute. A plain text run of the same words is the
  // details text's own closing block, never a tag.
  function shareTagMentionNode(field, nameNorm) {
    let hit = null;
    const walk = (node, depth) => {
      if (!node || depth > 8 || hit) return;
      const kids = node.children ? Array.from(node.children) : [];
      for (const k of kids) {
        if (normText(k.textContent) === nameNorm) {
          const tag = String(k.tagName || "").toUpperCase();
          let marked = tag === "A";
          if (!marked && typeof k.getAttribute === "function") {
            if (k.getAttribute("role") === "link" ||
                k.getAttribute("href")) {
              marked = true;
            } else if (typeof k.getAttributeNames === "function" &&
                k.getAttributeNames().some(a => /mention/i.test(a))) {
              marked = true;
            } else if (/mention/i.test(k.getAttribute("data-testid") || "")) {
              marked = true;
            }
          }
          if (marked) { hit = k; return; }
        }
        walk(k, depth + 1);
      }
    };
    walk(field, 0);
    return hit;
  }
  function shareTagNameCount(haystackNorm, nameNorm) {
    if (!haystackNorm || !nameNorm) return 0;
    let n = 0, i = haystackNorm.indexOf(nameNorm);
    while (i >= 0) {
      n++;
      i = haystackNorm.indexOf(nameNorm, i + nameNorm.length);
    }
    return n;
  }
  // Conversion verdict, from what the DOM honestly
  // exposes. mention_node: a mention/link-marked element
  // carries the name. text_state fallback: no marked node
  // is visible, but the name occurs once MORE in the
  // composer than the details text alone contains, no
  // raw "@name" residue remains, and the typeahead has
  // closed — the shape of a converted mention whose node
  // the editor does not expose.
  function shareTagConversion(field, name) {
    const nameNorm = normText(name);
    if (shareTagMentionNode(field, nameNorm)) {
      return { converted: true, via: "mention_node" };
    }
    let raw = "";
    try { raw = String(extractValue(field) || ""); } catch (e) {}
    const inComposer = shareTagNameCount(normText(raw), nameNorm);
    const inDetails = shareTagNameCount(
      normText(String(shareText || "")), nameNorm);
    if (inComposer >= inDetails + 1 && !raw.includes("@" + name) &&
        !shareTagVisibleOptions().length) {
      return { converted: true, via: "text_state" };
    }
    return { converted: false, via: "" };
  }
  // Restore the composer to exactly the proven details
  // text (force past the already-placed early exit) and
  // verify: details present, raw mention tail gone.
  async function restoreShareDetailsText(field, name) {
    try {
      insertShareTextIntoField(field, String(shareText || ""), true);
    } catch (e) { /* the read-back below reports the outcome */ }
    let val = "";
    try { val = String(extractValue(field) || ""); } catch (e) {}
    const firstLine = normText(String(shareText || "").split("\n")[0]);
    return !!firstLine && normText(val).includes(firstLine) &&
      !val.includes("@" + name);
  }
  // Type the mention line through the trusted CDP key
  // pipeline: focus the composer, caret to the very end
  // (Ctrl+End, the same rung the poster uses for Ctrl+A),
  // a fresh line, then "@" + name one real key event per
  // character — the only input Facebook's mention
  // typeahead wakes for. Returns false when trusted
  // typing is unavailable or any key is refused.
  async function typeShareTagKeys(field, name) {
    if (!(await cdpEnsure("Share"))) return false;
    try { realisticClick(field); } catch (e) {}
    try { field.focus(); } catch (e) {}
    await sleep(150);
    const endRes = await cdpRequest(
      buildCdpKey("End", "End", { modifiers: 2 }));
    if (!endRes || !endRes.ok) return false;
    const enterRes = await cdpRequest(buildCdpKey("Enter", "Enter"));
    if (!enterRes || !enterRes.ok) return false;
    for (const ch of "@" + name) {
      const init = keyEventInitForChar(ch);
      const r = await cdpRequest(
        buildCdpKey(init.key, init.code, { text: ch }));
      if (!r || !r.ok) return false;
      await sleep(35);
    }
    return true;
  }
  // The one entry point driveShareDialog awaits. NEVER
  // throws, NEVER fails or reports the share; an empty
  // dealership name returns silently so the share is
  // byte-identical to 2.1.58.
  async function tryShareDealershipTag() {
    const name = String(dealershipName || "").trim();
    if (!name) return;
    const wasAttached = cdpAttached;
    let field = null;
    try {
      const loc = shareTagFieldHoldingDetails();
      if (!loc) {
        recordStepNote("Share", "share_tag_skipped",
          "no editable composer field holding the details text could be re-located; share proceeds untagged", "0");
        return;
      }
      field = loc.field;
      const typed = await typeShareTagKeys(field, name);
      if (!typed) {
        const restored = await restoreShareDetailsText(field, name);
        recordStepNote("Share", "share_tag_skipped",
          `trusted typing unavailable for the dealership tag (cdp: ${(attemptsFor("Share").cdpError || "key_failed")}); details-only text ${restored ? "restored" : "NOT restored"}; share proceeds untagged`.slice(0, 185),
          "0", field);
        return;
      }
      const wanted = normText(name);
      const options = await pollShareTagOptions(2500, wanted);
      const seenNames = options.map(shareTagOptionDisplayName)
        .filter(Boolean);
      const seenDetail = `options seen (${options.length}): ${seenNames.join(" | ") || "(none)"}`;
      const matches = options.filter(
        o => shareTagOptionNames(o).has(wanted));
      if (!matches.length) {
        const restored = await restoreShareDetailsText(field, name);
        recordStepNote("Share", "share_tag_unmatched",
          `no exact typeahead match for "${name}"; ${seenDetail}; details-only text ${restored ? "restored" : "NOT restored"}`.slice(0, 185),
          "0", field);
        return;
      }
      realisticClick(matches[0]);
      recordStepNote("Share", "share_tag_option_clicked",
        `exact match "${name}" (${matches.length} exact of ${options.length} options)`.slice(0, 185),
        "", matches[0]);
      await sleep(800);
      let conv = shareTagConversion(field, name);
      if (!conv.converted) {
        await sleep(600);
        conv = shareTagConversion(field, name);
      }
      if (conv.converted) {
        recordStepNote("Share", "share_tag_placed",
          `dealership tag "@${name}" converted (${conv.via}); ${seenDetail}`.slice(0, 185),
          "1", field);
        return;
      }
      const restored = await restoreShareDetailsText(field, name);
      recordStepNote("Share", "share_tag_unmatched",
        `the typeahead pick did not convert to a mention; ${seenDetail}; details-only text ${restored ? "restored" : "NOT restored"}`.slice(0, 185),
        "0", field);
    } catch (err) {
      try {
        if (field) await restoreShareDetailsText(field, name);
      } catch (e) { /* best-effort cleanup; the share proceeds */ }
      try {
        recordStepNote("Share", "share_tag_skipped",
          `dealership tag attempt errored and was skipped: ${err && err.message ? err.message : "unknown"}`.slice(0, 185), "0");
      } catch (e) { /* notes are best-effort too */ }
    } finally {
      if (!wasAttached && cdpAttached) {
        try { await cdpDetach(); } catch (e) {}
      }
    }
  }
  // The share_text_unplaced evidence (v2.1.57 design,
  // v2.1.58 emission — header note 32): when the composer
  // cannot be placed, the failure row must say what the
  // dialog stack actually contained — the topmost dialog's
  // own text plus an inventory of every candidate field in
  // every open dialog (tag, role, contenteditable,
  // aria-label, placeholder) — so the next live miss is
  // diagnosable in ONE round. v2.1.57 returned all of it as
  // ONE detail string (~1100 chars, excerpt first); the
  // worker's compactDiagError slices every record's detail
  // at 200 chars, so the stored row kept the excerpt's
  // opening and the field inventory after it was amputated
  // whole. The parts are therefore emitted as step notes
  // chunked to ≤185 chars per record — each comfortably
  // inside the per-record budget — and the placeholder
  // element plus the post-click focused element join the
  // inventory (v2.1.58).
  function describeShareField(f) {
    const g = n => (typeof f.getAttribute === "function" && f.getAttribute(n)) || "";
    const bits = [String(f.tagName || "?").toLowerCase()];
    if (g("role")) bits.push("role=" + g("role"));
    const ce = typeof f.getAttribute === "function" ? f.getAttribute("contenteditable") : null;
    if (ce !== null && ce !== undefined) bits.push("ce=" + (ce === "" ? "(bare)" : ce));
    if (g("aria-label")) bits.push('aria="' + String(g("aria-label")).slice(0, 40) + '"');
    const ph = g("placeholder") || g("aria-placeholder") || g("data-placeholder");
    if (ph) bits.push('ph="' + String(ph).slice(0, 40) + '"');
    return bits.join(" ");
  }
  function shareComposerDiagParts() {
    const dialogs = openShareDialogs();
    if (!dialogs.length) {
      return { excerpt: "no dialogs open when the composer search gave up", fields: [] };
    }
    const top = dialogs[dialogs.length - 1];
    const excerpt = String(top.innerText || top.textContent || "")
      .replace(/\s+/g, " ").trim().slice(0, 560);
    const fields = [];
    for (const d of dialogs) {
      const els = Array.from(d.querySelectorAll(
        'textarea, input, [contenteditable], [role="textbox"], ' +
        '[aria-placeholder], [data-placeholder]'));
      for (const f of els) fields.push(describeShareField(f));
    }
    for (const d of dialogs) {
      const ph = findSharePlaceholderEl(d);
      if (ph) { fields.push("placeholder " + describeShareField(ph)); break; }
    }
    const foc = safeActiveElement();
    if (foc) fields.push("focused " + describeShareField(foc));
    return { excerpt, fields };
  }
  function recordShareComposerDiag() {
    const { excerpt, fields } = shareComposerDiagParts();
    const bodies = [
      "dialog text: " + (excerpt || "(empty)"),
      `candidate fields (${fields.length}): ` +
        (fields.length ? fields.join(" | ") : "(none)")
    ];
    for (const body of bodies) {
      for (let i = 0; i < body.length; i += 185) {
        recordStepNote("Share", "share_composer_diag",
          body.slice(i, i + 185), "0");
      }
    }
  }

  // ---- delete stage helpers (v2.1.9, header note 19) ---------------------
  // How the menu button was found, for the menu_button_found note:
  // the ancestor depth at which listingMenuButton's search level
  // contains it, plus the aria/text descriptor that matched.
  function menuButtonInfo(cardEl, btn) {
    let depth = -1;
    let node = cardEl;
    for (let d = 0; d < 6 && node; d++) {
      if (node === btn ||
          (typeof node.contains === "function" && node.contains(btn))) { depth = d; break; }
      node = node.parentElement;
    }
    const aria = (typeof btn.getAttribute === "function" && btn.getAttribute("aria-label")) || "";
    const txt = String(btn.textContent || "").trim().replace(/\s+/g, " ");
    const parts = [];
    if (aria) parts.push('aria-label="' + aria + '"');
    if (txt) parts.push('text="' + txt.slice(0, 40) + '"');
    return { depth, descriptor: parts.join(" ") || "(no label)" };
  }
  // A menu counts as OPEN when a [role="menu"] is visible — the
  // delete-item check is the caller's other witness (some variants
  // render the entries in a listbox portal with no menu role).
  function findVisibleMenu() {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    return menus.find(isVisibleEl) || null;
  }
  // The visible menu entries' texts, in document order, deduped —
  // the menu_items_seen evidence (what Facebook actually offered).
  function menuItemTexts() {
    const texts = [];
    const seen = new Set();
    const push = raw => {
      const s = String(raw || "").trim().replace(/\s+/g, " ");
      if (s && !seen.has(s)) { seen.add(s); texts.push(s); }
    };
    const containers = Array.from(
      document.querySelectorAll('[role="menu"], [role="listbox"]')).filter(isVisibleEl);
    for (const c of containers) {
      const els = Array.from(c.querySelectorAll
        ? c.querySelectorAll('[role="menuitem"], [role="option"], [role="button"], button, a') : []);
      for (const e of els) if (isVisibleEl(e)) push(e.textContent);
      if (!texts.length) {
        // Entries rendered as plain children with no item role.
        const kids = c.children ? Array.from(c.children)
          : Array.from(c.childNodes || []).filter(n => n && n.nodeType === 1);
        for (const k of kids) if (isVisibleEl(k)) push(k.textContent);
      }
    }
    return texts;
  }
  // What dialogs EXIST when the delete confirm never appears:
  // "role: first ~80 chars" per dialog — the confirm_dialog_dump
  // evidence, so a renamed/reworded confirm is legible in the DB.
  function describeOpenDialogs() {
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    if (!dialogs.length) return "(no dialogs in document)";
    return dialogs.map(d => {
      const role = (typeof d.getAttribute === "function" && d.getAttribute("role")) || "dialog";
      const txt = String(d.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      return role + ": " + txt;
    }).join(" | ").slice(0, 200);
  }
  // Poll (never a fixed sleep) for the card menu to open: a visible
  // [role="menu"] OR a locatable delete item ends the wait.
  async function pollForMenuOpen(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const menu = findVisibleMenu();
      const item = findDeleteMenuItem();
      if (menu || item) return { menu, item, elapsed: Date.now() - t0 };
      if (Date.now() - t0 >= timeoutMs) return { menu: null, item: null, elapsed: Date.now() - t0 };
      await sleep(275);
    }
  }
  // Poll for Facebook's delete confirmation button.
  async function pollForDeleteConfirm(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const btn = findDeleteConfirmButton();
      if (btn) return { btn, elapsed: Date.now() - t0 };
      if (Date.now() - t0 >= timeoutMs) return { btn: null, elapsed: Date.now() - t0 };
      await sleep(300);
    }
  }

  // ---- delete survey (v2.1.18) -------------------------------------------
  // Facebook's real delete gate is a survey dialog — "Did you sell
  // this item?" with radio answers and a Next button — and only
  // after it does the actual Delete confirmation appear. Every
  // version before this one polled straight for a Delete button
  // and kept finding the final dialog's hidden template instead
  // (the 2026-10-23 saga: three false completions, then honest
  // failures). The neutral answer ("I'd rather not answer") keeps
  // the seller's Facebook stats truthful — the car did not sell
  // just because its listing is being removed.
  function findDeleteSurvey() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of dialogs) {
      if (!isVisibleEl(d)) continue;
      if (!normText(d.textContent).includes("did you sell this item")) continue;
      const candidates = Array.from(
        d.querySelectorAll('[role="radio"], [role="option"], label, div, span'));
      let answer = null;
      for (const el of candidates) {
        // Apostrophe-agnostic: Facebook renders a curly ’ here.
        const t = normText(el.textContent).replace(/['’]/g, "");
        if (t === "id rather not answer" && isVisibleEl(el)) {
          if (!answer || answer.contains(el)) answer = el; // deepest match wins
        }
      }
      const btns = Array.from(d.querySelectorAll('[role="button"], button'));
      const next = btns.find(b => normText(b.textContent) === "next" &&
        isVisibleEl(b)) || null;
      return { dialog: d, answer, next };
    }
    return null;
  }

  // Waits for either the survey or the final confirm, whichever
  // Facebook shows first, and completes the survey if it appears.
  // Returns "handled" (survey answered, Next clicked), "confirm_first"
  // (no survey — the confirm is already up), "absent" (neither showed
  // within the wait), or "unhandled" (survey present but its answer
  // or Next could not be driven).
  async function handleDeleteSurveyIfPresent(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const s = findDeleteSurvey();
      if (s) {
        if (!s.answer) {
          recordStepNote("Delete", "delete_survey_unhandled",
            "survey present but the neutral answer was not found", "0");
          return "unhandled";
        }
        realisticClick(s.answer);
        recordStepNote("Delete", "delete_survey_answered",
          "selected the neutral answer (I'd rather not answer)", "", s.answer);
        await sleep(600);
        // Next usually enables only once an answer is selected —
        // poll for it to become usable, re-finding the dialog in
        // case Facebook re-rendered it.
        let nextBtn = null;
        const n0 = Date.now();
        for (;;) {
          const cur = findDeleteSurvey();
          const cand = cur && cur.next;
          if (cand && isUsableConfirmButton(cand)) { nextBtn = cand; break; }
          if (Date.now() - n0 >= 3000) break;
          await sleep(300);
        }
        if (!nextBtn) {
          recordStepNote("Delete", "delete_survey_unhandled",
            "survey answered but Next never became usable", "0");
          return "unhandled";
        }
        realisticClick(nextBtn);
        recordStepNote("Delete", "delete_survey_next",
          "clicked Next after the survey answer", "", nextBtn);
        await sleep(600);
        return "handled";
      }
      if (findDeleteConfirmButton()) return "confirm_first";
      if (Date.now() - t0 >= timeoutMs) return "absent";
      await sleep(300);
    }
  }

  // ---- fresh-load delete proof (v2.1.15) --------------------------------
  // Twice on 2026-10-23 (an F-250, then a Navigator, both on the
  // son's account) a delete reported success while the listing
  // stayed live: both listings were "being reviewed", and on the
  // job's own page the card obligingly vanished and stayed vanished
  // — every same-page check passed — while Facebook's server kept
  // the listing. A Ctrl+F5 on the Selling page told the truth.
  // So a delete may now only be CLAIMED from a fresh page load:
  // when the attempt's local evidence says "gone", the flow arms
  // deleteProof on the stored job and reloads; the reloaded script
  // routes to runDeleteProof, whose settled scan of the fresh page
  // is the verdict. Found + under review -> honest failure naming
  // the review hold. Found otherwise -> ONE genuine second attempt
  // (deleteProofDone makes its success report directly, so the
  // loop always terminates). Absent -> JOB_DELETED, for real.
  // ---- page-identity guard (v2.1.16) -------------------------------------
  // The fresh-load proof was still beaten on its first live test
  // (2026-10-23 ~11:32 EDT, both cars): Facebook is a single-page
  // app, so a stray click during the delete can move the tab to
  // another Facebook page (Matthew watched it land on Friend
  // Requests, green "deleted" banner and all) WITHOUT reloading —
  // the entry guard at the top of this script never re-runs, the
  // async flow keeps living in the drifted document, and every
  // scan there finds zero cards, which the proof read as "gone".
  // So no delete verdict is valid unless the tab is provably on
  // the Selling page AT VERDICT TIME: every claim path re-checks,
  // and a drifted tab is navigated back so the flow restarts on
  // the right page instead of concluding on the wrong one.
  const SELLING_URL_RE = /facebook\.com\/marketplace\/you\/(selling|dashboard)/;
  function onSellingPage() {
    return SELLING_URL_RE.test(window.location.href);
  }
  function sellingPageRendered() {
    // The selling page's own furniture. A page with no cards and
    // no selling chrome has not finished loading — a scan there
    // proves nothing either way.
    if (countSellingCards() > 0) return true;
    const t = (document.body && document.body.innerText) || "";
    return /create new listing/i.test(t) && /your listings|selling/i.test(t);
  }
  // True = caller may proceed. False = the tab had drifted and is
  // being navigated back; the caller must stop NOW (the reloaded
  // script restarts the flow on the right page). Recoveries are
  // counted on the job record; past 3 the job fails honestly
  // instead of looping.
  async function recoverToSellingPage(stage) {
    if (onSellingPage()) return true;
    let n = 0;
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId) {
        n = (j.deleteNavRecoveries || 0) + 1;
        j.deleteNavRecoveries = n;
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* the counter is best-effort */ }
    recordStepNote("Delete", "delete_wrong_page",
      `stage:${stage} url:${window.location.href.slice(0, 80)} recovery:${n}`, String(n));
    if (n > 3) {
      await fail(
        "The helper's tab kept leaving the Selling page, so the removal was NOT confirmed. The listing may still be live — check your Selling page.",
        "delete_wrong_page");
      return false;
    }
    say("Returning to your Selling page to finish the removal check…");
    await sleep(400);
    try { window.location.href = "https://www.facebook.com/marketplace/you/selling"; } catch (e) { /* no-op */ }
    return false;
  }

  // Real ladder progress in THIS incarnation earns the recovery
  // budget back (v2.1.17): on the 2.1.16 test, restarts from
  // before the attempt had already spent the budget, so when the
  // tab drifted at the finish line the job failed instead of
  // going back to prove the delete.
  async function resetNavRecoveries() {
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId && j.deleteNavRecoveries) {
        j.deleteNavRecoveries = 0;
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* best-effort */ }
  }

  async function finishDeleteWithFreshProof() {
    // A claim may only leave from the Selling page (v2.1.16): if
    // the tab drifted during the attempt, go back and let the
    // flow restart there instead of arming/reporting here.
    if (!(await recoverToSellingPage("finish"))) return;
    let stored = null;
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      stored = cur && cur.current_posting_job;
    } catch (e) { /* fall through to arming */ }
    if (stored && stored.queueId === queueId && stored.deleteProofDone) {
      await cdpDetach();
      say("Listing deleted on Facebook ✓", "#15803d");
      await report("AUTOLAUNCH_JOB_DELETED", {});
      return;
    }
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId) {
        j.deleteProof = { armedAt: new Date().toISOString() };
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* the reload is still the best next step */ }
    say("Confirming the removal on a fresh page load…");
    await sleep(600);
    try { window.location.reload(); } catch (e) { /* no-op */ }
  }

  // ---- delayed delete proof (v2.1.20) -----------------------------------
  // Armed from runDeleteListing when a genuine confirm click did
  // not clear the card inside the local verify window. Facebook
  // can take minutes to drop a deleted listing server-side (proven
  // 2026-10-23, twice in a row), and this tab's DOM may never
  // re-render the removal — so the verdict moves to fresh page
  // loads on a minutes scale: first check ~75s after the click,
  // one re-check ~75s after that. Delayed proof NEVER runs a
  // second ladder attempt (the click already happened; re-clicking
  // is not evidence) and NEVER fails as blocked_under_review (a
  // deletion may already be in flight whatever the card's text
  // says). Absent on a fresh, rendered Selling page = deleted;
  // still present after the second check = honestly not removed.
  async function armDelayedDeleteProof() {
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId) {
        j.deleteDelayedProof = { armedAt: Date.now(), tries: 0 };
        await chrome.storage.local.set({ current_posting_job: j });
        return true;
      }
    } catch (e) { /* fall through: caller keeps the honest failure */ }
    return false;
  }

  async function runDelayedDeleteProof() {
    try {
      say("Re-checking the removal on a fresh page load…");
      const dp = (job && job.deleteDelayedProof) || {};
      const armedAt = Number(dp.armedAt) || Date.now();
      const waitMs = Math.max(0, 75000 - (Date.now() - armedAt));
      if (waitMs) await sleep(waitMs);

      const pageText = (document.body.innerText || "").toLowerCase();
      if (window.location.href.includes("/login") ||
          pageText.includes("checkpoint") ||
          pageText.includes("confirm your identity") ||
          pageText.includes("log in to facebook")) {
        await fail(
          "Facebook is asking for login or an identity check — the removal could not be confirmed.",
          "facebook_checkpoint");
        return;
      }

      if (!(await recoverToSellingPage("delayed_proof_start"))) return;

      await settleSellingList();
      const strict = findListingCards();
      const titleOnly = strict.length ? [] : findListingCardsByTitle();
      const foundCount = strict.length + titleOnly.length;
      const tries = (Number(dp.tries) || 0) + 1;
      recordStepNote("Delete", "delete_delayed_proof",
        `check ${tries}/2 on a fresh page load after a wait: strict:${strict.length} title:${titleOnly.length}`,
        String(foundCount));

      if (!foundCount) {
        if (!(await recoverToSellingPage("delayed_proof_verdict"))) return;
        if (!sellingPageRendered()) {
          await fail(
            "The Selling page didn't finish loading, so the removal could not be confirmed. The listing may still be live — try Remove again.",
            "delete_unproven");
          return;
        }
        await cdpDetach();
        say("Listing deleted on Facebook ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_DELETED", {});
        return;
      }

      if (tries < 2) {
        try {
          const cur = await chrome.storage.local.get(["current_posting_job"]);
          const j = cur && cur.current_posting_job;
          if (j && j.queueId === queueId) {
            j.deleteDelayedProof = { armedAt: Date.now(), tries };
            await chrome.storage.local.set({ current_posting_job: j });
          }
        } catch (e) { /* the reload below simply ends this attempt */ }
        say("Still listed — Facebook is taking its time dropping it. One more check in about a minute…");
        await sleep(600);
        try { window.location.reload(); } catch (e) { /* no-op */ }
        return;
      }

      await fail("Clicked Delete and waited, checking twice on fresh page loads — the listing is still on your selling page, NOT removed.",
        "delete_not_verified");
    } catch (err) {
      console.error("[AutoLaunch] delayed delete proof error:", err);
      await fail("Unexpected error while confirming the removal: " + (err && err.message ? err.message : "unknown"));
    }
  }

  async function runDeleteProof() {
    try {
      say("Confirming the removal on a fresh page load…");
      await sleep(3000); // let the selling page render

      const pageText = (document.body.innerText || "").toLowerCase();
      if (window.location.href.includes("/login") ||
          pageText.includes("checkpoint") ||
          pageText.includes("confirm your identity") ||
          pageText.includes("log in to facebook")) {
        await fail(
          "Facebook is asking for login or an identity check — the removal could not be confirmed.",
          "facebook_checkpoint");
        return;
      }

      if (!(await recoverToSellingPage("proof_start"))) return;

      const title = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim() || "vehicle";
      await settleSellingList();
      const strict = findListingCards();
      const titleOnly = strict.length ? [] : findListingCardsByTitle();
      const found = strict[0] || titleOnly[0] || null;
      recordStepNote("Delete", "delete_fresh_proof",
        `strict:${strict.length} title:${titleOnly.length} on a fresh page load`,
        String(strict.length));

      if (!found) {
        // The verdict gate (v2.1.16): "absent" only counts from a
        // Selling page that actually rendered. Drifted tab -> go
        // back and restart; unrendered list -> unproven, not gone.
        if (!(await recoverToSellingPage("proof_verdict"))) return;
        if (!sellingPageRendered()) {
          await fail(
            "The Selling page didn't finish loading, so the removal could not be confirmed. The listing may still be live — try Remove again.",
            "delete_unproven");
          return;
        }
        await cdpDetach();
        say("Listing deleted on Facebook ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_DELETED", {});
        return;
      }

      const foundText = (found.textContent || "").toLowerCase();
      if (/being reviewed|under review|in review/.test(foundText)) {
        await fail(
          `Facebook is still reviewing the ${title} listing, and a listing under review can't be removed — it is still live. Try Remove again once the review clears.`,
          "delete_blocked_under_review");
        return;
      }

      // Still listed, no review hold: one genuine second attempt.
      // deleteProofDone makes that attempt's success report
      // directly — no second reload, no loop.
      try {
        const cur = await chrome.storage.local.get(["current_posting_job"]);
        const j = cur && cur.current_posting_job;
        if (j && j.queueId === queueId) {
          j.deleteProofDone = true;
          await chrome.storage.local.set({ current_posting_job: j });
        }
      } catch (e) { /* runDeleteListing's own checks still guard */ }
      recordStepNote("Delete", "delete_second_attempt",
        "listing still present on a fresh load — deleting again", "");
      await runDeleteListing();
    } catch (err) {
      console.error("[AutoLaunch] delete proof error:", err);
      await fail("Unexpected error while confirming the removal: " + (err && err.message ? err.message : "unknown"));
    }
  }

  // Share edition of recoverToSellingPage (v2.1.55): same bounded
  // self-navigation back to the Selling page, share-worded
  // evidence and failure — the delete helper's wording ("the
  // removal was NOT confirmed") would lie about a share.
  async function recoverToSellingPageForShare(stage) {
    if (onSellingPage()) return true;
    let n = 0;
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId) {
        n = (j.shareNavRecoveries || 0) + 1;
        j.shareNavRecoveries = n;
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* the counter is best-effort */ }
    recordStepNote("Share", "share_wrong_page",
      `stage:${stage} url:${window.location.href.slice(0, 80)} recovery:${n}`, String(n));
    if (n > 3) {
      await fail(
        "The helper's tab kept leaving the Selling page, so the share was NOT confirmed. The listing was not shared — try the Share button again.",
        "share_wrong_page");
      return false;
    }
    say("Returning to your Selling page to finish the share…");
    await sleep(400);
    try { window.location.href = "https://www.facebook.com/marketplace/you/selling"; } catch (e) { /* no-op */ }
    return false;
  }

  // The share DIALOG phase (v2.1.56, header note 30), factored
  // out of runShareListing so the harness can drive it directly:
  // identity gate FIRST, details text SECOND, destination +
  // confirm LAST. No path through here can click a confirm (or
  // a completing destination) before the dialog has proven it
  // is this car's dialog and the details text is sitting in its
  // composer. Returns true when the share completed (reported
  // here), false when the job was failed here.
  async function driveShareDialog(dlg) {
    // Identity gate on the dialog as opened.
    let verdict = shareIdentityVerdict(dlg);
    if (verdict.status === "mismatch") {
      recordStepNote("Share", "share_target_mismatch",
        shareIdentityDetail(verdict).slice(0, 200), "0", dlg);
      dismissShareDialog(dlg);
      await fail(
        "Facebook's share dialog was for a different listing (" +
          shareIdentityDetail(verdict) + ") — nothing was shared.",
        "share_target_mismatch");
      return false;
    }
    recordStepNote("Share",
      verdict.status === "match" ? "share_identity_verified" : "share_identity_unreadable",
      shareIdentityDetail(verdict).slice(0, 200),
      verdict.status === "match" ? "1" : "");

    // Details text: the job must carry it, and the dialog must
    // take it — placed BEFORE any destination click, because a
    // destination click can complete the share on some layouts.
    if (!String(shareText || "").trim()) {
      recordStepNote("Share", "share_text_missing",
        "the queue row carried no share_text — a bare share is not acceptable", "0", dlg);
      dismissShareDialog(dlg);
      await fail(
        "This share carried no vehicle details text, so nothing was shared. Queue the share again from the app to pick up the details.",
        "share_text_unplaced");
      return false;
    }
    let activeDlg = dlg;
    let placedDlg = await placeShareText();
    let textPlaced = !!placedDlg;
    if (textPlaced) {
      activeDlg = placedDlg;
      recordStepNote("Share", "share_text_placed",
        `${String(shareText).length} chars placed in the share composer`, "1");
    }

    // Destination: choose the FEED when the dialog offers a
    // choice. Some share sheets also complete on the
    // destination click itself — dialog gone = shared, but only
    // when the details text was already placed above.
    const feedOpt = findShareFeedOption(dlg);
    if (feedOpt) {
      realisticClick(feedOpt);
      recordStepNote("Share", "share_feed_option_clicked",
        normText(feedOpt.textContent).slice(0, 60), "", feedOpt);
      await sleep(1200);
      if (!findShareDialog() && !openShareDialogs().length) {
        if (checkpointShowing()) {
          await fail("Facebook showed an identity check during the share.",
            "facebook_checkpoint");
          return false;
        }
        if (!textPlaced) {
          // The click closed the share UI with no details in
          // it — never claim that as a good share.
          recordStepNote("Share", "share_text_unplaced",
            "the share UI closed on the destination click before the details text could be placed", "0");
          await fail(
            "Facebook closed the share before the vehicle details could be added, so the share was NOT marked shared. Check your feed, then share again.",
            "share_text_unplaced");
          return false;
        }
        recordStepNote("Share", "share_completed",
          "dialog closed after the feed destination click, details text placed", "1");
        say("Shared to your feed ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_SHARED", {});
        return true;
      }
      // The dialog that reaches the confirm — the same element
      // transitioned to the feed composer, a fresh one, or one
      // STACKED over the share sheet (v2.1.57: the topmost
      // share dialog is the one that counts) — is re-gated, and
      // the details text must be placed in the CURRENT dialog
      // stack: a placement in a composer the transition
      // replaced no longer counts.
      const dlg2 = lastShareDialog() || findShareDialog() || activeDlg;
      verdict = shareIdentityVerdict(dlg2);
      if (verdict.status === "mismatch") {
        recordStepNote("Share", "share_target_mismatch",
          shareIdentityDetail(verdict).slice(0, 200), "0", dlg2);
        dismissShareDialog(dlg2);
        await fail(
          "Facebook's share dialog was for a different listing (" +
            shareIdentityDetail(verdict) + ") — nothing was shared.",
          "share_target_mismatch");
        return false;
      }
      placedDlg = await placeShareText();
      textPlaced = !!placedDlg;
      if (textPlaced) {
        activeDlg = placedDlg;
        recordStepNote("Share", "share_text_placed",
          `${String(shareText).length} chars in the composer at the confirm step`, "1");
      }
      dlg = dlg2;
    }
    if (!textPlaced) {
      recordStepNote("Share", "share_text_unplaced",
        "no editable in the share dialog stack took the details text — " +
        "the stack's contents ride the share_composer_diag notes after this one",
        "0", activeDlg);
      recordShareComposerDiag();
      dismissShareDialog(activeDlg);
      await fail(
        "Facebook's share dialog had nowhere to put the vehicle details, so nothing was shared.",
        "share_text_unplaced");
      return false;
    }

    // Dealership @mention tag (v2.1.59, header note 33):
    // best-effort garnish on the proven details text. The
    // attempt is fully fail-open — every failure inside it
    // restores the details-only text and notes what the
    // typeahead offered — so the confirm below runs on
    // either the tagged or the proven untagged composer,
    // and the share's outcome never depends on the tag.
    await tryShareDealershipTag();

    // The confirm lives in the composer's dialog when the
    // text landed in a stacked one; fall back to the rest of
    // the dialog stack, topmost first.
    let confirmDlg = activeDlg;
    let confirmBtn = findShareConfirmButton(confirmDlg);
    if (!confirmBtn) {
      const stack = openShareDialogs().slice().reverse();
      for (const d of stack) {
        if (d === confirmDlg) continue;
        const b = findShareConfirmButton(d);
        if (b) { confirmBtn = b; confirmDlg = d; break; }
      }
    }
    if (!confirmBtn) {
      recordStepNote("Share", "share_dialog_dump",
        describeOpenDialogs(), "0");
      await fail("Facebook's share dialog offered no Post/Share button to confirm with — the listing was NOT shared.",
        "share_confirm_not_found");
      return false;
    }
    recordStepNote("Share", "share_confirm_found",
      `confirm "${normText(confirmBtn.textContent)}" located`, "", confirmBtn);
    // Click-target audit (the delete confirm's v2.1.17
    // discipline): never fire the confirming click at
    // coordinates whose topmost element is something else.
    const cr = confirmBtn.getBoundingClientRect();
    const cx = Math.round(cr.left + cr.width / 2);
    const cy = Math.round(cr.top + cr.height / 2);
    const topEl = document.elementFromPoint(cx, cy);
    const topOk = !!topEl && (topEl === confirmBtn ||
      (typeof confirmBtn.contains === "function" && confirmBtn.contains(topEl)) ||
      (typeof topEl.contains === "function" && topEl.contains(confirmBtn)));
    recordStepNote("Share", "share_confirm_click_target",
      `at (${cx},${cy}): ${topEl
        ? topEl.tagName + " " + String(topEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)
        : "(nothing)"} — aligned:${topOk}`,
      topOk ? "1" : "0");
    if (!topOk) {
      await fail("Something was covering Facebook's share confirmation, so the click was withheld — the listing was NOT shared.",
        "share_confirm_occluded");
      return false;
    }
    realisticClick(confirmBtn);
    recordStepNote("Share", "share_confirm_clicked",
      "strategy realistic", "", confirmBtn);

    // Honest success signal: DIALOG COMPLETION. The dialog must
    // close after the confirm; one still open when the bounded
    // wait ends means Facebook wants something else (a caption
    // decision, an error) — not a share this helper may claim.
    const t0 = Date.now();
    let closed = false;
    while (Date.now() - t0 < 12000) {
      await sleep(600);
      if (checkpointShowing()) {
        await fail("Facebook showed an identity check during the share.",
          "facebook_checkpoint");
        return false;
      }
      if (!isVisibleEl(confirmDlg) || !findShareDialog()) { closed = true; break; }
    }
    if (!closed) {
      recordStepNote("Share", "share_dialog_dump",
        describeOpenDialogs(), "0");
      await fail("Facebook's share dialog stayed open after confirming — the share was NOT confirmed, so nothing was marked shared.",
        "share_unverified");
      return false;
    }
    recordStepNote("Share", "share_completed",
      "share dialog closed after the confirm click", "1");
    say("Shared to your feed ✓", "#15803d");
    await report("AUTOLAUNCH_JOB_SHARED", {});
    return true;
  }

  // SHARE TO FEED (v2.1.55, header note 29): find this car's
  // listing on the Selling page with the delete flow's strict
  // matcher, click the card's OWN Share button — its label
  // verified against the job before the click (v2.1.57,
  // header note 31) — and share it to the user's personal
  // feed through Facebook's share dialog. Success is
  // reported (AUTOLAUNCH_JOB_SHARED) only when the dialog
  // COMPLETES — closes after the confirming click. The
  // listing itself is never modified and the car's posted
  // stamp is never touched.
  async function runShareListing() {
    try {
      say("Sharing your listing to your feed…");
      await sleep(3000); // let the selling page render

      const pageText = (document.body.innerText || "").toLowerCase();
      if (window.location.href.includes("/login") ||
          pageText.includes("checkpoint") ||
          pageText.includes("confirm your identity") ||
          pageText.includes("log in to facebook")) {
        await fail(
          "Facebook is asking for login or an identity check — the listing was NOT shared. Sign in normally in this browser, then share it again.",
          "facebook_checkpoint");
        return;
      }

      if (!(await recoverToSellingPageForShare("attempt_start"))) return;

      const title = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim() || "vehicle";
      if (!car.price) {
        // Strict matching needs the price — without it there is
        // no safe way to tell this car from a twin. Share nothing.
        recordStepNote("Share", "share_price_unavailable",
          "no price on the job payload — a strict title+price match is impossible", "");
        await fail(
          `Could not verify the exact ${title} listing (no price to match it by) — nothing was shared.`,
          "listing_not_found");
        return;
      }

      say(`Looking for your ${title} listing…`);
      await settleSellingList();
      const cards = findListingCards();
      recordStepNote("Share", "share_match_scan",
        `strict matches: ${cards.length} for ${title} @ $${Number(car.price).toLocaleString()}`,
        String(cards.length));
      if (!cards.length) {
        await fail(
          `Could not find the ${title} listing on your selling page — nothing was shared. It may have been removed.`,
          "listing_not_found");
        return;
      }
      if (cards.length > 1) {
        await fail(
          `Found ${cards.length} listings matching ${title} at that price — sharing none rather than risk the wrong car. Share the right one from Facebook's Your listings page.`,
          "listing_ambiguous");
        return;
      }

      const card = cards[0];
      say("Found it — opening its share dialog…");
      try { card.scrollIntoView({ block: "center" }); } catch (e) {}
      await sleep(600);
      await humanPause();

      // THE CARD'S OWN SHARE BUTTON (v2.1.57, header note 31):
      // the 2.1.56 runner opened the card's ⋯ menu and clicked
      // the first generic "Share" a document-wide search
      // offered — which was the NEXT card's per-card Share
      // button (the Beetle's menu contains no Share entry at
      // all; every card's dedicated Share button names its own
      // listing in its aria-label). The button is now found
      // inside the strictly matched card — climbing only
      // through wrappers that still hold exactly one strict
      // match, the listingMenuButton discipline — and its
      // label is verified against the job BEFORE anything is
      // clicked: a label naming this car proceeds; a bare
      // "Share" inside the card proceeds on containment; a
      // label naming a DIFFERENT car aborts
      // share_target_mismatch with the label as evidence. The
      // clicked button's label is recorded in share_button_found.
      const found = findCardShareButton(card);
      if (!found) {
        recordStepNote("Share", "share_button_not_found",
          "no Share button in the matched card or its single-listing wrappers", "0", card);
        await fail("Found the listing but not its Share button — nothing was shared.",
          "share_item_not_found");
        return;
      }
      recordStepNote("Share", "share_button_found",
        `aria-label "${found.label}"; verdict ${found.verdict}; depth ${found.depth}`.slice(0, 200),
        "", found.el);
      if (found.verdict === "mismatch") {
        recordStepNote("Share", "share_target_mismatch",
          `the card's Share button names a different listing ("${found.label}") — expected ${title}`.slice(0, 200),
          "0", found.el);
        await fail(
          `The listing card's Share button was for a different vehicle (${found.label}) — nothing was shared.`,
          "share_target_mismatch");
        return;
      }

      say("Sharing the listing to your feed…");
      await humanPause();
      realisticClick(found.el);
      recordStepNote("Share", "share_button_clicked",
        "strategy realistic", "", found.el);
      let dlg = await pollForShareDialog(4000);
      if (!dlg.dialog) {
        await cdpClickEl(found.el); // trusted click fallback, as elsewhere
        recordStepNote("Share", "share_button_clicked",
          "strategy cdpClick (fallback — no dialog after the realistic click)", "", found.el);
        dlg = await pollForShareDialog(5000);
      }
      if (!dlg.dialog) {
        recordStepNote("Share", "share_dialog_dump",
          describeOpenDialogs(), "0");
        await fail("Facebook's share dialog did not appear — the listing was NOT shared.",
          "share_dialog_not_found");
        return;
      }
      recordStepNote("Share", "share_dialog_found",
        `dialog located after poll ${dlg.elapsed}ms`, "");
      // The dialog phase: identity gate, details text,
      // destination, confirm — in that order, and the phase
      // itself reports or fails the job.
      await driveShareDialog(dlg.dialog);
    } catch (err) {
      console.error("[AutoLaunch] share error:", err);
      await fail("Unexpected error while sharing the listing: " + (err && err.message ? err.message : "unknown"), "share_error");
    }
  }

  async function runDeleteListing() {
    try {
      say("Removing your listing from Facebook…");
      await sleep(3000); // let the selling page render

      const pageText = (document.body.innerText || "").toLowerCase();
      if (window.location.href.includes("/login") ||
          pageText.includes("checkpoint") ||
          pageText.includes("confirm your identity") ||
          pageText.includes("log in to facebook")) {
        await fail(
          "Facebook is asking for login or an identity check — the listing was NOT removed. Sign in normally in this browser, then remove it again.",
          "facebook_checkpoint");
        return;
      }

      if (!(await recoverToSellingPage("attempt_start"))) return;

      const title = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim() || "vehicle";
      if (!car.price) {
        // Strict matching needs the price. Without it there is no
        // safe way to tell this car from a twin — delete nothing.
        recordStepNote("Delete", "delete_price_unavailable",
          "no price on the job payload — a strict title+price match is impossible", "");
        await fail(
          `Could not verify the exact ${title} listing (no price to match it by) — nothing was deleted.`,
          "listing_not_found");
        return;
      }

      say(`Looking for your ${title} listing…`);
      // SETTLED SCAN (v2.1.13 delete-verification hardening): the
      // selling list lazy-loads, and a just-published listing can
      // take a while to appear on it. On 2026-10-23 the delete for
      // a University Ford truck declared "already gone" from one
      // early scan of a still-loading list while the listing sat
      // live (under review) the whole time — the row completed and
      // the posted stamp cleared over a listing that still exists.
      // "Gone" must now survive a SETTLED list (scrolled through,
      // card census stable) AND a delayed second look.
      await settleSellingList();
      let cards = findListingCards();
      recordStepNote("Delete", "delete_match_scan",
        `strict matches: ${cards.length} for ${title} @ $${Number(car.price).toLocaleString()}`,
        String(cards.length));
      if (!cards.length) {
        // GOAL-ACHIEVED (v2.1.7, header note 18): the desired end
        // state of a delete job is "this car is not listed". When
        // the scan genuinely ran — the listings region rendered,
        // zero strict matches, and zero TITLE matches at any
        // price — that state is already true (Matthew's case: he
        // had deleted the listing by hand before this job ran).
        // Finish exactly like a verified delete: JOB_DELETED →
        // the worker marks the row completed and clears the car's
        // posted stamp. A title match at another price means the
        // car is still live — NOT achieved, honest failure, stamp
        // untouched. A page whose listings region never rendered
        // proves nothing — also an honest failure. Since v2.1.13
        // the branch additionally requires the delayed second look
        // below before it may conclude anything.
        let titleCards = findListingCardsByTitle();
        // PROBE BEFORE DECIDING (v2.1.9, header note 19b): the
        // branch decision itself is recorded — strict count,
        // title-only count, which rendered signals fired, and the
        // final verdict — so if goal-achieved ever misjudges
        // again, error_message alone explains why.
        const signals = sellingChromeSignals();
        const rendered = sellingRenderedFromSignals(signals);
        const fired = Object.keys(signals).filter(k => signals[k]);
        recordStepNote("Delete", "delete_zero_match_probe",
          (`strict:0 title:${titleCards.length} rendered:${rendered} ` +
           `signals:${fired.length ? fired.join(",") : "none"}`).slice(0, 200),
          String(titleCards.length));
        if (!titleCards.length && rendered) {
          // DELAYED SECOND LOOK: give a just-published listing
          // time to reach the selling list, then settle + rescan.
          // If the card shows up, fall through and delete it for
          // real; only a second settled zero earns "already gone".
          await sleep(20000);
          await settleSellingList();
          cards = findListingCards();
          titleCards = findListingCardsByTitle();
          recordStepNote("Delete", "delete_zero_match_second_look",
            `strict:${cards.length} title:${titleCards.length} after settle + 20s wait`,
            String(cards.length));
        }
        if (!cards.length && !titleCards.length && rendered) {
          recordStepNote("Delete", "delete_already_gone",
            `no listing for ${title} on the settled selling page after two looks — ` +
            `the removal goal looks met on this page; fresh-load proof decides`, "0");
          await finishDeleteWithFreshProof();
          return;
        }
        if (!cards.length) {
          await fail(
            `Could not find the ${title} listing on your selling page — nothing was deleted. It may already be gone.`,
            "listing_not_found");
          return;
        }
        // The second look FOUND the card — fall through and delete
        // it for real below.
      }
      if (cards.length > 1) {
        await fail(
          `Found ${cards.length} listings matching ${title} at that price — deleting nothing rather than risk the wrong car. Delete the right one from Facebook's Your listings page.`,
          "listing_ambiguous");
        return;
      }

      const card = cards[0];
      say("Found it — opening its menu…");
      // Bring the card on screen and let the scroll settle before
      // touching its menu (v2.1.9): a menu button measured or
      // clicked mid-scroll / off-viewport is a classic silent miss
      // on lazy-rendered selling pages.
      try { card.scrollIntoView({ block: "center" }); } catch (e) {}
      await sleep(600);
      await humanPause();
      const menuBtn = listingMenuButton(card);
      if (!menuBtn) {
        recordStepNote("Delete", "menu_button_not_found",
          "listingMenuButton returned null for the matched card", "0", card);
        await fail("Found the listing but not its options (⋯) menu — nothing was deleted.",
          "delete_menu_not_found");
        return;
      }
      const btnInfo = menuButtonInfo(card, menuBtn);
      recordStepNote("Delete", "menu_button_found",
        `ancestor depth ${btnInfo.depth}; ${btnInfo.descriptor}`.slice(0, 200),
        "", menuBtn);

      // Menu-opening ladder (v2.1.9): after EACH strategy, POLL up
      // to ~3s for a visible menu (or a located delete item)
      // before escalating — a slow menu caught by polling must not
      // be re-clicked shut by the next rung, and a menu that is
      // already open stops the ladder wherever it opened.
      const menuStrategies = [
        { name: "realistic", run: async () => { realisticClick(menuBtn); } },
        { name: "cdpClick", run: async () => { await cdpClickEl(menuBtn); } },
        { name: "cdpClickSeq", run: async () => { await cdpMouseSeqClickEl(menuBtn); } }
      ];
      let menuOpenedBy = null;
      let menuPollMs = 0;
      let deleteItem = null;
      for (const strat of menuStrategies) {
        await strat.run();
        const res = await pollForMenuOpen(3000);
        menuPollMs = res.elapsed;
        if (res.menu || res.item) {
          menuOpenedBy = strat.name;
          deleteItem = res.item || findDeleteMenuItem();
          break;
        }
      }
      if (!menuOpenedBy) {
        recordStepNote("Delete", "menu_never_opened",
          "realistic, cdpClick and cdpClickSeq each polled ~3s — no visible menu, no delete item",
          "0", menuBtn);
        await fail("The listing's menu did not open — nothing was deleted.",
          "delete_menu_not_found");
        return;
      }
      recordStepNote("Delete", "menu_opened",
        `strategy ${menuOpenedBy}; poll ${menuPollMs}ms`, "", menuBtn);
      const itemTexts = menuItemTexts();
      recordStepNote("Delete", "menu_items_seen",
        (itemTexts.length ? itemTexts.join(" | ") : "(no visible item texts)").slice(0, 200),
        String(itemTexts.length));
      if (!deleteItem) deleteItem = findDeleteMenuItem();
      if (!deleteItem) {
        // The menu IS open — it simply offers no Delete entry.
        // That is a different fact from "menu never opened", and
        // it gets its own reason (v2.1.9); the item texts above
        // are the evidence.
        await fail("The listing's menu did not offer a Delete entry — nothing was deleted.",
          "delete_item_not_found");
        return;
      }

      say("Deleting the listing…");
      await humanPause();
      realisticClick(deleteItem);
      recordStepNote("Delete", "delete_item_clicked",
        "strategy realistic", "", deleteItem);
      // The survey gate (v2.1.18): "Did you sell this item?" comes
      // BEFORE the real Delete confirm. Answer it if it appears;
      // an undrivable survey is an honest stop, not a dead end to
      // click through blindly.
      const surveyOutcome = await handleDeleteSurveyIfPresent(5000);
      if (surveyOutcome === "unhandled") {
        recordStepNote("Delete", "confirm_dialog_dump",
          describeOpenDialogs(), "0");
        await fail("Facebook's delete survey (\"Did you sell this item?\") couldn't be completed — the listing was NOT removed.",
          "delete_survey_unhandled");
        return;
      }
      let conf = await pollForDeleteConfirm(2000);
      if (!conf.btn) {
        await cdpClickEl(deleteItem); // trusted click fallback, as elsewhere
        recordStepNote("Delete", "delete_item_clicked",
          "strategy cdpClick (fallback — no confirm after the realistic click)", "", deleteItem);
        // The fallback click can surface the survey late — give it
        // the same chance before the longer confirm poll.
        const lateSurvey = await handleDeleteSurveyIfPresent(3000);
        if (lateSurvey === "unhandled") {
          await fail("Facebook's delete survey (\"Did you sell this item?\") couldn't be completed — the listing was NOT removed.",
            "delete_survey_unhandled");
          return;
        }
        conf = await pollForDeleteConfirm(4000);
      }
      const confirmBtn = conf.btn;
      if (!confirmBtn) {
        recordStepNote("Delete", "confirm_dialog_dump",
          describeOpenDialogs(), "0");
        await fail("Facebook's delete confirmation did not appear — the listing was NOT removed.",
          "delete_confirm_not_found");
        return;
      }
      recordStepNote("Delete", "confirm_found",
        `confirm button located after poll ${conf.elapsed}ms`, "", confirmBtn);
      await resetNavRecoveries();
      // Click-target audit (v2.1.17): never fire the confirm click
      // at coordinates whose topmost element is something else —
      // a covered button means the click would go to the covering
      // element (a header icon, a notification, the page behind).
      const cr = confirmBtn.getBoundingClientRect();
      const cx = Math.round(cr.left + cr.width / 2);
      const cy = Math.round(cr.top + cr.height / 2);
      const topEl = document.elementFromPoint(cx, cy);
      const topOk = !!topEl && (topEl === confirmBtn ||
        (typeof confirmBtn.contains === "function" && confirmBtn.contains(topEl)) ||
        (typeof topEl.contains === "function" && topEl.contains(confirmBtn)));
      recordStepNote("Delete", "confirm_click_target",
        `at (${cx},${cy}): ${topEl
          ? topEl.tagName + " " + String(topEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)
          : "(nothing)"} — aligned:${topOk}`,
        topOk ? "1" : "0");
      if (!topOk) {
        await fail("Something was covering Facebook's delete confirmation, so the click was withheld — the listing was NOT removed.",
          "delete_confirm_occluded");
        return;
      }
      realisticClick(confirmBtn);
      recordStepNote("Delete", "confirm_clicked",
        "strategy realistic", "", confirmBtn);

      // Verify before claiming anything: the card must be GONE.
      let gone = false;
      for (let i = 0; i < 8 && !gone; i++) {
        await sleep(1500);
        if (checkpointShowing()) {
          await fail("Facebook showed an identity check during the removal.",
            "facebook_checkpoint");
          return;
        }
        const remaining = findListingCards().length;
        recordStepNote("Delete", "verify_passes",
          `pass ${i + 1}/8: ${remaining} strict match(es) remaining`,
          String(remaining));
        gone = remaining === 0;
      }
      if (!gone) {
        // v2.1.20: the local verify window is ~12 seconds of
        // same-page DOM, but on 2026-10-23 (Corolla + Focus, back
        // to back) Facebook executed both deletions server-side
        // on a minutes-long delay — the cards never re-rendered
        // away in this tab, the jobs failed as not_verified, and
        // minutes later the seller's own fresh Selling page showed
        // both listings gone. A genuine, audited confirm click
        // has earned a slower verdict: defer to a delayed
        // fresh-load proof (verdict at ~75s, one re-check at
        // ~+75s more) instead of failing here. Only if the
        // delayed proof cannot be armed does the honest failure
        // stand.
        recordStepNote("Delete", "delete_verify_deferred",
          "card still rendered after the local verify window — " +
          "deferring the verdict to a delayed fresh-load proof", "");
        if (await armDelayedDeleteProof()) {
          say("Facebook can take a minute to drop a deleted listing — re-checking on a fresh page shortly…");
          await sleep(600);
          try { window.location.reload(); } catch (e) { /* no-op */ }
          return;
        }
        await fail("Clicked Delete, but the listing is still on your selling page — NOT removed.",
          "delete_not_verified");
        return;
      }
      // The DOM passes above are page-local evidence only: a card
      // can leave this page's DOM while Facebook keeps the listing
      // (proven 2026-10-23, twice — see runDeleteProof). The claim
      // is therefore finished on a FRESH page load, never here.
      recordStepNote("Delete", "listing_deleted",
        `${title} @ $${Number(car.price).toLocaleString()} — card gone from this page; fresh-load proof decides`, "gone");
      await finishDeleteWithFreshProof();
    } catch (err) {
      console.error("[AutoLaunch] delete error:", err);
      await fail("Unexpected error during removal: " + (err && err.message ? err.message : "unknown"));
    }
  }

  // ---- post-publish verification (v2.1.7, header note 18) ----------------
  // The passive success vocabulary (detectPublished) is a hint,
  // not an arbiter: post-publish screens vary by path and timing,
  // and the first Full Auto run posted a car the detector never
  // recognized. When the passive signals stay silent, the tab
  // navigates to the Selling page and the question "is this car
  // listed?" is settled by the delete flow's strict matcher in a
  // read-only scan. The continuation state rides the stored job
  // (verifyPublished {tries, startedAt}) because navigation
  // restarts this script; the finish reports are the ordinary
  // JOB_POSTED / JOB_FAILED the worker already knows.
  const SELLING_PAGE_URL = "https://www.facebook.com/marketplace/you/selling";
  // Stamp the publish attempt on the stored job BEFORE the first
  // Publish click (v2.52, header note 26). The marker is the
  // flow's memory across page lifetimes: any later re-entry of
  // this script for the same job sees it and goes straight to
  // Selling-page verification instead of filling and publishing
  // a second time. Fail-open: if the write is lost, the retry
  // evidence guard (publishRetryEvidence) is still standing.
  async function markPublishAttempted() {
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId && !j.publishAttemptedAt) {
        j.publishAttemptedAt = new Date().toISOString();
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* the evidence guard still applies */ }
  }

  async function escalateToSellingVerification() {
    recordStepNote("Verify", "posted_verify_escalated",
      "passive success signals did not fire — verifying on the Selling page", "");
    try {
      const cur = await chrome.storage.local.get(["current_posting_job"]);
      const j = cur && cur.current_posting_job;
      if (j && j.queueId === queueId) {
        j.verifyPublished = { tries: 0, startedAt: new Date().toISOString() };
        await chrome.storage.local.set({ current_posting_job: j });
      }
    } catch (e) { /* storage hiccup — the navigation is still the best next step */ }
    say("Confirming the post on your Selling page…");
    await sleep(600);
    try { window.location.href = SELLING_PAGE_URL; } catch (e) { /* no-op */ }
  }

  async function runVerifyPublished() {
    // Orphan recovery (v2.52, header note 26): when the worker
    // armed this scan to settle a stale job, the scan is the
    // same but its "not there" outcomes collapse back to
    // job_orphaned — the failure the watchdog would have
    // written — while a shells-only verdict stays the honest
    // duplicate_rejected in both modes, and a live card posts
    // the job truthfully in both modes.
    const inOrphanRecovery = !!(job.verifyPublished && job.verifyPublished.orphanRecovery);
    const failUnverified = async (bannerText, storedReason) => {
      if (!inOrphanRecovery) { await fail(bannerText, storedReason); return; }
      recordStepNote("Verify", "orphan_recovery_scan_inconclusive",
        `recovery scan ended ${storedReason || "error"} — the orphan failure stands`,
        storedReason || "");
      await fail(
        "An earlier post run was interrupted and its listing could not be verified on the Selling page — marked failed (job_orphaned).",
        "job_orphaned");
    };
    try {
      // Routed here from any page the job's tab sits on; the scan
      // itself only ever runs on the Selling page.
      if (!/facebook\.com\/marketplace\/you\/(selling|dashboard)/.test(window.location.href)) {
        try { window.location.href = SELLING_PAGE_URL; } catch (e) { /* no-op */ }
        return;
      }
      say("Checking your Selling page to confirm the listing…");
      await sleep(3000); // let the selling page render

      const pageText = (document.body.innerText || "").toLowerCase();
      if (window.location.href.includes("/login") ||
          pageText.includes("checkpoint") ||
          pageText.includes("confirm your identity") ||
          pageText.includes("log in to facebook")) {
        await failUnverified(
          "Facebook is asking for login or an identity check — the post could not be verified.",
          "facebook_checkpoint");
        return;
      }

      const title = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim() || "vehicle";
      let cards = findListingCards();
      let scan = classifyListingCards(cards);
      // The selling page lazy-loads its cards; give them a moment
      // (the same patience the delete scan uses). The patience
      // now runs until a LIVE card appears — a shell rendered
      // early must not cut the wait for a live twin still
      // loading (v2.52, header note 26).
      for (let i = 0; i < 4 && !scan.live.length; i++) {
        await sleep(1500);
        cards = findListingCards();
        scan = classifyListingCards(cards);
      }
      recordStepNote("Verify", "posted_verify_scan",
        `strict matches: ${cards.length} (live ${scan.live.length}, shells ${scan.shells.length}) for ${title} @ $${Number(car.price || 0).toLocaleString()}`,
        String(cards.length));
      if (scan.live.length) {
        recordStepNote("Verify", "posted_verified_on_selling_page",
          `${title} found live on the Selling page after Publish`,
          String(scan.live.length));
        say("Listing confirmed live ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: window.location.href });
        return;
      }
      if (scan.shells.length) {
        // Facebook's duplicate verdict is definitive for this
        // submission — no rescan patience applies. Fail honestly
        // and DO NOT stamp: a shell is proof the post was
        // REFUSED, never that it landed (v2.52, header note 26).
        recordStepNote("Verify", "posted_verify_shells_only",
          `only duplicate shells found for ${title} — Facebook rejected the submission`,
          String(scan.shells.length));
        await fail(
          "Facebook rejected this post as a duplicate of a listing that is already live — NOT marked posted.",
          "duplicate_rejected");
        return;
      }

      // Absent: a listing this fresh can lag while it sits in
      // review, so the scan retries (2 more, ~30s apart, each on a
      // fresh page load). The startedAt wall-clock cap guarantees
      // the retry loop terminates even if the tries counter could
      // not be persisted.
      const vp = job.verifyPublished || {};
      const tries = vp.tries || 0;
      const startedAtMs = Date.parse(vp.startedAt || "") || Date.now();
      if (tries < 2 && Date.now() - startedAtMs < 4 * 60 * 1000) {
        try {
          const cur = await chrome.storage.local.get(["current_posting_job"]);
          const j = cur && cur.current_posting_job;
          if (j && j.queueId === queueId) {
            j.verifyPublished = Object.assign({}, j.verifyPublished, { tries: tries + 1 });
            await chrome.storage.local.set({ current_posting_job: j });
          }
        } catch (e) { /* the wall-clock cap above still bounds the loop */ }
        say("The listing isn't visible yet — Facebook can take a moment. Rechecking…");
        await sleep(30000);
        try { window.location.reload(); } catch (e) { /* no-op */ }
        return;
      }
      await failUnverified(
        "Publish was clicked but the listing could not be found on your Selling page — NOT marked posted.",
        "publish_unverified");
    } catch (err) {
      console.error("[AutoLaunch] verify error:", err);
      await failUnverified("Unexpected error while verifying the post: " + (err && err.message ? err.message : "unknown"), "verify_error");
    }
  }

  // ---- main flow ----------------------------------------------------------
  if (jobAction === "delete") {
    // A delete whose confirm click may have executed on a delay
    // (v2.1.20) routes to the delayed proof, which only ever
    // re-checks fresh page loads — it never re-runs the ladder.
    if (job.deleteDelayedProof) {
      await runDelayedDeleteProof();
      return;
    }
    // A delete that already made its attempt and reloaded for the
    // fresh-load proof (v2.1.15) routes to the proof, not a blind
    // restart of the whole flow.
    if (job.deleteProof && !job.deleteProofDone) {
      await runDeleteProof();
      return;
    }
    await runDeleteListing();
    return;
  }
  if (jobAction === "share") {
    await runShareListing();
    return;
  }
  if (jobAction === "post" && job.verifyPublished) {
    await runVerifyPublished();
    return;
  }
  if (jobAction === "post" && job.publishAttemptedAt) {
    // A Publish click already happened for this job in an
    // earlier life of this script (v2.52, header note 26): the
    // page reloaded or navigated mid-verification and the flow
    // would otherwise restart from an empty form and publish
    // AGAIN — the double-submission half of the 2026-10-28
    // Passport incident. Never fill or publish twice for one
    // job: settle it on the Selling page instead.
    await escalateToSellingVerification();
    return;
  }
  // Job liveness (v2.54, header note 28): this tab loaded its
  // job from storage, and a tab can outlive the job — in the
  // 2026-10-28 Accord incident a surviving tab re-drove this
  // fill after the worker had already settled the row. Ask
  // the worker whether this stored job is still the live one.
  // ONLY a definitive "no" aborts; any error, timeout or
  // ambiguity falls through and fills exactly as before.
  const deadReason = livenessAbortReason(await askJobLiveness(queueId));
  if (deadReason) {
    console.log(`[AutoLaunch] Fill skipped — this tab's job is no longer live (${deadReason}).`);
    say("This posting was already settled in your queue — this tab won't post it again.", "#b91c1c");
    return;
  }

  try {
    say("Preparing your listing…");
    await sleep(3500); // let Facebook render the form

    const pageText = (document.body.innerText || "").toLowerCase();
    if (window.location.href.includes("/login") ||
        pageText.includes("checkpoint") ||
        pageText.includes("confirm your identity") ||
        pageText.includes("log in to facebook")) {
      await fail("Facebook is asking for login or an identity check. Sign in normally in this browser, then re-queue the car.");
      return;
    }

    // Photos first: a listing without photos is not worth posting, and a
    // failed upload must stop the job — not silently continue.
    const photos = photoUrls();
    let photoOk = false;
    if (photos.length) {
      say(`Uploading ${photos.length} photo(s)…`);
      const res = await attachPhotos(photos);
      if (!res.ok) {
        await fail(`Photo upload failed (${res.reason}).`);
        return;
      }
      photoOk = true;
      if (res.warning) {
        // Soft warning only (v3.1): Facebook is showing more previews
        // than we sent (its uploader merged leftovers), still within
        // its 20-photo limit — say so, then carry on.
        say(`Photos attached — Facebook is showing ${res.shownCount || res.count} (some duplicates from its uploader). Continuing…`);
        await sleep(2000);
      }
      await humanPause();
    }

    // Intro video (v2.1.53, header note 27): after the photos,
    // before the step walk — and only when the worker resolved
    // one onto this job. Strictly fail-open: any skip leaves
    // the post exactly as it was before this version.
    if (introVideo) {
      await attachIntroVideo();
      await humanPause();
    }

    // Walk the steps: fill + verify each step, then click Next (in BOTH
    // modes — advancing a step is navigation, not publishing; confirm
    // mode stops only at the Publish button, when the form is complete).
    const verifiedEver = new Set();
    let lastStepMissing = [];
    let isFirstStep = true;
    for (let step = 0; step < 6; step++) {
      await fillCurrentStepFields(isFirstStep);
      isFirstStep = false;

      const spec = requiredSpecForStep();
      lastStepMissing = await verifyFieldsWithRefill(spec);
      for (const f of spec) {
        if (!lastStepMissing.includes(f.name)) verifiedEver.add(f.name);
      }
      if (spec.length) {
        say(lastStepMissing.length
          ? `Checking details… still missing: ${lastStepMissing.join(", ")}`
          : "Checking details… this step verified ✓");
      }

      if (publishButton()) break; // final step reached — Publish is here
      const next = nextButton();
      if (!next) break;
      next.click();
      await sleep(2800);
      if (checkpointShowing()) {
        await fail("Facebook showed an identity check mid-posting.");
        return;
      }
    }

    // Final verification pass — the LAST thing before confirm-watch, so
    // a mid-fill React re-render (photo attach, step change, VIN decode)
    // that wiped a field is caught here and repaired by the refill.
    // One last modal swat first (v2.1.6): nothing informational may be
    // sitting over the form when the verify/Publish phase begins.
    await dismissInfoModals();
    await sleep(800);
    const finalSpec = requiredSpecForStep();
    const finalMissing = await verifyFieldsWithRefill(finalSpec);
    const missing = new Set(finalMissing);
    for (const f of finalSpec) {
      if (!finalMissing.includes(f.name)) verifiedEver.add(f.name);
    }
    // A required field that is not on the final step only passes if it
    // verified on the step where it lived.
    for (const name of ["Year", "Make", "Model", "Price", "Description"]) {
      const presentNow = finalSpec.some(f => f.name === name);
      if (!presentNow && !verifiedEver.has(name)) {
        const hadExpected =
          (name === "Year" && car.year) || (name === "Make" && car.make) ||
          (name === "Model" && car.model) || (name === "Price" && car.price) ||
          name === "Description";
        if (hadExpected) missing.add(name);
      }
    }
    // Never-empty diagnostics (v3.2): EVERY failed required field
    // leaves a forensic record. Fields the ladder exhausted already
    // have one (diagRecorded). The rest split in two: located but
    // never laddered (e.g. Description) — snapshot the real element;
    // and NEVER LOCATED — no spec ever included them because
    // fieldPresent was false all along (the run-5 failure mode) —
    // synthesize a "field_not_located" record, and map the form ONCE
    // so the shapes Facebook actually served are on the record too.
    for (const name of missing) {
      if (name === "Photos" || diagRecorded.has(name)) continue;
      const specEntry = finalSpec.find(f => f.name === name);
      const kw = REQUIRED_FIELD_KEYWORDS[name];
      if (specEntry) {
        let rb = "";
        try { rb = specEntry.read(); } catch (e) { rb = ""; }
        recordFieldDiagnostic(
          specEntry.keywords ? specEntry
            : Object.assign({}, specEntry, { keywords: kw }),
          rb);
      } else if (!locateRequiredField(name)) {
        recordFieldDiagnostic(
          { name, expected: expectedForFieldName(name), keywords: kw },
          "", "field_not_located");
        recordFormMap();
      } else {
        recordFieldDiagnostic(
          { name, expected: expectedForFieldName(name), keywords: kw }, "");
      }
    }
    if (!photoOk) missing.add("Photos");
    if (missing.size) {
      await failUnfilled([...missing]);
      return;
    }

    // The fill sequence is over and everything verified — end the
    // trusted-input session (Chrome's debugging infobar goes with it)
    // before the confirm watch / publish step.
    await cdpDetach();

    const already = detectPublished();
    if (already) {
      say("Listing confirmed live ✓", "#15803d");
      await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: already });
      return;
    }

    if (confirmMode) {
      say("Everything is filled in. Review it, then click Publish — AutoLaunch will confirm the post for you.", "#b45309");
      const watch = await watchForPublishClick(10 * 60 * 1000);
      if (watch.hit) {
        say("Listing confirmed live ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: watch.hit });
      } else if (watch.clickLikely) {
        // The human DID click Publish, but Facebook never showed a
        // state the passive detector knows — the same blindness
        // that failed the first Full Auto run. Settle it actively
        // on the Selling page instead of failing a listing that
        // may well be live (v2.1.7, header note 18).
        await escalateToSellingVerification();
      } else {
        await fail("Publish was not confirmed within 10 minutes (never clicked, or Facebook did not show a success state).");
      }
      return;
    }

    // Full-auto mode (v2.1.4): the verify gate has passed and the
    // user turned Full Auto on, so the filler publishes by itself.
    // Click through any remaining Next steps (human-paced), click
    // Publish with the realistic sequence, and — if the button is
    // still sitting there with no success state after a short watch —
    // retry ONCE with a trusted CDP click. The passive watch after
    // the click is deliberately SHORT (~60s total, v2.1.7): a
    // silent detector no longer fails the job, it escalates to
    // active verification on the Selling page, which settles
    // posted-vs-not with the strict matcher. Posted is reported
    // only on a detected success or a verified live listing.
    say("Full Auto is on — publishing without waiting for a click…");
    let btn = publishButton();
    for (let hop = 0; hop < 4 && !btn; hop++) {
      const next = nextButton();
      if (!next) break;
      await humanPause();
      realisticClick(next);
      await sleep(2800);
      if (checkpointShowing()) {
        await fail("Facebook showed an identity check mid-posting.");
        return;
      }
      btn = publishButton();
    }
    if (!btn) {
      await fail(
        "Full Auto could not reach Facebook's Publish button — nothing was published.",
        "publish_button_not_found");
      return;
    }
    await humanPause();
    // The attempt marker lands BEFORE the click (v2.52, header
    // note 26): from this moment, any re-entry of this flow —
    // reload, navigation, crash — verifies on the Selling page
    // instead of ever submitting this job a second time.
    await markPublishAttempted();
    const preClickUrl = window.location.href;
    realisticClick(btn);
    let hit = await watchForPublish(15000);
    if (!hit) {
      const retryBtn = publishButton();
      if (retryBtn && publishRetryEvidence(preClickUrl, retryBtn)) {
        // Positive evidence the first click never submitted
        // (button idle, no navigation, no dialog): the one
        // trusted retry, then the session closes before the
        // watch — the same shape as before, now earned.
        recordStepNote("Publish", "publish_retry_click",
          "first Publish click evidently never submitted — one trusted CDP retry", "");
        await cdpClickEl(retryBtn);
        await cdpDetach();
        hit = await watchForPublish(45000);
      } else if (retryBtn) {
        recordStepNote("Publish", "publish_retry_withheld",
          "Publish button still present but the submission state is ambiguous — no second click; Selling-page verification decides", "");
      }
    }
    if (hit) {
      say("Listing confirmed live ✓", "#15803d");
      await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: hit });
    } else {
      await escalateToSellingVerification();
    }
  } catch (err) {
    console.error("[AutoLaunch] content error:", err);
    await fail("Unexpected error: " + (err && err.message ? err.message : "unknown"));
  }
})();

