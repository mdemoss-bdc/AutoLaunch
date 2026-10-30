# scraper_next SHADOW run (step 2) — 20261030T144202Z-shadow

Mode: FULL pipeline incl. Chromium browser leg; inventory push replaced by a recorder (zero writes to scraped_inventory); no stale pass, no auto-post, no scrape_jobs writes. Target: Moses Auto Group (feeds from user_settings).

====================================================================
SCRAPER_NEXT DIGEST — run 20261030T144202Z-shadow
====================================================================
[Used              ] www.mosescars.com via dealeron / browser: 988 found, 963 written, 25 held, 26 uncertain (1133.79s) — ok
[Certified Pre-Owned] www.mosescars.com via dealeron / browser: 65 found, 0 written, 65 held, 2 uncertain (86.0s) — QUARANTINED: count swing: 65 cars vs learned norm ~983
[New               ] www.mosescars.com via dealeron / browser: 1318 found, 1313 written, 5 held, 5 uncertain (1531.15s) — ok

Platform coverage: dealeron ×3
Lots that did not complete cleanly: 1 — www.mosescars.com|Certified Pre-Owned
Uncertain items sent to the review list (scraper_uncertain): 33
Runtime: 2837s for 2276 cars (48.1 cars/min).
Runtime trend (previous finished runs, seconds): 2512, 2840, 2678

What would make me faster:
  - Nothing evidenced this run.
---

## Comparison vs production (shadow step 2)

**Counts — scraper_next found vs production:**

| Feed | Found | Would write | Held | Prod total | Prod active |
|---|---|---|---|---|---|
| Used | 988 | 963 | 25 | 1049 | 923 |
| Certified Pre-Owned | 65 | 0 | 65 | 73 | 65 |
| New | 1318 | 1313 | 5 | 1518 | 1318 |

VIN overlap vs production ACTIVE: both=2306 · only scraper_next=0 (fresh arrivals) · only production-active=0 · unique VINs found=2306 · prod rows=2640 (active 2306)

**Field agreement on 2276 overlapping active VINs:**

| Field | Agree | Disagree |
|---|---|---|
| price | 2262 (99.4%) | 14 |
| mileage | 2276 (100.0%) | 0 |
| photos_n | 2275 (100.0%) | 1 |
| stock_number | 2272 (99.8%) | 4 |
| year | 2276 (100.0%) | 0 |

**Mileage tripwire:** cars with mileage ≤ 10 while production holds > 100 for the same VIN: **0** (step 1 on the fallback leg: 2,237 — the browser leg + the 2026-10-28 parse fix + sanity gate should drive this to ~0.)

Mileage distribution (top 6): [(1000, 1313), (11, 9), (1, 6), (10, 5), (42588, 2), (106681, 1)]

**Spot checks (next vs prod):**

- 1FADP3KE3GL273598: price None vs 8161 · miles None vs 126851 · photos None vs 20 · stock None vs NTP1355A · loc None
- KL79MPS22MB078483: price 20428 vs 20428 · miles 31786 vs 31786 · photos 20 vs 20 · stock ZT7008A vs ZT7008A · loc Moses Used Supercenter
- WBY43EJ00RCR48753: price 111020 vs 111020 · miles 1000 vs 1000 · photos 20 vs 20 · stock WC40225 vs WC40225 · loc Moses BMW
- 5J6RS4H24VL002154: price 33758 vs 33758 · miles 1000 vs 1000 · photos 20 vs 20 · stock HT60622 vs HT60622 · loc Moses Honda
- 2T2BAMCA8PC024110: price 43295 vs 43295 · miles 50461 vs 50461 · photos 20 vs 20 · stock LT60484A vs LT60484A · loc Moses Used Supercenter

**Strategies (per feed):**

- Used: platform=dealeron (signature 'dealeron.com' in page source) · browser: 988 cars/821501ms · rate-limit hits=0 · attempts=1 · error=None
- Certified Pre-Owned: platform=dealeron (signature 'dealeron.com' in page source) · browser: 65 cars/58877ms · rate-limit hits=0 · attempts=1 · error=None
- New: platform=dealeron (signature 'dealeron.com' in page source) · browser: 1318 cars/1123717ms · rate-limit hits=0 · attempts=1 · error=None

