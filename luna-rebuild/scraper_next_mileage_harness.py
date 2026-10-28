"""Harness for the 2026-10-28 mileage fixes (scraper_next step 2, part A).

Two fixes under test:
  1. scraper.parse_vdp_details mileage fallback (rebuild tree only):
     the old pattern searched RAW html, hit the CSS selector
     `.mileage-icon` in the DealerOn <style> block, and captured the
     "5" of the hex color #c5c5c5. The fix searches visible text
     only with a tight label-to-value bridge.
  2. scraper_next.evaluate_lot mileage sanity gate: a Used car 3+
     model years old reporting single-digit mileage is held +
     review-listed; new/recent cars with legitimately low miles
     pass.

Run against the tree this file lives in:
    python3 scraper_next_mileage_harness.py
Control run: copy this file into a PRE-FIX tree (scraper.py +
scraper_next.py at step-1 HEAD) and run it there — every fix
assertion must FAIL while the parity assertions still pass.

If SCRAPER_NEXT_REAL_VDP_DIR points at a folder holding real
captured DealerOn VDP pages (trailblazer.html / lexus.html /
crv.html from the step-1 spot-check VINs), the parity + mileage
checks also run against those pages.
"""
import os
import sys

# VM/CI httpx quirk: a malformed no_proxy entry breaks the Supabase
# client constructed at scraper import time (same guard the step-1
# supervisor driver used). Harmless everywhere else.
os.environ["no_proxy"] = "localhost,127.0.0.1"
os.environ["NO_PROXY"] = "localhost,127.0.0.1"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FAILURES = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


CSS = (".info .condition-icon,.info .mileage-icon{color:#c5c5c5;"
       "padding-left:2px}.info .odometer-icon{color:#c5c5c5}")


def vdp_fixture(vin, price, color, spec_mileage_text):
    spec = f"<div class='spec'>Mileage</div><div>{spec_mileage_text}</div>" if spec_mileage_text else ""
    return f"""<html><head><style>{CSS}</style>
<script type="application/ld+json">{{"@type":"Vehicle",
"vehicleIdentificationNumber":"{vin}","color":"{color}",
"offers":{{"price":{price}}},
"image":["https://cdn.example.com/a.jpg","https://cdn.example.com/b.jpg"]}}</script>
</head><body><h1>Car</h1>{spec}
<div>City/Highway 28/31 MPG</div></body></html>"""


