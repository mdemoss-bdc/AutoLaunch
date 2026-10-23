# Button Audit — AutoLaunch Rebuild (`luna-rebuild/index.html`)

Requested by Matthew (2026-10-22 morning, after the Settings-tabs find):
*"verify and fix all buttons on the app so all of the buttons throughout
the app are clickable."*

## Method

Every clickable control in the file was inventoried and cross-checked
programmatically, before and after fixes:

- All `<button>` elements (108 in the final build), all `<a>` elements,
  label/switch controls, clickable cards/divs, and dynamically generated
  buttons inside JS template strings (inventory rows, grid cards, queue
  rows, wishlist matches, dropdown, generated onboarding results).
- Every inline handler name (`onclick`/`onchange`/`oninput`/…) was
  cross-checked against the functions actually defined in the script.
- **Every inline handler body was compiled** (`new Function` semantics via
  `node --check`). This is the check that matters — it caught a real
  defect during this audit (see "Process note" below).
- Handler bodies were scanned for empty / console.log-only no-ops.
- All static `id`s were checked for duplicates; every `getElementById`
  reference was checked against an element that actually exists.
- Overlays were checked for click interception (the vehicle action
  dropdown starts hidden and closes on outside click and on selection).

## Verification results (after fixes)

- Full `<script>` passes `node --check`.
- **All 147 inline handler bodies compile.** 0 references to undefined
  functions. 0 dead `href="#"` links. 0 duplicate static IDs. 0
  `getElementById` references without a matching element. 0 empty or
  console-only handler functions.
- The 14 buttons the scanner flags as "no onclick" are all generated
  row/card buttons that use `data-action` + the app's delegated click
  handler — and the used `data-action` values match the handler's cases
  exactly (details, enqueue, change-price, remove-fb, row-dropdown,
  queue-remove). Deliberate pattern, verified, not an exception list.
- Previously fixed functions confirmed intact: `renderTableRows`,
  `loadPostingQueue`, `switchSettingsTab`, `toggleRibbonSetting`, the
  enqueue paths, `escapeHtml` / `safeHttpUrl`, Phase 0 / mobile /
  overnight work untouched.

## What was broken and what it does now

### 1. Sidebar — Dashboard (dead link)
`href="#"` with no handler: clicking did nothing.
**Now:** returns to the main inventory/dashboard view via the existing
`showInventoryPage()`.

### 2. Sidebar — Inventory (dead link)
Same disease on the currently-selected nav item.
**Now:** also calls `showInventoryPage()` (closes Get Started / Wishlist).

### 3. USER-REPORTED: automation ribbon cards don't open their popups
Matthew, live testing: *"Auto-post new arrivals ›", "Auto delete &
repost ›", "Automatic photo edits ›" — the toggle switches work, but
clicking the card/title/chevron does nothing.*

Root cause: each card's header row (title + chevron + toggle) carried
`onclick="event.stopPropagation()"`, which swallowed every click in the
most-clicked part of the card before it could reach the card's own
`onclick`. Only the narrow lower strip of the card responded.

**Fixed for all six ribbon cards:**
- The stop-propagation now lives only on the toggle switch's `<label>`,
  so flipping a switch never opens the popup — and everything else on
  the card (title, chevron, description) opens its settings modal:
  Auto-post new arrivals → `openAutoPostModal()`, Auto delete & repost →
  `openAutoRepostModal()`, Automatic photo edits →
  `openAutoPhotoEditsModal()`, Posting safety →
  `openPostingSafetyModal()`, Posting preferences →
  `openPostingPreferencesModal()`.
- Each card's "How to use" link (and the master card's "Settings & how
  it works") now carries its own explicit handler opening the **same**
  settings modal as its card — no separate help system invented.
- First (master) Automations card checked as requested: its card click
  and its "Settings & how it works" link open the Settings modal via
  `openSettingsModal()`.

