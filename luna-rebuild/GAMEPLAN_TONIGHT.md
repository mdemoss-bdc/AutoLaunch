# GAME PLAN — Overnight, Thu 2026-10-22 → Fri 2026-10-23

Matthew's mandate (2026-10-22 20:54 EDT): fix the delete failure, then spend the
night getting "all other aspects of the app working, or at least everything tied
together" — he tests tomorrow from a 1-by-1 checklist (TOMORROW_CHECKLIST.md).

Standing rules all night: luna-rebuild/** only, live/root files untouched,
honest copy only, commit per phase, nothing destructive in the DB.

## Context the plan starts from
- Extension at 2.1.8; app has auto-delete (0269ced) + fresh-read fix (d821c4d).
- Delete of the Silverado failed TWICE tonight on Matthew's home PC after the
  scan found exactly 1 strict match; the queue diag records nothing past the
  scan. His manual menu screenshot proves the card's ⋯ menu DOES contain
  "Delete listing" (Mark as pending / View listing / List in more places /
  Edit listing / Delete listing / View messages). So the failure is in the
  helper's click/open/confirm interaction on that machine, invisible because
  post-scan delete stages write no step notes. The same flow succeeded on his
  work PC (Tucson, 2026-10-22 ~19:01 EDT).
- Silverado: sold in the app (status Sold), listing still live on Facebook at
  plan time; Matthew was asked to delete it by hand from the open menu. If a
  delete row dated tonight completes as `delete_already_gone`, Luna queued a
  cleanup pass after his manual deletion — that's expected, not a bug.

## Phase A — Extension v2.1.9: delete flow that explains itself (FIRST)
1. Step notes at EVERY delete stage, persisted via the existing diag channel:
   menu_button_found (with how), menu_opened (poll result), menu_items_seen
   (the actual item texts), delete_item_clicked, confirm_found/clicked,
   verify_passes (card count per pass), and the terminal reason — so any
   failure is fully diagnosable from auto_posting_queue.error_message alone.
2. Harden the interaction:
   - scroll the matched card into view before touching its menu;
   - after clicking ⋯, POLL for a visible [role="menu"] up to ~3s (no fixed
     sleeps); if no menu, escalate click strategies in order: realistic click
     → CDP trusted click → debugger Input.dispatchMouseEvent sequence at the
     button's center; re-poll after each;
   - when the menu is open but no Delete entry matches, dump the item texts
     into the diag and fail delete_item_not_found with them recorded;
   - after clicking Delete listing, POLL for the confirm dialog up to ~4s
     before failing delete_confirm_not_found (record what dialogs exist);
   - keep strict matching, goal-achieved semantics, tab rules, everything
     else byte-stable where possible.
3. Full regression suite (all prior harnesses that exist on disk + a new
   harness reproducing: menu opens slowly; menu needs the second click
   strategy; menu items dumped on no-match).
4. Manifest 2.1.9, EXTENSION_NOTES section, commit, push, remote verify.

## Phase B — App consistency pass (the wrinkles Matthew hit tonight)
1. Filter pills must agree with their contents: tonight "Posted 1" showed
   0 cars because the sold-but-posted truck fell out of every pill view
   except All. Define and implement: Active = is_active and not Sold;
   Posted = marketplace_posted_at set (sold or not — chip shows Sold);
   Not posted = posted_at null and not Sold; All = everything. Counts and
   rendered rows must match exactly for all four, with location/search/
   other filters applied on top.
2. Sold cars remain reachable and truthful in Post Queue (removal state).
3. Sanity-verify end to end in code + harness: Change price flow, Post
   Selected with mixed selection (incl. a sold car — must be excluded
   with honest copy), queue modal live refresh, wishlist excludes
   sold/inactive cars from matches (confirm; fix if not).
4. Commit + push; live page verified.

## Phase C — Dark command-center rollout, rest of app
Apply DESIGN_DARK.md tokens + the theme system to the surfaces still light
or partially themed: all modals (Settings incl. tabs, Guides, Photo Edits,
Elite info, confirm/alert replacements if any), Get Started, Wishlist,
Dashboard, login/onboarding. All 8 presets + custom themes must hold on
every screen (accent-driven controls included). No layout/behavior changes
beyond appearance. Commit + push; spot-verify served HTML/CSS.

## Phase D — Webhook: everything except Matthew's 2 minutes
1. Deploy the dispatch-scrape Edge Function via the Management API pattern
   that worked for photo-proxy; verify it's ACTIVE.
2. Create the Supabase database webhook (scrape_jobs insert → function)
   via SQL; verify registration.
3. The function needs a GitHub token WITH Actions dispatch permission as
   its GITHUB_TOKEN secret — Luna cannot supply the value (the muse PAT is
   vault-sealed and currently lacks Actions RW). Leave exactly ONE step
   for Matthew, written into WEBHOOK_SETUP.md as a 2-minute click-path:
   (a) add Actions: Read and write to the muse token; (b) paste the token
   as the function's GITHUB_TOKEN secret in the Supabase dashboard.
   Until then the Refresh button keeps behaving as today (job row waits).
4. Record in the doc what was deployed/verified vs what waits on him.

## Phase E — Distribution prep (paperwork only; filings are Matthew's)
1. App's "Chrome Extension" sidebar page → the approved guided setup:
   live status from the bridge handshake (not installed / installed —
   waiting for sign-in / ready), click-by-click install steps, and the
   Web Store placeholder link slot for launch day.
2. WEBSTORE_PACKET.md: unlisted-listing copy, permission justifications
   (https://*/* host access = dealer photo CDNs; debugger = trusted input
   for Facebook's form), privacy policy draft page in the repo.