def main():
    import scraper as S
    import scraper_next as N

    print("== parse_vdp_details mileage fallback ==")
    # Probe (informational): what the PRE-FIX raw-html pattern finds.
    import re
    old_re = r"(?:MILEAGE|ODOMETER)[^0-9]{0,120}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,6})"
    fx = vdp_fixture("KL79MPS22MB078483", 20428, "Scarlet Red Metallic", "31,786")
    probe = re.search(old_re, fx, re.I)
    print(f"  [info] pre-fix raw-html pattern on fixture -> {probe.group(1) if probe else None!r} (bug: '5' from #c5c5c5)")

    out = S.parse_vdp_details(fx, "KL79MPS22MB078483", "https://www.mosescars.com/x")
    check("used VDP spec mileage extracted (31,786)", out["mileage"] == 31786, f"got {out['mileage']}")
    check("price parity on fixture (20,428)", out["price"] == 20428, f"got {out['price']}")
    check("photos parity on fixture (2)", len(out["photos"]) == 2, f"got {len(out['photos'])}")
    check("color parity on fixture", out["color"] == "Scarlet Red Metallic", f"got {out['color']}")

    fx_none = vdp_fixture("5J6RS4H24VL002154", 33758, "Meteorite Gray Metallic", None)
    out = S.parse_vdp_details(fx_none, "5J6RS4H24VL002154", "https://www.mosescars.com/x")
    check("new-car VDP with no printed mileage -> None (honest)", out["mileage"] is None, f"got {out['mileage']}")
    check("price parity on no-mileage fixture (33,758)", out["price"] == 33758, f"got {out['price']}")

    # The 2026-10-23 Sentra case: bare "MILEAGE 442", no comma, no suffix.
    fx442 = vdp_fixture("3N1CN8EV8TL000442", 11222, "Super Black", "442")
    out = S.parse_vdp_details(fx442, "3N1CN8EV8TL000442", "https://www.mosescars.com/x")
    check("bare spec mileage extracted (442)", out["mileage"] == 442, f"got {out['mileage']}")

    print("== evaluate_lot mileage sanity gate ==")
    from datetime import datetime, timezone
    now_year = datetime.now(timezone.utc).year

    def car(vin, year, condition, mileage, price=20000):
        return {"vin": vin, "year": year, "make": "Test", "model": "Car",
                "condition": condition, "mileage": mileage, "price": price,
                "photos": ["p"] * 10, "_confidence": "high"}

    def lot_with(target):
        fillers = [car(f"1HGCM82633A00000{i}", 2022, "Used", 40000 + i) for i in range(5)]
        return [target] + fillers

    old_used = car("1FADP3KE3GL273598", now_year - 10, "Used", 5)
    v = N.evaluate_lot(lot_with(old_used), {})
    check("old used car, mileage 5 -> held",
          any(h["vin"] == old_used["vin"] for h in v["held"]))
    check("old used car, mileage 5 -> uncertain(mileage)",
          any(u["vin"] == old_used["vin"] and u["field"] == "mileage" for u in v["uncertain"]))
    check("held car excluded from write_cars",
          all(c["vin"] != old_used["vin"] for c in v["write_cars"]))

    new_car = car("5J6RS4H24VL002154", now_year + 1, "New", 5)
    v = N.evaluate_lot(lot_with(new_car), {})
    check("new car, mileage 5 -> NOT held",
          not any(h["vin"] == new_car["vin"] for h in v["held"]))

    recent_used = car("3GNAXJEV1LL169517", now_year - 2, "Used", 5)
    v = N.evaluate_lot(lot_with(recent_used), {})
    check("2-year-old used car, mileage 5 -> NOT held",
          not any(h["vin"] == recent_used["vin"] for h in v["held"]))

    boundary_used = car("2T3BF4DV9BW176273", now_year - 3, "Used", 9)
    v = N.evaluate_lot(lot_with(boundary_used), {})
    check("3-year-old used car, mileage 9 -> held (boundary)",
          any(h["vin"] == boundary_used["vin"] for h in v["held"]))

    real_used = car("2T2BAMCA8PC024110", now_year - 5, "Used", 50461)
    v = N.evaluate_lot(lot_with(real_used), {})
    check("old used car, real mileage 50,461 -> NOT held",
          not any(h["vin"] == real_used["vin"] for h in v["held"]))

    none_used = car("JF2SJAWC0HH518590", now_year - 8, "Used", None)
    v = N.evaluate_lot(lot_with(none_used), {})
    check("old used car, mileage None -> NOT held by mileage gate",
          not any(h["vin"] == none_used["vin"] for h in v["held"]))

    real_dir = os.environ.get("SCRAPER_NEXT_REAL_VDP_DIR")
    if real_dir:
        print("== real captured DealerOn VDPs ==")
        cases = [
            ("trailblazer.html", "KL79MPS22MB078483", 31786, 20428, 20),
            ("lexus.html", "2T2BAMCA8PC024110", 50461, 43295, 20),
            ("crv.html", "5J6RS4H24VL002154", None, 33758, 20),
        ]
        for fn, vin, miles, price, nphotos in cases:
            path = os.path.join(real_dir, fn)
            if not os.path.exists(path):
                print(f"  [skip] {fn} not present")
                continue
            html = open(path, encoding="utf-8", errors="replace").read()
            out = S.parse_vdp_details(html, vin, "https://www.mosescars.com/x")
            check(f"{vin} mileage == {miles}", out["mileage"] == miles, f"got {out['mileage']}")
            check(f"{vin} price parity == {price}", out["price"] == price, f"got {out['price']}")
            check(f"{vin} photos parity == {nphotos}", len(out["photos"]) == nphotos, f"got {len(out['photos'])}")

    print(f"\n{'ALL PASS' if not FAILURES else 'FAILURES: ' + ', '.join(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