> **Correction — 2026-10-22 (guides change, after this audit):** the
> "no separate help system" point above no longer describes the links.
> Today each ribbon card's "How it works" link carries its own
> `openGuide('<key>')` handler (with `event.stopPropagation()`, so it
> still never triggers the card's own click) and opens the one
> reusable `#guideModal`, whose title, icon, what/steps/notes are
> filled from the `GUIDES` map; the guide modal's "Open these
> settings" button (`openGuideFeature()`) is what then opens the
> same settings modal this item verified. The card clicks themselves
> still open their settings modals exactly as fixed above. Also
> since this audit: the status line under each ribbon card is
> written solely by `renderRibbonStatuses()` — the one writer,
> derived from the live switches/settings — so no card can show a
> hardcoded status that disagrees with its switch.

### 4. List / Grid view toggle (dead buttons)
The two view buttons next to the sort control had no handlers at all.
**Now:** a real grid view. `setViewMode()` switches rendering — inventory
cards (photo, title, stock/VIN, price, miles, status chip, and the same
Post / Change price / Remove / details actions) rendered by
`renderGridRows()`. Only one view renders at a time, deliberately: bulk
selection maps `.car-select-chk` checkboxes to the filtered inventory by
DOM order, and rendering both views would break that mapping.

### 5. Auto-Post modal — photo-count selector (decorative buttons)
"1 photo / 3 / 5 / 10 photos" looked selectable but tracked nothing and
`saveAutoPostPreferences()` never read them.
**Now:** real state (`setMinPhotos()` + highlight), restored from saved
settings on load, and persisted on save in its own best-effort write
(column `auto_post_min_photos` — see "Database follow-ups"). If the
column isn't there yet, the choice still applies for the session and the
confirmation says so honestly.

### 6. Photo Edits modal — three dead controls
- **"Try another vehicle"** did nothing. **Now:** cycles the preview
  through the loaded inventory (`cyclePreviewVehicle()`), updating the
  photo and the "Previewing on …" name; honest alert if no vehicles are
  loaded yet.
- **"Background" / "Adjust crop" tabs** did nothing (Background was just
  the pre-selected look). **Now:** real tabs (`switchPhotoEditTab()`).
  Adjust crop reveals its panel and turns the preview photo into a
  drag surface — dragging sets the crop focal point (`object-position`),
  exactly what the modal's own help text promised ("Use Adjust crop
  above the photo to drag it"). A **Reset to center** button was added
  and is wired.
- Bycatch: the **Auto-crop frequency select** was never read by any
  save. It and the crop position now persist in the same best-effort
  write as item 5 (columns `auto_crop_frequency`,
  `photo_crop_position`) and restore on load when present.

### 7. Header — dealer website link (placeholder trap)
`dealerUrlDisplay` points at `#` until settings load assigns the real
dealer URL; with no URL configured, clicking jumped to the top of the
page. **Now:** a click guard (`handleDealerUrlClick()`) — real URL opens
the dealer site in a new tab as before; no URL configured opens Settings
instead.

### 8. Filters modal — "Apply Filters" (half-behaviour)
It applied the filters but left the modal open, reading as broken next
to the live-applying selects. **Now:** applies and closes the modal.

### 9. Sidebar Elite items — Inbox, Calendar, AI Training, Playground
Roadmap placeholders with dead `href="#"` clicks.
**Now:** each opens a polished **Elite info modal** (`showEliteInfo()`)
naming the feature, what it will do, and that it's part of AutoLaunch
Elite and not available yet. No fake features were built.
**Leads is deliberately NOT in this list** — see the Wishlist section.

## Verified healthy (checked, no change needed)

Auth tabs + submit (form `onsubmit`), password visibility toggle;
Get Started sidebar link; Post Queue link + badge; Chrome Extension
external link; Settings link; sign-out; mobile menu buttons + drawer
auto-close on nav; Get Started page (Test Inventory, generated Continue,
Complete Setup, progress steps are non-interactive labels); onboarding
inputs (read at save); Refresh Inventory; Post Selected (bulk queue);
Configure URLs; ribbon toggles ×4 (`toggleRibbonSetting`, Phase 4);
search input; sort select; filter pills ×5; select-all + row checkboxes;
Filters button; filters modal selects ×8 + Clear Filters + Cancel;
inventory row actions (delegated: details, enqueue, change-price,
remove-from-Facebook, row dropdown); the floating action dropdown's 4
items (`handleDropdownAction`) + outside-click close; vehicle details /
change price / add-Facebook-link modals (open, cancel, save); queue modal
+ generated Remove; Settings modal (close, the four tabs from this
morning's fix, dealership form, Auto Posting switch, channel toggles,
Facebook panel buttons, AI panel buttons, Save Settings); auto-post
modal radios + Done; auto-repost frequency select + Done; photo-edits
background choices ×3 (`setPreviewBg`), AI background select, auto-crop
switch, Save/Cancel; posting safety radios, custom-limit toggle, speed
option buttons, Save/Cancel; posting preferences toggles, emoji /
distance / description-length option buttons, AI description controls,
Save/Cancel; the ribbon cards themselves (see item 3).

## WISHLIST — "Leads" became Customer Wishlist (real feature)

Per Matthew's scope change mid-audit, the sidebar **Leads** item was
renamed **Customer Wishlist**, lost its Elite chip (replaced by a
new-match count badge), and was built for real instead of getting the
coming-soon modal. Full documentation: `WISHLIST.md`. In brief:

- **View** following the app's page-swap pattern: entry list with want
  summaries, live match counts, matching cars with the standard
  view/queue actions and NEW tags, honest empty state.
- **Add/Edit form modal**: name (required), phone, email, make keyword,
  model/keyword, year range, max price, max mileage, notes. Save / edit /
  delete per entry; all user text escaped on render.
- **Storage**: Supabase table `customer_wishlist` via `supabaseClient`,
  with an additive, owner-only-RLS draft migration at
  `supabase/wishlist_migration_DRAFT.sql`. If the table doesn't exist
  yet, the app falls back to per-user localStorage and shows a "Saved on
  this device" notice in the view — never a lost entry, never a faked
  server save.
- **Matching**: pure `matchWishlistEntry(entry, cars)` over
  `rawInventory` — make substring, model substring over make+model+trim,
  year range, price/mileage caps, active and not-Sold only.
- **Notifications**: matching runs after every inventory load and when
  the view opens; never-before-seen matched VINs (per-user/per-entry
  seen-set in localStorage) drive the sidebar badge and a toast
  ("🎉 N new wishlist matches — … for James R.") with a View button.
  Opening the view marks matches seen (badge clears). **Check for
  matches now** re-runs and reports truthfully, including "no new
  matches". Email/SMS plug in later via the webhook work.

## Process note (why the compile check matters)

The first wiring of the Elite links inserted backslash-escaped quotes
(`showEliteInfo(\'Inbox\')`) — invalid JS that a script-level
`node --check` cannot see and a name-existence check reads as fine. The
handler-compile pass caught it; the handlers were rewritten plainly and
re-verified. Lesson recorded: for this file, "the handler exists" is not
"the handler runs" — compile every handler body.

## Database follow-ups (drafts, nothing applied)

- `customer_wishlist` — `supabase/wishlist_migration_DRAFT.sql`
  (the one step that turns on synced wishlist storage).
- Small `user_settings` columns used best-effort by items 5–6:
  `auto_post_min_photos` (int), `photo_crop_position` (text),
  `auto_crop_frequency` (text). The app works without them; adding them
  makes those three choices stick between visits.
