# =============================================================================
# scraper_next.py — the self-healing, self-learning successor to scraper.py.
#
# STATUS: BUILT + HARNESS-VERIFIED 2026-10-26 (overnight pass). NOT the
# production scraper — the nightly job still runs scraper.py. Promotion is
# Matthew's call (checklist in SCRAPER_NEXT.md).
#
# Design contract (Matthew's spec, 2026-10-26):
#   SELF-HEALING
#     - Per-dealership retry with backoff + jitter; a failed lot never
#       sinks the run; --resume skips feeds a previous run completed.
#     - Extraction strategy ladder per site (JSON-LD -> embedded JSON ->
#       DOM cards -> text patterns), recording which strategy produced
#       the cars, how long it took, and how often it comes back empty.
#     - Anomaly quarantine: a lot whose yield swings outside its learned
#       band, or whose prices/photos come back garbage, has its changes
#       HELD OUT of the sync — good stored data is never overwritten by
#       suspect data — and gets exactly one re-crawl attempt.
#     - Watchdog: every run writes 'started' / per-feed / 'finished'
#       heartbeat rows to scraper_run_log, and the digest names any lot
#       that did not complete.
#   SELF-LEARNING (bounded: parameters and playbooks, never code)
#     - Per-lot playbook in scraper_playbooks, plus a PER-PLATFORM
#       playbook: platform fingerprinting (DealerOn / Dealer.com /
#       Dealer Inspire / Sokal / Fox Dealer / WordPress / unknown)
#       means what one site teaches transfers to every site on the
#       same platform; a new lot cold-starts from its platform's
#       playbook and specializes from there. Unknown platforms are
#       surfaced as compatibility gaps, never force-fit.
#     - Speed learning: strategy order optimizes expected time-to-cars;
#       strategies that burn time before failing are demoted per site;
#       rate-limit hits lower the site's learned concurrency posture
#       and become evidence in the needs report.
#     - Needs report: every digest ends with "What would make me
#       faster" — concrete, evidence-backed asks only, accumulated in
#       the playbook until resolved.
#     - Uncertainty surfacing: anything extracted with low confidence
#       goes to scraper_uncertain with what was found and why it's
#       unsure. Nothing is silently dropped; nothing is guessed.
#
# Everything proven in production is REUSED, not rewritten: this module
# imports scraper.py and calls its db client, browser extractor, VDP
# enrichment, batch writer, stale pass, and auto-post pass. New logic
# is orchestration, evaluation, and learning around those primitives.
# Every playbook / heartbeat / uncertain write is FAIL-OPEN: if the
# learning layer can't write, the crawl degrades to today's behavior
# instead of breaking.
# =============================================================================

import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from statistics import median
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scraper as S  # noqa: E402  (production primitives: db, extractors, writers)

db = S.db

MAX_PAGES_PER_FEED = S.MAX_PAGES_PER_FEED
TEST_SYNC_LIMIT = S.TEST_SYNC_LIMIT

STRATEGY_ORDER_DEFAULT = ["browser", "jsonld", "embedded_json", "dom_cards", "text_patterns"]
HTML_STRATEGIES = ["jsonld", "embedded_json", "dom_cards", "text_patterns"]

# Retry policy per feed (seconds, before jitter).
RETRY_BACKOFFS = [2, 5, 12]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _median_or_none(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return float(median(vals))


# =============================================================================
# PLATFORM FINGERPRINTING
# =============================================================================
# Signatures are asset-host / markup markers that dealer platforms stamp
# on every page they serve. Order matters: the most specific first.
# Detection is heuristic and EVIDENCE is always recorded with the guess;
# an unrecognized site is 'unknown', never force-fit (SCRAPER_NEXT.md).

PLATFORM_SIGNATURES = [
    ("dealeron", ["dealeron.com", "dealeron", "cdkdigitalmarketing"]),
    ("dealer_com", ["dealer.com", "inventory.dealer.com", "ddc-api", "dealercenters"]),
    ("dealer_inspire", ["dealerinspire.com", "dealerinspire", "di-ignite"]),
    ("sokal", ["gosokal.com", "sokal.com", "sokalgroup"]),
    ("fox_dealer", ["foxdealer.com", "fox dealer"]),
    ("wordpress", ["wp-content/", "wp-includes/"]),
]


def detect_platform(html: str, url: str = "") -> tuple:
    """Return (platform, evidence). Evidence is the matched signature,
    or — for unknown — the first script hosts seen, so a human can
    classify the gap from the digest alone."""
    low = (html or "").lower()
    for name, needles in PLATFORM_SIGNATURES:
        for n in needles:
            if n in low:
                return name, f"signature '{n}' in page source"
    hosts = []
    for m in re.finditer(r'<script[^>]+src=["\']https?://([^/"\']+)', html or "", re.I):
        h = m.group(1).lower()
        if h not in hosts:
            hosts.append(h)
        if len(hosts) >= 4:
            break
    return "unknown", "script hosts: " + (", ".join(hosts) if hosts else "none found")


def site_key_for(feed_url: str, condition: str) -> str:
    host = urlparse(feed_url).netloc.lower() or feed_url
    return f"{host}|{condition}"


# =============================================================================
# EXTRACTION LADDER (HTML-string strategies)
# =============================================================================
# Each strategy takes raw page HTML and returns production-shaped car
# dicts (the same keys push_batch_to_supabase writes). Fields a strategy
# cannot know stay None/empty — VDP enrichment fills photos/prices later,
# exactly as in production. Confidence travels on private keys
# (_confidence, _notes) and is consumed by evaluate_lot; the keys are
# stripped before any write.

VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b")
PRICE_RE = re.compile(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})(?:\.[0-9]{2})?")
YEAR_MAKE_MODEL_RE = re.compile(
    r"\b(19[9][0-9]|20[0-4][0-9])\s+([A-Z][A-Za-z]+)\s+([A-Z0-9][A-Za-z0-9\- ]{1,24})"
)

# VIN position-10 year codes, 2010-2039 cycle (letters skip I/O/Q/U/Z).
_VIN_YEAR_CODES = {}
for _i, _ch in enumerate("ABCDEFGHJKLMNPRSTVWXY"):
    _VIN_YEAR_CODES[_ch] = 2010 + _i
for _d in range(1, 10):
    _VIN_YEAR_CODES[str(_d)] = 2030 + _d - 1


def vin_year_code(vin: str):
    if not vin or len(vin) < 10:
        return None
    return _VIN_YEAR_CODES.get(vin[9].upper())


def _base_car(ctx: dict) -> dict:
    return {
        "vin": None,
        "stock_number": None,
        "user_id": ctx.get("uid"),
        "year": None,
        "make": None,
        "model": None,
        "trim": None,
        "price": None,
        "mileage": None,
        "location_name": ctx.get("location_name") or "Dealership Lot",
        "image_url": None,
        "photos": [],
        "interior_color": None,
        "detail_url": ctx.get("page_url"),
        "color": "Standard",
        "body_type": "Other",
        "transmission": "Automatic",
        "status": "Available",
        "condition": ctx.get("condition") or "Used",
        "is_active": True,
        "_confidence": "high",
        "_notes": [],
    }


def _finish_car(car: dict) -> dict:
    vin = (car.get("vin") or "").strip().upper()
    car["vin"] = vin or None
    if not car.get("stock_number") and vin:
        car["stock_number"] = vin[-8:]
    if car.get("image_url") and not car.get("photos"):
        car["photos"] = [car["image_url"]]
    return car


def _name_to_ymm(name: str, car: dict):
    m = YEAR_MAKE_MODEL_RE.search(name or "")
    if m:
        car["year"] = int(m.group(1))
        car["make"] = m.group(2)
        rest = m.group(3).strip()
        car["model"] = rest.split(" ")[0] if rest else None
        car["trim"] = rest[len(car["model"]):].strip() or None


def _walk_json(obj, out: list):
    if isinstance(obj, dict):
        out.append(obj)
        for v in obj.values():
            _walk_json(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _walk_json(v, out)


def _car_from_json_obj(o: dict, ctx: dict):
    vin = None
    for k in ("vehicleIdentificationNumber", "vin", "VIN", "Vin"):
        if isinstance(o.get(k), str) and VIN_RE.fullmatch(o[k].strip().upper()):
            vin = o[k].strip().upper()
            break
    if not vin and isinstance(o.get("identifier"), str) and VIN_RE.fullmatch(o["identifier"].strip().upper()):
        # schema.org ListItem/Product shape — DealerOn's SRP JSON-LD
        # carries the VIN as 'identifier' (found on the live Moses
        # site 2026-10-26; production's browser pass reads it too).
        vin = o["identifier"].strip().upper()
    if not vin:
        return None
    car = _base_car(ctx)
    car["vin"] = vin
    # Price: prefer an explicit offers block, then direct price keys.
    price = None
    offers = o.get("offers")
    if isinstance(offers, dict):
        price = S._money_int(offers.get("price"))
    if price is None:
        for k in ("price", "salePrice", "finalPrice", "internetPrice", "sellingPrice"):
            price = S._money_int(o.get(k))
            if price is not None:
                break
    car["price"] = price
    odo = o.get("mileageFromOdometer")
    if isinstance(odo, dict):
        odo = odo.get("value")
    car["mileage"] = S._mileage_int(odo if odo is not None else o.get("mileage", o.get("miles")))
    _name_to_ymm(str(o.get("name") or ""), car)
    if isinstance(o.get("model"), str) and not car.get("model"):
        car["model"] = o["model"]
    if isinstance(o.get("brand"), (str, dict)) and not car.get("make"):
        car["make"] = o["brand"].get("name") if isinstance(o["brand"], dict) else o["brand"]
    if isinstance(o.get("modelDate"), (int, str)) and not car.get("year"):
        try:
            car["year"] = int(str(o["modelDate"])[:4])
        except ValueError:
            pass
    img = o.get("image")
    if isinstance(img, list) and img:
        img = img[0]
    if isinstance(img, dict):
        img = img.get("url")
    if isinstance(img, str) and img.startswith("http"):
        car["image_url"] = img
        car["photos"] = [img]
    if isinstance(o.get("sku"), str):
        car["stock_number"] = o["sku"]
    if isinstance(o.get("url"), str) and o["url"].startswith("http"):
        car["detail_url"] = o["url"]
    if isinstance(o.get("color"), str):
        car["color"] = o["color"]
    return _finish_car(car)


def _jsonld_blocks(html: str) -> list:
    blocks = []
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html or "", re.S | re.I,
    ):
        try:
            blocks.append(json.loads(m.group(1).strip()))
        except Exception:
            continue
    return blocks


