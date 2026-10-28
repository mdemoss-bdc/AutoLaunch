# scraper_next SHADOW run (step 2) — 20261028T043522Z-shadow

Mode: FULL pipeline incl. Chromium browser leg; inventory push replaced by a recorder (zero writes to scraped_inventory); no stale pass, no auto-post, no scrape_jobs writes. Target: Moses Auto Group (feeds from user_settings).

====================================================================
SCRAPER_NEXT DIGEST — run 20261028T043522Z-shadow
====================================================================
[Used              ] www.mosescars.com via dealeron / browser: 965 found, 946 written, 19 held, 19 uncertain (1090.68s) — ok
[Certified Pre-Owned] www.mosescars.com via dealeron / browser: 65 found, 65 written, 0 held, 0 uncertain (82.07s) — ok
[New               ] www.mosescars.com via dealeron / browser: 1317 found, 1312 written, 5 held, 5 uncertain (1503.11s) — ok

Platform coverage: dealeron ×3
Lots that did not complete cleanly: 0
Uncertain items sent to the review list (scraper_uncertain): 24
Runtime: 2678s for 2323 cars (52.0 cars/min).
Runtime trend: no prior scraper_next runs recorded yet — this run sets the baseline. (The current production scraper is not instrumented, so no honest baseline exists for it.)

What would make me faster:
  - Nothing evidenced this run.
---

## Comparison vs production (shadow step 2)

**Counts — scraper_next found vs production:**

| Feed | Found | Would write | Held | Prod total | Prod active |
|---|---|---|---|---|---|
| Used | 965 | 946 | 19 | 979 | 912 |
| Certified Pre-Owned | 65 | 65 | 0 | 71 | 66 |
| New | 1317 | 1312 | 5 | 1425 | 1322 |

VIN overlap vs production ACTIVE: both=2260 · only scraper_next=21 (fresh arrivals) · only production-active=40 · unique VINs found=2282 · prod rows=2475 (active 2300)

**Field agreement on 2237 overlapping active VINs:**

| Field | Agree | Disagree |
|---|---|---|
| price | 2174 (97.2%) | 63 |
| mileage | 2224 (99.4%) | 13 |
| photos_n | 2219 (99.2%) | 18 |
| stock_number | 2236 (100.0%) | 1 |
| year | 2237 (100.0%) | 0 |

**Mileage tripwire:** cars with mileage ≤ 10 while production holds > 100 for the same VIN: **0** (step 1 on the fallback leg: 2,237 — the browser leg + the 2026-10-28 parse fix + sanity gate should drive this to ~0.)

Mileage distribution (top 6): [(1000, 1312), (11, 9), (1, 6), (10, 5), (31786, 2), (30223, 2)]

**Spot checks (next vs prod):**

- 1FADP3KE3GL273598: price None vs 8161 · miles None vs 126842 · photos None vs 20 · stock None vs NTP1355A · loc None
- KL79MPS22MB078483: price 20428 vs 20428 · miles 31786 vs 31786 · photos 20 vs 20 · stock ZT7008A vs ZT7008A · loc Moses Used Supercenter
- WBY43EJ00RCR48753: price 111020 vs 111020 · miles 1000 vs 1000 · photos 20 vs 20 · stock WC40225 vs WC40225 · loc Moses BMW
- 5J6RS4H24VL002154: price 33758 vs 33758 · miles 1000 vs 1000 · photos 20 vs 20 · stock HT60622 vs HT60622 · loc Moses Honda
- 2T2BAMCA8PC024110: price 43295 vs 43295 · miles 50461 vs 50461 · photos 20 vs 20 · stock LT60484A vs LT60484A · loc Moses Used Supercenter

**Strategies (per feed):**

- Used: platform=dealeron (signature 'dealeron.com' in page source) · browser: 965 cars/794791ms · rate-limit hits=0 · attempts=1 · error=None
- Certified Pre-Owned: platform=dealeron (signature 'dealeron.com' in page source) · browser: 65 cars/53414ms · rate-limit hits=0 · attempts=1 · error=None
- New: platform=dealeron (signature 'dealeron.com' in page source) · browser: 1317 cars/1118207ms · rate-limit hits=0 · attempts=1 · error=None

**Anomaly counters:** stock_number = VIN-fallback on 162/2323 full rows · location_name values: {'Moses Factory Outlet - Teays Valley': 84, 'Moses Factory Outlet-Corridor G': 86, 'Moses Used Supercenter': 389, 'Moses Ford Lincoln': 369, 'Moses Toyota of Morgantown': 274, 'Moses Volkswagen': 89, 'Moses Cadillac of Charleston': 119, 'Moses Honda': 175, 'Moses BMW': 64, 'Moses GMC of Charleston': 116, 'Moses Chevrolet': 138, 'Moses Mitsubishi of Morgantown': 27, 'Moses Nissan St. Albans': 166, 'Moses Lexus': 104, 'Moses Toyota': 123} · rows with year/make/model unparsed: 0 · quarantines: 0

---

## Full uncertainty list (24 items)

- 19 × price far outside the lot's median ($31,802) — possible wrong-car or stale price
- 5 × price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 1FADP3KE3GL273598 — found '8161': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 1C4NJRFB9ED575746 — found '9475': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] KNAFX6A83E5181339 — found '10138': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] JF2SJAWC0HH518590 — found '10275': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 19XFB2F85DE220793 — found '10573': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 5NPDH4AE4DH226952 — found '10574': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] KM8J3CA29GU230762 — found '11327': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 5XYPG4A31JG384781 — found '11389': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] JN1CV6EKXDM900286 — found '11564': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 3FA6P0D95LR174042 — found '11574': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] JN8AY2NC4H9506955 — found '12561': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 3GNAXJEV1LL169517 — found '12563': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 1FT8W2BM8REE06606 — found '80571': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 1GKS2KKL1TR104927 — found '92190': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 5UX33EU07T9285712 — found '96450': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 2T3BF4DV9BW176273 — found '11574': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 1D8HN54169B500607 — found '8573': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 5UX23EU01T9450536 — found '82675': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] WBS43BA03TCV35046 — found '94384': price far outside the lot's median ($31,802) — possible wrong-car or stale price
- [price] 5YM13ET00T9369260 — found '141750': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 5YM13ET01T9385144 — found '142770': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 5YM13ET09T9405009 — found '142770': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 5UX33EM01V9542236 — found '128955': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 1GYS9GKL1VR130042 — found '130085': price far outside the lot's median ($50,389) — possible wrong-car or stale price

---
## Write-safety ledger

- scraped_inventory row count (ALL users): before=1000 after=1000 — the shadow recorder writes nothing; any delta belongs to production's own schedule, not this run.
- learning tables before: {'scraper_playbooks': 0, 'scraper_uncertain': 0, 'scraper_run_log': 1}
- learning tables after: {'scraper_playbooks': 4, 'scraper_uncertain': 24, 'scraper_run_log': 1}

