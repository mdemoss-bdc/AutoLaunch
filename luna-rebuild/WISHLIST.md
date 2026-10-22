# Customer Wishlist

Matthew's feature (replaces the sidebar "Leads" placeholder). A rep keeps a
list of customers and what each one is hunting for; AutoLaunch continuously
matches that list against the loaded inventory and tells the rep the moment
a matching car is on the lot.

## Where it lives

- Sidebar → **YOUR BUYERS → Customer Wishlist**. The pink badge on the item
  is the count of NEW matches (hidden at zero).
- Everything is in `luna-rebuild/index.html` (view, form modal, matcher,
  notifications). Data migration draft:
  `supabase/wishlist_migration_DRAFT.sql`.

## The view

- **Add Customer Want** opens the form. **Check for matches now** re-runs
  the matcher and reports honestly — including "no new matches".
- Each entry shows: customer name, contact info, a plain-language summary of
  the want ("2020–2024 • Ford F-150 • under $45,000 • under 80,000 mi"),
  notes, a live match count, and its matching cars (photo, year/make/model,
  price, mileage, stock). Cars that matched since the last check wear a
  **NEW** tag. Matching cars carry the same actions as the inventory grid
  (view details, Post To Facebook / Change price / Remove from Facebook).
- **Edit** and **Delete** on every entry (delete asks first).

## The form

Customer name (required), phone, email, make keyword, model/keyword,
year from, year to, max price, max mileage, notes. Any blank "want" field
matches anything. All user text is escaped on render (Phase 5 `escapeHtml`).

## Matching rules — `matchWishlistEntry(entry, cars)`

Pure function over the app's loaded inventory (`rawInventory`, which already
excludes inactive rows):

- make keyword is a case-insensitive substring of the car's make
- model keyword is a case-insensitive substring of make + model + trim
- year within [year from, year to] when set
- price ≤ max price when set (cars with no price pass)
- mileage ≤ max mileage when set (cars with no mileage pass)
- only active (`is_active !== false`) and not-Sold cars count

## Notifications (in-app)

- Matching runs automatically after every inventory load/refresh and when
  the Wishlist view opens.
- A per-user, per-entry "seen" set of VINs lives in localStorage. Matched
  VINs that were never seen before are NEW: the sidebar badge shows their
  total count and a toast appears ("🎉 3 new wishlist matches — 2022 F-150
  for James R.") with a **View** button.
- Opening the Wishlist view marks current matches seen, so the badge
  clears — the NEW tags stay visible for that visit so the rep can see
  what changed.
- Email/SMS are intentionally out of scope here. They plug in later through
  the webhook work (a server-side matcher on inventory insert can reuse
  these exact rules).

## Storage

Primary: Supabase table `customer_wishlist`
(`id, user_id, customer_name, phone, email, make, model, year_min,
year_max, max_price, max_miles, notes, created_at`), owner-only RLS.

**Fallback:** if the table does not exist yet (PostgREST "relation does not
exist" / 42P01-style error), the app automatically stores the wishlist in
the browser's localStorage for that user and shows a notice in the view:
"Saved on this device until the wishlist table is enabled." Entries are
never lost silently, and the app never pretends a server save happened.

## The one step for Matthew

To turn on synced server storage: open the Supabase SQL editor for the
AutoLaunch project and run `supabase/wishlist_migration_DRAFT.sql`
(review it first — it's additive and owner-scoped). The app detects the
table on the next load and switches over automatically; no code change
needed. Note: entries saved on a device before the migration live in that
browser's localStorage and do not migrate themselves — re-add them once,
or ask Luna to write a one-time import.
