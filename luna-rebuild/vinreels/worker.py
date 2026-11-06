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
               "&select=id,user_id,vin,stock_number,status,source")
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

HOLD_STALE_MINUTES = 60  # phase 2: a hold older than this with no
# ready reel releases flagged — a dead worker never starves posts.

def _release_hold(user_id, vin, flagged):
    """Flip every held queue row for (user, vin) claimable again.
    flagged=True also stamps reel_failed (the health bar's
    'posted without video' chip reads it after the post lands)."""
    body = {"awaiting_reel": False}
    if flagged:
        body["reel_failed"] = True
    st, resp = gen.rest(
        "PATCH", f"/rest/v1/auto_posting_queue?user_id=eq.{user_id}"
                 f"&vin=eq.{vin}&awaiting_reel=eq.true",
        body=body, headers={"Prefer": "return=minimal"})
    if st >= 300:
        log(f"hold release failed for vin={vin}: {st} {resp}")
        return False
    log(f"hold released vin={vin} "
        f"({'flagged reel_failed' if flagged else 'reel ready'})")
    return True

def _has_live_reel(user_id, vin):
    """True when ANY reel for (user, vin) is still live —
    queued, generating or ready. The stale-release guard
    (v2.1.86): an aged hold whose reel is still coming must
    never be flag-released out from under the render. A
    failed lookup answers False (the pre-guard behavior:
    the stale release proceeds) so a REST hiccup can never
    wedge a hold forever."""
    st, rows = gen.rest(
        "GET", f"/rest/v1/vin_reels?user_id=eq.{user_id}"
               f"&vin=eq.{vin}"
               "&status=in.(queued,generating,ready)"
               "&limit=1&select=status")
    return st == 200 and bool(rows)

def reconcile_holds():
    """Phase 2 hold reconciliation — runs on every poll.

    For each held auto-post row (grouped by user+VIN), the LATEST
    reel for the car decides:
      ready            -> release (the poster attaches it)
      failed/consumed  -> release flagged (post without video)
      queued/generating -> keep holding, unless the hold is stale
      no reel at all   -> keep holding while fresh (the producer
                          inserts the reel job in the same pass)
    A hold older than HOLD_STALE_MINUTES with no ready reel
    releases flagged whatever the reel state — UNLESS a reel
    for the car is still live (queued/generating/ready): the
    stale branch never fires under a live reel (v2.1.86 — the
    Nov 6 desk test caught it flag-releasing mid-render
    holds). The failure policy is that a video problem never
    starves a post. Only rows still
    awaiting_reel=true are ever patched, so a reel finishing after
    its hold already released changes nothing (no resurrection).
    """
    st, holds = gen.rest(
        "GET", "/rest/v1/auto_posting_queue?awaiting_reel=eq.true"
               "&status=eq.pending"
               "&select=user_id,vin,reel_requested_at"
               "&order=reel_requested_at.asc&limit=200")
    if st != 200 or not holds:
        return
    now = datetime.now(timezone.utc)
    seen = set()
    for h in holds:
        key = (h.get("user_id"), h.get("vin"))
        if not all(key) or key in seen:
            continue
        seen.add(key)
        st2, reels = gen.rest(
            "GET", f"/rest/v1/vin_reels?user_id=eq.{key[0]}"
                   f"&vin=eq.{key[1]}&order=created_at.desc&limit=1"
                   "&select=status")
        latest = reels[0].get("status") if (st2 == 200 and reels) else None
        stale = False
        req = h.get("reel_requested_at")
        if req:
            try:
                asked = datetime.fromisoformat(
                    str(req).replace("Z", "+00:00"))
                stale = (now - asked) > timedelta(
                    minutes=HOLD_STALE_MINUTES)
            except Exception:
                stale = False
        if latest == "ready":
            _release_hold(key[0], key[1], flagged=False)
        elif latest in ("failed", "consumed"):
            _release_hold(key[0], key[1], flagged=True)
        elif stale and not _has_live_reel(key[0], key[1]):
            _release_hold(key[0], key[1], flagged=True)
        # else: a fresh hold with a live or imminent reel — wait.
        # A STALE hold with a live reel also waits (v2.1.86):
        # the stale branch above is the only guarded verdict —
        # ready/failed/consumed settle exactly as before.

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
            reconcile_holds()
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
            # The render just settled this reel — settle any hold
            # riding on it in the same pass (--once included).
            try:
                reconcile_holds()
            except Exception as e:
                log(f"hold reconcile error: {e}")
            if args.once:
                return 0
            continue
        if args.once:
            log("queue empty")
            return 3
        time.sleep(args.interval)

if __name__ == "__main__":
    sys.exit(main())
