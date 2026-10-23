# Auto-Delete on Exit — how a sold/gone car's listing comes down by itself

Matthew's design (agreed 2026-10-22): when a car that has a **live**
Marketplace listing leaves inventory, its listing comes down
automatically. The delete machinery itself (extension `action:'delete'`
queue rows, strict year/make/model + price match on the Selling page,
verify-gone, clear `marketplace_posted_at`) was live-proven in
extension v2.1.4–2.1.7. This feature adds the **triggers**.

## The one contract every trigger writes

All producers write the identical queue row — the same shape the
Remove button has always written:

```
auto_posting_queue {
  user_id, vin,
  target_channel: "facebook", action: "delete", status: "pending",
  year, make, model, stock_num, price   -- stamped at insert time
}
```

The identity fields ride the row on purpose: a delete job must stay
executable after the car's inventory row is inactive or gone, because
the extension's strict matcher needs year/make/model **and** price.

**Dedupe (every producer):** a VIN that already has a `pending` or
`processing` delete row never gets a second one. In the app this is
`queueListingRemoval()`; in the scraper it's a dedupe read before the
insert (and if that read fails, the scraper queues nothing rather
than risk a duplicate).

## Trigger 1 — Mark as sold (app)

The car's ⋯ action menu gained **"Mark as sold"** (there was no
mark-sold affordance before; only status plumbing existed).

- Sets `scraped_inventory.status = "Sold"` (the existing value the
  pill filters already understand — sold cars show under the **All**
  pill with a violet **Sold** chip).
- If the car is posted (`marketplace_posted_at` set) **and**
  auto-remove is on: immediately inserts one delete row via
  `queueListingRemoval()` and says so honestly:
  *"Listing removal queued — the helper will take the Facebook
  listing down."*
- Not posted → just marks sold, no queue row.
- Already sold → no-op with an "already marked sold" note (so a
  double mark-sold can never double-queue).
- While the removal is in flight the chip reads **Sold — removal
  queued**; when the extension confirms the delete, it clears
  `marketplace_posted_at` and the car settles to a clean Sold /
  not-posted state.

## Trigger 2 — Leaves the feed (scraper stale pass)

Inside `mark_stale_inventory()` in `scraper.py`, atomically with the
exit marking: after stale rows are flagged `is_active = false`, any
of them with `marketplace_posted_at` set get **one delete row each**
(same contract, deduped, capped — see below). The app-side
**Remove from inventory** action fires the same producer for the
same reason: an exited posted car takes its listing down with it.

Unchanged guardrails around this:

- The stale pass still runs **only** after a fully clean crawl that
  actually saw cars.
- Capped test runs (`SCRAPE_LIMIT` set) still disable the stale pass
  entirely — so this trigger is disabled there too.

## The mass-exit safety brake (the critical guardrail)

Inherited from Phase 1 and reused exactly: if one run would exit
**more than 50%** of a user's previously-active inventory (and there
are at least 20 active cars), the stale pass marks **nothing** and
queues **nothing** — it logs the anomaly
(`Stale pass skipped … refusing to mass-deactivate`). A broken feed
can never mass-delete live listings.

Second belt: even on a healthy crawl, one run queues at most
**25 auto-delete rows per user** (`AUTO_DELETE_MAX_PER_RUN`). Beyond
that, the remaining exits are still marked inactive but their
removals are skipped and reported in the log; a later run queues
them then.

## The on/off switch

`user_settings.auto_delete_on_exit_enabled` (boolean, default true) —
Settings → Automation → **"Auto-remove sold & exited cars"**.

- The `enable_auto_repost` toggle was inspected and NOT reused: it
  controls the delete-&-repost cycle for aging listings, a different
  behavior.
- Both the app and the scraper treat a **missing** column as ON, so
  the feature works before the migration runs; only an explicit
  `false` disables it. The toggle persists once Luna applies
  `supabase/migrations_draft/auto_delete_on_exit_DRAFT.sql`
  (additive, one column). Until then, flipping the switch reports a
  save error and the feature simply stays on — it never silently
  pretends to be off.
- With the switch off: mark-sold still marks sold (and says the
  listing was left up), the stale pass still marks exits — neither
  queues a delete row.

## The staged Silverado test

The sold 2021 Silverado (VIN 3GCUYEED7MG464648, $32,440) was
force-imported and its listing posted via AutoLaunch. To exercise
Trigger 1 end-to-end, untouched:

1. In the app, open the Silverado's ⋯ menu → **Mark as sold**.
2. Confirm. The app queues the removal; the chip reads
   **Sold — removal queued**.
3. Touch nothing. The extension claims the delete job, deletes the
   listing on the Selling page, verifies it gone, and clears the
   posted stamp — the car settles to **Sold**.

Trigger 2 exercises itself the first time a full (uncapped) scrape
runs after a posted car has dropped off the Moses feed — or is
covered by the fixture simulation in the build report (brake, cap,
dedupe, toggle cases all simulated green).

## Addendum (2026-10-22, later that night) — the stale-copy lesson

The first live Trigger 1 test **missed**, and the reason is now a
standing rule. Matthew marked the posted Silverado sold from his
phone; the database recorded `status = "Sold"` but **no delete row
was queued**. His phone's inventory had been loaded *before* the
truck posted, so the app's in-memory copy said "unposted" and
`markVehicleSold` took the mark-only branch — even though the
database had `marketplace_posted_at` set the whole time.

**The fresh-read rule:** any decision with real-world side effects
is made from the car's **current database row**, never from the
screen's possibly-stale copy. Implemented in
`freshCarForDecision(vin, localCar)` — re-reads `status`,
`marketplace_posted_at` and the identity fields by vin + user,
merges fresh over local:

- `markVehicleSold` — after the confirm, the already-sold check,
  the is-posted decision, and the fields stamped on the removal
  job all come from the fresh row.
- `removeVehicleFromInventory` — same: posted-ness is decided
  fresh (the local copy now only writes the confirm note's text).
- `queueListingRemoval` — its dedupe keeps the local
  `postingQueue` check as a fast path, then **re-checks the table**
  for a pending/processing delete before inserting. If that check
  itself fails, it falls through to the insert: a rare duplicate
  (which the extension goal-achieves harmlessly) beats a lost
  removal.
- A failed fresh read never blocks the action: the helper returns
  the local copy and the flow proceeds with the old behavior.

`removeVehicleFromFacebook` was audited and deliberately left
alone: it makes no posted-state decision of its own (it never reads
`marketplace_posted_at`), and its only local-state dependency was
the dedupe — which the producer's new fresh check now backs up.
Its confirm → queue → already-queued outcome is correct on either
copy.

## What did not change

- The Remove from Facebook button: same confirm, same copy, same
  result — it now calls the shared `queueListingRemoval()` producer
  instead of its own inline insert (identical row shape).
- Queue rendering, the Post Queue modal, and posted-state derivation
  (`marketplace_posted_at`) are untouched.
- Wishlist matching already excluded inactive cars; exited cars
  still never match.
