# scraper_next.py — Self-Healing, Self-Learning Scraper

**Status: built + harness-verified 2026-10-26. NOT promoted.** The
nightly job still runs `scraper.py`; this is its sibling successor,
waiting on Matthew's promotion call. It reuses production's proven
primitives by importing `scraper.py` (db client, browser extractor,
VDP enrichment, batch writer, stale pass, auto-post pass) and adds
orchestration, evaluation, and learning around them. Learning is
**data only** — playbooks of parameters; the code never rewrites
itself.

## Self-healing

- **Per-lot retry**: each feed gets up to 4 attempts with backoff
  (2s / 5s / 12s ± jitter). A failed lot is marked failed in the
  digest and never sinks the run or other lots. Navigation failures
  *surface* (they retry, then fail the feed) — the production flaw
  where a failed navigation silently re-extracted the previous page
  is designed out.
- **Strategy ladder**: per page — the production browser extractor
  first (recorded as strategy `browser`), then HTML strategies in
  playbook order: `jsonld` → `embedded_json` (`__NEXT_DATA__` /
  `window.__STATE__`) → `dom_cards` → `text_patterns`. Every attempt
  records cars found + milliseconds.
- **Anomaly quarantine**: a feed's cars are buffered, enriched, and
  *evaluated before anything is written*. Quarantine triggers:
  >40% garbage prices (missing / under $1,000), >60% photo collapse,
  count outside the learned band, or median price outside the
  learned price band. A quarantined lot writes **nothing**, is
  excluded from stale/auto-post trust, and gets exactly **one
  re-crawl**; the digest names it.
- **Watchdog**: `scraper_run_log` heartbeat rows — `started`,
  per-feed `feed_done` / `feed_quarantined` / `feed_failed`,
  `finished` with totals. `--resume <run_id>` (or
  `SCRAPER_NEXT_RESUME`) skips feeds a previous run completed.
  **The 2026-10-25 2 AM mystery, answered**: with heartbeats, a
  missing run is diagnosable at a glance — no `started` row means
  the process never launched (scheduler/workflow layer, which is
  what the evidence already pointed to); `started` with no
  `finished` means it died mid-run, and the last feed event says
  where.

## Self-learning (two levels)

- **Platform fingerprinting**: each lot's platform is detected from
  page signatures and recorded with its evidence:

  | Platform | Signature (asset/markup markers) |
  |---|---|
  | DealerOn | `dealeron.com` |
  | Dealer.com | `dealer.com`, `inventory.dealer.com`, `ddc-api` |
  | Dealer Inspire | `dealerinspire.com` |
  | Sokal | `gosokal.com`, `sokal.com` |
  | Fox Dealer | `foxdealer.com` |
  | WordPress | `wp-content/`, `wp-includes/` |
  | unknown | no signature — script hosts recorded as evidence |

- **Per-platform playbooks** (`scraper_playbooks`, scope `platform`)
  accumulate strategy stats/timings and bands across every site on
  that platform. **Per-lot playbooks** (scope `lot`) specialize from
  there: lot evidence wins once the lot has ≥3 strategy attempts or
  ≥2 band samples; below that, the platform's learned values carry
  the lot. A brand-new dealership cold-starts from its platform's
  playbook instead of zero. An **unrecognized** platform is never
  force-fit — it learns per-lot only and is surfaced in the digest
  as a compatibility gap.
- **Speed learning**: strategy order ranks by expected
  time-to-cars (cars/ms × success rate); a strategy that comes back
  empty ≥3 times and never produced a car is demoted to the back of
  its site's order. Rate-limit responses (429/403) increment the
  lot's hit counter and lower its learned concurrency posture.
  The digest reports total runtime, cars/min, and the trend across
  finished runs. (Honest note: the production scraper is not
  instrumented, so no true baseline exists for it — scraper_next's
  first runs set the baseline.)
- **Needs report**: every digest ends with **"What would make me
  faster"** — only evidence-backed items (a discovered vehicle
  sitemap that would shortcut pagination; repeated rate-limiting
  with the hit count; an unrecognized platform with its page
  evidence; a slow primary strategy with both strategies' measured
  averages). Needs persist in the playbook across digests and
  auto-resolve after 3 consecutive runs without fresh evidence.

