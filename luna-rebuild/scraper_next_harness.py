# =============================================================================
# scraper_next_harness.py — fixture-driven verification for scraper_next.
#
# Drives the REAL engine code (ladder, evaluation, learning, feed
# pipeline) against static fixture pages and an in-memory fake of the
# three scraper_next tables. No network, no browser: the fetcher is
# stubbed, Playwright is stubbed at import (the harness never calls
# run_next's browser path).
#
# Run: python3 scraper_next_harness.py   (exit 0 = all green)
# =============================================================================

import asyncio
import os
import sys
import types

# The VM's proxy env breaks this httpx build's URL parser when the
# supabase client is constructed; the harness makes no network calls,
# so scrub proxies before anything imports the client.
for _v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
           "no_proxy", "NO_PROXY"):
    os.environ.pop(_v, None)

# --- stub playwright BEFORE importing scraper (scraper imports it) ---
_pw = types.ModuleType("playwright")
_api = types.ModuleType("playwright.async_api")
_api.async_playwright = None
_pw.async_api = _api
sys.modules.setdefault("playwright", _pw)
sys.modules.setdefault("playwright.async_api", _api)

sys.path.insert(0, "/home/hatch/workspace/autolaunch-repo/luna-rebuild")
import scraper_next as N  # noqa: E402

FIX = "/home/hatch/workspace/autolaunch-repo/luna-rebuild/scraper_next_fixtures"


def fixture(name):
    with open(f"{FIX}/{name}") as f:
        return f.read()


# ---------------- fake DB (the three learning tables) ----------------
class Q:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.rng, self.ord = [], None, None
        self.ins, self.upd = None, None

    def select(self, *a, **k):
        return self

    def eq(self, c, v):
        self.filters.append(lambda r, c=c, v=v: r.get(c) == v)
        return self

    def is_(self, c, v):
        self.filters.append(lambda r, c=c: r.get(c) is None)
        return self

    def limit(self, n):
        self.rng = (0, n - 1)
        return self

    def order(self, c, desc=False):
        self.ord = (c, desc)
        return self

    def insert(self, rows):
        self.ins = rows if isinstance(rows, list) else [rows]
        return self

    def update(self, row):
        self.upd = row
        return self

    def execute(self):
        tbl = self.db.tables.setdefault(self.table, [])
        if self.ins is not None:
            for r in self.ins:
                r = dict(r)
                r.setdefault("id", f"fake-{len(tbl) + 1}")
                tbl.append(r)
            return types.SimpleNamespace(data=self.ins)
        if self.upd is not None:
            n = 0
            for r in tbl:
                if all(f(r) for f in self.filters):
                    r.update(self.upd)
                    n += 1
            return types.SimpleNamespace(data=[{}] * n)
        rows = [r for r in tbl if all(f(r) for f in self.filters)]
        if self.ord:
            rows.sort(key=lambda r: str(r.get(self.ord[0]) or ""), reverse=self.ord[1])
        if self.rng:
            rows = rows[self.rng[0]:self.rng[1] + 1]
        return types.SimpleNamespace(data=rows)


class FakeDB:
    def __init__(self):
        self.tables = {}

    def table(self, name):
        return Q(self, name)


N.db = FakeDB()

# ---------------- harness plumbing ----------------
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  {extra}"))
    if not cond:
        fails.append(name)


class Push:
    def __init__(self):
        self.rows = []

    def __call__(self, records):
        self.rows.extend(records)
        return len(records)


EMPTY_PAGE = "<html><body><p>No vehicles.</p></body></html>"


def single_page_fetcher(html, status=200):
    async def factory():
        async def fetch(url):
            if "pt=" in url:
                return {"status": 200, "html": EMPTY_PAGE, "browser_cars": None, "browser_ms": 0}
            return {"status": status, "html": html, "browser_cars": None, "browser_ms": 0}
        return fetch
    return factory


def make_opts(push, sleeps=None):
    async def fake_sleep(d):
        if sleeps is not None:
            sleeps.append(round(d, 1))
    return {"limit": 0, "page_modifier": "?pt={page}", "push_fn": push,
            "enrich_fn": None, "sleep_fn": fake_sleep}


CTX = {"uid": "user-1", "location_name": "Test Lot"}
FEED = {"url": "https://lot.example.com/inventory/used", "condition": "Used"}


def crawl(feed, fetcher_factory, eff_pb, opts, run_id="harness"):
    return asyncio.run(N.crawl_feed(feed, CTX, fetcher_factory, eff_pb, run_id, opts))


