# =============================================================================
# scraper_price_gate_harness.py — verification for the $500 price gate in
# scraper._price_update_queue_rows (Matthew's rule, settled 2026-11-18:
# a listing price changes ONLY when the difference vs the posted/stamp
# price is at least $500 — gate everything, manual edits included; the
# manual Change-price flow writes the inventory price and rides this
# same drift pass, so it is gated here too by design).
#
# Drives the REAL selector from scraper.py against in-memory inventory
# rows. No network, no browser: Playwright is stubbed at import and the
# selector is pure.
#
# Run: python3 scraper_price_gate_harness.py   (exit 0 = all green)
# =============================================================================

import os
import sys
import types

# The VM's proxy env breaks this httpx build's URL parser when the
# supabase client is constructed; the harness makes no network calls,
# so scrub proxies before anything imports the client.
for _v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
           "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"):
    os.environ.pop(_v, None)

# --- stub playwright BEFORE importing scraper (scraper imports it) ---
_pw = types.ModuleType("playwright")
_api = types.ModuleType("playwright.async_api")
_api.async_playwright = None
_pw.async_api = _api
sys.modules.setdefault("playwright", _pw)
sys.modules.setdefault("playwright.async_api", _api)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scraper as S  # noqa: E402

UID = "harness-user"
FAILURES = []


def inv_row(vin, posted, current, **over):
    row = {
        "vin": vin,
        "marketplace_posted_at": "2026-11-01T00:00:00+00:00",
        "is_active": True,
        "marketplace_posted_price": posted,
        "price": current,
        "year": 2024,
        "make": "Chevrolet",
        "model": "Silverado",
        "stock_number": "STK-" + vin[-4:],
    }
    row.update(over)
    return row


def select(rows, blocked=None, failed=None):
    return S._price_update_queue_rows(
        UID, rows, blocked if blocked is not None else set(), failed or []
    )


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILURES.append(name)


# --- the gate itself -------------------------------------------------------
check("sub-$500 drift up (+$1) queues nothing",
      select([inv_row("VIN00000000000001", 57871, 57872)]) == [])
check("sub-$500 drift up (+$499) queues nothing",
      select([inv_row("VIN00000000000002", 20000, 20499)]) == [])
check("sub-$500 drift down (-$499) queues nothing",
      select([inv_row("VIN00000000000003", 20000, 19501)]) == [])
check("no drift at all queues nothing",
      select([inv_row("VIN00000000000004", 20000, 20000)]) == [])

rows = select([inv_row("VIN00000000000005", 20000, 20500)])
check("exactly $500 drift queues a row", len(rows) == 1)
if rows:
    check("payload: price=current, update_from_price=stamp, action=update_price",
          rows[0]["price"] == 20500
          and rows[0]["update_from_price"] == 20000
          and rows[0]["action"] == "update_price"
          and rows[0]["status"] == "pending")

check(">$500 drift up (+$2,164) queues a row",
      len(select([inv_row("VIN00000000000006", 54353, 56517)])) == 1)
check("price drop of exactly $500 queues a row",
      len(select([inv_row("VIN00000000000007", 20000, 19500)])) == 1)
check("price drop >$500 (-$1,069) queues a row",
      len(select([inv_row("VIN00000000000008", 40498, 39429)])) == 1)

# --- pre-existing guards still exclude -------------------------------------
check("no stamp (marketplace_posted_at None) excluded despite big drift",
      select([inv_row("VIN00000000000009", 20000, 25000,
                      marketplace_posted_at=None)]) == [])
check("no posted price stamped excluded despite big drift",
      select([inv_row("VIN00000000000010", None, 25000)]) == [])
check("inactive car excluded despite big drift",
      select([inv_row("VIN00000000000011", 20000, 25000,
                      is_active=False)]) == [])
check("is_active missing (not True) excluded despite big drift",
      select([inv_row("VIN00000000000012", 20000, 25000,
                      is_active=None)]) == [])
check("blocked VIN excluded despite big drift",
      select([inv_row("VIN00000000000013", 20000, 25000)],
             blocked={"VIN00000000000013"}) == [])
check("zero/negative current price excluded",
      select([inv_row("VIN00000000000014", 20000, 0)]) == [])

# --- mixed batch: only >=$500 rows survive ---------------------------------
batch = [
    inv_row("VIN00000000000015", 30000, 30100),   # +100 -> no
    inv_row("VIN00000000000016", 30000, 30750),   # +750 -> yes
    inv_row("VIN00000000000017", 30000, 29000),   # -1000 -> yes
    inv_row("VIN00000000000018", 30000, 30000),   # 0 -> no
]
got = select(batch)
check("mixed batch keeps exactly the two >=$500 drifts",
      sorted(r["vin"] for r in got)
      == ["VIN00000000000016", "VIN00000000000017"])

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): " + "; ".join(FAILURES))
    sys.exit(1)
print("ALL GREEN")
