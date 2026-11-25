#!/usr/bin/env python3
# =====================================================================
# Preferred sync time — daily anchor scheduler (Matthew, 2026-11-25).
#
# Runs on the self-hosted box under a systemd timer (every 5 min).
# For every user who picked a preferred sync time
# (user_settings.preferred_sync_hour + .preferred_sync_timezone)
# and left Auto-sync ON, it queues ONE scrape_jobs row per day at
# that local time:
#
#     sync_mode    = 'anchor'
#     triggered_by = 'preferred_sync_anchor'
#
# The insert fires the database's dispatch trigger, which dispatches
# the scraper workflow for that user — the same path as the app's
# Sync Inventory button — so the anchor is fully hands-free: no app
# tab, no browser, no helper needs to be open or awake.
#
# Guarantee shape: a tick fires whenever now >= today's anchor and
# no anchor row exists from the last 20 hours and none is still
# pending — so a missed tick (box reboot, timer hiccup) fires late
# rather than never, and it can never fire twice in a day.
#
# Minute-spreading: the minute inside the chosen hour is
# FNV-1a(user id) mod 60 — deterministic per user, identical to the
# value the app shows beside the picker (preferredSyncMinute in
# index.html) — so a popular hour never lands on a single minute.
#
# The plan sync cadence never defers an anchor row and an anchor
# never sets the cadence clock (see the cadence guard in
# luna-rebuild/scraper.py); the scraper also completes-and-skips an
# anchor whose owner turned Auto-sync off after it was queued.
#
# Database access is local psql through the supabase-db container
# (postgres role) — this script reads and stores no keys.
# =====================================================================
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PSQL = [
    "docker", "exec", "supabase-db",
    "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
]
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
TZ_RE = re.compile(r"^[A-Za-z0-9_+\-/]{1,64}$")
FALLBACK_TZ = "America/New_York"
DRY_RUN = os.environ.get("ANCHOR_DRY_RUN") == "1"


def anchor_minute(user_id):
    """FNV-1a 32-bit of the user id, mod 60 — must match
    preferredSyncMinute() in index.html byte for byte."""
    h = 2166136261
    for b in str(user_id).encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h % 60


def psql(sql):
    out = subprocess.run(
        PSQL + [sql], capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def load_candidates():
    sql = (
        "select row_to_json(t) from ("
        "select user_id, preferred_sync_hour, preferred_sync_timezone "
        "from public.user_settings "
        "where preferred_sync_hour is not null "
        "and auto_sync_enabled is true"
        ") t"
    )
    rows = []
    for line in psql(sql).splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def anchor_already_queued(user_id):
    sql = (
        "select count(*) from public.scrape_jobs "
        f"where user_id = '{user_id}' and sync_mode = 'anchor' "
        "and (status = 'pending' "
        "or started_at > now() - interval '20 hours')"
    )
    return int(psql(sql) or "0") > 0


def queue_anchor(user_id):
    sql = (
        "insert into public.scrape_jobs "
        "(user_id, status, triggered_by, sync_mode) values "
        f"('{user_id}', 'pending', 'preferred_sync_anchor', 'anchor')"
    )
    if DRY_RUN:
        print(f"[dry-run] would queue anchor for {user_id[:8]}")
        return
    psql(sql)
    print(f"queued preferred-sync anchor for user {user_id[:8]}")


def main():
    try:
        candidates = load_candidates()
    except Exception as e:
        print(f"[!] anchor scheduler: candidate read failed: {e}")
        return 1
    fired = 0
    for row in candidates:
        try:
            uid = str(row.get("user_id") or "")
            hour = row.get("preferred_sync_hour")
            tz_name = str(row.get("preferred_sync_timezone") or "")
            if not UUID_RE.match(uid):
                continue
            if not isinstance(hour, int) or hour < 0 or hour > 23:
                continue
            if not TZ_RE.match(tz_name):
                tz_name = FALLBACK_TZ
            try:
                tz = ZoneInfo(tz_name)
            except (ZoneInfoNotFoundError, ValueError):
                tz = ZoneInfo(FALLBACK_TZ)
            now_local = datetime.now(tz)
            anchor_local = now_local.replace(
                hour=hour, minute=anchor_minute(uid),
                second=0, microsecond=0,
            )
            if now_local < anchor_local:
                continue  # today's anchor is still ahead
            if anchor_already_queued(uid):
                continue  # fired already (or one is still pending)
            queue_anchor(uid)
            fired += 1
        except Exception as e:
            print(f"[!] anchor scheduler: user row failed: {e}")
            continue
    if fired:
        print(f"anchor scheduler: {fired} anchor(s) queued")
    return 0


if __name__ == "__main__":
    sys.exit(main())
