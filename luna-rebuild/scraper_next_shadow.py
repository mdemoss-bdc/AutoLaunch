"""SHADOW supervisor driver for scraper_next — step 2 of the promotion
plan (Matthew approved 2026-10-28; step 1 = the supervised local
shadow run of 2026-10-28, digest in goals/autolaunch-rebuild/
hidden_files/scraper-next-test-2026-10-28.md).

WHAT THIS IS
------------
A week of daily shadow runs in GitHub Actions (workflow:
.github/workflows/scraper-next-shadow.yml) so scraper_next's FULL
pipeline — including the Chromium browser leg, which cannot run from
Luna's VM — is compared against production at real scale, with the
2026-10-28 mileage fixes in place, BEFORE any promotion decision.

SHADOW CONTRACT (hard rules, enforced in this file)
---------------------------------------------------
* Refuses to run unless SCRAPER_NEXT_SHADOW=1 is set.
* NEVER calls run_next(), mark_stale_inventory(), _auto_post_filtered()
  or push_batch_to_supabase(). Inventory writes are replaced by a
  recorder: production scraped_inventory is unreachable by
  construction, not by luck.
* The ONLY database writes it can make are through scraper_next's own
  learning-layer helpers (scraper_playbooks, scraper_uncertain,
  scraper_run_log) under whatever key the environment provides —
  proving whether those tables fill under the CI key is one of
  step 2's explicit questions.
* Feeds come from the target user's user_settings rows — literally
  the same feeds production crawls.

OUTPUT (into $SHADOW_OUT, default ./shadow-out)
-----------------------------------------------
digest.md (step-1 format: scraper_next's own build_digest + the
production-comparison sections), cars.json, uncertain.json,
outcomes.json, run_id.txt. The workflow uploads these as an artifact
and commits digest.md + JSONs to luna-rebuild/shadow-reports/<run_id>/.
"""
import os

os.environ["no_proxy"] = "localhost,127.0.0.1"   # VM httpx/no_proxy quirk
os.environ["NO_PROXY"] = "localhost,127.0.0.1"

import asyncio
import collections
import json
import sys
import time

if os.environ.get("SCRAPER_NEXT_SHADOW") != "1":
    print("[!] REFUSING TO RUN: this is the SHADOW driver. "
          "Set SCRAPER_NEXT_SHADOW=1 to acknowledge shadow mode "
          "(recorder push, no stale pass, no auto-post).")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scraper as S          # production primitives (unmodified)
import scraper_next as N     # the script under test (unmodified by this driver)

db = S.db
OUT = os.environ.get("SHADOW_OUT") or os.path.join(os.getcwd(), "shadow-out")
TARGET_UID = (os.environ.get("USER_ID") or "40a95557-504a-460f-a891-462bb2b4f25c").strip()

# ---------------------------------------------------------------- capture
uncertain_rows = []          # full scraper_uncertain payload rows, local copy
_orig_log_uncertain = N.log_uncertain


def capturing_log_uncertain(run_id, user_id, site_key, rows):
    for r in rows:
        uncertain_rows.append({"run_id": run_id, "user_id": user_id,
                               "site_key": site_key, **r})
    return _orig_log_uncertain(run_id, user_id, site_key, rows)


N.log_uncertain = capturing_log_uncertain

pushed = {}                  # site_key -> list of rows the pipeline WOULD write


def recording_push(rows):
    pushed.setdefault(recording_push.current_key, []).extend(
        [dict(r) for r in rows])
    return len(rows)


# ------------------------------------------------------- production reads
def load_user_feeds(uid):
    """(store_name, feeds, page_modifier) from user_settings — the same
    source run_next/production use."""
    res = db.table("user_settings").select("*").eq("user_id", uid).execute()
    rows = res.data or []
    if not rows:
        raise RuntimeError(f"no user_settings row for {uid}")
    cfg = rows[0]
    store = cfg.get("dealership_name") or cfg.get("store_name") or "User Store"
    feeds = []
    for key, cond in (("used_url", "Used"),
                      ("certified_url", "Certified Pre-Owned"),
                      ("new_url", "New")):
        u = (cfg.get(key) or "").strip()
        if u:
            feeds.append({"url": u, "condition": cond})
    return store, feeds, (cfg.get("page_modifier") or "?pt={page}")