## Uncertainty surfacing

Confidence rules:

| Level | Source | Behavior |
|---|---|---|
| High | JSON-LD / embedded JSON / browser pass | writes normally |
| Medium | DOM-card extraction | writes; field gaps flagged |
| Low | text patterns (prose) | **never writes on this evidence** — car goes to `scraper_uncertain` with what was found |
| Suspect price | >2.5× either side of the lot's own median | held + review-listed |
| Ambiguous price | two different prices near one VIN in prose | held + review-listed with both candidates and the evidence snippet — never picks one |
| VIN year mismatch | VIN year code vs page year (>1 yr) | writes, flagged on the review list |
| Thin photos | photo count far below the lot's learned norm | writes, flagged |

`scraper_uncertain` rows: run id, lot, VIN, field, found value,
reason, evidence. Nothing is silently dropped; nothing is guessed.

## Tables (additive, applied 2026-10-26)

`scraper_playbooks`, `scraper_run_log`, `scraper_uncertain` — see
`supabase/migrations_draft/scraper_next_APPLIED_2026-10-26.sql`.
RLS: owners can SELECT their own rows; no client write policies —
the scraper writes with its server-side key, and **every learning
write in the code is fail-open** (verified live: with the public
key, RLS denials were absorbed as warnings and the run completed).

## Verification (2026-10-26)

- **Harness: 51/51 checks** (`scraper_next_harness.py`, fixtures in
  `scraper_next_fixtures/`): baseline parity on the normal lot
  (exact VIN/price sets); ladder recovery on the layout-changed lot
  (JSON-LD dead → embedded JSON takes over, 5/5 cars); garbage lot
  quarantined with **zero writes** and its bad cars on the review
  list, then a healthy re-crawl writes normally; dead lot retried
  4× with growing backoff while the next lot crawls fine; ambiguous
  prose cars (incl. a was/now price) land in `scraper_uncertain`
  with evidence instead of inventory; a $150k outlier is held while
  its lot-mates write; **platform transfer proven** — lot B on the
  same fake platform inherits lot A's learned order and never
  wastes a try on the dead strategy; slow strategy demoted by the
  speed learner; learned count band quarantines a swing; needs
  generate / persist / auto-resolve; heartbeat rows and digest
  contents verified.
- **Live page test**: the real mosescars.com used-inventory HTML
  (fetched 2026-10-26) fingerprints as **DealerOn**, and the ladder
  extracts its 12 listed cars (year/make/model/VIN/image; price
  arrives via VDP enrichment, exactly like production's own
  JSON-LD pass). This test caught and fixed a real gap: DealerOn
  carries VINs as schema.org `identifier` on ListItems, which the
  first ladder draft didn't read.
- **Live DB test**: `run_next` executed end-to-end against Phantom
  with the public key — heartbeat/playbook writes were denied by
  RLS and absorbed fail-open as designed; the digest printed.
- **Not proven**: a full Chromium-driven crawl from this VM — the
  sandbox's egress proxy refuses Chromium tunnels
  (`ERR_TUNNEL_CONNECTION_FAILED`) while curl works. Production's
  Chromium runs in GitHub Actions, where the current scraper
  already crawls this same site nightly; the browser leg of
  scraper_next is the same primitives, but *I* have not watched it
  run. Also unproven: `--resume` against a real interrupted run
  (logic is unit-shaped like the harness-proven paths, but no live
  drill), and playbook writes under the CI key (posture inferred
  from production's working writes, not directly observed).

## Recommendation

**Do not swap the nightly yet.** Promote in two steps:

1. Point one app-triggered **test sync** (or a dispatch-only
   workflow) at `scraper_next.py` and read its digest + the
   `scraper_run_log` rows. Confirm the playbook tables fill under
   the CI key.
2. If that digest is clean, swap the nightly workflow's script
   path to `scraper_next.py` for one week, comparing digests
   against inventory counts, before retiring `scraper.py`.

Known limitations: model names from JSON-LD take the first token
("Grand" for Grand Caravan) until VDP enrichment refines the row —
the same behavior as production's JSON-LD path; DOM-card strategy
covers common card class patterns only; platform signatures are
asset-host heuristics that will need tuning as new platforms are
met (which is itself a needs-report item when it happens).
