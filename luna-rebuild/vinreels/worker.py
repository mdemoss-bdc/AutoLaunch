#!/usr/bin/env python3
"""
worker.py — VIN Reels worker (rebuild proof mode).

Polls public.vin_reels for status='queued' rows (oldest first), claims
one atomically (a conditional PATCH that only lands while the row is
still 'queued', so two workers can never take the same reel), then runs
generator.py for it as a subprocess. The generator owns the row from
there: it renders, QA-gates the finished file, uploads, and finishes
the row 'ready' or 'failed' with the reason.

    python3 worker.py --once          # process one queued reel, exit
    python3 worker.py                 # poll forever (20s interval)
    python3 worker.py --interval 10

PROOF MODE: this runs on the VM (see README). The production shape is
the same code on a scheduled runner; nothing in the generator depends
on where it runs.
"""
import argparse, os, subprocess, sys, time
from datetime import datetime, timezone, timedelta

import generator as gen

RENDER_TIMEOUT_S = 1500  # a 12-photo reel renders in ~5 min on the VM

def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

def claim_next():
    """Atomically claim the oldest queued row; returns it or None."""
    st, rows = gen.rest(
        "GET", "/rest/v1/vin_reels?status=eq.queued"
               "&order=created_at.asc&limit=1"
               "&select=id,user_id,vin,stock_number,status")
    if st != 200 or not rows:
        return None
    row = rows[0]
    st, body = gen.rest(
        "PATCH", f"/rest/v1/vin_reels?id=eq.{row['id']}&status=eq.queued",
        body={"status": "generating", "updated_at": gen._now_iso()},
        headers={"Prefer": "return=representation"})
    if st == 200 and body:
        return body[0]
    return None  # lost the race — another worker took it

def warn_stale():
    """Log (never touch) 'generating' rows older than 45 minutes —
    a worker died mid-render. Proof mode surfaces them; requeueing is
    a deliberate human act (delete-and-recreate via the app is the
    user's path: the stale row's VIN frees once it leaves the live
    statuses)."""
    cutoff = (datetime.now(timezone.utc)
              - timedelta(minutes=45)).isoformat()
    st, rows = gen.rest(
        "GET", "/rest/v1/vin_reels?status=eq.generating"
               f"&updated_at=lt.{cutoff}&select=id,vin,updated_at")
    if st == 200 and rows:
        for r in rows:
            log(f"WARN stale generating row {r['id']} vin={r['vin']} "
                f"since {r['updated_at']}")

def process(row):
    log(f"rendering row {row['id']} vin={row['vin']} "
        f"stock={row.get('stock_number')}")
    gen_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "generator.py")
    p = subprocess.run([sys.executable, gen_path,
                        "--row-id", row["id"]],
                       capture_output=True, text=True,
                       timeout=RENDER_TIMEOUT_S)
    for line in (p.stdout or "").splitlines():
        log("  " + line)
    if p.returncode != 0:
        log(f"generator exited {p.returncode}: "
            f"{(p.stderr or '').strip()[:300]}")
    return p.returncode

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true",
                    help="process at most one queued reel, then exit")
    ap.add_argument("--interval", type=int, default=20)
    args = ap.parse_args()

    while True:
        try:
            warn_stale()
            row = claim_next()
        except Exception as e:
            log(f"poll error: {e}")
            row = None
        if row:
            try:
                process(row)
            except subprocess.TimeoutExpired:
                log(f"render timed out after {RENDER_TIMEOUT_S}s "
                    f"(row {row['id']}) — marking failed")
                try:
                    gen.row_finish(row["id"], "failed",
                                   error="render timed out")
                except Exception as e:
                    log(f"could not mark timed-out row failed: {e}")
            if args.once:
                return 0
            continue
        if args.once:
            log("queue empty")
            return 3
        time.sleep(args.interval)

if __name__ == "__main__":
    sys.exit(main())
