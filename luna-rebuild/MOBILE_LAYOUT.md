# Mobile (Phone) Layout — Inventory Page

Built 2026-10-24 after Matthew's iOS screen recording showed the desktop
table collapsing on a phone (overlapping PRICE/MILES/STATUS columns,
clipped status pills, rows bleeding into each other, filters eating the
first screen, header buttons overlapping the title).

Applied identically to `index.html` and `luna-rebuild/index.html`.
No data flow, filtering, queue/posting logic, or table markup changed.

## What shipped

1. **Phones open on card (grid) view.** The card renderer already existed
   (`renderGridRows`, now refactored onto a shared `gridCardHtml(car)`
   helper). The view toggle (`setViewMode`) now persists the user's
   explicit choice in `localStorage` key `al_inv_view` ("list" | "grid").
   On session start (`initAppSession`) the app applies
   `initialInventoryViewMode()` through the same `setViewMode` path:
   saved choice → else "grid" when `window.innerWidth < 768` → else "list".
   Automatic switches never write the preference (they pass
   `savePref = false`).

2. **Grid columns.** `#inventoryGridView` already carried
   `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3` (1 column on phones, 2 at
   ≥640px, 3 at ≥1280px), so its classes were left exactly as they were —
   desktop column counts unchanged. Grid card photos now use
   `loading="lazy"`.

3. **Chunked grid rendering on phones only.** On viewports <768px with
   more than 60 filtered cars, `renderGridRows` paints the first 60 cards
   plus a full-width **Show more cars (N more)** button
   (`#gridShowMoreBtn`); each tap of `showMoreGridCars()` appends the next
   60 and removes the button when exhausted. State lives in
   `gridChunkState = { cars, shown }`, reset on every `renderGridRows`
   call. At ≥768px the single full render is byte-for-byte the old path.

4. **Filters collapse on phones.** The 8-select bar (`#filterBar`) starts
   hidden below 768px via a deterministic stylesheet rule:
   `@media (max-width: 767px) { #filterBar:not(.mobile-filters-open) { display: none } }`.
   A phone-only (`md:hidden`) **Filters** button (`#mobileFiltersBtn`,
   funnel icon) toggles the class via `toggleMobileFilters()`. Because the
   hiding rule only exists inside the media query, resizing to desktop
   always shows the bar regardless of the class. The button carries an
   active-filter count badge (`#mobileFiltersBadge`) updated by
   `updateMobileFilterBadge()`, called at the end of `applyFilters()`;
   "active" = any of the 8 selects off its `value=""` "All/Any" default.
   Search, sort, status pills, select-all, Post Selected and Remove
   Selected were already outside the bar and stay visible on phones.

5. **Header stacks on phones.** The Inventory header row is now
   `flex flex-col items-start gap-3 sm:flex-row sm:items-center
   sm:justify-between` (menu button → title → Refresh/Configure actions
   stack vertically on phones; ≥640px identical to before), and the
   title's status line wraps (`flex-wrap`). The automation ribbon below
   was already responsive (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-6`)
   and needed no change.

## Breakpoint rules

- **<768px ("phone")**: card view default, chunked grid (60/tap), filter
  bar collapsed, header stacked.
- **≥768px**: exactly the previous desktop behavior.
- **Resize**: a debounced (200ms) listener tracks which side of 768px the
  window is on. Crossing down with NO saved preference switches to grid;
  crossing up switches back to list. A saved `al_inv_view` preference is
  never overridden by resizing. (iOS Safari's scroll-triggered resizes
  change height, not width, so they cannot flip the side.)

## Chunking audit — selection & DOM dependence (checked before building)

- **Selection truth is the `selectedCarVins` Set, never the DOM.**
  `toggleSelectAllCars` adds/removes every VIN in
  `window.currentFilteredInventory` directly in the Set, then
  `syncInventorySelectionUI()` pushes Set → rendered checkboxes.
  Select-all therefore selects unrendered (not-yet-chunked) cars
  correctly on phones with zero changes.
- Per-car checkbox changes flow through one delegated `change` listener
  that writes into the Set.
- `getSelectedInventoryCars()` filters `rawInventory` by the Set;
  `pruneSelectedCarVins()` only drops VINs that left the inventory.
- The only inventory-row `querySelectorAll` is `.car-select-chk` inside
  `syncInventorySelectionUI()` — syncing rendered boxes from the Set is
  safe when some cars are unrendered. `gridCardHtml` also bakes the
  `checked` attribute from the Set, and `showMoreGridCars()` re-runs
  `syncInventorySelectionUI()` after appending.
- Conclusion: chunking needed **no** select-all adaptation.

## Test on a real phone

1. Fresh open (no saved view): phone lands on card view, one column,
   60 cards + "Show more cars (N more)"; tapping appends 60 at a time
   until the button disappears; scrolling stays smooth on a ~2,000-car lot.
2. Toggle to list view, fully close and reopen: list view persists
   (saved choice wins). Toggle back to grid: persists too.
3. Select-all on the phone with chunking: Post Selected / Remove Selected
   counts act on ALL filtered cars, not just the visible 60.
4. Check a few cars, tap Show more: previously checked stay checked;
   newly appended cars reflect the Set.
5. Filters: bar hidden on load; Filters button opens/closes it; pick a
   Make → badge shows 1; Clear → badge hides. Rotate/resize to desktop
   width with the bar closed: bar appears; back to phone: still closed.
6. Header: title, status line, Refresh Inventory and Configure URLs no
   longer overlap at 360–390px wide.
7. Desktop ≥768px regression pass: table, filters, header, and view
   toggle all look and behave exactly as before; grid view renders all
   cars at once (no Show more button) at 2 and 3 columns.
8. Known cosmetic edge: widening a phone browser (or rotating a tablet)
   across 768px while chunked keeps the Show more button until the next
   filter/search/sort re-render, which then paints the full grid.