def load_production_rows(uid):
    """All scraped_inventory rows for the user (paginated — the
    PostgREST 1,000-row cap must never silently truncate this)."""
    rows, start = [], 0
    while True:
        chunk = (db.table("scraped_inventory")
                 .select("vin,condition,price,mileage,stock_number,year,is_active,photos")
                 .eq("user_id", uid)
                 .range(start, start + 999)
                 .execute()).data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            return rows
        start += 1000


def table_count(name):
    """Exact row count. PostgREST count responses can silently cap at
    the server row limit — the 2026-10-28 proof run's ledger read
    '1000' for a 2,898-row scraped_inventory — so page through ids
    when the table has one; fall back to count='exact' otherwise."""
    try:
        total, start = 0, 0
        while True:
            chunk = (db.table(name).select("id")
                     .range(start, start + 999).execute()).data or []
            total += len(chunk)
            if len(chunk) < 1000:
                return total
            start += 1000
    except Exception:
        pass
    try:
        return (db.table(name).select("id", count="exact").limit(1).execute()).count
    except Exception:
        try:
            return len((db.table(name).select("*").limit(5000).execute()).data or [])
        except Exception:
            return None


# ---------------------------------------------------------------- digest
def comparison_section(outcomes, prod_rows, all_cars):
    L = []
    L.append("\n---\n")
    L.append("## Comparison vs production (shadow step 2)\n")
    prod_by_vin = {r["vin"]: r for r in prod_rows if r.get("vin")}
    prod_active = {v: r for v, r in prod_by_vin.items() if r.get("is_active")}
    L.append("**Counts — scraper_next found vs production:**\n")
    L.append("| Feed | Found | Would write | Held | Prod total | Prod active |")
    L.append("|---|---|---|---|---|---|")
    for o in outcomes:
        cond = o["condition"]
        p_all = sum(1 for r in prod_rows if r["condition"] == cond)
        p_act = sum(1 for r in prod_rows if r["condition"] == cond and r["is_active"])
        L.append(f"| {cond} | {o['cars_found']} | {o['cars_written']} | "
                 f"{len(o.get('held') or [])} | {p_all} | {p_act} |")
    next_by_vin = {}
    for c in all_cars:
        if c.get("vin"):
            next_by_vin.setdefault(c["vin"], c)
    both = set(next_by_vin) & set(prod_active)
    only_next = set(next_by_vin) - set(prod_by_vin)
    only_prod = set(prod_active) - set(next_by_vin)
    L.append(f"\nVIN overlap vs production ACTIVE: both={len(both)} · "
             f"only scraper_next={len(only_next)} (fresh arrivals) · "
             f"only production-active={len(only_prod)} · "
             f"unique VINs found={len(next_by_vin)} · prod rows={len(prod_rows)} "
             f"(active {len(prod_active)})\n")

    full_both = [v for v in both if next_by_vin[v].get("held_why") is None]
    agree, disagree = collections.Counter(), collections.Counter()
    miles_bad = 0
    for v in full_both:
        n, p = next_by_vin[v], prod_active[v]
        pv = dict(p)
        pv["photos_n"] = len(p.get("photos") or [])
        for f in ("price", "mileage", "photos_n", "stock_number", "year"):
            (agree if n.get(f) == pv.get(f) else disagree)[f] += 1
        if n.get("mileage") is not None and n["mileage"] <= 10 and (p.get("mileage") or 0) > 100:
            miles_bad += 1
    L.append(f"**Field agreement on {len(full_both)} overlapping active VINs:**\n")
    L.append("| Field | Agree | Disagree |")
    L.append("|---|---|---|")
    for f in ("price", "mileage", "photos_n", "stock_number", "year"):
        tot = agree[f] + disagree[f]
        pct = f" ({agree[f] / tot * 100:.1f}%)" if tot else ""
        L.append(f"| {f} | {agree[f]}{pct} | {disagree[f]} |")
    L.append(f"\n**Mileage tripwire:** cars with mileage ≤ 10 while production "
             f"holds > 100 for the same VIN: **{miles_bad}** "
             f"(step 1 on the fallback leg: 2,237 — the browser leg + the "
             f"2026-10-28 parse fix + sanity gate should drive this to ~0.)")
    dist = collections.Counter(c.get("mileage") for c in all_cars
                               if c.get("held_why") is None)
    L.append(f"\nMileage distribution (top 6): {dist.most_common(6)}")

    L.append("\n**Spot checks (next vs prod):**\n")
    picks = ["1FADP3KE3GL273598", "KL79MPS22MB078483", "WBY43EJ00RCR48753",
             "5J6RS4H24VL002154", "2T2BAMCA8PC024110"]
    shown = 0
    for v in picks:
        if v in next_by_vin and v in prod_active:
            n, p = next_by_vin[v], prod_active[v]
            L.append(f"- {v}: price {n.get('price')} vs {p.get('price')} · "
                     f"miles {n.get('mileage')} vs {p.get('mileage')} · "
                     f"photos {n.get('photos_n')} vs {len(p.get('photos') or [])} · "
                     f"stock {n.get('stock_number')} vs {p.get('stock_number')} · "
                     f"loc {n.get('location_name')}")
            shown += 1
    if not shown:
        L.append("- (step-1 spot-check VINs no longer on the lot)")

    L.append("\n**Strategies (per feed):**\n")
    for o in outcomes:
        strat = ", ".join(f"{k}: {v['cars']} cars/{v['ms']}ms"
                          for k, v in (o.get("strategies") or {}).items()) or "none"
        L.append(f"- {o['condition']}: platform={o.get('platform')} "
                 f"({o.get('platform_evidence')}) · {strat} · "
                 f"rate-limit hits={o.get('rate_limit_hits')} · "
                 f"attempts={o.get('attempts')} · error={o.get('error')}")
    fb = sum(1 for c in all_cars if c.get("held_why") is None and c.get("vin")
             and c.get("stock_number") == c["vin"][-8:])
    full_n = sum(1 for c in all_cars if c.get("held_why") is None)
    locs = collections.Counter(c.get("location_name") for c in all_cars
                               if c.get("held_why") is None)
    unparsed = sum(1 for c in all_cars if c.get("held_why") is None
                   and not c.get("year"))
    L.append(f"\n**Anomaly counters:** stock_number = VIN-fallback on {fb}/{full_n} "
             f"full rows · location_name values: {dict(locs)} · "
             f"rows with year/make/model unparsed: {unparsed} · "
             f"quarantines: {sum(1 for o in outcomes if o.get('quarantined'))}")
    return "\n".join(L) + "\n"