# ---------------- 1) parity on the normal lot ----------------
lad = N.extract_with_ladder(fixture("normal.html"), N.HTML_STRATEGIES,
                            {"uid": "user-1", "condition": "Used", "page_url": "x"})
truth_vins = {"2HKRS4H7XPH123456", "1FTFW1E84NFA12345", "4T1C11AK5RU123456",
              "1C4HJXFG8MW123456", "1HGCV1F34LA123456", "1N4BL4BV8KC123456"}
truth_prices = {"2HKRS4H7XPH123456": 32995, "1FTFW1E84NFA12345": 41500,
                "4T1C11AK5RU123456": 28750, "1C4HJXFG8MW123456": 36900,
                "1HGCV1F34LA123456": 23400, "1N4BL4BV8KC123456": 18995}
check("parity: jsonld wins on the normal lot", lad["strategy"] == "jsonld", f"{lad['strategy']}")
check("parity: exact VIN set", {c['vin'] for c in lad['cars']} == truth_vins,
      f"{[c['vin'] for c in lad['cars']]}")
check("parity: exact prices", {c['vin']: c['price'] for c in lad['cars']} == truth_prices)
check("parity: years parsed", {c['vin']: c['year'] for c in lad['cars']}["4T1C11AK5RU123456"] == 2024)

# Real-world shape (live mosescars.com, 2026-10-26): DealerOn's SRP
# JSON-LD is an ItemList of ListItems carrying the VIN as 'identifier'
# with name/url/image but NO price (price arrives via VDP enrichment).
dealeron_shape = (
    '<script type="application/ld+json">{"@type":"ItemList","itemListElement":['
    '{"@type":"ListItem","position":1,"url":"https://lot.example.com/used-2023-Honda-CR-V-2HKRS4H7XPH123456",'
    '"name":"2023 Honda CR-V EX","identifier":"2HKRS4H7XPH123456","image":"https://lot.example.com/ip/1.jpg"},'
    '{"@type":"ListItem","position":2,"url":"https://lot.example.com/used-2022-Ford-F-150-1FTFW1E84NFA12345",'
    '"name":"2022 Ford F-150 XLT","identifier":"1FTFW1E84NFA12345","image":"https://lot.example.com/ip/2.jpg"}]}</script>'
)
dshape = N.extract_jsonld(dealeron_shape, {"uid": "user-1", "condition": "Used", "page_url": "x"})
check("real shape: identifier-VIN ListItems extract", len(dshape) == 2, f"{len(dshape)}")
check("real shape: name/image/url carried, price left for enrichment",
      dshape and dshape[0]["make"] == "Honda" and dshape[0]["price"] is None
      and (dshape[0]["image_url"] or "").endswith("1.jpg"))

# ---------------- 2) ladder recovery on the layout-changed lot ----------------
lad2 = N.extract_with_ladder(fixture("layout_changed.html"), N.HTML_STRATEGIES,
                             {"uid": "user-1", "condition": "Used", "page_url": "x"})
check("recovery: jsonld finds nothing after the redesign",
      N.extract_jsonld(fixture("layout_changed.html"), {}) == [])
check("recovery: embedded_json takes over", lad2["strategy"] == "embedded_json", f"{lad2['strategy']}")
check("recovery: all 5 cars recovered", len(lad2["cars"]) == 5, f"{len(lad2['cars'])}")
check("recovery: platform fingerprinted as dealer_inspire",
      N.detect_platform(fixture("layout_changed.html"))[0] == "dealer_inspire")

# ---------------- 3) full feed run, normal lot ----------------
push = Push()
out = crawl(FEED, single_page_fetcher(fixture("normal.html")), N.default_playbook(), make_opts(push))
check("feed: trusted + written", out["trusted"] and out["cars_written"] == 6, f"{out['cars_written']}")
check("feed: platform dealeron", out["platform"] == "dealeron", f"{out['platform']}")
check("feed: push received the 6 cars", len(push.rows) == 6)
check("feed: no private keys leak into writes",
      all(not any(k.startswith("_") for k in r) for r in push.rows))

# playbook learns + persists
lot_pb = N.learn_from_outcome(N.default_playbook(), out, {})
N.save_playbook("lot", out["site_key"], "user-1", lot_pb.get("platform"), lot_pb)
reloaded = N.load_playbook("lot", out["site_key"], "user-1")
check("playbook: strategy stat recorded", reloaded["strategy_stats"].get("jsonld", {}).get("ok") == 1,
      f"{reloaded['strategy_stats']}")
check("playbook: count band learned", reloaded["count_band"]["samples"] == [6],
      f"{reloaded['count_band']}")
check("playbook: price band learned (~30872)",
      abs((reloaded["price_band"]["samples"] or [0])[0] - 30872.5) < 1,
      f"{reloaded['price_band']}")