**Anomaly counters:** stock_number = VIN-fallback on 153/2276 full rows · location_name values: {'Moses Factory Outlet - Teays Valley': 81, 'Moses Factory Outlet-Corridor G': 86, 'Moses Ford Lincoln': 351, 'Moses Toyota of Morgantown': 269, 'Moses Used Supercenter': 381, 'Moses Volkswagen': 87, 'Moses Cadillac of Charleston': 117, 'Moses Honda': 167, 'Moses BMW': 64, 'Moses GMC of Charleston': 118, 'Moses Chevrolet': 145, 'Moses Mitsubishi of Morgantown': 28, 'Moses Lexus': 104, 'Moses Nissan St. Albans': 165, 'Moses Toyota': 113} · rows with year/make/model unparsed: 0 · quarantines: 1

---

## Full uncertainty list (35 items)

- 25 × price far outside the lot's median ($31,531) — possible wrong-car or stale price
- 5 × price far outside the lot's median ($50,389) — possible wrong-car or stale price
- 4 × photo set far below this lot's norm (~20 per car)
- 1 × VIN year code says 2037, page says 2008
- [price] 1FADP3KE3GL273598 — found '8161': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1C4NJRFB9ED575746 — found '9475': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] KNAFX6A83E5181339 — found '9938': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] JF2SJAWC0HH518590 — found '10275': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 5XYPG4A31JG384781 — found '10363': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 19XFB2F85DE220793 — found '10573': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 5NPDH4AE4DH226952 — found '10574': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] KM8J3CA29GU230762 — found '11327': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] JN1CV6EKXDM900286 — found '11564': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 3FA6P0D95LR174042 — found '11574': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1C4RDJAGXHC710028 — found '12458': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 3GNAXJEV1LL169517 — found '12475': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] JN8AY2NC4H9506955 — found '12561': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1GT4UXEY5SF208498 — found '79095': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1FT8W2BM8REE06606 — found '80571': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1GKS2KKL1TR104927 — found '92190': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 5UX33EU07T9285712 — found '96450': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 2T3BF4DV9BW176273 — found '11574': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] ZACCJABB2JPJ39537 — found '12457': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1G1PC5SH2C7384955 — found '9998': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 5YFEPMAE2MP175560 — found '9998': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [year] JM1NC25F780138569 — found '2008': VIN year code says 2037, page says 2008
- [price] 5UX23EU01T9450536 — found '82675': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 5UX23EM07R9W02666 — found '90770': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1N4AA5AP6BC816129 — found '9998': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [price] 1HGCY1F43TA004369 — found '9998': price far outside the lot's median ($31,531) — possible wrong-car or stale price
- [photos] JTEAAAAH7PJ140557 — found '1': photo set far below this lot's norm (~20 per car)
- [photos] JTNABAAE4SA016743 — found '1': photo set far below this lot's norm (~20 per car)
- [photos] JTEAAAAH7PJ140557 — found '1': photo set far below this lot's norm (~20 per car)
- [photos] JTNABAAE4SA016743 — found '1': photo set far below this lot's norm (~20 per car)
- [price] 5YM13ET00T9369260 — found '141750': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 5YM13ET01T9385144 — found '142770': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 5YM13ET09T9405009 — found '142770': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 1GYS9GKL1VR130042 — found '130085': price far outside the lot's median ($50,389) — possible wrong-car or stale price
- [price] 1GYS9GKL5VR158409 — found '126865': price far outside the lot's median ($50,389) — possible wrong-car or stale price

---
## Write-safety ledger

- scraped_inventory row count (ALL users): before=1000 after=1000 — the shadow recorder writes nothing; any delta belongs to production's own schedule, not this run.
- learning tables before: {'scraper_playbooks': 4, 'scraper_uncertain': 2165, 'scraper_run_log': 10}
- learning tables after: {'scraper_playbooks': 4, 'scraper_uncertain': 2200, 'scraper_run_log': 10}

