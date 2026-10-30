# =============================================================================
# scraper_next_carfax_harness.py — fixture-driven verification for the
# CARFAX link capture trial in scraper_next (2026-10-29).
#
# Covers: the pure extractor against fixtures built from a REAL Moses
# VDP (2018 Honda Ridgeline, VIN 5FPYK2F54JB000797 — badge anchor
# captured verbatim from the served HTML), the async capture pass
# (scope, stats, uncertain rejects, no-find-never-writes), the digest
# section, the targeted column writer, and a process_feed end-to-end
# with a stubbed fetcher/push. No network, no browser.
#
# Run: python3 scraper_next_carfax_harness.py   (exit 0 = all green)
# =============================================================================

import asyncio
import os
import sys
import types

# Scrub the VM's proxy env before anything builds an httpx client
# (same discipline as scraper_next_harness.py); no network is used.
for _v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
           "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"):
    os.environ.pop(_v, None)

_pw = types.ModuleType("playwright")
_api = types.ModuleType("playwright.async_api")
_api.async_playwright = None
_pw.async_api = _api
sys.modules.setdefault("playwright", _pw)
sys.modules.setdefault("playwright.async_api", _api)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scraper_next as N  # noqa: E402

FIX = os.path.join(HERE, "scraper_next_fixtures")
RIDGELINE_VIN = "5FPYK2F54JB000797"
RIDGELINE_URL = "https://www.mosescars.com/used-Huntington-2018-Honda-Ridgeline-RTL-" + RIDGELINE_VIN
EXPECTED_CARFAX = ("https://www.carfax.com/vehiclehistory/ar20/"
                   "JxNsiVc0A7c3lzfeEgx1pcgWx2hdmSqcRh3xpEnEOsab5jXxS9XxOXrE"
                   "SDJHcUW_i11Y3LlKHKzCuktsJnO5KOkUSsqtUtJCITA")

FAILURES = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def fixture(name):
    with open(os.path.join(FIX, name)) as f:
        return f.read()


# ---------------------------------------------------------- extractor
real = fixture("carfax_vdp_real.html")
r = N.extract_carfax_url(real, RIDGELINE_VIN, RIDGELINE_URL)
check("real VDP: link captured", r["url"] == EXPECTED_CARFAX, str(r))
check("real VDP: form is direct", r["form"] == "direct")
check("real VDP: badge seen, no reject", r["badge_seen"] and r["reject"] is None)

