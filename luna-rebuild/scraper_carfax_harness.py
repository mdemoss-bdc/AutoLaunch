# =============================================================================
# scraper_carfax_harness.py — fixture-driven verification for the CARFAX
# link capture in PRODUCTION scraper.py (phase 2, 2026-10-29; the
# shadow trial's harness is scraper_next_carfax_harness.py).
#
# Covers: the pure extractor against the trial's fixtures (built from
# a REAL Moses VDP — 2018 Honda Ridgeline, VIN 5FPYK2F54JB000797),
# the production enrichment merge (scope, verified-find-only writes,
# wrong-VIN rejects filed to scraper_uncertain, fail-open fetches),
# and the push payload rule: a record with no verified find carries
# NO carfax_url key into the upsert, so a stored link can never be
# erased by a later sync. No network, no browser.
#
# Run: python3 scraper_carfax_harness.py   (exit 0 = all green)
# =============================================================================

import asyncio
import os
import sys
import types

# Scrub the VM's proxy env before anything builds a client (same
# discipline as the other scraper harnesses); no network is used.
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
import scraper as S  # noqa: E402  (production luna-rebuild/scraper.py)

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
r = S.extract_carfax_url(real, RIDGELINE_VIN, RIDGELINE_URL)
check("real VDP: link captured", r["url"] == EXPECTED_CARFAX, str(r))
check("real VDP: form is direct", r["form"] == "direct")
check("real VDP: badge seen, no reject", r["badge_seen"] and r["reject"] is None)

r = S.extract_carfax_url(fixture("carfax_vdp_cross_sell_only.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("cross-sell badge only: NO link for host car", r["url"] is None, str(r))
check("cross-sell badge only: badge not attributed to host",
      r["badge_seen"] is False and r["reject"] is None)

r = S.extract_carfax_url(fixture("carfax_vdp_no_badge.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("no badge: clean no-find",
      r["url"] is None and r["badge_seen"] is False and r["form"] is None)

r = S.extract_carfax_url(fixture("carfax_vdp_wrong_vin.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("wrong-VIN report link: refused", r["url"] is None and bool(r["reject"]),
      str(r))
check("wrong-VIN refusal names the mismatch",
      r["reject"] and "1FTFW1E13JFD82930" in r["reject"], str(r))

r = S.extract_carfax_url(fixture("carfax_vdp_jsonly.html"),
                         RIDGELINE_VIN, RIDGELINE_URL)
check("JS-only badge: js_only form, no link, no reject",
      r["url"] is None and r["form"] == "js_only" and r["reject"] is None,
      str(r))

r = S.extract_carfax_url("", RIDGELINE_VIN, RIDGELINE_URL)
check("empty html: clean no-find", r["url"] is None and r["badge_seen"] is False)

r = S.extract_carfax_url(
    real.replace(EXPECTED_CARFAX,
                 "https://www.carfax.com/vehiclehistory/p/Report.cfx?vin=" + RIDGELINE_VIN),
    RIDGELINE_VIN, RIDGELINE_URL)
check("vin= URL naming this car: accepted",
      r["url"] is not None and r["url"].endswith(RIDGELINE_VIN), str(r))


# ------------------------------------------------------- fake Supabase
class FakeQB:
    def __init__(self, log, table):
        self.log, self.table = log, table
        self._rows = []

    def select(self, *a, **k):
        return self

    def eq(self, *a):
        return self

    def in_(self, *a):
        return self

    def insert(self, rows):
        self.log.append(("insert", self.table, rows))
        return self

    def upsert(self, rows, on_conflict=None):
        self.log.append(("upsert", self.table, rows))
        self._rows = rows
        return self

    def execute(self):
        class R:
            pass
        r = R()
        r.data = self._rows
        return r


class FakeDB:
    def __init__(self):
        self.log = []

    def table(self, name):
        return FakeQB(self.log, name)


# --------------------------------------------- enrichment merge (VDP)
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


async def run_enrich(fake_db):
    pages = {
        "http://x/real": fixture("carfax_vdp_real.html"),
        "http://x/none": fixture("carfax_vdp_no_badge.html"),
        "http://x/wrong": fixture("carfax_vdp_wrong_vin.html"),
    }
    ctx = FakeContext(pages, fail=("http://x/dead",))
    cars = [
        {"vin": RIDGELINE_VIN, "user_id": "u1", "condition": "Used",
         "detail_url": "http://x/real", "price": 16923},
        {"vin": "1FTFW1E13JFD82930", "user_id": "u1", "condition": "Used",
         "detail_url": "http://x/none", "price": 21000},
        {"vin": RIDGELINE_VIN, "user_id": "u1", "condition": "Certified Pre-Owned",
         "detail_url": "http://x/wrong", "price": 17500},
        {"vin": "3FA6P0HD2LR000001", "user_id": "u1", "condition": "New",
         "detail_url": "http://x/real", "price": 31000},
        {"vin": "3FA6P0HD2LR000003", "user_id": "u1", "condition": "Used",
         "detail_url": "http://x/dead", "price": 9000},
    ]
    await S.enrich_cars_with_vdp(ctx, cars)
    return cars


_orig_db = S.db
fake = FakeDB()
S.db = fake
try:
    cars = asyncio.run(run_enrich(fake))
finally:
    S.db = _orig_db

check("enrich: verified Used car gained carfax_url",
      cars[0].get("carfax_url") == EXPECTED_CARFAX, str(cars[0].get("carfax_url")))
check("enrich: no-badge car carries NO carfax_url key (stored link survives)",
      "carfax_url" not in cars[1])
check("enrich: wrong-VIN car carries NO carfax_url key",
      "carfax_url" not in cars[2])
check("enrich: New car never gains the key (scope)",
      "carfax_url" not in cars[3])
check("enrich: failed fetch leaves the car untouched and never raises",
      "carfax_url" not in cars[4])
unc = [e[2] for e in fake.log if e[0] == "insert" and e[1] == "scraper_uncertain"]
check("enrich: exactly one reject filed to scraper_uncertain",
      len(unc) == 1, str(unc))
check("uncertain row: field carfax_url, this car's VIN, mismatch named",
      bool(unc) and unc[0]["field"] == "carfax_url"
      and unc[0]["vin"] == RIDGELINE_VIN
      and "1FTFW1E13JFD82930" in unc[0]["reason"]
      and unc[0]["user_id"] == "u1", str(unc))


# ------------------------------------------------- push payload rule
fake2 = FakeDB()
S.db = fake2
try:
    find_rec = {"vin": "VINFIND", "user_id": "u1", "price": 16923,
                "carfax_url": EXPECTED_CARFAX}
    nofind_rec = {"vin": "VINNOFIND", "user_id": "u1", "price": 21000}
    S.push_batch_to_supabase([find_rec, nofind_rec])
finally:
    S.db = _orig_db
ups = [e[2] for e in fake2.log if e[0] == "upsert"]
payload = {r["vin"]: r for r in (ups[0] if ups else [])}
check("push: verified find rides the upsert payload",
      payload.get("VINFIND", {}).get("carfax_url") == EXPECTED_CARFAX, str(payload))
check("push: no-find record has NO carfax_url key — a stored link is never nulled",
      "carfax_url" not in payload.get("VINNOFIND", {"carfax_url": None}), str(payload))

print()
if FAILURES:
    print(f"PRODUCTION CARFAX HARNESS: {len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("PRODUCTION CARFAX HARNESS: ALL GREEN")