def uncertainty_section():
    L = ["\n---\n", f"## Full uncertainty list ({len(uncertain_rows)} items)\n"]
    if not uncertain_rows:
        L.append("None — the run raised no uncertainties.")
    by_reason = collections.Counter(r["reason"] for r in uncertain_rows)
    for r, n in by_reason.most_common():
        L.append(f"- {n} × {r}")
    for r in uncertain_rows:
        L.append(f"- [{r.get('field')}] {r.get('vin')} — found {r.get('found_value')!r}: "
                 f"{r.get('reason')}")
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------- main
async def main():
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-shadow"
    os.makedirs(OUT, exist_ok=True)
    print(f"[*] SCRAPER_NEXT SHADOW RUN {run_id} — push=recorder, "
          f"no stale pass, no auto-post, no scrape_jobs writes")
    N.heartbeat(run_id, "started", TARGET_UID, None, {"shadow": True, "step": 2})

    store, feeds, page_modifier = load_user_feeds(TARGET_UID)
    print(f"[*] {store}: {len(feeds)} feed(s) from user_settings")
    inv_before = table_count("scraped_inventory")
    learn_before = {t: table_count(t) for t in
                    ("scraper_playbooks", "scraper_uncertain", "scraper_run_log")}

    from playwright.async_api import async_playwright
    outcomes, learned = [], {}
    needs_union = N.default_playbook()
    t_all = time.monotonic()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=[
            "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080})
        page = await context.new_page()

        async def enrich(cars):
            await S.enrich_cars_with_vdp(context, cars)

        for feed in feeds:
            sk = N.site_key_for(feed["url"], feed["condition"])
            recording_push.current_key = sk
            lot_pb = N.load_playbook("lot", sk, TARGET_UID)
            plat_pb = (N.load_playbook("platform", f"platform:{lot_pb.get('platform')}", None)
                       if lot_pb.get("platform") else N.default_playbook())
            eff_pb = N.merge_playbooks(plat_pb, lot_pb)
            opts = {"limit": 0, "page_modifier": page_modifier,
                    "push_fn": recording_push, "enrich_fn": enrich}
            ctx_base = {"uid": TARGET_UID, "location_name": store}

            async def make_fetcher(feed=feed, cond=feed["condition"]):
                async def fetch(url):
                    resp = await page.goto(url, wait_until="commit", timeout=30000)
                    status = resp.status if resp else None
                    if status is None:
                        raise N.FeedDead(f"no response: {url}")
                    await asyncio.sleep(2)
                    browser_cars, browser_ms = None, 0
                    t0 = time.monotonic()
                    try:
                        browser_cars = await S.extract_cards_from_page(
                            page, default_condition=cond, active_uid=TARGET_UID)
                    except Exception:
                        browser_cars = None
                    browser_ms = int((time.monotonic() - t0) * 1000)
                    try:
                        html = await page.content()
                    except Exception:
                        html = ""
                    return {"status": status, "html": html,
                            "browser_cars": browser_cars, "browser_ms": browser_ms}
                return fetch

            print(f"[*] Crawling {feed['condition']}: {feed['url']}")
            outcome = await N.crawl_feed(feed, ctx_base, make_fetcher, eff_pb, run_id, opts)
            outcome["store"] = store

            if outcome.get("quarantined"):
                print(f"[*] Quarantined ({'; '.join(outcome['reasons'])}); re-crawling once…")
                recording_push.current_key = sk + "|recrawl"
                try:
                    second = await N.process_feed(feed, ctx_base, await make_fetcher(),
                                                  eff_pb, run_id, opts)
                    second["recrawl_of"] = True
                    second["store"] = store
                    if not second["quarantined"] and not second.get("error"):
                        outcome = second
                        print("[*] Re-crawl clean — using second outcome.")
                except Exception as e:
                    print(f"[!] Re-crawl error: {e}")

            outcomes.append(outcome)
            new_lot_pb = N.learn_from_outcome(lot_pb, outcome, {})
            N.save_playbook("lot", sk, TARGET_UID, new_lot_pb.get("platform"), new_lot_pb)
            if outcome.get("platform"):
                psk = f"platform:{outcome['platform']}"
                cur = N.load_playbook("platform", psk, None)
                new_plat_pb = N.learn_from_outcome(cur, outcome, {})
                N.save_playbook("platform", psk, None, outcome["platform"], new_plat_pb)
                learned[psk] = new_plat_pb
            learned[sk] = new_lot_pb
            needs_union["needs"] = (needs_union.get("needs") or []) + (new_lot_pb.get("needs") or [])
            print(f"[✓] {feed['condition']}: found={outcome['cars_found']} "
                  f"would_write={outcome['cars_written']} held={len(outcome.get('held') or [])} "
                  f"uncertain={outcome.get('uncertain_count')} quarantined={outcome['quarantined']} "
                  f"platform={outcome.get('platform')} ({outcome['seconds']}s)")

        await browser.close()

    totals = {"run_id": run_id, "seconds": round(time.monotonic() - t_all, 1),
              "cars": sum(o["cars_written"] for o in outcomes)}
    trend = N.recent_run_totals(5)
    digest = N.build_digest(outcomes, needs_union, totals, trend)
    digest = (f"# scraper_next SHADOW run (step 2) — {run_id}\n\n"
              f"Mode: FULL pipeline incl. Chromium browser leg; inventory push "
              f"replaced by a recorder (zero writes to scraped_inventory); no "
              f"stale pass, no auto-post, no scrape_jobs writes. Target: {store} "
              f"(feeds from user_settings).\n\n" + digest)

    def car_row(c, feed_cond, held_why=None):
        return {"vin": c.get("vin"), "condition": feed_cond,
                "year": c.get("year"), "make": c.get("make"), "model": c.get("model"),
                "trim": c.get("trim"), "price": c.get("price"),
                "price_status": c.get("price_status"), "mileage": c.get("mileage"),
                "photos_n": len(c.get("photos") or []),
                "stock_number": c.get("stock_number"),
                "location_name": c.get("location_name"),
                "color": c.get("color"), "body_type": c.get("body_type"),
                "detail_url": c.get("detail_url"), "held_why": held_why}

    all_cars = []
    for o, feed in zip(outcomes, feeds):
        sk = o["site_key"]
        rows = pushed.get(sk, []) + pushed.get(sk + "|recrawl", [])
        held_vins = {h["vin"]: h["why"] for h in (o.get("held") or [])}
        for r in rows:
            all_cars.append(car_row(r, feed["condition"]))
        for vin, why in held_vins.items():
            if not any(c["vin"] == vin for c in all_cars
                       if c["condition"] == feed["condition"]):
                all_cars.append({"vin": vin, "condition": feed["condition"],
                                 "held_why": why})

    try:
        prod_rows = load_production_rows(TARGET_UID)
        digest += comparison_section(outcomes, prod_rows, all_cars)
    except Exception as e:
        digest += f"\n---\n## Comparison vs production\n\nUNAVAILABLE: {e}\n"
    digest += uncertainty_section()

    inv_after = table_count("scraped_inventory")
    learn_after = {t: table_count(t) for t in
                   ("scraper_playbooks", "scraper_uncertain", "scraper_run_log")}
    digest += ("\n---\n## Write-safety ledger\n\n"
               f"- scraped_inventory row count (ALL users): before={inv_before} "
               f"after={inv_after} — the shadow recorder writes nothing; any "
               f"delta belongs to production's own schedule, not this run.\n"
               f"- learning tables before: {learn_before}\n"
               f"- learning tables after: {learn_after}\n")

    with open(os.path.join(OUT, "cars.json"), "w") as f:
        json.dump(all_cars, f, indent=1)
    with open(os.path.join(OUT, "uncertain.json"), "w") as f:
        json.dump(uncertain_rows, f, indent=1)
    with open(os.path.join(OUT, "learned_playbooks.json"), "w") as f:
        json.dump(learned, f, indent=1, default=str)
    serial = []
    for o in outcomes:
        oo = dict(o)
        oo["seen_vins"] = sorted(o.get("seen_vins") or [])
        serial.append(oo)
    with open(os.path.join(OUT, "outcomes.json"), "w") as f:
        json.dump(serial, f, indent=1, default=str)
    with open(os.path.join(OUT, "digest.md"), "w") as f:
        f.write(digest + "\n")
    with open(os.path.join(OUT, "run_id.txt"), "w") as f:
        f.write(run_id + "\n")

    N.heartbeat(run_id, "finished", TARGET_UID, None,
                {**totals, "shadow": True, "lots": len(outcomes)})
    print("\n" + digest)
    print(f"\n[*] Artifacts in {OUT}: digest.md, cars.json ({len(all_cars)}), "
          f"uncertain.json ({len(uncertain_rows)}), outcomes.json, run_id.txt")
    return 1 if outcomes and all(o.get("error") for o in outcomes) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
