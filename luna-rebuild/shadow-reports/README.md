# scraper_next shadow reports (step 2)

Daily shadow-run digests from the **AutoLaunch Scraper-Next SHADOW**
workflow (`.github/workflows/scraper-next-shadow.yml`), one folder
per run: `<run_id>/digest.md` plus `cars.json`, `uncertain.json`,
`outcomes.json`.

Shadow mode = scraper_next's full pipeline (incl. the Chromium
browser leg) with the inventory push replaced by a recorder: **zero
writes to `scraped_inventory`**, no stale pass, no auto-post, no
`scrape_jobs` writes. The only possible DB writes are scraper_next's
own learning tables (`scraper_playbooks`, `scraper_uncertain`,
`scraper_run_log`).

Window: daily 2026-10-29 → 2026-11-04 (7 scheduled runs), plus manual
dispatches. Driver: `luna-rebuild/scraper_next_shadow.py` (refuses to
run without `SCRAPER_NEXT_SHADOW=1`). Step-1 baseline digest:
`~/workspace/goals/autolaunch-rebuild/hidden_files/scraper-next-test-2026-10-28.md`
(local record). These digests are the evidence base for Matthew's
promotion decision — no promotion happens from this folder.