def extract_jsonld(html: str, ctx: dict) -> list:
    cars, seen = [], set()
    for block in _jsonld_blocks(html):
        objs = []
        _walk_json(block, objs)
        for o in objs:
            t = str(o.get("@type") or "")
            if t and t not in ("Vehicle", "Car", "Product", "IndividualProduct"):
                # ItemList wrappers etc. are walked through, but only
                # vehicle-ish leaves become cars.
                if not any(k in o for k in ("vehicleIdentificationNumber", "vin", "VIN", "identifier")):
                    continue
            car = _car_from_json_obj(o, ctx)
            if car and car["vin"] not in seen:
                seen.add(car["vin"])
                cars.append(car)
    return cars


def extract_embedded_json(html: str, ctx: dict) -> list:
    payloads = []
    m = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html or "", re.S | re.I)
    if m:
        try:
            payloads.append(json.loads(m.group(1)))
        except Exception:
            pass
    for m in re.finditer(r"window\.__[A-Za-z0-9_]+__\s*=\s*(\{.*?\});?\s*</script>", html or "", re.S | re.I):
        try:
            payloads.append(json.loads(m.group(1)))
        except Exception:
            continue
    cars, seen = [], set()
    for payload in payloads:
        objs = []
        _walk_json(payload, objs)
        for o in objs:
            car = _car_from_json_obj(o, ctx)
            if car and car["vin"] not in seen:
                seen.add(car["vin"])
                car["_confidence"] = "high"
                cars.append(car)
    return cars


class _CardParser(HTMLParser):
    """Collect candidate card blocks: subtrees whose class names look
    like vehicle cards. Captures text, img srcs, and hrefs per block."""

    CARD_HINTS = ("vehicle-card", "vehiclecard", "inventory-card", "car-card",
                  "vehicle-item", "listing-card", "vehicle_card", "srp-card")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self._stack = []
        self._cur = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").lower()
        if self._cur is None and any(h in classes for h in self.CARD_HINTS):
            self._cur = {"text": [], "imgs": [], "hrefs": []}
            self._depth = 1
            self._stack = [tag]
            return
        if self._cur is not None:
            self._stack.append(tag)
            if tag == "img" and attrs.get("src"):
                self._cur["imgs"].append(attrs["src"])
            if tag == "a" and attrs.get("href"):
                self._cur["hrefs"].append(attrs["href"])

    def handle_endtag(self, tag):
        if self._cur is None:
            return
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()
        if not self._stack:
            self.blocks.append(self._cur)
            self._cur = None

    def handle_data(self, data):
        if self._cur is not None:
            self._cur["text"].append(data)


def extract_dom_cards(html: str, ctx: dict) -> list:
    parser = _CardParser()
    try:
        parser.feed(html or "")
    except Exception:
        return []
    cars, seen = [], set()
    for block in parser.blocks:
        text = " ".join(" ".join(block["text"]).split())
        vm = VIN_RE.search(text)
        if not vm:
            continue
        vin = vm.group(0).upper()
        if vin in seen:
            continue
        seen.add(vin)
        car = _base_car(ctx)
        car["vin"] = vin
        pm = PRICE_RE.search(text)
        car["price"] = S._money_int(pm.group(1)) if pm else None
        _name_to_ymm(text, car)
        mm = re.search(r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,6})\s*(?:miles|mi\b)", text, re.I)
        car["mileage"] = S._mileage_int(mm.group(1)) if mm else None
        imgs = [i for i in block["imgs"] if i.startswith("http") and "/static/" not in i]
        if imgs:
            car["image_url"] = imgs[0]
            car["photos"] = imgs[:20]
        car["_confidence"] = "medium"
        cars.append(_finish_car(car))
    return cars