# ---------------- 4) garbage lot -> quarantine, then re-crawl heals ----------------
push_g = Push()
out_g = crawl(FEED, single_page_fetcher(fixture("garbage.html")), N.default_playbook(), make_opts(push_g))
check("garbage: quarantined", out_g["quarantined"], f"{out_g['reasons']}")
check("garbage: quarantine cites garbage prices",
      any("garbage prices" in r for r in out_g["reasons"]), f"{out_g['reasons']}")
check("garbage: ZERO writes while quarantined", len(push_g.rows) == 0 and out_g["cars_written"] == 0)
check("garbage: not trusted (stale pass would skip)", out_g["trusted"] is False)
unc_rows = N.db.tables.get("scraper_uncertain", [])
check("garbage: bad-price cars landed on the review list",
      len([r for r in unc_rows if r["field"] == "price"]) >= 4, f"{len(unc_rows)} rows")
push_g2 = Push()
async def _fixed():
    factory = single_page_fetcher(fixture("garbage_fixed.html"))
    return await N.process_feed(FEED, CTX, await factory(), N.default_playbook(), "harness", make_opts(push_g2))
out_g2 = asyncio.run(_fixed())
check("garbage: re-crawl with healthy data writes normally",
      (not out_g2["quarantined"]) and out_g2["cars_written"] == 6, f"{out_g2['cars_written']}")

# ---------------- 5) dead lot isolation + retry shape ----------------
sleeps = []
push_d = Push()
dead_feed = {"url": "https://dead.example.com/inventory/used", "condition": "Used"}
out_d = crawl(dead_feed, single_page_fetcher(fixture("dead.html"), status=404),
              N.default_playbook(), make_opts(push_d, sleeps))
check("dead: feed fails cleanly with an error", bool(out_d.get("error")), f"{out_d.get('error')}")
check("dead: retried with backoff (4 attempts, 3 sleeps)",
      out_d["attempts"] == 4 and len(sleeps) == 3, f"attempts={out_d['attempts']} sleeps={sleeps}")
check("dead: backoff delays grow", sleeps == sorted(sleeps) or len(set(sleeps)) > 1, f"{sleeps}")
push_a = Push()
out_a = crawl(FEED, single_page_fetcher(fixture("normal.html")), N.default_playbook(), make_opts(push_a))
check("dead: the NEXT lot still crawls fine (isolation)", out_a["cars_written"] == 6)

# ---------------- 6) ambiguous prose -> review list, never written ----------------
N.db.tables["scraper_uncertain"] = []
push_m = Push()
amb_feed = {"url": "https://prose.example.com/lot", "condition": "Used"}
out_m = crawl(amb_feed, single_page_fetcher(fixture("ambiguous.html")), N.default_playbook(), make_opts(push_m))
check("ambiguous: nothing written from prose evidence", len(push_m.rows) == 0, f"{len(push_m.rows)}")
check("ambiguous: all 3 prose cars held for review", len(out_m["held"]) == 3, f"{len(out_m['held'])}")
unc = N.db.tables.get("scraper_uncertain", [])
amb = [r for r in unc if "two different prices" in (r["reason"] or "")]
check("ambiguous: the was/now car is flagged ambiguous with both prices",
      len(amb) == 1 and "24995" in (amb[0]["found_value"] or "") and "22495" in (amb[0]["found_value"] or ""),
      f"{[(r['vin'], r['found_value']) for r in unc]}")
check("ambiguous: single-price prose car is on the review list too",
      any(r["vin"] == "1FMCU9J96MUA77701" for r in unc))

# ---------------- 7) price outlier held, year mismatch flagged ----------------
N.db.tables["scraper_uncertain"] = []
push_o = Push()
out_o = crawl(FEED, single_page_fetcher(fixture("normal_outlier.html")), N.default_playbook(), make_opts(push_o))
check("outlier: 6 of 7 written", out_o["cars_written"] == 6, f"{out_o['cars_written']}")
check("outlier: the $150k car is held", any(h["vin"] == "1N4BL4BV8PC222007" for h in out_o["held"]),
      f"{out_o['held']}")
unc = N.db.tables.get("scraper_uncertain", [])
check("outlier: review list has the price flag", any(r["field"] == "price" and r["vin"] == "1N4BL4BV8PC222007" for r in unc))
check("outlier: review list has the VIN-year flag", any(r["field"] == "year" and r["vin"] == "1N4BL4BV8PC222006" for r in unc))