r = N.extract_carfax_url(fixture("carfax_vdp_cross_sell_only.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("cross-sell badge only: NO link for host car", r["url"] is None, str(r))
check("cross-sell badge only: badge not attributed to host",
      r["badge_seen"] is False and r["reject"] is None)

r = N.extract_carfax_url(fixture("carfax_vdp_no_badge.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("no badge: clean no-find",
      r["url"] is None and r["badge_seen"] is False and r["form"] is None)

r = N.extract_carfax_url(fixture("carfax_vdp_wrong_vin.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("wrong-VIN report link: refused", r["url"] is None and bool(r["reject"]),
      str(r))
check("wrong-VIN refusal names the mismatch",
      r["reject"] and "1FTFW1E13JFD82930" in r["reject"], str(r))

r = N.extract_carfax_url(fixture("carfax_vdp_jsonly.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("JS-only badge: js_only form, no link, no reject",
      r["url"] is None and r["form"] == "js_only" and r["reject"] is None,
      str(r))

r = N.extract_carfax_url("", RIDGELINE_VIN, RIDGELINE_URL)
check("empty html: clean no-find", r["url"] is None and r["badge_seen"] is False)

# A URL that asserts THIS car's VIN in a vin= parameter is accepted.
r = N.extract_carfax_url(
    real.replace(EXPECTED_CARFAX,
                 "https://www.carfax.com/vehiclehistory/p/Report.cfx?vin=" + RIDGELINE_VIN),
    RIDGELINE_VIN, RIDGELINE_URL)
check("vin= URL naming this car: accepted",
      r["url"] is not None and r["url"].endswith(RIDGELINE_VIN), str(r))


# ------------------------------------------------------------- pass
class FakeResp:
    def __init__(self, html):
        self.status = 200
        self._html = html

    async def text(self):
        return self._html


class FakeRequest:
    def __init__(self, pages, fail=()):
        self.pages, self.fail, self.calls = pages, set(fail), []

    async def get(self, url, timeout=None):
        self.calls.append(url)
        if url in self.fail:
            raise RuntimeError("fetch boom")
        return FakeResp(self.pages[url])


class FakeContext:
    def __init__(self, pages, fail=()):
        self.request = FakeRequest(pages, fail)


async def run_pass():
    pages = {
        "http://x/real": fixture("carfax_vdp_real.html"),
        "http://x/none": fixture("carfax_vdp_no_badge.html"),
        "http://x/wrong": fixture("carfax_vdp_wrong_vin.html"),
    }
    ctx = FakeContext(pages, fail=("http://x/dead",))
    cars = [
        {"vin": RIDGELINE_VIN, "condition": "Used", "detail_url": "http://x/real"},
        {"vin": "1FTFW1E13JFD82930", "condition": "Used", "detail_url": "http://x/none"},
        {"vin": RIDGELINE_VIN, "condition": "Certified Pre-Owned", "detail_url": "http://x/wrong"},
        {"vin": "3FA6P0HD2LR000001", "condition": "New", "detail_url": "http://x/real"},
        {"vin": "3FA6P0HD2LR000002", "condition": "Used", "detail_url": None},
        {"vin": "3FA6P0HD2LR000003", "condition": "Used", "detail_url": "http://x/dead"},
    ]
    stats, unc = await N.carfax_enrich_pass(ctx, cars)
    return stats, unc, cars, ctx


stats, unc, cars, ctx = asyncio.run(run_pass())
check("pass: visited counts in-scope cars with a detail_url",
      stats["visited"] == 4, str(stats))
check("pass: fetched excludes the failed fetch", stats["fetched"] == 3, str(stats))
check("pass: badges/captured/no_badge tally",
      stats["badges"] == 2 and stats["captured"] == 1 and stats["no_badge"] == 1
      and stats["rejected"] == 1 and stats["js_only"] == 0, str(stats))
check("pass: only the verified car gained carfax_url",
      cars[0].get("carfax_url") == EXPECTED_CARFAX
      and all("carfax_url" not in c for c in cars[1:]),
      str([c.get("carfax_url") for c in cars]))
check("pass: New car never fetched",
      ctx.request.calls.count("http://x/real") == 1, str(ctx.request.calls))
check("pass: wrong-VIN reject filed as uncertain row",
      len(unc) == 1 and unc[0]["field"] == "carfax_url"
      and "rejected" in unc[0]["reason"], str(unc))


# ------------------------------------------------------ digest section
def outcome_with(carfax):
    return {"site_key": "www.mosescars.com|Used", "host": "www.mosescars.com",
            "condition": "Used", "platform": "dealeron",
            "platform_evidence": "fixture", "pages": 1, "cars_found": 3,
            "cars_written": 3, "held": [], "uncertain_count": 0,
            "quarantined": False, "reasons": [], "strategies": {},
            "seconds": 1.0, "error": None, "trusted": True,
            "seen_vins": set(), "rate_limit_hits": 0, "sitemap_url": None,
            "recrawl_of": False, "carfax": carfax}


pb = N.default_playbook()
d = N.build_digest([outcome_with(stats)], pb, {"run_id": "t", "seconds": 1, "cars": 3}, [])
check("digest: CARFAX section appears when stats exist",
      "CARFAX link capture" in d and "1 captured" in d)
d2 = N.build_digest([outcome_with(None)], pb, {"run_id": "t", "seconds": 1, "cars": 3}, [])
check("digest: no CARFAX section when the pass did not run",
      "CARFAX link capture" not in d2)


# ------------------------------------------------------------ writer
class FakeQB:
    def __init__(self, log, table):
        self.log, self.table = log, table

    def update(self, payload):
        self.log.append(("update", self.table, payload))
        return self

    def eq(self, col, val):
        self.log.append(("eq", col, val))
        return self

    def execute(self):
        class R:
            data = [{"ok": True}]
        return R()


class FakeDB:
    def __init__(self):
        self.log = []

    def table(self, name):
        return FakeQB(self.log, name)


_orig_db = N.db
N.db = FakeDB()
try:
    res = N.carfax_apply_writes([
        {"vin": "V1", "carfax_url": "https://www.carfax.com/vehiclehistory/a"},
        {"vin": "V1", "carfax_url": "https://www.carfax.com/vehiclehistory/a"},
        {"vin": "V2"},                                   # no find: never written
        {"vin": "V3", "carfax_url": "  "},               # blank: never written
        {"vin": "V4", "carfax_url": "https://www.carfax.com/vehiclehistory/b"},
    ], "user-1")
finally:
    written = list(N.db.log)
    N.db = _orig_db
ups = [e for e in written if e[0] == "update"]
check("writer: one targeted update per verified VIN (deduped)",
      res["attempted"] == 2 and res["errors"] == 0 and len(ups) == 2, str(res))
check("writer: updates touch only the carfax_url column",
      all(set(e[2].keys()) == {"carfax_url"} for e in ups), str(ups))


# --------------------------------------------- process_feed end-to-end
class FakeTable:
    def __init__(self, sink):
        self.sink = sink

    def insert(self, rows):
        self.sink.extend(rows if isinstance(rows, list) else [rows])
        return self

    def execute(self):
        class R:
            data = []
        return R()


class FakeDB2:
    def __init__(self):
        self.inserted = []

    def table(self, name):
        return FakeTable(self.inserted)


async def run_feed():
    N.db = FakeDB2()
    try:
        srp = fixture("normal.html")
        vdp_pages = {}
        ctx = FakeContext(vdp_pages)

        async def carfax_fn(cars):
            # Serve the real VDP fixture for every detail_url.
            for c in cars:
                if c.get("detail_url"):
                    vdp_pages[c["detail_url"]] = fixture("carfax_vdp_real.html")
            return await N.carfax_enrich_pass(ctx, cars)

        pushed = []

        def push(rows):
            pushed.extend(rows)
            return len(rows)

        async def fetcher(url):
            return {"status": 200, "html": srp, "browser_cars": None, "browser_ms": 0}

        feed = {"url": "https://www.mosescars.com/used-inventory/index.htm",
                "condition": "Used"}
        ctx_base = {"uid": "user-1", "location_name": "Moses"}
        opts = {"limit": 0, "push_fn": push, "enrich_fn": None,
                "carfax_fn": carfax_fn}
        outcome = await N.process_feed(feed, ctx_base, fetcher,
                                       N.default_playbook(), "run-t", opts)
        return outcome, pushed, N.db.inserted
    finally:
        N.db = _orig_db


outcome, pushed, inserted = asyncio.run(run_feed())
cfx = outcome.get("carfax") or {}
check("feed: outcome carries CARFAX stats", bool(cfx) and cfx["visited"] > 0,
      str(cfx))
check("feed: pushed rows carry the captured link",
      any(r.get("carfax_url") == EXPECTED_CARFAX for r in pushed),
      f"{sum(1 for r in pushed if r.get('carfax_url'))}/{len(pushed)} rows")
unc_rows = [r for r in inserted if r.get("run_id") == "run-t"]
check("feed: uncertain_count equals the uncertain rows actually logged",
      outcome["uncertain_count"] == len(unc_rows),
      f"{outcome['uncertain_count']} vs {len(unc_rows)}")
check("feed: valid-link run files no carfax_url rejects",
      not any(r.get("field") == "carfax_url" for r in unc_rows))

print()
if FAILURES:
    print(f"CARFAX HARNESS: {len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("CARFAX HARNESS: ALL GREEN")