def _strip_to_text(html: str) -> str:
    h = re.sub(r"<script.*?</script>", " ", html or "", flags=re.S | re.I)
    h = re.sub(r"<style.*?</style>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.split())


def extract_text_patterns(html: str, ctx: dict) -> list:
    """Last resort: VINs in visible prose, price = the dollar figure
    nearest after the VIN. Low confidence BY CONSTRUCTION — cars found
    here are routed to the review list by evaluate_lot, never written
    on this evidence alone. Two distinct prices in the window means
    the price is AMBIGUOUS (e.g. 'was $X, now $Y'): flagged, not picked."""
    text = _strip_to_text(html)
    cars, seen = [], set()
    matches = list(VIN_RE.finditer(text))
    for idx, vm in enumerate(matches):
        vin = vm.group(0).upper()
        if vin in seen:
            continue
        seen.add(vin)
        # The car's window ends where the NEXT car's VIN begins —
        # otherwise one car's price bleeds into its neighbour's.
        end = matches[idx + 1].start() if idx + 1 < len(matches) else vm.start() + 500
        window = text[vm.start():end]
        prices = []
        for pm in PRICE_RE.finditer(window):
            v = S._money_int(pm.group(1))
            if v is not None and v not in prices:
                prices.append(v)
        car = _base_car(ctx)
        car["vin"] = vin
        car["_confidence"] = "low"
        if len(prices) == 1:
            car["price"] = prices[0]
            car["_notes"].append("price parsed from page prose, not structured data")
        elif len(prices) > 1:
            car["price"] = None
            car["_ambiguous_price"] = prices
            car["_evidence"] = window[:220]
            car["_notes"].append(f"ambiguous price in prose: candidates {prices}")
        else:
            car["_notes"].append("no price found near VIN in page prose")
        _name_to_ymm(text[max(0, vm.start() - 200):vm.start() + 200], car)
        cars.append(_finish_car(car))
    return cars


EXTRACTORS = {
    "jsonld": extract_jsonld,
    "embedded_json": extract_embedded_json,
    "dom_cards": extract_dom_cards,
    "text_patterns": extract_text_patterns,
}


def extract_with_ladder(html: str, order: list, ctx: dict) -> dict:
    """Try strategies in the playbook's order; first non-empty wins.
    Returns {cars, strategy, attempts:[{strategy, ms, cars}]}."""
    attempts = []
    for name in order:
        fn = EXTRACTORS.get(name)
        if fn is None:
            continue
        t0 = time.monotonic()
        try:
            cars = fn(html, ctx)
        except Exception:
            cars = []
        ms = int((time.monotonic() - t0) * 1000)
        attempts.append({"strategy": name, "ms": ms, "cars": len(cars)})
        if cars:
            return {"cars": cars, "strategy": name, "attempts": attempts}
    return {"cars": [], "strategy": None, "attempts": attempts}


# =============================================================================
# LOT EVALUATION — quarantine gates + confidence routing
# =============================================================================
# Confidence rules (also documented in SCRAPER_NEXT.md):
#   HIGH   structured data (JSON-LD / embedded JSON / browser pass):
#          writes normally.
#   MEDIUM DOM-card extraction: writes, but field gaps are flagged.
#   LOW    text-pattern (prose) extraction: NEVER writes on this
#          evidence alone — the car goes to scraper_uncertain with
#          what was found, and is held out of the sync. Nothing is
#          guessed to fill the gap.
#   A price more than ~2.5x either side of the lot's own median is
#   treated as suspect (the stale/wrong-car price failure class): held
#   + review-listed, never silently written.
# Quarantine (whole-lot hold) triggers:
#   - >40% of cars garbage-priced (missing / under $1,000)
#   - >60% of cars with zero photos after enrichment
#   - car count outside the learned band (needs >=3 historical runs)
#   - run median price outside the learned price band (>=3 runs)

def evaluate_lot(cars: list, pb: dict) -> dict:
    prices = [c["price"] for c in cars if c.get("price")]
    run_median_price = _median_or_none(prices)
    photo_counts = [len(c.get("photos") or []) for c in cars]
    photo_median = _median_or_none(photo_counts)
    verdict = {
        "quarantine": False,
        "reasons": [],
        "write_cars": [],
        "held": [],
        "uncertain": [],
        "stats": {
            "count": len(cars),
            "median_price": run_median_price,
            "photo_median": photo_median,
        },
    }
    if not cars:
        return verdict

    def uncertain(car, field, found, reason, evidence=""):
        verdict["uncertain"].append({
            "vin": car.get("vin"),
            "field": field,
            "found_value": None if found is None else str(found),
            "reason": reason,
            "evidence": (evidence or "")[:500],
        })

    # ---- per-car routing first (holds are computed even if the lot
    # ends up quarantined, so the review list is complete).
    held_ids = set()
    for car in cars:
        conf = car.get("_confidence", "high")
        if conf == "low":
            held_ids.add(id(car))
            why = "; ".join(car.get("_notes") or ["low-confidence extraction"])
            verdict["held"].append({"vin": car.get("vin"), "why": f"low confidence: {why}"})
            if car.get("_ambiguous_price"):
                uncertain(car, "price", car["_ambiguous_price"],
                          "two different prices near this VIN in page prose — refusing to pick one",
                          car.get("_evidence", ""))
            else:
                uncertain(car, "extraction", car.get("price"), why,
                          "; ".join(car.get("_notes") or []))
            continue
        # Price sanity against the lot's own distribution.
        p = car.get("price")
        if p and run_median_price and len(prices) >= 5:
            if p > run_median_price * 2.5 or p < run_median_price * 0.4:
                held_ids.add(id(car))
                verdict["held"].append({
                    "vin": car.get("vin"),
                    "why": f"price ${p:,} is far outside this lot's median ${int(run_median_price):,}",
                })
                uncertain(car, "price", p,
                          f"price far outside the lot's median (${int(run_median_price):,}) — possible wrong-car or stale price",
                          f"lot median ${int(run_median_price):,} across {len(prices)} priced cars")
                continue
        # Mileage sanity (2026-10-28, step-2 condition 1): a USED car
        # whose model year is 3+ years behind the current year cannot
        # plausibly show single-digit miles — that is the fallback
        # leg's old CSS-hex artifact class (mileage "5" on 99.9% of
        # step-1 cars), never a real odometer. Hold + review, never
        # guess a value. Current/recent model years and New cars are
        # exempt: a brand-new car with 5 miles is legitimate, and a
        # newer used car can honestly be near-zero. New-car placeholder
        # figures (production stamps 1,000) are untouched: 1,000 is
        # not single-digit.
        miles = car.get("mileage")
        if (car.get("condition") == "Used" and miles is not None
                and 0 <= miles < 10):
            yr = car.get("year") or vin_year_code(car.get("vin") or "")
            try:
                yr = int(yr) if yr else None
            except (TypeError, ValueError):
                yr = None
            if yr and yr <= datetime.now(timezone.utc).year - 3:
                held_ids.add(id(car))
                verdict["held"].append({
                    "vin": car.get("vin"),
                    "why": f"mileage {miles} is implausible for a {yr} used car",
                })
                uncertain(car, "mileage", miles,
                          f"single-digit mileage on a {yr} used car — extraction artifact, not an odometer reading",
                          "step-1 artifact class: fallback regex read a CSS hex digit as mileage")
                continue
        # VIN year-code vs extracted year: flag, don't hold — a
        # one-year model/calendar offset is common and legitimate.
        yc = vin_year_code(car.get("vin") or "")
        if yc and car.get("year") and abs(int(car["year"]) - yc) > 1:
            uncertain(car, "year", car.get("year"),
                      f"VIN year code says {yc}, page says {car.get('year')}")
        # Photo set far below the lot's learned norm: flag only
        # (enrichment may still be catching up on later runs).
        norm = (pb.get("photo_norm") or {}).get("median_photos")
        if norm and norm >= 4 and len(car.get("photos") or []) <= 1:
            uncertain(car, "photos", len(car.get("photos") or []),
                      f"photo set far below this lot's norm (~{int(norm)} per car)")
    verdict["write_cars"] = [c for c in cars if id(c) not in held_ids]

    # ---- whole-lot anomaly gates.
    n = len(cars)
    garbage = sum(1 for c in cars if not c.get("price") or c["price"] < 1000)
    if n >= 4 and garbage / n > 0.40:
        verdict["reasons"].append(
            f"garbage prices: {garbage} of {n} cars missing/implausible price")
    no_photo = sum(1 for c in cars if not (c.get("photos") or []))
    if n >= 4 and no_photo / n > 0.60:
        verdict["reasons"].append(
            f"photo collapse: {no_photo} of {n} cars have no photos")
    count_samples = (pb.get("count_band") or {}).get("samples") or []
    if len(count_samples) >= 3:
        cm = float(median(count_samples))
        if cm >= 10 and (n < cm * 0.45 or n > cm * 2.2):
            verdict["reasons"].append(
                f"count swing: {n} cars vs learned norm ~{int(cm)}")
    price_samples = (pb.get("price_band") or {}).get("samples") or []
    if len(price_samples) >= 3 and run_median_price:
        pm = float(median(price_samples))
        if pm and (run_median_price < pm * 0.55 or run_median_price > pm * 1.8):
            verdict["reasons"].append(
                f"price band break: run median ${int(run_median_price):,} vs learned ~${int(pm):,}")

    if verdict["reasons"]:
        verdict["quarantine"] = True
        if any(r.startswith("garbage prices") for r in verdict["reasons"]):
            for c in cars:
                if not c.get("price") or c["price"] < 1000:
                    uncertain(c, "price", c.get("price"),
                              "missing or implausible price in a crawl quarantined for garbage prices",
                              f"{(c.get('year') or '')} {(c.get('make') or '')} {(c.get('model') or '')}".strip())
        verdict["write_cars"] = []
        verdict["held"] = [{"vin": c.get("vin"), "why": "lot quarantined"} for c in cars]
    return verdict


# =============================================================================
# PLAYBOOK — the learned state (data only; always visible, resettable)
# =============================================================================

def default_playbook() -> dict:
    return {
        "platform": None,
        "platform_evidence": None,
        "strategy_stats": {},   # name -> {ok, empty, cars, ms}
        "strategy_order": list(STRATEGY_ORDER_DEFAULT),
        "count_band": {"samples": []},
        "price_band": {"samples": []},
        "photo_norm": {"median_photos": None},
        "timings": [],          # [{at, seconds, cars, pages}] newest last, cap 12
        "rate_limit_hits": 0,
        "concurrency_cap": None,
        "needs": [],            # [{id, kind, text, evidence, first_seen, last_seen, missed_runs, resolved}]
        "last_outcome": None,
    }


def adapt_strategy_order(stats: dict) -> list:
    """Rank strategies by expected time-to-cars. A strategy that has
    come back empty >=3 times and never produced a car is demoted to
    the back — it burns crawl time before failing. 'browser' (the
    production extractor) is scored like everything else."""
    def score(name):
        st = stats.get(name) or {}
        ok, empty = st.get("ok", 0), st.get("empty", 0)
        cars, ms = st.get("cars", 0), st.get("ms", 0)
        if ok == 0 and empty >= 3:
            return (1, 0.0)  # demoted bucket
        if ok == 0:
            return (0, 0.0)  # unproven: neutral, canonical order breaks ties
        cars_per_ms = cars / max(ms, 1)
        ok_rate = ok / max(ok + empty, 1)
        return (0, cars_per_ms * ok_rate)

    canonical = {name: i for i, name in enumerate(STRATEGY_ORDER_DEFAULT)}
    names = list(STRATEGY_ORDER_DEFAULT)
    names.sort(key=lambda n: (score(n)[0], -score(n)[1], canonical[n]))
    return names


def record_strategy(pb: dict, name: str, cars: int, ms: int):
    st = pb["strategy_stats"].setdefault(name, {"ok": 0, "empty": 0, "cars": 0, "ms": 0})
    if cars > 0:
        st["ok"] += 1
        st["cars"] += cars
    else:
        st["empty"] += 1
    st["ms"] += ms
    pb["strategy_order"] = adapt_strategy_order(pb["strategy_stats"])


def update_bands(pb: dict, stats: dict):
    if stats.get("count"):
        samples = pb["count_band"].setdefault("samples", [])
        samples.append(stats["count"])
        pb["count_band"]["samples"] = samples[-12:]
    if stats.get("median_price"):
        samples = pb["price_band"].setdefault("samples", [])
        samples.append(stats["median_price"])
        pb["price_band"]["samples"] = samples[-12:]
    if stats.get("photo_median") is not None:
        pb["photo_norm"] = {"median_photos": stats["photo_median"]}


def merge_playbooks(platform_pb: dict, lot_pb: dict) -> dict:
    """Two-level learning: the platform playbook is the prior, the lot
    playbook specializes it. Lot evidence wins where the lot has
    enough of it (>=3 strategy attempts or >=2 band samples); below
    that the platform's learned values carry the lot."""
    eff = json.loads(json.dumps(platform_pb or default_playbook()))
    lot = lot_pb or default_playbook()
    lot_attempts = sum(
        (s.get("ok", 0) + s.get("empty", 0)) for s in (lot.get("strategy_stats") or {}).values()
    )
    if lot_attempts >= 3:
        eff["strategy_stats"] = lot["strategy_stats"]
        eff["strategy_order"] = lot.get("strategy_order") or eff["strategy_order"]
    if len((lot.get("count_band") or {}).get("samples") or []) >= 2:
        eff["count_band"] = lot["count_band"]
    if len((lot.get("price_band") or {}).get("samples") or []) >= 2:
        eff["price_band"] = lot["price_band"]
    if (lot.get("photo_norm") or {}).get("median_photos") is not None:
        eff["photo_norm"] = lot["photo_norm"]
    if lot.get("platform"):
        eff["platform"] = lot["platform"]
        eff["platform_evidence"] = lot.get("platform_evidence")
    if lot.get("concurrency_cap"):
        eff["concurrency_cap"] = lot["concurrency_cap"]
    eff["rate_limit_hits"] = lot.get("rate_limit_hits", eff.get("rate_limit_hits", 0))
    # Needs: union by id, lot copy is fresher.
    by_id = {n["id"]: n for n in eff.get("needs") or []}
    for n in lot.get("needs") or []:
        by_id[n["id"]] = n
    eff["needs"] = list(by_id.values())
    return eff


# =============================================================================
# NEEDS — "What would make me faster" (evidence-backed only)
# =============================================================================

def _need_id(kind: str, site_key: str) -> str:
    return hashlib.sha1(f"{kind}|{site_key}".encode()).hexdigest()[:12]


def generate_needs(facts: dict) -> list:
    """facts: {site_key, host, platform, platform_evidence, sitemap_url,
    rate_limit_hits, strategy_stats}. Every need cites its numbers."""
    out = []
    sk, host = facts.get("site_key", ""), facts.get("host", "")
    if facts.get("platform") == "unknown":
        out.append({
            "id": _need_id("unknown_platform", sk), "kind": "unknown_platform",
            "text": f"Unrecognized website platform at {host} — compatibility gap. "
                    f"Learning is running per-lot only until this platform is identified.",
            "evidence": facts.get("platform_evidence") or "no signature matched",
        })
    if facts.get("sitemap_url"):
        out.append({
            "id": _need_id("sitemap_shortcut", sk), "kind": "sitemap_shortcut",
            "text": f"{host} publishes a vehicle sitemap ({facts['sitemap_url']}) — "
                    f"crawling it directly would skip SRP pagination entirely.",
            "evidence": "sitemap link found in page source this run",
        })
    if (facts.get("rate_limit_hits") or 0) >= 2:
        out.append({
            "id": _need_id("rate_limited", sk), "kind": "rate_limited",
            "text": f"{host} rate-limited this crawler {facts['rate_limit_hits']} times — "
                    f"lower per-site concurrency or shift this lot's crawl window.",
            "evidence": f"{facts['rate_limit_hits']} HTTP 429/403 responses recorded in the playbook",
        })
    stats = facts.get("strategy_stats") or {}
    ranked = adapt_strategy_order(stats)
    primary = ranked[0] if ranked else None
    if primary and stats.get(primary, {}).get("ok", 0) >= 3:
        pst = stats[primary]
        avg_ms = pst["ms"] / max(pst["ok"], 1)
        for other in ranked[1:]:
            ost = stats.get(other) or {}
            if ost.get("ok", 0) >= 3:
                o_avg = ost["ms"] / max(ost["ok"], 1)
                if avg_ms > 15000 and o_avg * 2 < avg_ms:
                    out.append({
                        "id": _need_id("slow_primary", sk), "kind": "slow_primary",
                        "text": f"On {host}, '{primary}' averages {int(avg_ms/1000)}s per page while "
                                f"'{other}' averages {int(o_avg/1000)}s — the playbook order already "
                                f"prefers the faster path where it works; pages where only "
                                f"'{primary}' works are the bottleneck.",
                        "evidence": f"strategy stats over {pst['ok'] + pst.get('empty', 0)} attempts",
                    })
                break
    return out


def merge_needs(pb: dict, new_needs: list):
    """Needs persist across digests until resolved. A need whose
    evidence stops appearing for 3 consecutive runs auto-resolves."""
    existing = {n["id"]: n for n in pb.get("needs") or []}
    seen_now = set()
    for n in new_needs:
        seen_now.add(n["id"])
        if n["id"] in existing:
            existing[n["id"]].update({
                "text": n["text"], "evidence": n["evidence"],
                "last_seen": _now_iso(), "missed_runs": 0, "resolved": False,
            })
        else:
            n = dict(n)
            n.update({"first_seen": _now_iso(), "last_seen": _now_iso(),
                      "missed_runs": 0, "resolved": False})
            existing[n["id"]] = n
    for nid, n in existing.items():
        if nid not in seen_now and not n.get("resolved"):
            n["missed_runs"] = n.get("missed_runs", 0) + 1
            if n["missed_runs"] >= 3:
                n["resolved"] = True
    pb["needs"] = list(existing.values())


def open_needs(pb: dict) -> list:
    return [n for n in pb.get("needs") or [] if not n.get("resolved")]


# =============================================================================
# DB LAYER — every write fail-open (learning must never break the crawl)
# =============================================================================

def load_playbook(scope: str, site_key: str, user_id=None) -> dict:
    try:
        q = db.table("scraper_playbooks").select("*").eq("scope", scope).eq("site_key", site_key)
        q = q.eq("user_id", user_id) if user_id else q.is_("user_id", "null")
        rows = (q.limit(1).execute()).data or []
        if rows:
            data = rows[0].get("data") or {}
            merged = default_playbook()
            merged.update(data)
            merged["_row_id"] = rows[0]["id"]
            return merged
    except Exception as e:
        print(f"[!] Playbook load warning ({scope}/{site_key}): {e}")
    return default_playbook()


def save_playbook(scope: str, site_key: str, user_id, platform, pb: dict):
    try:
        row = {
            "scope": scope, "site_key": site_key, "user_id": user_id,
            "platform": platform,
            "data": {k: v for k, v in pb.items() if not k.startswith("_")},
            "updated_at": _now_iso(),
        }
        if pb.get("_row_id"):
            db.table("scraper_playbooks").update(row).eq("id", pb["_row_id"]).execute()
        else:
            db.table("scraper_playbooks").insert(row).execute()
    except Exception as e:
        print(f"[!] Playbook save warning ({scope}/{site_key}): {e}")


def heartbeat(run_id: str, event: str, user_id=None, site_key=None, detail=None):
    if event == "started":
        _tally_note_run_start(run_id)
    try:
        db.table("scraper_run_log").insert({
            "run_id": run_id, "user_id": user_id, "site_key": site_key,
            "event": event, "detail": detail or {},
        }).execute()
    except Exception as e:
        print(f"[!] Heartbeat warning ({event}): {e}")
    if event == "finished":
        # Sync-summary recording (app popup): both entry points emit
        # 'finished' only after the crawl AND the digest are complete,
        # and the flush is gated on the shadow contract + fail-open —
        # see the SYNC SUMMARIES section below.
        _flush_sync_summaries(run_id)


def log_uncertain(run_id: str, user_id, site_key: str, rows: list):
    if not rows:
        return
    try:
        db.table("scraper_uncertain").insert([
            {"run_id": run_id, "user_id": user_id, "site_key": site_key, **r}
            for r in rows
        ]).execute()
    except Exception as e:
        print(f"[!] Uncertain-log warning: {e}")


def recent_run_totals(limit: int = 5) -> list:
    try:
        rows = (db.table("scraper_run_log").select("detail, created_at")
                .eq("event", "finished")
                .order("created_at", desc=True).limit(limit).execute()).data or []
        return [r["detail"] for r in rows if isinstance(r.get("detail"), dict)]
    except Exception:
        return []


# =============================================================================
# SYNC SUMMARIES — per-user run tallies for the app's sync-summary popup
# =============================================================================
# After a SHADOW run (SCRAPER_NEXT_SHADOW=1 — the scraper_next_shadow
# contract), one row per user lands in sync_summaries: how many vehicles
# the run checked, how many were new, how many changed, how many had
# exited. The tally is computed from the run's own data — the VINs each
# feed saw plus the exact rows it handed to its push function —
# compared against the stored inventory at flush time. In shadow mode
# the run writes no inventory, so the stored rows are the pre-run
# baseline.
#
# Placement is deliberate: registration inside process_feed is pure
# in-memory bookkeeping (no I/O, no output, no return-value change),
# and the flush hangs off the 'finished' heartbeat, which both entry
# points (run_next and the shadow driver) emit only after the crawl
# AND the digest are complete. Crawl, extraction and digest outputs
# are identical with or without this section, and every step is
# fail-open: a tally or insert failure logs a warning and the run
# finishes exactly as before.
#
# queued_posts / queued_deletes are written NULL: a shadow run never
# queues real jobs and computes no would-queue numbers (the auto-post
# pass is production's and never runs in shadow mode). NULL renders as
# "—" in the app rather than a fabricated zero.

_SYNC_TALLY = {}           # run_id -> {"started_at": iso, "users": {uid: acc}}
_LAST_SYNC_SUMMARIES = {}  # run_id -> [row, ...] exactly as computed at flush


def _tally_note_run_start(run_id):
    try:
        _SYNC_TALLY.setdefault(run_id, {"started_at": _now_iso(), "users": {}})
    except Exception:
        pass


def _tally_acc(run_id, uid):
    entry = _SYNC_TALLY.setdefault(run_id, {"started_at": None, "users": {}})
    acc = entry["users"].get(uid)
    if acc is None:
        acc = {"seen": set(), "written": {}, "feeds": {},
               "failed_feeds": set(), "capped": False}
        entry["users"][uid] = acc
    return acc


def _tally_register(run_id, uid, site_key, seen_vins, written_rows,
                    capped=False, trusted=True):
    """In-memory only. Records what one finished feed saw and the exact
    rows it handed to its push_fn. A later registration for the same
    site_key overwrites that feed's trust flag, so a healed re-crawl
    wins — mirroring how run_next replaces the outcome."""
    try:
        if not uid:
            return
        acc = _tally_acc(run_id, uid)
        acc["seen"] |= {v for v in (seen_vins or set()) if v}
        for r in written_rows or []:
            vin = r.get("vin")
            if vin:
                acc["written"][vin] = {
                    "price": r.get("price"),
                    "status": r.get("status"),
                    "photos": list(r.get("photos") or []),
                }
        acc["feeds"][site_key] = bool(trusted)
        acc["capped"] = acc["capped"] or bool(capped)
    except Exception:
        pass


def _tally_mark_feed_failed(run_id, uid, site_key):
    try:
        if uid:
            _tally_acc(run_id, uid)["failed_feeds"].add(site_key)
    except Exception:
        pass


def _tally_baseline(uid):
    """The user's stored inventory right now, paginated — the
    PostgREST 1,000-row cap must never silently truncate this. In
    shadow mode the run wrote none of it, so this is the pre-run
    baseline the tally compares against."""
    base = {}
    start = 0
    while True:
        chunk = (db.table("scraped_inventory")
                 .select("vin, price, status, photos, is_active")
                 .eq("user_id", uid)
                 .range(start, start + 999)
                 .execute()).data or []
        for r in chunk:
            if r.get("vin"):
                base[r["vin"]] = r
        if len(chunk) < 1000:
            return base
        start += 1000


def _tally_field_changed(written, stored):
    """A field counts as changed only when the run produced a value
    for it and it differs from the stored one. A missing value on the
    run's side preserves the stored one in production's writer, so it
    is never evidence of change."""
    if written.get("price") is not None and written["price"] != stored.get("price"):
        return True
    if written.get("status") is not None and written["status"] != stored.get("status"):
        return True
    w_photos = written.get("photos") or []
    if w_photos and w_photos != (stored.get("photos") or []):
        return True
    return False


def _tally_compute(uid, acc, started_at, finished_at):
    base = _tally_baseline(uid)
    seen = acc["seen"]
    written = acc["written"]
    new_added = updated = exited = None
    if base:
        new_added = sum(1 for vin in written if vin not in base)
        updated = sum(1 for vin, w in written.items()
                      if vin in base and _tally_field_changed(w, base[vin]))
        # Exits are only honest on a complete, trusted, uncapped
        # crawl — the same gate production's stale pass uses.
        complete = (not acc["capped"] and not acc["failed_feeds"]
                    and bool(acc["feeds"]) and all(acc["feeds"].values()))
        if complete:
            exited = sum(1 for vin, r in base.items()
                         if r.get("is_active") and vin not in seen)
    # An empty baseline means the stored inventory is not visible to
    # this run's key at all: every comparison count would be invented
    # (all-written "new", zero exits), so they stay NULL ("—").
    # vehicles_checked still stands — it comes from the run itself.
    return {
        "user_id": uid,
        "run_started_at": started_at,
        "run_finished_at": finished_at,
        "vehicles_checked": len(seen),
        "new_added": new_added,
        "updated": updated,
        "exited_removed": exited,
        "queued_posts": None,
        "queued_deletes": None,
        "source": "shadow",
    }


def _flush_sync_summaries(run_id):
    """Insert one sync_summaries row per user of a finished shadow
    run. Fully fail-open: any failure becomes a printed warning, never
    an exception, and each user is isolated from the others."""
    try:
        entry = _SYNC_TALLY.pop(run_id, None)
        if not entry:
            return
        if os.environ.get("SCRAPER_NEXT_SHADOW") != "1":
            return
        finished_at = _now_iso()
        rows = []
        for uid, acc in (entry.get("users") or {}).items():
            try:
                row = _tally_compute(uid, acc, entry.get("started_at"),
                                     finished_at)
                rows.append(row)
                try:
                    db.table("sync_summaries").insert(row).execute()
                except Exception as e:
                    print(f"[!] Sync summary insert warning ({uid}): {e}")
            except Exception as e:
                print(f"[!] Sync summary tally warning ({uid}): {e}")
        if rows:
            _LAST_SYNC_SUMMARIES[run_id] = rows
    except Exception as e:
        print(f"[!] Sync summary flush warning: {e}")


# =============================================================================
# FEED PIPELINE — fetcher-agnostic so the harness drives the same code
# =============================================================================
# A fetcher is an async callable: fetch(url) -> {status, html,
# browser_cars, browser_ms}. browser_cars is the production in-page
# extractor's result (None = not attempted / unavailable, e.g. tests).
# process_feed buffers the whole feed, enriches, evaluates, and only
# then writes — that ordering is what makes quarantine possible.

class FeedDead(Exception):
    pass


def _strip_private(car: dict) -> dict:
    return {k: v for k, v in car.items() if not k.startswith("_")}


async def process_feed(feed: dict, ctx_base: dict, fetcher, eff_pb: dict,
                       run_id: str, opts: dict) -> dict:
    t_start = time.monotonic()
    uid = ctx_base["uid"]
    condition = feed["condition"]
    site_key = site_key_for(feed["url"], condition)
    host = urlparse(feed["url"]).netloc.lower()
    outcome = {
        "site_key": site_key, "host": host, "condition": condition,
        "platform": None, "platform_evidence": None,
        "pages": 0, "cars_found": 0, "cars_written": 0,
        "held": [], "uncertain_count": 0, "quarantined": False,
        "reasons": [], "strategies": {}, "seconds": 0.0,
        "error": None, "trusted": False, "seen_vins": set(),
        "rate_limit_hits": 0, "sitemap_url": None, "recrawl_of": False,
    }
    cars_by_vin = {}
    strat_agg = {}
    platform_done = False
    limit = opts.get("limit") or 0

    def note_attempt(name, n_cars, ms, page_attempts):
        page_attempts.append((name, n_cars, ms))

    def flush_attempts(page_attempts):
        for name, n_cars, ms in page_attempts:
            agg = strat_agg.setdefault(name, {"cars": 0, "ms": 0, "tried": False})
            agg["tried"] = True
            agg["cars"] += n_cars
            agg["ms"] += ms

    for pt in range(1, MAX_PAGES_PER_FEED + 1):
        if limit and len(cars_by_vin) >= limit:
            break
        url = S.build_page_url(feed["url"], opts.get("page_modifier") or "?pt={page}", pt)
        res = await fetcher(url)
        status = res.get("status")
        if status in (429, 403):
            outcome["rate_limit_hits"] += 1
        if status == 404:
            if pt == 1:
                raise FeedDead(f"feed URL 404: {url}")
            break
        html = res.get("html") or ""
        if not platform_done:
            outcome["platform"], outcome["platform_evidence"] = detect_platform(html, url)
            platform_done = True
            sm = re.search(r'href=["\']([^"\']*sitemap[^"\']*)["\']', html, re.I)
            if sm and ("vehicle" in sm.group(1) or "inventory" in sm.group(1)):
                outcome["sitemap_url"] = sm.group(1)
        ctx = dict(ctx_base)
        ctx.update({"condition": condition, "page_url": url})
        page_cars = []
        page_attempts = []
        browser_cars = res.get("browser_cars")
        if browser_cars is not None:
            note_attempt("browser", len(browser_cars), res.get("browser_ms", 0), page_attempts)
        if browser_cars:
            page_cars = browser_cars
        else:
            order = [s for s in eff_pb.get("strategy_order", STRATEGY_ORDER_DEFAULT)
                     if s in HTML_STRATEGIES]
            lad = extract_with_ladder(html, order, ctx)
            for a in lad["attempts"]:
                note_attempt(a["strategy"], a["cars"] if a["strategy"] == lad["strategy"] else 0, a["ms"], page_attempts)
            page_cars = lad["cars"]
        # Strategy stats are only learned from pages where SOME
        # strategy found cars (plus page 1, where an all-empty result
        # is a real signal): the empty final page of a feed would
        # otherwise hand every strategy a fake "empty" every run.
        if page_cars or pt == 1:
            flush_attempts(page_attempts)
        if not page_cars:
            break
        page_vins = {c["vin"] for c in page_cars if c.get("vin")}
        if page_vins and page_vins.issubset(set(cars_by_vin.keys())):
            break  # duplicate batch: end of feed (production parity)
        for c in page_cars:
            if c.get("vin"):
                c.setdefault("user_id", uid)
                cars_by_vin[c["vin"]] = c
        outcome["pages"] += 1

    cars = list(cars_by_vin.values())
    if limit and len(cars) > limit:
        cars = cars[:limit]
    outcome["cars_found"] = len(cars)
    outcome["seen_vins"] = {c["vin"] for c in cars if c.get("vin")}

    if opts.get("enrich_fn") and cars:
        try:
            await opts["enrich_fn"](cars)
        except Exception as e:
            print(f"[!] Enrichment warning ({site_key}): {e}")

    # CARFAX trial pass (opt-in: entry points supply carfax_fn only
    # under SCRAPER_NEXT_CARFAX=1). Runs before evaluation so a
    # captured link rides the write rows like any other field; its
    # rejects join the run's review list under field "carfax_url".
    carfax_stats, carfax_unc = None, []
    if opts.get("carfax_fn") and cars:
        try:
            carfax_stats, carfax_unc = await opts["carfax_fn"](cars)
        except Exception as e:
            print(f"[!] CARFAX pass warning ({site_key}): {e}")
    outcome["carfax"] = carfax_stats

    verdict = evaluate_lot(cars, eff_pb)
    outcome["eval_stats"] = verdict["stats"]
    outcome["quarantined"] = verdict["quarantine"]
    outcome["reasons"] = verdict["reasons"]
    outcome["held"] = verdict["held"]
    outcome["uncertain_count"] = len(verdict["uncertain"]) + len(carfax_unc)
    outcome["strategies"] = strat_agg

    log_uncertain(run_id, uid, site_key, verdict["uncertain"])
    if carfax_unc:
        log_uncertain(run_id, uid, site_key, carfax_unc)

    tally_rows = []
    if verdict["quarantine"]:
        outcome["trusted"] = False
    else:
        tally_rows = [_strip_private(c) for c in verdict["write_cars"]]
        if tally_rows:
            outcome["cars_written"] = opts["push_fn"](tally_rows)
        outcome["trusted"] = True
    # Bookkeeping only (sync-summary popup): remember what this feed
    # saw and the exact rows it handed to its push function. Pure
    # in-memory, never raises, changes nothing above.
    _tally_register(run_id, uid, site_key, outcome["seen_vins"], tally_rows,
                    capped=bool(opts.get("limit")), trusted=outcome["trusted"])
    outcome["seconds"] = round(time.monotonic() - t_start, 2)
    return outcome


def learn_from_outcome(pb: dict, outcome: dict, facts_extra: dict) -> dict:
    """Fold one feed outcome into a playbook. Bands and stats are only
    learned from TRUSTED (non-quarantined) outcomes — the engine does
    not teach itself from suspect data."""
    pb = json.loads(json.dumps(pb))
    for name, agg in (outcome.get("strategies") or {}).items():
        if agg.get("tried"):
            record_strategy(pb, name, agg["cars"], agg["ms"])
    if outcome.get("trusted"):
        stats = {
            "count": outcome["cars_found"],
            "median_price": None,
            "photo_median": None,
        }
        # Band inputs come from the outcome's evaluation stats.
        ev = outcome.get("eval_stats") or {}
        stats["median_price"] = ev.get("median_price")
        stats["photo_median"] = ev.get("photo_median")
        update_bands(pb, stats)
    pb["timings"] = (pb.get("timings") or [])[-11:] + [{
        "at": _now_iso(), "seconds": outcome["seconds"],
        "cars": outcome["cars_found"], "pages": outcome["pages"],
    }]
    if outcome.get("rate_limit_hits"):
        pb["rate_limit_hits"] = pb.get("rate_limit_hits", 0) + outcome["rate_limit_hits"]
        cap = pb.get("concurrency_cap") or S.VDP_FETCH_CONCURRENCY
        pb["concurrency_cap"] = max(1, cap - 1)
    if outcome.get("platform"):
        pb["platform"] = outcome["platform"]
        pb["platform_evidence"] = outcome.get("platform_evidence")
    facts = {
        "site_key": outcome["site_key"], "host": outcome["host"],
        "platform": outcome.get("platform"), "platform_evidence": outcome.get("platform_evidence"),
        "sitemap_url": outcome.get("sitemap_url"),
        "rate_limit_hits": pb.get("rate_limit_hits", 0),
        "strategy_stats": pb.get("strategy_stats") or {},
    }
    facts.update(facts_extra or {})
    merge_needs(pb, generate_needs(facts))
    pb["last_outcome"] = {
        "at": _now_iso(), "cars": outcome["cars_found"],
        "written": outcome["cars_written"], "quarantined": outcome["quarantined"],
        "error": outcome.get("error"),
    }
    return pb


async def crawl_feed(feed: dict, ctx_base: dict, fetcher_factory, eff_pb: dict,
                     run_id: str, opts: dict) -> dict:
    """Retry wrapper: a failed feed is retried with backoff + jitter
    and never sinks the run. Writes happen only at the end of a
    successful process_feed, so a retry never double-writes (and the
    writer upserts by (vin, user_id) regardless)."""
    sleep_fn = opts.get("sleep_fn") or asyncio.sleep
    last_err = None
    for attempt in range(len(RETRY_BACKOFFS) + 1):
        try:
            fetcher = await fetcher_factory()
            outcome = await process_feed(feed, ctx_base, fetcher, eff_pb, run_id, opts)
            outcome["attempts"] = attempt + 1
            return outcome
        except Exception as e:
            last_err = e
            if attempt < len(RETRY_BACKOFFS):
                delay = RETRY_BACKOFFS[attempt] * random.uniform(0.7, 1.3)
                print(f"[!] Feed {feed['url']} attempt {attempt + 1} failed ({e}); retrying in {delay:.1f}s")
                await sleep_fn(delay)
    site_key = site_key_for(feed["url"], feed["condition"])
    _tally_mark_feed_failed(run_id, ctx_base.get("uid"), site_key)
    return {
        "site_key": site_key, "host": urlparse(feed["url"]).netloc.lower(),
        "condition": feed["condition"], "platform": None, "platform_evidence": None,
        "pages": 0, "cars_found": 0, "cars_written": 0, "held": [],
        "uncertain_count": 0, "quarantined": False, "reasons": [],
        "strategies": {}, "seconds": 0.0, "error": str(last_err),
        "trusted": False, "seen_vins": set(), "rate_limit_hits": 0,
        "sitemap_url": None, "recrawl_of": False, "carfax": None,
        "attempts": len(RETRY_BACKOFFS) + 1,
    }


# =============================================================================
# CARFAX LINK CAPTURE (shadow trial, Matthew approved 2026-10-29)
# =============================================================================
# Dealer VDPs carry a "Show Me the CARFAX" badge in the car's benefits
# block whose anchor opens the free CARFAX report the dealer publishes
# for that car (on the Moses/DealerOn template: <a class="reportImg"
# data-loc="carfax" href="https://www.carfax.com/vehiclehistory/ar20/
# <token>">, verified in the raw served HTML 2026-10-29). This section
# teaches the SHADOW engine to capture that link per car:
#
# * extract_carfax_url() is a pure function over one VDP's raw HTML.
#   Scoping mirrors production's price_status rule: script/style are
#   stripped first (the platform's CSS mentions the cross-sell classes
#   long before the real section), then the page is cut at the
#   "Vehicles You Might Like" cross-sell — a cross-sell car's badge
#   must never land on the host car.
# * Validation: a URL that carries a parseable VIN (a vin= parameter
#   or a path segment that is exactly a VIN) must name THIS car, or
#   the link is rejected into scraper_uncertain — a wrong-car report
#   link in a listing is the critical hazard. The DealerOn ar20 token
#   carries no parseable VIN; there the section scoping + the report
#   path shape are the guards.
# * The pass runs ONLY when an entry point supplies opts["carfax_fn"]
#   (env SCRAPER_NEXT_CARFAX=1). Standing shadow runs and any
#   production-parity run are byte-for-byte unaffected. A verified
#   find sets car["carfax_url"]; a no-find NEVER sets the key, so no
#   writer downstream can erase a previously captured value (the
#   writers upsert only the keys a record carries).

_CARFAX_CROSS_SELL_MARKERS = (
    "vehicles you might like",
    "you may also like",
    "similar vehicles",
    "recommended vehicles",
    "similar-vehicles",
)
_CARFAX_ANCHOR_RE = re.compile(r"<a\b[^>]*>.*?</a>", re.S | re.I)
_CARFAX_HREF_RE = re.compile(r"""href\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
_CARFAX_VIN_TOKEN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


def _carfax_main_section(html: str) -> str:
    """The car's own VDP region: script/style stripped, cut at the
    cross-sell — the same scoping production's price_status uses."""
    stripped = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
    low = stripped.lower()
    cut = len(stripped)
    for marker in _CARFAX_CROSS_SELL_MARKERS:
        idx = low.find(marker)
        if 0 <= idx < cut:
            cut = idx
    return stripped[:cut]


def _carfax_url_vin(url: str):
    """A VIN the URL itself asserts, or None: the vin= query parameter,
    or a path segment that is exactly a 17-char VIN. An opaque report
    token (DealerOn's ar20) yields None — no assertion to check."""
    try:
        parts = urlparse(url)
    except Exception:
        return None
    for pair in (parts.query or "").split("&"):
        if pair.lower().startswith("vin="):
            val = pair[4:].strip().upper()
            if _CARFAX_VIN_TOKEN_RE.match(val):
                return val
    for seg in (parts.path or "").split("/"):
        seg = seg.strip().upper()
        if _CARFAX_VIN_TOKEN_RE.match(seg):
            return seg
    return None


def extract_carfax_url(html: str, vin: str, page_url: str = "") -> dict:
    """Find this car's CARFAX report link in its VDP HTML.

    Returns {url, form, badge_seen, reject, evidence}:
    * form: "direct" (carfax.com report URL), "redirector" (a URL
      naming carfax off-host), "dealer_page" (dealer-hosted report
      path), "js_only" (badge present, no usable href), or None.
    * reject: a human reason when a badge link was REFUSED (the
      caller files it in scraper_uncertain); url is None then.
    """
    out = {"url": None, "form": None, "badge_seen": False,
           "reject": None, "evidence": ""}
    if not html:
        return out
    main = _carfax_main_section(html)
    origin = ""
    if page_url:
        p = urlparse(page_url)
        if p.scheme and p.netloc:
            origin = f"{p.scheme}://{p.netloc}"

    candidates = []
    for m in _CARFAX_ANCHOR_RE.finditer(main):
        block = m.group(0)
        if "carfax" not in block.lower():
            continue
        out["badge_seen"] = True
        open_tag = block[:block.find(">") + 1] if ">" in block else block
        hm = _CARFAX_HREF_RE.search(open_tag)
        href = ""
        if hm:
            href = (hm.group(1) or hm.group(2) or "").strip()
        if href and not href.lower().startswith(("javascript:", "#", "mailto:")):
            candidates.append(href)
    if not out["badge_seen"]:
        # Badge artwork can exist without any anchor wrapping it.
        if re.search(r"partnerstatic\.carfax\.com|data-loc=[\"']carfax[\"']", main, re.I):
            out["badge_seen"] = True
    if not out["badge_seen"]:
        return out
    if not candidates:
        out["form"] = "js_only"
        out["evidence"] = "CARFAX badge present but no usable anchor href (JS-only)"
        return out

    vin_u = (vin or "").strip().upper()
    first_bad = None
    for raw in candidates:
        href = raw.replace("&amp;", "&")
        if href.startswith("//"):
            href = "https:" + href
        elif href.startswith("/") and origin:
            href = origin + href
        if not href.startswith("http"):
            continue
        host = (urlparse(href).netloc or "").lower()
        path = (urlparse(href).path or "").lower()
        if host.endswith("carfax.com"):
            form = "direct"
            is_report = "/vehiclehistory/" in path
        elif "carfax" in href.lower():
            form, is_report = "redirector", True
        elif any(t in path for t in ("vehiclehistory", "vehicle-history",
                                     "history-report", "carfax")):
            form, is_report = "dealer_page", True
        else:
            form, is_report = None, False
        if not is_report:
            if first_bad is None:
                first_bad = (href, "badge link does not resolve to a report URL")
            continue
        asserted = _carfax_url_vin(href)
        if asserted and vin_u and asserted != vin_u:
            if first_bad is None:
                first_bad = (href, f"report URL names VIN {asserted}, not this car's VIN {vin_u}")
            continue
        out["url"] = href
        out["form"] = form
        out["evidence"] = f"form={form}; href={href[:180]}"
        return out
    if first_bad:
        out["reject"] = first_bad[1]
        out["evidence"] = f"refused href={first_bad[0][:180]}"
    elif candidates:
        out["form"] = "js_only"
        out["evidence"] = "CARFAX anchors present but none carried an http(s) href"
    return out


async def carfax_enrich_pass(context, cars: list):
    """Fetch each in-scope (Used / Certified Pre-Owned) car's VDP once
    and capture its CARFAX link. Sets car["carfax_url"] ONLY on a
    verified find — a no-find leaves the key unset so no downstream
    write can erase a stored value. Returns (stats, uncertain_rows).
    Mirrors production's VDP fetch discipline (context.request,
    semaphore 5, 20s timeout); any failure is an honest 'unfetched',
    never a guess."""
    stats = {"visited": 0, "fetched": 0, "badges": 0, "captured": 0,
             "rejected": 0, "no_badge": 0, "js_only": 0}
    uncertain = []
    sem = asyncio.Semaphore(5)

    def in_scope(car):
        cond = (car.get("condition") or "").strip().lower()
        return cond.startswith("used") or cond.startswith("certified")

    async def one(car):
        detail_url = car.get("detail_url")
        if not detail_url:
            return
        stats["visited"] += 1
        html = None
        async with sem:
            try:
                resp = await context.request.get(detail_url, timeout=20000)
                if resp.status == 200:
                    html = await resp.text()
            except Exception:
                html = None
        if not html:
            return
        stats["fetched"] += 1
        try:
            r = extract_carfax_url(html, car.get("vin") or "", detail_url)
        except Exception as e:
            r = {"url": None, "form": None, "badge_seen": False,
                 "reject": f"extractor error: {e}", "evidence": ""}
        if r.get("badge_seen"):
            stats["badges"] += 1
        if r.get("url"):
            car["carfax_url"] = r["url"]
            stats["captured"] += 1
        elif r.get("reject"):
            stats["rejected"] += 1
            uncertain.append({
                "vin": car.get("vin"), "field": "carfax_url",
                "found_value": (r.get("evidence") or "")[:180],
                "reason": f"CARFAX link rejected: {r['reject']}",
                "evidence": (r.get("evidence") or "")[:500],
            })
        elif r.get("form") == "js_only":
            stats["js_only"] += 1
        elif not r.get("badge_seen"):
            stats["no_badge"] += 1

    await asyncio.gather(*(one(c) for c in cars if in_scope(c)),
                         return_exceptions=True)
    return stats, uncertain


def carfax_apply_writes(rows, uid) -> dict:
    """Targeted carfax_url writes for the shadow trial: one column,
    filtered by (vin, user_id), only for rows carrying a verified
    link. This is the ONLY inventory write the shadow path can make,
    and only when an entry point explicitly calls it under its
    opt-in flag. Returns {"attempted", "errors"}; the caller verifies
    landed values by readback."""
    seen = {}
    for r in rows:
        u = (r.get("carfax_url") or "").strip()
        v = (r.get("vin") or "").strip()
        if u and v:
            seen[v] = u
    errors = 0
    for v, u in seen.items():
        try:
            db.table("scraped_inventory").update(
                {"carfax_url": u}).eq("vin", v).eq("user_id", uid).execute()
        except Exception as e:
            errors += 1
            print(f"[!] CARFAX write warning ({v}): {e}")
    return {"attempted": len(seen), "errors": errors}


# =============================================================================
# DIGEST — the run's report (printed; also stored on the finished row)
# =============================================================================

def build_digest(outcomes: list, needs_pb: dict, totals: dict, trend: list) -> str:
    lines = []
    lines.append("=" * 68)
    lines.append(f"SCRAPER_NEXT DIGEST — run {totals.get('run_id', '?')}")
    lines.append("=" * 68)
    for o in outcomes:
        status = ("FAILED: " + o["error"]) if o.get("error") else (
            "QUARANTINED: " + "; ".join(o["reasons"])) if o["quarantined"] else "ok"
        strat = ",".join(k for k, v in (o.get("strategies") or {}).items() if v.get("cars")) or "-"
        lines.append(
            f"[{o['condition']:<18}] {o['host']} via {o.get('platform') or 'unknown'} / {strat}: "
            f"{o['cars_found']} found, {o['cars_written']} written, "
            f"{len(o.get('held') or [])} held, {o.get('uncertain_count', 0)} uncertain "
            f"({o['seconds']}s) — {status}")
    platforms = {}
    for o in outcomes:
        platforms[o.get("platform") or "unknown"] = platforms.get(o.get("platform") or "unknown", 0) + 1
    lines.append("")
    lines.append("Platform coverage: " + ", ".join(f"{k} ×{v}" for k, v in sorted(platforms.items())))
    cfx = [o for o in outcomes if o.get("carfax")]
    if cfx:
        lines.append("")
        lines.append("CARFAX link capture (shadow trial — Used/CPO VDPs only):")
        tot = {"visited": 0, "fetched": 0, "badges": 0, "captured": 0,
               "rejected": 0, "no_badge": 0, "js_only": 0}
        for o in cfx:
            s = o["carfax"]
            for k in tot:
                tot[k] += s.get(k, 0)
            pct = (s["captured"] / s["fetched"] * 100) if s.get("fetched") else 0.0
            lines.append(
                f"  [{o['condition']:<18}] {o['host']}: {s['visited']} visited, "
                f"{s['fetched']} fetched, {s['badges']} badges, "
                f"{s['captured']} captured ({pct:.0f}% of fetched), "
                f"{s['rejected']} rejected, {s['no_badge']} no badge, "
                f"{s['js_only']} JS-only")
        tpct = (tot["captured"] / tot["fetched"] * 100) if tot["fetched"] else 0.0
        lines.append(
            f"  TOTAL: {tot['visited']} visited, {tot['fetched']} fetched, "
            f"{tot['badges']} badges, {tot['captured']} captured "
            f"({tpct:.0f}% of fetched), {tot['rejected']} rejected, "
            f"{tot['no_badge']} no badge, {tot['js_only']} JS-only")
    for o in outcomes:
        if (o.get("platform") or "unknown") == "unknown":
            lines.append(f"  ⚠ UNRECOGNIZED platform at {o['host']} ({o.get('platform_evidence') or 'no evidence'}) — compatibility gap, learning per-lot only.")
    incomplete = [o for o in outcomes if o.get("error") or o["quarantined"]]
    lines.append(f"Lots that did not complete cleanly: {len(incomplete)}"
                 + ("" if not incomplete else " — " + ", ".join(o["site_key"] for o in incomplete)))
    unc = sum(o.get("uncertain_count", 0) for o in outcomes)
    lines.append(f"Uncertain items sent to the review list (scraper_uncertain): {unc}")
    total_s = totals.get("seconds", 0)
    cpm = (totals.get("cars", 0) / (total_s / 60)) if total_s else 0
    lines.append(f"Runtime: {total_s:.0f}s for {totals.get('cars', 0)} cars ({cpm:.1f} cars/min).")
    prev = [t.get("seconds") for t in trend if t.get("seconds")]
    if prev:
        lines.append(f"Runtime trend (previous finished runs, seconds): {', '.join(str(int(x)) for x in prev)}")
    else:
        lines.append("Runtime trend: no prior scraper_next runs recorded yet — this run sets the baseline. "
                     "(The current production scraper is not instrumented, so no honest baseline exists for it.)")
    needs = open_needs(needs_pb)
    lines.append("")
    lines.append("What would make me faster:")
    if needs:
        for n in needs:
            lines.append(f"  - {n['text']} [evidence: {n['evidence']}]")
    else:
        lines.append("  - Nothing evidenced this run.")
    return "\n".join(lines)


# =============================================================================
# RUN ORCHESTRATION — mirrors scraper.run_scraper's enumeration & gates
# =============================================================================

async def run_next(opts_override: dict = None) -> list:
    opts_override = opts_override or {}
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    run_started = time.monotonic()
    resume_run = opts_override.get("resume_run_id") or os.environ.get("SCRAPER_NEXT_RESUME")
    done_feeds = set()
    if resume_run:
        try:
            rows = (db.table("scraper_run_log").select("site_key")
                    .eq("run_id", resume_run).eq("event", "feed_done").execute()).data or []
            done_feeds = {r["site_key"] for r in rows if r.get("site_key")}
            print(f"[*] Resuming run {resume_run}: {len(done_feeds)} feed(s) already done, skipping them.")
        except Exception as e:
            print(f"[!] Resume lookup warning: {e}")

    heartbeat(run_id, "started", detail={"resume_of": resume_run})
    target_uid = (os.environ.get("USER_ID") or "").strip()
    # Production parity: if this run serves an app-queued job, it must
    # be the row that gets marked completed at the end.
    active_job_id = None
    if target_uid:
        try:
            pj = (db.table("scrape_jobs").select("*")
                  .eq("user_id", target_uid).eq("status", "pending").execute())
            if pj.data:
                active_job_id = max(pj.data, key=lambda x: x["started_at"])["id"]
        except Exception as e:
            print(f"[!] Pending-job lookup warning: {e}")
    try:
        if target_uid:
            res = db.table("user_settings").select("*").eq("user_id", target_uid).execute()
        else:
            res = db.table("user_settings").select("*").execute()
        users = res.data or []
    except Exception as e:
        heartbeat(run_id, "finished", detail={"error": f"user load failed: {e}", "seconds": 0, "cars": 0})
        print(f"[!] Could not load users: {e}")
        return []

    # AUTO-SYNC SWITCH parity (Matthew, 2026-10-29): mirror
    # production — an auto run (this run serves no pending job)
    # skips users whose user_settings.auto_sync_enabled is False.
    # Uses production's own helper (scraper._auto_sync_skipped_uids)
    # so the two selection paths cannot drift.
    try:
        _auto_sync_skipped = S._auto_sync_skipped_uids(
            users, active_job_id is not None)
    except Exception as e:
        print(f"[!] Auto-sync switch warning (non-fatal, proceeding): {e}")
        _auto_sync_skipped = []
    if _auto_sync_skipped:
        for _skipped_uid in _auto_sync_skipped:
            print(f"[*] Auto-sync OFF for user {_skipped_uid[:8]}: "
                  "skipping this run (production parity).")
        print(f"[*] Auto-sync: skipped {len(_auto_sync_skipped)} of "
              f"{len(users)} account(s) with auto-sync off.")
        _auto_sync_skipped_set = set(_auto_sync_skipped)
        users = [u for u in users
                 if u.get("user_id") not in _auto_sync_skipped_set]

    limit = opts_override.get("limit", S.SCRAPE_LIMIT)
    outcomes_all = []
    total_written = 0
    needs_union = default_playbook()

    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=[
            "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080})
        page = await context.new_page()

        async def enrich(cars):
            await S.enrich_cars_with_vdp(context, cars)

        # CARFAX trial pass — opt-in only (SCRAPER_NEXT_CARFAX=1).
        # Default None: standing runs behave exactly as before.
        carfax_fn = None
        if os.environ.get("SCRAPER_NEXT_CARFAX") == "1":
            async def carfax_fn(cars):
                return await carfax_enrich_pass(context, cars)

        for user_cfg in users:
            uid = user_cfg.get("user_id")
            if not uid:
                continue
            store_name = user_cfg.get("dealership_name") or user_cfg.get("store_name") or "User Store"
            feeds = []
            for key, cond in (("used_url", "Used"), ("certified_url", "Certified Pre-Owned"), ("new_url", "New")):
                u = (user_cfg.get(key) or "").strip()
                if u:
                    feeds.append({"url": u, "condition": cond})
            if not feeds:
                continue
            user_seen, user_trusted = set(), True
            quarantined_feeds = []
            user_outcomes = []
            for feed in feeds:
                sk = site_key_for(feed["url"], feed["condition"])
                if sk in done_feeds:
                    print(f"[*] Resume: skipping completed feed {sk}")
                    continue
                lot_pb = load_playbook("lot", sk, uid)
                plat_name = lot_pb.get("platform")
                plat_pb = load_playbook("platform", f"platform:{plat_name}", None) if plat_name else default_playbook()
                eff_pb = merge_playbooks(plat_pb, lot_pb)

                async def make_fetcher(feed=feed, cond=feed["condition"]):
                    async def fetch(url):
                        # A navigation failure must SURFACE (retry /
                        # feed-failed), never silently extract from
                        # whatever page happens to be open — the exact
                        # failure the production audit flagged.
                        resp = await page.goto(url, wait_until="commit", timeout=30000)
                        status = resp.status if resp else None
                        if status is None:
                            raise FeedDead(f"no response: {url}")
                        await asyncio.sleep(2)
                        browser_cars, browser_ms = None, 0
                        t0 = time.monotonic()
                        try:
                            browser_cars = await S.extract_cards_from_page(
                                page, default_condition=cond, active_uid=uid)
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

                feed_opts = {
                    "limit": limit, "page_modifier": user_cfg.get("page_modifier") or "?pt={page}",
                    "push_fn": S.push_batch_to_supabase, "enrich_fn": enrich, "carfax_fn": carfax_fn,
                }
                ctx_base = {"uid": uid, "location_name": store_name}
                outcome = await crawl_feed(feed, ctx_base, make_fetcher, eff_pb, run_id, feed_opts)
                outcome["store"] = store_name
                user_outcomes.append(outcome)
                outcomes_all.append(outcome)
                if outcome.get("error"):
                    user_trusted = False
                    heartbeat(run_id, "feed_failed", uid, sk, {"error": outcome["error"]})
                elif outcome["quarantined"]:
                    user_trusted = False
                    quarantined_feeds.append((feed, outcome))
                    heartbeat(run_id, "feed_quarantined", uid, sk, {"reasons": outcome["reasons"]})
                else:
                    user_seen |= outcome["seen_vins"]
                    heartbeat(run_id, "feed_done", uid, sk, {
                        "cars": outcome["cars_written"], "seconds": outcome["seconds"]})
                total_written += outcome["cars_written"]

                # Learn at both levels (lot + its platform).
                new_lot_pb = learn_from_outcome(lot_pb, outcome, {})
                save_playbook("lot", sk, uid, new_lot_pb.get("platform"), new_lot_pb)
                if outcome.get("platform"):
                    psk = f"platform:{outcome['platform']}"
                    cur_plat = load_playbook("platform", psk, None)
                    new_plat_pb = learn_from_outcome(cur_plat, outcome, {})
                    save_playbook("platform", psk, None, outcome["platform"], new_plat_pb)
                needs_union["needs"] = (needs_union.get("needs") or []) + (new_lot_pb.get("needs") or [])

            # One re-crawl attempt for quarantined feeds.
            for feed, first in quarantined_feeds:
                print(f"[*] Re-crawling quarantined feed once: {feed['url']}")
                sk = site_key_for(feed["url"], feed["condition"])
                lot_pb = load_playbook("lot", sk, uid)
                plat_pb = load_playbook("platform", f"platform:{lot_pb.get('platform')}", None) if lot_pb.get("platform") else default_playbook()
                eff_pb = merge_playbooks(plat_pb, lot_pb)
                feed_opts = {
                    "limit": limit, "page_modifier": user_cfg.get("page_modifier") or "?pt={page}",
                    "push_fn": S.push_batch_to_supabase, "enrich_fn": enrich, "carfax_fn": carfax_fn,
                }
                try:
                    fetcher = await make_fetcher(feed=feed, cond=feed["condition"])
                    second = await process_feed(feed, {"uid": uid, "location_name": store_name},
                                                fetcher, eff_pb, run_id, feed_opts)
                    second["recrawl_of"] = True
                    second["store"] = store_name
                    if not second["quarantined"] and not second.get("error"):
                        idx = outcomes_all.index(first)
                        outcomes_all[idx] = second
                        user_seen |= second["seen_vins"]
                        total_written += second["cars_written"]
                        heartbeat(run_id, "feed_done", uid, sk, {"cars": second["cars_written"], "recrawl": True})
                        if all(o.get("trusted") for o in user_outcomes if o is not first):
                            user_trusted = True
                    else:
                        heartbeat(run_id, "feed_quarantined", uid, sk, {"reasons": second["reasons"], "recrawl": True})
                except Exception as e:
                    print(f"[!] Re-crawl failed for {feed['url']}: {e}")

            # Stale + auto-post: only on a fully trusted, uncapped crawl
            # (production's gate, extended with quarantine).
            if limit:
                print(f"[*] Capped run for {store_name}: stale pass + auto-post skipped.")
            elif user_seen and user_trusted:
                S.mark_stale_inventory(uid, user_seen)
                S._auto_post_filtered(uid)
            else:
                print(f"[*] Stale pass + auto-post skipped for {store_name}: crawl not fully trusted.")

        await browser.close()

    totals = {"run_id": run_id, "seconds": round(time.monotonic() - run_started, 1),
              "cars": total_written}
    trend = recent_run_totals(5)
    digest = build_digest(outcomes_all, needs_union, totals, trend)
    print("\n" + digest)
    heartbeat(run_id, "finished", detail={**totals, "lots": len(outcomes_all)})
    if active_job_id:
        try:
            db.table("scrape_jobs").update({
                "status": "completed",
                "completed_at": _now_iso(),
                "cars_synced": total_written,
            }).eq("id", active_job_id).execute()
            print(f"[✓] Job {active_job_id} marked completed.")
        except Exception as e:
            print(f"[!] Could not update scrape job: {e}")
    return outcomes_all


if __name__ == "__main__":
    asyncio.run(run_next())