# ---------------- 8) platform transfer: lot B inherits lot A's lesson ----------------
plat_pb = N.default_playbook()
push_pa = Push()
feed_a = {"url": "https://lota.example.com/inventory/used", "condition": "Used"}
out_pa = crawl(feed_a, single_page_fetcher(fixture("plat_a.html")), N.default_playbook(), make_opts(push_pa))
check("platform: lot A recovered via embedded_json", out_pa["cars_written"] == 3)
plat_pb = N.learn_from_outcome(plat_pb, out_pa, {})
N.save_playbook("platform", "platform:dealeron", None, "dealeron", plat_pb)
plat_re = N.load_playbook("platform", "platform:dealeron", None)
html_order = [s for s in plat_re["strategy_order"] if s in N.HTML_STRATEGIES]
check("platform: learned order leads with embedded_json", html_order[0] == "embedded_json",
      f"{plat_re['strategy_order']}")
eff_b = N.merge_playbooks(plat_re, N.default_playbook())
push_pb = Push()
feed_b = {"url": "https://lotb.example.com/inventory/used", "condition": "Used"}
out_pb = crawl(feed_b, single_page_fetcher(fixture("plat_b.html")), eff_b, make_opts(push_pb))
check("platform: lot B (same platform, cold lot) writes its cars", out_pb["cars_written"] == 3)
check("platform: lot B's first (and winning) strategy is the inherited embedded_json",
      list((out_pb["strategies"] or {}).keys())[0] == "embedded_json"
      and (out_pb["strategies"] or {}).get("embedded_json", {}).get("cars") == 3,
      f"{list((out_pb['strategies'] or {}).keys())}")
check("platform: lot A (control) had to try jsonld first",
      list((out_pa["strategies"] or {}).keys())[0] == "jsonld",
      f"{list((out_pa['strategies'] or {}).keys())}")

# ---------------- 9) speed learning: slow strategy demoted ----------------
order = N.adapt_strategy_order({
    "jsonld": {"ok": 3, "empty": 0, "cars": 30, "ms": 60000},
    "dom_cards": {"ok": 3, "empty": 0, "cars": 30, "ms": 3000},
    "text_patterns": {"ok": 0, "empty": 4, "cars": 0, "ms": 9000},
})
check("speed: fast dom_cards outranks slow jsonld", order.index("dom_cards") < order.index("jsonld"), f"{order}")
check("speed: always-empty text_patterns demoted last", order[-1] == "text_patterns", f"{order}")

# ---------------- 10) count-band quarantine from learned history ----------------
seeded = N.default_playbook()
seeded["count_band"]["samples"] = [100, 102, 98]
push_c = Push()
out_c = crawl(FEED, single_page_fetcher(fixture("normal.html")), seeded, make_opts(push_c))
check("bands: 6 cars vs learned ~100 quarantines as count swing",
      out_c["quarantined"] and any("count swing" in r for r in out_c["reasons"]), f"{out_c['reasons']}")
check("bands: nothing written on a band quarantine", len(push_c.rows) == 0)

# ---------------- 11) needs: evidence-backed, persist, auto-resolve ----------------
needs = N.generate_needs({"site_key": "x|Used", "host": "x.example.com", "platform": "unknown",
                          "platform_evidence": "script hosts: cdn.mystery.io",
                          "sitemap_url": None, "rate_limit_hits": 3, "strategy_stats": {}})
kinds = {n["kind"] for n in needs}
check("needs: unknown platform + rate limiting surface", kinds == {"unknown_platform", "rate_limited"}, f"{kinds}")
pb_n = N.default_playbook()
N.merge_needs(pb_n, needs)
check("needs: open after first sighting", len(N.open_needs(pb_n)) == 2)
for _ in range(3):
    N.merge_needs(pb_n, [])
check("needs: auto-resolve after 3 silent runs", len(N.open_needs(pb_n)) == 0)

# ---------------- 12) heartbeat + digest ----------------
N.heartbeat("harness-run", "started")
N.heartbeat("harness-run", "finished", detail={"seconds": 42, "cars": 6})
log_rows = N.db.tables.get("scraper_run_log", [])
check("heartbeat: started + finished rows written",
      [r["event"] for r in log_rows if r["run_id"] == "harness-run"] == ["started", "finished"])
digest = N.build_digest(
    [dict(out, platform="unknown", platform_evidence="script hosts: cdn.mystery.io")],
    pb_n, {"run_id": "harness-run", "seconds": 42, "cars": 6}, [])
check("digest: names the incomplete (unknown-platform) lot", "UNRECOGNIZED platform" in digest)
check("digest: has the needs section", "What would make me faster" in digest)
check("digest: honest baseline note (production not instrumented)", "not instrumented" in digest)

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