3. FILINGS_PREP.md: Meta App Review + TikTok audit — the exact questions,
   assets, and screencasts he'll need, as a checklist he can execute in
   one sitting.

## Phase F — Cleanups + tomorrow's checklist
1. FALLBACK_IMAGE: replace the remaining Unsplash hotlink with a local
   asset everywhere it appears (app + extension photo rule reference).
2. Remove unreferenced generated background images from
   luna-rebuild/assets/backgrounds/ (keep the folder's used files only).
3. Reconcile supabase/wishlist_migration_DRAFT.sql with what was actually
   applied on 2026-10-22 (mark it APPLIED with the real statements).
4. Amend BUTTON_AUDIT.md §3 for the guides/ribbon changes that postdate it.
5. Final smoke pass over the whole rebuild; write TOMORROW_CHECKLIST.md —
   numbered, one line per check, grouped (Extension reload / Posting /
   Deleting / Auto-delete / Screens & filters / Settings & themes /
   Wishlist), each with the expected result. Write the morning summary
   into this file (what shipped, what's staged, what still needs Matthew).

## Overnight progress log (Luna, coordinator)

- [x] Phase A — extension v2.1.9 delete diagnostics + click hardening — commit `c031c8a`. Stage notes at every delete stage + 3-rung click ladder with polling; new slug `delete_item_not_found`. Addendum root cause found & fixed: the goal-achieved veto was the extension's OWN banner ("Looking for your 2021 Chevrolet Silverado 1500 listing…") matching the title-only scan — banner now carries `id="autolaunch-status-banner"` and is excluded from both scans; empty-state chrome signals + `delete_zero_match_probe` shipped. Verified by coordinator: v39 harness 58/58, v38 regression 56/56, node --check clean, remote manifest reads 2.1.9 and remote content.js contains `menu_items_seen` + `delete_zero_match_probe`.
- [x] Phase B — app filter/pill consistency pass — commit `331a6fe` (index.html only). One predicate set now drives both pill counts and applyFilters: Active = not Sold; Posted = marketplace_posted_at set (sold included, Sold chip shows); Unposted = not posted AND not Sold; All = everything. Bulk Post Selected excludes sold cars (and photoless, as before) with honest skip copy; single-enqueue sold guard; Change price verified working; wishlist matcher excludes sold + inactive. Verified by coordinator: worker harness ALL GREEN (run independently), count block + filter block read in code, remote blob SHA byte-identical to local (9de1deea…, 316,873 bytes).
- [x] Phase C — dark command-center rollout (rest of app) — commit `0737ce4` (index.html + DESIGN_DARK.md). All 13 modals, auth overlay, row-action dropdown, wishlist toast, and the Get Started / Wishlist pages (light pins replaced by token rules) now consume the theme tokens via utility mappings scoped to body.dark-shell; semantic hues untouched. Verified by coordinator: theme-engine regression 0 failures across 8 presets + hostile customs (worst 4.51:1), inline script node --check clean, remote blob SHA byte-identical (a00c59d8…, 351,134 bytes).
- [x] Phase D — webhook deploy (all but Matthew's token step) — commit `893a8bd` (WEBHOOK_SETUP.md rewritten). Edge Function dispatch-scrape DEPLOYED + ACTIVE v1 (verify_jwt off); secrets set: GITHUB_OWNER/GITHUB_REPO/WEBHOOK_SECRET (generated, set on both sides, recorded nowhere); DB trigger `dispatch_scrape_on_insert` created on scrape_jobs via supabase_functions.http_request (verified in pg_trigger, enabled). Function verified live: returns function_not_configured to all requests until GITHUB_PAT exists (config gate precedes the secret gate in code) — the honest staged state. Surprises found: (1) the root workflow ALREADY accepts the user_id input — no workflow change needed; (2) a PRE-EXISTING DB trigger `on_scrape_job_inserted` → trigger_github_scraper_runner() dispatches the same workflow directly from Postgres with an embedded token (pg_net shows HTTP 204 successes on 2026-10-21, none on 10-22) — left untouched; flagged in WEBHOOK_SETUP.md: retire it on Matthew's say-so AFTER the function path is proven, else double dispatch. Remaining step (Matthew, ~2 min, in WEBHOOK_SETUP.md): add Actions: Read and write to the muse token, paste token as the GITHUB_PAT function secret.
- [x] Phase E — distribution prep (guided setup page + packets) — commit `848f6d9` (8 files). New in-app "Chrome Extension" setup page replaces the bare Web Store link: live status via a real bridge handshake (app posts AUTOLAUNCH_EXT_PING → bridge forwards AUTOLAUNCH_PING → worker answers {hasToken} reading the real `autolaunch_access_token` key, sender-disciplined to the app origin, boolean only) → not installed / installed-waiting / ready; numbered sideload steps + Web Store "coming soon" placeholder slot; page added to the Phase C dark-scope mappings. Extension 2.1.10. WEBSTORE_PACKET.md (listing copy + verbatim permission justifications + data-use disclosures), FILINGS_PREP.md (Meta App Review + TikTok audit one-sitting checklists, grounded in CHANNELS.md), privacy.html (branded policy page, [CONTACT EMAIL] placeholder). Verified by coordinator: v38 harness extended to 60/60, v39 58/58, syntax clean, remote blobs byte-identical for manifest (2.1.10) + index.html.
- [x] Phase F — cleanups + TOMORROW_CHECKLIST.md + morning summary — main commit `0603d4e` + Contents-API deletion commits (bg JPGs, wishlist DRAFT). Unsplash hotlink gone: new local `assets/no-photo.png` (branded slate tile) is the app fallback; the worker's claim check rejects a list (old Unsplash URL + new asset, absolute & relative) — extension 2.1.11. Orphaned bg-bright/bg-dark/bg-lot.jpg deleted from repo (assets/ now holds only no-photo.png). wishlist_migration_APPLIED_2026-10-22.sql records the real applied schema; DRAFT removed. BUTTON_AUDIT.md §3 amended with the guides correction. TOMORROW_CHECKLIST.md written (17 checks). Verified by coordinator: v38 60/60, Phase B harness ALL GREEN, remote manifest blob == local, remote assets listing clean.

---

# MORNING SUMMARY — 2026-10-23 (overnight run complete)

All six phases shipped and independently verified by the coordinator. Live/root files untouched; everything is in luna-rebuild/.

**Shipped:** A `c031c8a` extension 2.1.9 (delete stage diagnostics + click ladder + the empty-page goal-achieved fix — root cause was the helper's own banner matching its title scan) · B `331a6fe` pill/count/filter agreement · C `0737ce4` dark rollout to every modal/page · D `893a8bd` webhook deployed + DB trigger wired (function ACTIVE; only the GITHUB_PAT secret missing) · E `848f6d9` guided setup page with live helper status (extension 2.1.10) + Web Store packet + filings prep + privacy page · F `0603d4e` cleanups + TOMORROW_CHECKLIST.md (extension 2.1.11).

**Start tomorrow with:** luna-rebuild/TOMORROW_CHECKLIST.md — 17 quick checks, in order.

**Needs you (only you can do these):**
1. The 2-minute webhook step in supabase/WEBHOOK_SETUP.md (add Actions: Read and write to the muse token → paste token as the GITHUB_PAT function secret), then one Sync click together to prove it.
2. Decide on the OLD database trigger Luna found (on_scrape_job_inserted, your original build's direct dispatch): retire it AFTER the webhook proof, or one Refresh will start two scrape runs. One SQL statement, in WEBHOOK_SETUP.md.
3. Meta App Review + TikTok audit filings — FILINGS_PREP.md has the one-sitting checklist; the privacy policy page it needs is built (privacy.html).
4. Spotted, not touched (your live file): the root scraper workflow's default user_id (`40a95557-504a-400f-a493-462bb2b4f25e`) differs from your real one (`40a95557-504a-460f-a891-462bb2b4f25c`) — worth a look before relying on scheduled/manual runs without an explicit user_id.

## Explicitly NOT tonight
- Full 2,387-car refill (deferred by Matthew while fine-tuning).
- Capped rescrape dispatch (blocked on his Actions-permission choice).
- Meta/TikTok filings themselves (only he can file).
- Anything in live/root app files.
