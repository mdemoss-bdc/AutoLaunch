// =====================================================================
// luna-repairs — Luna Repairs, Phase 1 (spec: luna-repairs-assistant-
// spec-2026-11-17.md, sections 4, 5, 7, 12).
//
// In-app Luna gets DATA tools, never code tools (Matthew's fence,
// 2026-11-17). This function is the deterministic half: a fixed
// registry of named repair actions over the caller's OWN bookkeeping
// (queue rows, posting stamps, hold markers). The model in
// support-chat may surface and explain proposals; every precondition,
// evidence check, and write lives here.
//
// Actions (user JWT, verified manually — referral-claim pattern):
//   { action: "evaluate" }            → consume verify verdicts, run
//                                       detection for the caller, and
//                                       return open proposals + the
//                                       recent activity log.
//   { action: "execute", repair_id }  → re-check preconditions against
//                                       live rows, then apply the fix.
//   { action: "dismiss", repair_id }  → user said "not now".
//   { action: "undo", repair_id }    → restore before_state (7 days).
//   { action: "sweep", secret }      → detection for ALL accounts
//                                       (daily sweep, §12), plus the
//                                       Phase 2 auto-apply pass below.
//                                       Gated by LUNA_SWEEP_SECRET.
//                                       Optional "only_user" scopes a
//                                       sweep to one account (smoke
//                                       tests); default is all users.
//
// Phase 1 rules (spec §7/§10/§12): every lane is ASK — nothing applies
// without the user's tap. Verify-gated repairs (actions 1 and 3)
// enqueue a read-only verify_listing queue job ONLY when the user's
// helper is >= 2.1.142 (the first verify-capable build); an unknown
// action must never sit in the claim window of an older helper.
//
// Blast radius (spec §3.5): a fix may touch only the caller's own
// queue rows, stamps, and hold markers. Never a live listing, never a
// new post, never a message, never settings, never billing.
//
// Phase 2 (spec §7/§12, built 2026-11-17): SAFE auto-apply for the
// three verify-proven / DB-fact classes ONLY — clear_false_attach_
// failure, release_stuck_reel_hold, correct_stamp_price. The pass
// runs ONLY inside the nightly sweep (never interactive evaluate),
// ONLY on proposals whose evidence bar is already met (verify-gated
// classes must be "ready"; the hold release is a DB fact re-checked
// at execution), and ONLY while the owner kill switch for that class
// is ON in public.luna_repairs_config (auto_apply) — every class
// ships OFF, so deploying this build changes nothing until Matthew
// flips a class on. clear_phantom_stamp is absence-based and is
// NEVER auto-applied, in any phase. Auto-applied repairs are logged
// with actor "auto", appear in Recent Luna activity with the same
// 7-day undo, respect the per-user opt-out (user_settings.
// luna_ask_before_fixing = true demotes that user to proposals),
// and stop under the recurrence guard: after 2 auto-applies of the
// same class for a user inside 14 days, the next case escalates
// (evidence.escalated, watchdog-visible) instead of applying —
// repeated identical repairs are a defect signal, not maintenance.
//
// Post-failure clusters (2026-11-18, Matthew's direction after a
// run of video-gate aborts Luna never saw): a detector watches for
// >= 3 failed POST rows sharing one failure signature inside 24h
// and raises ONE escalation-only proposal (action
// post_failure_cluster, vin null — it spans cars). There is no
// user-side repair for a cluster: execute refuses the class and
// the card is an alert with a dismiss only. The proposal is born
// escalated (evidence.escalated, watchdog-surfaced), because a
// same-signature cluster is a platform/helper defect signal, not
// bookkeeping. Dedup is manual (the open-proposal index keys on
// queue_row_id, which is null here): an open proposal for the same
// signature is updated in place as the cluster grows.
//
// Instagram failures (2026-11-20, Matthew's direction: "make sure
// Ask Luna can help with failed insta posts too"): IG outcomes live
// in public.instagram_posts, not the queue, so two IG classes ride
// the same propose -> tap -> apply -> log shape with the IG row's
// id carried in queue_row_id (a plain uuid column — no FK — so the
// open-proposal dedupe index covers them unchanged):
//   clear_failed_ig_intent   — delete a dead FAILED instagram_posts
//     record so a fresh tap starts clean. Execute re-verifies: the
//     record is still failed AND no published post exists for the
//     VIN. Undo re-inserts the snapshotted row.
//   release_stuck_ig_intent  — an awaiting_reel intent whose reel
//     is VERIFIABLY ready (latest vin_reels row ready + video_url)
//     and which has sat parked past the finisher's cadence is
//     re-armed by moving it to the front of the finisher's
//     oldest-first line (the created_at stamp this codebase already
//     uses to front-run Luna's verify rows). Luna never publishes:
//     the EXISTING paths (the instagram-post finisher's finish
//     pass, which completes manual intents too, and the app's
//     reel watcher) do the posting, exactly as the blast-radius
//     fence requires. Undo restores the original created_at.
// Both classes are ASK-only forever: neither is in
// AUTO_APPLY_ACTIONS and neither gets a config row. The diagnosis
// half (what each failure class MEANS) lives in support-chat's
// snapshot, computed from the same classifier below.
//
// Auto-retry (2026-11-18, Matthew's approval — a graduated
// capability under the teach-back rule): ONE bounded re-queue for
// an isolated failed post whose signature is on a tiny allowlist
// of proven transients (AUTO_RETRY_ALLOWLIST), gated by
// luna_repairs_config like the other classes, demoted to an ASK
// proposal for opted-out users, and hard-paused whenever an open
// post_failure_cluster covers the signature. One retry per queue
// row, ever; at most 2 per signature per user per 14 days, then
// the recurrence guard escalates instead. The action is
// data-only: a failed row returns to pending with its error
// cleared — the helper's normal claim path does the rest.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VERIFY_MIN_HELPER = [2, 1, 142];
const BUMP_MIN_POSTS_AHEAD = 5;
const BUMP_MIN_AGE_MS = 30 * 60 * 1000;
const UNDO_WINDOW_MS = 7 * 24 * 3600 * 1000;
const CLUSTER_WINDOW_MS = 24 * 3600 * 1000;
const CLUSTER_MIN_ROWS = 3;

// Instagram classes: a failed IG record earns a clear proposal
// inside 24h (the same freshness window as the cluster detector);
// an awaiting_reel intent is "stuck" once it has sat parked with a
// ready reel well past the finisher's 3-minute cadence (20 min =
// several missed passes); the release re-arm stamps created_at
// this far back so the intent leads the finisher's oldest-first
// pass — and the detector's 30-day sanity bound keeps a re-armed
// intent (age ~1 year) from ever being proposed twice.
const IG_FAILED_WINDOW_MS = 24 * 3600 * 1000;
const IG_STUCK_MS = 20 * 60 * 1000;
const IG_STUCK_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const IG_FRONT_MS = 365 * 24 * 3600 * 1000;

// Bounded auto-retry: the allowlist is deliberately tiny — a
// retry must never be able to do the wrong thing twice, so
// identity/VIN mismatches, price-gate rejections, media failures,
// and auth/session errors are never eligible. Founding member,
// proven transient the day it was added: the Bronco took this
// exact gate abort once and posted clean on retry.
const AUTO_RETRY_ALLOWLIST = ["pwv348_gate_rejected:counter_vanished"];
const AUTO_RETRY_COOLDOWN_MS = 20 * 60 * 1000;

// Phase 2 auto-apply (spec §12). Exactly these classes may ever
// auto-apply; clear_phantom_stamp is deliberately absent — absence
// evidence never auto-fixes.
const AUTO_APPLY_ACTIONS = [
  "clear_false_attach_failure",
  "release_stuck_reel_hold",
  "correct_stamp_price",
];
// Recurrence guard: this many PRIOR auto-applies of one class for
// one user inside the window means the next case escalates instead
// of applying (i.e. the 3rd case in 14 days trips the guard).
const AUTO_RECURRENCE_PRIOR_LIMIT = 2;
const AUTO_RECURRENCE_WINDOW_MS = 14 * 24 * 3600 * 1000;
// Past-tense summaries for auto-applied repairs, so the activity
// list reads as a report ("Fixed: ...") rather than an offer.
const AUTO_SUMMARIES: Record<string, string> = {
  clear_false_attach_failure:
    "Luna fixed this on her own overnight: she checked the live listing, the video was on it, and she cleared the false failure row.",
  release_stuck_reel_hold:
    "Luna fixed this on her own overnight: the video was ready, so she released the hold and the post will go ahead.",
  correct_stamp_price:
    "Luna fixed this on her own overnight: she checked the live listing, it already showed the new price, and she corrected your records.",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

async function verifyUser(req: Request): Promise<any | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const client = createClient(supabaseUrl, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

function parseVersion(v: unknown): number[] | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function versionGte(v: unknown, min: number[]): boolean {
  const p = parseVersion(v);
  if (!p) return false;
  for (let i = 0; i < 3; i++) {
    if (p[i] > min[i]) return true;
    if (p[i] < min[i]) return false;
  }
  return true;
}

function carLabel(row: any): string {
  const parts = [row?.year, row?.make, row?.model].filter(Boolean);
  return parts.length ? parts.join(" ") : (row?.vin ?? "vehicle");
}

function stripHoldMarkers(msg: string | null): string | null {
  if (!msg) return null;
  const cleaned = msg
    .replace(/reel_claim_hold:[^;]*/g, "")
    .replace(/reel_gate_hold[^;]*/g, "")
    .replace(/reel_gate_abort[^;]*/g, "")
    .replace(/;{2,}/g, ";")
    .replace(/^[\s;]+|[\s;]+$/g, "")
    .trim();
  return cleaned.length ? cleaned : null;
}

// ---------------------------------------------------------------------
// Detection. Each detector returns candidate proposals; insertion is
// deduped by the partial unique index on (user_id, action,
// queue_row_id) for open statuses, so re-running detection is safe.
// ---------------------------------------------------------------------

async function loadUserRows(svc: any, userId: string) {
  const [{ data: failed }, { data: pending }, { data: settings }] = await Promise.all([
    svc.from("auto_posting_queue").select("*")
      .eq("user_id", userId).eq("status", "failed")
      .order("created_at", { ascending: true }).limit(300),
    svc.from("auto_posting_queue").select("*")
      .eq("user_id", userId).eq("status", "pending")
      .order("created_at", { ascending: true }).limit(500),
    svc.from("user_settings").select("helper_version")
      .eq("user_id", userId).maybeSingle(),
  ]);
  return {
    failed: failed ?? [],
    pending: pending ?? [],
    helperVersion: settings?.helper_version ?? null,
  };
}

async function latestReelByVin(svc: any, userId: string, vins: string[]) {
  const map = new Map<string, any>();
  if (!vins.length) return map;
  const { data } = await svc.from("vin_reels")
    .select("id, vin, status, video_url, updated_at, created_at")
    .eq("user_id", userId).in("vin", vins)
    .order("created_at", { ascending: false });
  for (const r of data ?? []) {
    if (!map.has(r.vin)) map.set(r.vin, r);
  }
  return map;
}

async function inventoryByVin(svc: any, userId: string, vins: string[]) {
  const map = new Map<string, any>();
  if (!vins.length) return map;
  const { data } = await svc.from("scraped_inventory")
    .select("vin, marketplace_posted_price, marketplace_posted_at")
    .eq("user_id", userId).in("vin", vins);
  for (const r of data ?? []) map.set(r.vin, r);
  return map;
}

async function insertProposal(svc: any, p: any): Promise<boolean> {
  const { error } = await svc.from("luna_repairs").insert(p);
  if (error) {
    // 23505 = the open-proposal dedupe index; expected on re-runs.
    if ((error as any).code === "23505") return false;
    console.error("luna-repairs insertProposal", error);
    return false;
  }
  return true;
}

// The stable reason token of a failure: the first line of the
// helper's error text, minus the trailing JSON diagnostics blob
// and minus a leading wrapper segment ("pwv348_abort:"), so the
// same failure mode groups together across cars. Deterministic;
// the reason grammar is fixed tokens (gate/build tags), never
// per-car values, so no volatile ids survive into a signature.
function postFailureSignature(err: string): string | null {
  if (!err) return null;
  const firstLine = err.split("\n")[0].split("{")[0].trim();
  if (!firstLine) return null;
  const parts = firstLine.split(":").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const segs = parts.length >= 3 ? parts.slice(1) : parts;
  return segs.join(":");
}

// Failed POST rows inside the cluster window, grouped by failure
// signature, keeping only groups at cluster size. Pure given its
// inputs (rows arrive from loadUserRows, all status "failed").
// Queue rows carry no settle timestamp (no updated_at, and
// executed_at is null on failed rows), so the window rides on
// created_at — the only clock a queue row has.
function clusterGroups(failed: any[], now: number): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const row of failed) {
    if (row.action !== "post") continue;
    if (now - new Date(row.created_at).getTime() > CLUSTER_WINDOW_MS) continue;
    const sig = postFailureSignature(
      typeof row.error_message === "string" ? row.error_message : "");
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(row);
  }
  for (const [sig, rows] of groups) {
    if (rows.length < CLUSTER_MIN_ROWS) groups.delete(sig);
  }
  return groups;
}

function clusterSummaryText(sig: string, count: number): string {
  const what = sig.includes("gate_rejected")
    ? `failed at the video gate (${sig.split(":").pop()})`
    : `failed the same way (${sig})`;
  return `${count} posts ${what} in the last 24 hours \u2014 every one stopped safely before publishing, so nothing went out wrong. This usually points to a Facebook-side or helper-side problem, not your cars. Luna has escalated it for investigation.`;
}

// ---------------------------------------------------------------------
// Instagram failure classification + proposal summaries. Pure given
// their inputs; the class keys are shared verbatim with
// support-chat's snapshot diagnosis, so the card and the chat answer
// always call the same failure by the same name.
// ---------------------------------------------------------------------

function igFailureClass(row: any): string {
  const code = typeof row?.error_code === "string" ? row.error_code : "";
  const msg = typeof row?.error_message === "string" ? row.error_message : "";
  if (code === "9007" || msg.includes("Media ID is not available")) {
    return "media_unavailable";
  }
  if (code === "reel_render_failed") return "render_failed";
  if (code === "instagram_not_connected" || code === "instagram_token_expired") {
    return "not_connected";
  }
  if (code === "finisher_interrupted") return "interrupted";
  if (code === "media_processing_timeout") return "processing_timeout";
  return "meta_failed";
}

function igClearSummary(
  label: string, cls: string, failure: string, reelReadyNow: boolean,
): string {
  switch (cls) {
    case "media_unavailable":
      return reelReadyNow
        ? `The Instagram post for your ${label} failed — Meta rejected the media on that attempt ("Media ID is not available"). The car's video is ready now, so a fresh tap on its Instagram button should post it. Luna can clear the dead failure record so that tap starts clean.`
        : `The Instagram post for your ${label} failed — Meta rejected it because the car had no video ready ("Media ID is not available"). That flow is fixed now: tapping Instagram renders the video first, then posts. Luna can clear the dead failure record so a fresh tap starts clean.`;
    case "render_failed":
      return `The Instagram post for your ${label} never went out — the car's video render failed first. Luna can clear the dead record; tapping the car's Reel button retries the render, and then Instagram can post it.`;
    case "not_connected":
      return `The Instagram post for your ${label} failed because the Instagram connection wasn't live at that moment. Luna can clear the dead record — if Instagram isn't connected now, reconnect it in Settings, then tap the car's Instagram button to post.`;
    case "interrupted":
      return `The Instagram post for your ${label} was interrupted mid-flight, so it sits marked failed. Check Instagram first: if the car never appeared, Luna can clear this record so a fresh tap starts clean.`;
    case "processing_timeout":
      return `The Instagram post for your ${label} timed out while Instagram was still processing the video, so it sits marked failed. Luna can clear the dead record so a fresh tap starts clean.`;
    default:
      return `The Instagram post for your ${label} failed — Meta said: "${failure.slice(0, 200)}". Luna can clear the dead record so a fresh tap on the car's Instagram button starts clean.`;
  }
}

function igReleaseSummary(label: string): string {
  return `Your ${label}'s Instagram post is stuck: its video has been ready for a while, but the post is still parked. Luna can re-arm it — the post then goes out on the next automatic pass (a few minutes) or as soon as the app is open on the car.`;
}

async function runDetection(svc: any, userId: string): Promise<number> {
  const { failed, pending, helperVersion } = await loadUserRows(svc, userId);
  let created = 0;
  const now = Date.now();

  const heldPosts = pending.filter((r: any) =>
    r.action === "post" &&
    (r.awaiting_reel === true ||
      (typeof r.error_message === "string" &&
        (r.error_message.includes("reel_claim_hold") ||
          r.error_message.includes("reel_gate_hold")))));
  const pendingPosts = pending.filter((r: any) => r.action === "post");
  const pendingAttaches = pending.filter((r: any) => r.action === "attach_video");

  const reelMap = await latestReelByVin(
    svc, userId,
    [...new Set(heldPosts.map((r: any) => r.vin))],
  );
  const invMap = await inventoryByVin(
    svc, userId,
    [...new Set(failed.map((r: any) => r.vin))],
  );

  // Verdict-failed guard (2026-11-17, shipped with the detector
  // widening): a repair the helper's verdict already closed as
  // "checked, not fixed" must not re-propose — and re-verify —
  // on every evaluation while the queue row sits unchanged; that
  // loop would burn a helper verify run per evaluation forever.
  // The guard keys on the failure text captured in the repair's
  // evidence: a byte-identical error means the same evidence the
  // verdict already judged. A retry rewrites the row's error
  // (fresh diagnostics), which lifts the guard and earns a
  // fresh look — a retried row is never locked out.
  const { data: verdictFailed } = await svc.from("luna_repairs")
    .select("action, queue_row_id, evidence")
    .eq("user_id", userId)
    .eq("status", "failed")
    .in("action", ["clear_false_attach_failure", "correct_stamp_price"]);
  const checkedFailures = new Map<string, string>();
  for (const r of verdictFailed ?? []) {
    if (r.queue_row_id && r.evidence && typeof r.evidence.failure === "string") {
      checkedFailures.set(`${r.action}:${r.queue_row_id}`, r.evidence.failure);
    }
  }
  const alreadyChecked = (action: string, row: any) =>
    checkedFailures.get(`${action}:${row.id}`) ===
    (typeof row.error_message === "string" ? row.error_message.slice(0, 400) : "");

  // --- Action 2: release_stuck_reel_hold (DB-only evidence) ---------
  for (const row of heldPosts) {
    const reel = reelMap.get(row.vin);
    if (!reel || reel.status !== "ready") continue;
    const ok = await insertProposal(svc, {
      user_id: userId,
      action: "release_stuck_reel_hold",
      vin: row.vin,
      queue_row_id: row.id,
      lane: "ask",
      status: "proposed",
      evidence: {
        reel_id: reel.id, reel_status: reel.status,
        reel_updated_at: reel.updated_at,
        awaiting_reel: row.awaiting_reel ?? false,
      },
      summary: `Your ${carLabel(row)} is ready to post — its video finished rendering, but the post is still being held. Luna can release the hold so your queued post goes ahead.`,
    });
    if (ok) created++;
  }

  // --- Action 6: bump_starved_attaches (DB-only evidence) -----------
  for (const att of pendingAttaches) {
    const ahead = pendingPosts.filter(
      (p: any) => new Date(p.created_at).getTime() > new Date(att.created_at).getTime(),
    ).length;
    const age = now - new Date(att.created_at).getTime();
    if (ahead < BUMP_MIN_POSTS_AHEAD || age < BUMP_MIN_AGE_MS) continue;
    const ok = await insertProposal(svc, {
      user_id: userId,
      action: "bump_starved_attaches",
      vin: att.vin,
      queue_row_id: att.id,
      lane: "ask",
      status: "proposed",
      evidence: { posts_ahead: ahead, attach_age_min: Math.round(age / 60000) },
      summary: `The video attach for your ${carLabel(att)} is stuck behind ${ahead} newer posts, so the listing sits without its video. Luna can move the attach to the front of the line.`,
    });
    if (ok) created++;
  }

  // --- Failed-row detectors ------------------------------------------
  for (const row of failed) {
    const inv = invMap.get(row.vin);
    const err = typeof row.error_message === "string" ? row.error_message : "";

    // Action 1: clear_false_attach_failure (verify-gated) ------------
    // Widened 2026-11-17 at Matthew's direction ("teach Luna"), after
    // the Grand Cherokee ZTP1517A miss: the original marker-only rule
    // (attach_unverified / saved_unproven) missed a failed attach
    // whose video had in fact landed under a different failure
    // signature. Now ANY failed attach on a car with a live posted
    // stamp is proposed. The verify verdict — never the proposal —
    // decides whether the row clears, so a genuinely failed attach
    // simply closes back out as "checked, not fixed".
    if (row.action === "attach_video" && inv && inv.marketplace_posted_at &&
        !alreadyChecked("clear_false_attach_failure", row)) {
      const knownClass = err.includes("attach_unverified") || err.includes("saved_unproven");
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "clear_false_attach_failure",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "needs_verify",
        evidence: {
          failure: err.slice(0, 400),
          failure_class: knownClass ? "counter_unverified" : "unclassified",
          checks: ["listing_present", "video_present"],
        },
        summary: knownClass
          ? `The video attach for your ${carLabel(row)} is marked failed — but that failure class is often wrong (the editor never confirmed either way). Luna can check the live listing first, and only clear the bad row if the video is really there.`
          : `The video attach for your ${carLabel(row)} is marked failed. Luna can check the live listing first — if the video is really there, she'll clear the bad row; if it isn't, she'll leave everything exactly as it is.`,
      });
      if (ok) created++;
      continue;
    }

    // Action 3: correct_stamp_price (verify-gated) -------------------
    if (row.action === "update_price" && typeof row.price === "number" &&
        inv && inv.marketplace_posted_price !== row.price &&
        !alreadyChecked("correct_stamp_price", row)) {
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "correct_stamp_price",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "needs_verify",
        evidence: {
          target_price: row.price,
          stamp_price: inv.marketplace_posted_price ?? null,
          failure: err.slice(0, 400),
          checks: ["listing_present", "live_price"],
        },
        summary: `The price change on your ${carLabel(row)} is marked failed, so your records still show the old price. Luna can check the live listing — if the new price of $${row.price} is really there, she'll correct the record and clear the failed row.`,
      });
      if (ok) created++;
      continue;
    }

    // Action 5: remove_dead_row (DB-only subsets) --------------------
    let deadReason: string | null = null;
    if (row.action === "delete" && inv && !inv.marketplace_posted_at) {
      deadReason = "the car is not marked as posted anymore, so there is nothing left for this delete job to remove";
    } else if (row.action === "update_price" && typeof row.price === "number" &&
               inv && inv.marketplace_posted_price === row.price) {
      deadReason = "your records already show the target price, so this failed row is just debris";
    } else if (row.action === "attach_video") {
      const superseded = [...failed, ...pending].some((o: any) =>
        o.id !== row.id && o.vin === row.vin &&
        new Date(o.created_at).getTime() > new Date(row.created_at).getTime()) &&
        pending.some((o: any) => o.vin === row.vin && o.action === "post");
      if (superseded) {
        deadReason = "the car has been re-queued since this attach failed, so the old row's context no longer applies";
      }
    }
    if (deadReason) {
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "remove_dead_row",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "proposed",
        evidence: { reason: deadReason, failure: err.slice(0, 400) },
        summary: `A failed job for your ${carLabel(row)} can't ever succeed — ${deadReason}. Luna can remove the dead row so it stops cluttering your queue.`,
      });
      if (ok) created++;
    }
  }

  // --- Action 7: post_failure_cluster (escalation-only) -------------
  // The open-proposal dedupe index keys on queue_row_id, which is
  // null for a multi-car cluster, so dedup is manual: an open
  // proposal for the same signature is updated in place (a growing
  // cluster re-surfaces via the new count, and a growth resets the
  // escalation's reported flag so the watchdog digest picks it up
  // again). A dismissed cluster stays dismissed unless it was
  // dismissed over 24h ago or has since grown by >= CLUSTER_MIN_ROWS
  // rows — a user who said "got it" is not re-nagged by the same
  // evidence.
  for (const [sig, rows] of clusterGroups(failed, now)) {
    const stocks = [...new Set(rows.map((r: any) => r.stock_num).filter(Boolean))];
    const times = rows.map((r: any) => new Date(r.created_at).getTime());
    const summary = clusterSummaryText(sig, rows.length);
    const reason = `post-failure cluster: ${rows.length} posts failed with ${sig} in 24h`;
    const { data: openClusters } = await svc.from("luna_repairs")
      .select("id, evidence")
      .eq("user_id", userId).eq("action", "post_failure_cluster")
      .eq("status", "proposed").limit(20);
    const existing = (openClusters ?? []).find(
      (p: any) => p.evidence?.signature === sig);
    if (existing) {
      const prev = existing.evidence ?? {};
      const grew = rows.length > (Number(prev.count) || 0);
      await svc.from("luna_repairs").update({
        evidence: {
          signature: sig,
          count: rows.length,
          stocks,
          first_at: new Date(Math.min(...times)).toISOString(),
          last_at: new Date(Math.max(...times)).toISOString(),
          escalated: {
            at: grew || !prev.escalated
              ? new Date().toISOString() : prev.escalated.at,
            reason,
            failure: null,
            reported: grew ? false : (prev.escalated?.reported ?? false),
          },
        },
        summary,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      continue;
    }
    const { data: dismissedClusters } = await svc.from("luna_repairs")
      .select("evidence, updated_at")
      .eq("user_id", userId).eq("action", "post_failure_cluster")
      .eq("status", "dismissed")
      .order("updated_at", { ascending: false }).limit(20);
    const dismissed = (dismissedClusters ?? []).find(
      (p: any) => p.evidence?.signature === sig);
    if (dismissed) {
      const age = now - new Date(dismissed.updated_at).getTime();
      const prevCount = Number(dismissed.evidence?.count) || 0;
      if (age < CLUSTER_WINDOW_MS &&
          rows.length < prevCount + CLUSTER_MIN_ROWS) continue;
    }
    const ok = await insertProposal(svc, {
      user_id: userId,
      action: "post_failure_cluster",
      vin: null,
      queue_row_id: null,
      lane: "ask",
      actor: "luna",
      status: "proposed",
      evidence: {
        signature: sig,
        count: rows.length,
        stocks,
        first_at: new Date(Math.min(...times)).toISOString(),
        last_at: new Date(Math.max(...times)).toISOString(),
        escalated: {
          at: new Date().toISOString(),
          reason,
          failure: null,
          reported: false,
        },
      },
      summary,
    });
    if (ok) created++;
  }

  // --- Instagram: failed records + stuck intents -------------------
  created += await runIgDetection(svc, userId, now);

  // --- Verify enqueueing for needs_verify proposals ------------------
  if (versionGte(helperVersion, VERIFY_MIN_HELPER)) {
    const { data: waiting } = await svc.from("luna_repairs")
      .select("*")
      .eq("user_id", userId).eq("status", "needs_verify")
      .is("verify_queue_id", null)
      .limit(10);
    for (const prop of waiting ?? []) {
      // Escalated proposals (spec §11) are waiting on agent-Luna:
      // she stops re-asking the helper until the escalation is
      // resolved and the flag is cleared.
      if (prop.evidence?.escalated) continue;
      const { data: qrow } = await svc.from("auto_posting_queue")
        .select("*").eq("id", prop.queue_row_id).maybeSingle();
      if (!qrow) {
        await svc.from("luna_repairs")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("id", prop.id);
        continue;
      }
      const checks = prop.action === "clear_false_attach_failure"
        ? ["listing_present", "video_present"]
        : ["listing_present", "live_price"];
      const { data: vrow, error } = await svc.from("auto_posting_queue").insert({
        user_id: userId,
        vin: qrow.vin,
        target_channel: "facebook",
        action: "verify_listing",
        status: "pending",
        year: qrow.year, make: qrow.make, model: qrow.model,
        stock_num: qrow.stock_num,
        price: typeof qrow.price === "number" ? qrow.price : null,
        // Luna's jobs supersede the queue (Matthew, 2026-11-17):
        // the helper claims oldest-first, so her read-only verify
        // rows are stamped a year back and always land at the
        // front of the line — a verify left behind a dozen posts
        // reads as "Luna is stuck" when she is only in line. The
        // stamp preserves FIFO among her own rows (each new
        // verify is newer than the last). A job already running
        // is never preempted; front-of-line means next claim.
        created_at: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
        share_text: JSON.stringify({ luna_verify: { repair_id: prop.id, checks } }),
      }).select("id").single();
      if (!error && vrow) {
        await svc.from("luna_repairs")
          .update({ verify_queue_id: vrow.id, updated_at: new Date().toISOString() })
          .eq("id", prop.id);
      }
    }
  }

  return created;
}

// Instagram detection: reads the user's own instagram_posts rows
// (service role; the caller scopes by userId). Failed records get a
// clear proposal inside 24h unless the VIN already has a published
// post (then the failure is stale noise next to a success — nothing
// to clear). Awaiting intents get a release proposal only when the
// latest reel is verifiably ready AND the intent has been parked
// past the finisher's cadence; a still-rendering reel is "cooking",
// never stuck. A proposal the user dismissed (or undid) for the
// same IG row is never re-proposed; an applied release moves
// created_at ~1 year back, outside the detector's age bound, so it
// cannot re-propose either. ASK-only: nothing here auto-applies.
async function runIgDetection(
  svc: any, userId: string, now: number,
): Promise<number> {
  let created = 0;
  const { data: igRows } = await svc.from("instagram_posts")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["failed", "awaiting_reel"])
    .order("created_at", { ascending: true })
    .limit(100);
  const rows = (igRows ?? []) as any[];
  if (!rows.length) return 0;

  const { data: published } = await svc.from("instagram_posts")
    .select("vin")
    .eq("user_id", userId)
    .eq("status", "published")
    .limit(500);
  const publishedVins = new Set(
    (published ?? []).map((r: any) => r.vin).filter(Boolean),
  );

  const igIds = rows.map((r) => r.id);
  const { data: closedProps } = await svc.from("luna_repairs")
    .select("action, queue_row_id")
    .eq("user_id", userId)
    .in("action", ["clear_failed_ig_intent", "release_stuck_ig_intent"])
    .in("status", ["dismissed", "undone"])
    .in("queue_row_id", igIds);
  const suppressed = new Set(
    (closedProps ?? []).map((r: any) => `${r.action}:${r.queue_row_id}`),
  );

  const vins = [...new Set(rows.map((r) => r.vin).filter(Boolean))];
  const { data: invRows } = await svc.from("scraped_inventory")
    .select("vin, year, make, model")
    .eq("user_id", userId)
    .in("vin", vins);
  const invByVin = new Map((invRows ?? []).map((r: any) => [r.vin, r]));
  const reelMap = await latestReelByVin(svc, userId, vins);

  const labelFor = (row: any): string => {
    const inv = row.vin ? invByVin.get(row.vin) : null;
    return inv ? carLabel(inv) : (row.stock_number ?? row.vin ?? "car");
  };

  for (const row of rows) {
    const age = now - new Date(row.created_at).getTime();
    if (row.status === "failed") {
      if (age > IG_FAILED_WINDOW_MS) continue;
      if (row.vin && publishedVins.has(row.vin)) continue;
      if (suppressed.has(`clear_failed_ig_intent:${row.id}`)) continue;
      const cls = igFailureClass(row);
      const reel = row.vin ? reelMap.get(row.vin) : null;
      const reelReadyNow = !!(
        reel && reel.status === "ready" && reel.video_url
      );
      const label = labelFor(row);
      const ok = await insertProposal(svc, {
        user_id: userId,
        queue_row_id: row.id,
        vin: row.vin,
        action: "clear_failed_ig_intent",
        summary: igClearSummary(
          label, cls, row.error_message ?? "", reelReadyNow,
        ),
        evidence: {
          source: "instagram_posts",
          ig_post_id: row.id,
          failure_class: cls,
          error_code: row.error_code ?? null,
          failure: (row.error_message ?? "").slice(0, 400),
          kind: row.kind ?? null,
          car_label: label,
          reel_status_now: reel ? reel.status : null,
        },
      });
      if (ok) created++;
    } else if (row.status === "awaiting_reel") {
      if (age < IG_STUCK_MS || age > IG_STUCK_MAX_AGE_MS) continue;
      if (suppressed.has(`release_stuck_ig_intent:${row.id}`)) continue;
      const reel = row.vin ? reelMap.get(row.vin) : null;
      if (!reel || reel.status !== "ready" || !reel.video_url) continue;
      const label = labelFor(row);
      const ok = await insertProposal(svc, {
        user_id: userId,
        queue_row_id: row.id,
        vin: row.vin,
        action: "release_stuck_ig_intent",
        summary: igReleaseSummary(label),
        evidence: {
          source: "instagram_posts",
          ig_post_id: row.id,
          reel_id: reel.id ?? null,
          reel_status: "ready",
          intent_created_at: row.created_at,
          car_label: label,
        },
      });
      if (ok) created++;
    }
  }
  return created;
}

// ---------------------------------------------------------------------
// Verify verdict consumption. The helper completes a verify_listing
// row with error_message = "luna_verdict:{json}". A verdict can only
// promote a proposal to "ready" — it never executes a fix.
// ---------------------------------------------------------------------

async function consumeVerdicts(svc: any, userId: string): Promise<void> {
  const { data: done } = await svc.from("auto_posting_queue")
    .select("*")
    .eq("user_id", userId).eq("action", "verify_listing")
    .in("status", ["completed", "failed"])
    .limit(50);
  for (const vrow of done ?? []) {
    let repairId: string | null = null;
    try {
      const req = JSON.parse(vrow.share_text ?? "{}");
      repairId = req?.luna_verify?.repair_id ?? null;
    } catch { /* unparseable request payload; clean up below */ }

    let verdict: any = null;
    if (vrow.status === "completed" &&
        typeof vrow.error_message === "string" &&
        vrow.error_message.startsWith("luna_verdict:")) {
      try { verdict = JSON.parse(vrow.error_message.slice("luna_verdict:".length)); }
      catch { verdict = null; }
    }

    if (repairId) {
      const { data: prop } = await svc.from("luna_repairs")
        .select("*").eq("id", repairId).eq("user_id", userId).maybeSingle();
      if (prop && prop.status === "needs_verify") {
        if (verdict && verdict.identity_ok === true && verdict.listing_present === true) {
          if (prop.action === "clear_false_attach_failure" && verdict.video_present === true) {
            await svc.from("luna_repairs").update({
              status: "ready",
              evidence: { ...prop.evidence, verdict },
              summary: `Checked live: the video IS on your ${prop.vin ? "vehicle's" : ""} listing — the failure was a false alarm. Luna can clear the bad row now.`,
              updated_at: new Date().toISOString(),
            }).eq("id", prop.id);
          } else if (prop.action === "correct_stamp_price" &&
                     typeof verdict.live_price === "number" &&
                     verdict.live_price === prop.evidence?.target_price) {
            await svc.from("luna_repairs").update({
              status: "ready",
              evidence: { ...prop.evidence, verdict },
              summary: `Checked live: the listing already shows the new price. Luna can correct your records and clear the failed row now.`,
              updated_at: new Date().toISOString(),
            }).eq("id", prop.id);
          } else {
            // Verified, and the failure was REAL — close honestly.
            await svc.from("luna_repairs").update({
              status: "failed",
              evidence: { ...prop.evidence, verdict },
              summary: `Luna checked the live listing: the failure was real, so this one stays with the normal retry path.`,
              updated_at: new Date().toISOString(),
            }).eq("id", prop.id);
          }
        } else if (verdict) {
          // Listing not found or identity not confirmed: fail safe,
          // close the proposal rather than guess.
          await svc.from("luna_repairs").update({
            status: "failed",
            evidence: { ...prop.evidence, verdict },
            summary: `Luna checked for the live listing and couldn't confirm it, so she didn't touch anything.`,
            updated_at: new Date().toISOString(),
          }).eq("id", prop.id);
        } else {
          // Verify job failed without a verdict. Count the silent
          // failure; at two in a row Luna stops re-asking (a broken
          // check looping looks like random tabs opening on the
          // user's screen) and ESCALATES to agent-Luna with the
          // diagnostics (spec §11). Clearing evidence.escalated
          // after a fix resumes normal verify enqueueing.
          const fails = (Number(prop.evidence?.verify_failures) || 0) + 1;
          const failure = typeof vrow.error_message === "string" && vrow.error_message
            ? vrow.error_message.slice(0, 200) : null;
          const ev: any = {
            ...prop.evidence,
            verify_failures: fails,
            last_verify_failure: failure,
          };
          if (fails >= 2) {
            ev.escalated = {
              at: new Date().toISOString(),
              reason: "verify produced no verdict twice in a row",
              failure,
              reported: false,
            };
            await svc.from("luna_repairs").update({
              verify_queue_id: null,
              evidence: ev,
              summary: `Luna's live check isn't completing, so she stopped retrying and escalated it for a closer look. Nothing was changed.`,
              updated_at: new Date().toISOString(),
            }).eq("id", prop.id);
          } else {
            await svc.from("luna_repairs").update({
              verify_queue_id: null,
              evidence: ev,
              updated_at: new Date().toISOString(),
            }).eq("id", prop.id);
          }
        }
      }
    }
    // The verify row is Luna's own bookkeeping; remove it once read.
    await svc.from("auto_posting_queue").delete().eq("id", vrow.id);
  }
}

// ---------------------------------------------------------------------
// Fix execution. Every applier re-checks its preconditions against the
// LIVE row at execution time (spec §4: repairs act on settled state or
// wait). A row that vanished or changed materially expires the
// proposal instead of being touched.
// ---------------------------------------------------------------------

async function markApplied(
  svc: any, prop: any, before: any, after: any,
  actor: string = "user_tap",
) {
  const patch: any = {
    status: "applied",
    actor,
    before_state: before,
    after_state: after,
    applied_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Report-after (spec §12): an auto-applied repair's summary reads
  // as something Luna DID, not something she is offering to do.
  if (actor === "auto" && AUTO_SUMMARIES[prop.action]) {
    patch.summary = AUTO_SUMMARIES[prop.action];
  }
  await svc.from("luna_repairs").update(patch).eq("id", prop.id);
}

async function markExpired(svc: any, prop: any, note: string) {
  await svc.from("luna_repairs").update({
    status: "expired",
    summary: note,
    updated_at: new Date().toISOString(),
  }).eq("id", prop.id);
  return json({ ok: false, expired: true, message: note }, 200);
}

async function executeRepair(
  svc: any, userId: string, prop: any, actor: string = "user_tap",
) {
  // Instagram classes act on instagram_posts, not the queue — they
  // branch before the queue-row load (their queue_row_id carries
  // the IG row's id, which has no queue row behind it).
  if (
    prop.action === "clear_failed_ig_intent" ||
    prop.action === "release_stuck_ig_intent"
  ) {
    return executeIgRepair(svc, userId, prop, actor);
  }
  const { data: row } = await svc.from("auto_posting_queue")
    .select("*").eq("id", prop.queue_row_id).eq("user_id", userId).maybeSingle();

  switch (prop.action) {
    case "release_stuck_reel_hold": {
      if (!row || row.action !== "post" || row.status !== "pending") {
        return markExpired(svc, prop, "That post is no longer waiting, so the hold release isn't needed anymore.");
      }
      const { data: reel } = await svc.from("vin_reels")
        .select("status").eq("user_id", userId).eq("vin", row.vin)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!reel || reel.status !== "ready") {
        return markExpired(svc, prop, "The video isn't marked ready anymore, so Luna left the hold alone.");
      }
      const before = { awaiting_reel: row.awaiting_reel, error_message: row.error_message };
      const cleaned = stripHoldMarkers(row.error_message);
      const { error } = await svc.from("auto_posting_queue").update({
        awaiting_reel: false, error_message: cleaned,
      }).eq("id", row.id);
      if (error) return json({ ok: false, message: "The update didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { awaiting_reel: false, error_message: cleaned }, actor);
      return json({ ok: true, message: "Hold released — the post will go ahead on the next pass." });
    }

    case "bump_starved_attaches": {
      if (!row || row.action !== "attach_video" || row.status !== "pending") {
        return markExpired(svc, prop, "That attach is no longer waiting in the queue.");
      }
      const { data: oldest } = await svc.from("auto_posting_queue")
        .select("created_at").eq("user_id", userId).eq("status", "pending")
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      const front = oldest
        ? new Date(new Date(oldest.created_at).getTime() - 1000).toISOString()
        : new Date().toISOString();
      const before = { created_at: row.created_at };
      const { error } = await svc.from("auto_posting_queue")
        .update({ created_at: front }).eq("id", row.id);
      if (error) return json({ ok: false, message: "The reorder didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { created_at: front }, actor);
      return json({ ok: true, message: "Moved to the front — the video attach runs next." });
    }

    case "remove_dead_row": {
      if (!row || row.status !== "failed") {
        return markExpired(svc, prop, "That row is no longer in a failed state, so there's nothing to remove.");
      }
      const before = { row };
      const { error } = await svc.from("auto_posting_queue").delete().eq("id", row.id);
      if (error) return json({ ok: false, message: "The removal didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { deleted: true }, actor);
      return json({ ok: true, message: "Dead row removed." });
    }

    case "clear_false_attach_failure": {
      if (prop.status !== "ready") {
        return json({ ok: false, message: "Luna still needs the live check to come back before this can be cleared." }, 200);
      }
      if (!row || row.status !== "failed" || row.action !== "attach_video") {
        return markExpired(svc, prop, "That failed row is already gone.");
      }
      const before = { row };
      const { error } = await svc.from("auto_posting_queue").delete().eq("id", row.id);
      if (error) return json({ ok: false, message: "The removal didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { deleted: true }, actor);
      return json({ ok: true, message: "False failure cleared — the video was on the listing all along." });
    }

    case "correct_stamp_price": {
      if (prop.status !== "ready") {
        return json({ ok: false, message: "Luna still needs the live price check to come back before this can be corrected." }, 200);
      }
      if (!row || row.status !== "failed" || row.action !== "update_price") {
        return markExpired(svc, prop, "That failed price row is already gone.");
      }
      const target = prop.evidence?.target_price;
      if (typeof target !== "number") {
        return markExpired(svc, prop, "The target price is missing from the proposal, so Luna didn't touch the record.");
      }
      const { data: inv } = await svc.from("scraped_inventory")
        .select("marketplace_posted_price, marketplace_posted_at")
        .eq("user_id", userId).eq("vin", row.vin).maybeSingle();
      if (!inv) return markExpired(svc, prop, "The inventory record is gone, so there's nothing to correct.");
      const before = {
        marketplace_posted_price: inv.marketplace_posted_price,
        marketplace_posted_at: inv.marketplace_posted_at,
        row,
      };
      const { error: invErr } = await svc.from("scraped_inventory").update({
        marketplace_posted_price: target,
      }).eq("user_id", userId).eq("vin", row.vin);
      if (invErr) return json({ ok: false, message: "The record update didn't go through — nothing was changed." }, 200);
      await svc.from("auto_posting_queue").delete().eq("id", row.id);
      await markApplied(svc, prop, before, { marketplace_posted_price: target, row_deleted: true }, actor);
      return json({ ok: true, message: "Record corrected to the live price and the failed row cleared." });
    }

    case "post_failure_cluster": {
      // Escalation-only: there is no data repair for a cluster and
      // no user tap should ever "fix" one. The card is an alert.
      return json({ ok: false, message: "There's nothing to fix on your side for this one \u2014 Luna has escalated it and is investigating." }, 200);
    }

    case "auto_retry_post": {
      // The opt-out path's Fix it: the same bounded re-queue the
      // sweep performs automatically, with every precondition
      // re-checked against the live rows — a stale proposal
      // expires instead of retrying blind.
      if (!row || row.action !== "post" || row.status !== "failed") {
        return markExpired(svc, prop,
          "That post is no longer in a failed state, so there's nothing to retry.");
      }
      const sig = postFailureSignature(
        typeof row.error_message === "string" ? row.error_message : "");
      if (!sig || !AUTO_RETRY_ALLOWLIST.includes(sig)) {
        return markExpired(svc, prop,
          "That failure isn't one Luna retries — it needs a human look instead.");
      }
      const { data: openClusters } = await svc.from("luna_repairs")
        .select("evidence").eq("user_id", userId)
        .eq("action", "post_failure_cluster")
        .in("status", ["proposed", "needs_verify", "ready"]).limit(20);
      if ((openClusters ?? []).some(
          (p: any) => p.evidence?.signature === sig)) {
        return markExpired(svc, prop,
          "Several posts are failing the same way right now — Luna escalated that as a cluster instead of retrying one car into it.");
      }
      const { data: priorApplied } = await svc.from("luna_repairs")
        .select("queue_row_id, before_state, applied_at")
        .eq("user_id", userId).eq("action", "auto_retry_post")
        .eq("status", "applied").limit(200);
      if ((priorApplied ?? []).some(
          (p: any) => p.queue_row_id === row.id)) {
        return markExpired(svc, prop,
          "Luna already retried this post once — a second retry is a human call.");
      }
      const windowStart = Date.now() - AUTO_RECURRENCE_WINDOW_MS;
      const priorForSig = (priorApplied ?? []).filter((p: any) =>
        p.before_state?.signature === sig && p.applied_at &&
        new Date(p.applied_at).getTime() >= windowStart).length;
      if (priorForSig >= AUTO_RECURRENCE_PRIOR_LIMIT) {
        return markExpired(svc, prop,
          "Luna has already retried this same failure a couple of times in the last two weeks — she flagged it for a closer look instead.");
      }
      const { data: reel } = await svc.from("vin_reels")
        .select("status").eq("user_id", userId).eq("vin", row.vin)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!reel || reel.status !== "ready") {
        return markExpired(svc, prop,
          "The car's video isn't ready, so a retry would fail the same way — Luna left the row alone.");
      }
      const { error } = await svc.from("auto_posting_queue").update({
        status: "pending", error_message: null, awaiting_reel: false,
      }).eq("id", row.id).eq("status", "failed");
      if (error) {
        return json({ ok: false, message: "The re-queue didn't go through — nothing was changed." }, 200);
      }
      await markApplied(svc, prop,
        { status: "failed", signature: sig }, { status: "pending" }, actor);
      return json({ ok: true, message: "Queued to try once more." });
    }

    default:
      return json({ ok: false, message: "Unknown repair action." }, 200);
  }
}

// The IG executor: every claim re-verified at tap time against the
// live row, because the world moves between proposal and tap (the
// finisher may have published the car, the user may have retried).
// Luna never calls instagram-post and never publishes here: clear
// deletes a dead record; release re-arms the user's own intent for
// the existing completion paths.
async function executeIgRepair(
  svc: any, userId: string, prop: any, actor: string,
) {
  const igId = prop.evidence?.ig_post_id ?? prop.queue_row_id;
  const { data: intent } = await svc.from("instagram_posts")
    .select("*")
    .eq("id", igId)
    .eq("user_id", userId)
    .maybeSingle();

  if (prop.action === "clear_failed_ig_intent") {
    if (!intent) {
      return markExpired(
        svc, prop,
        "That failed Instagram record is already gone.",
      );
    }
    if (intent.status !== "failed") {
      return markExpired(
        svc, prop,
        "That Instagram post is no longer in a failed state, so there's nothing to clear.",
      );
    }
    if (intent.vin) {
      const { data: pub } = await svc.from("instagram_posts")
        .select("id")
        .eq("user_id", userId)
        .eq("vin", intent.vin)
        .eq("status", "published")
        .limit(1);
      if (pub && pub.length) {
        return markExpired(
          svc, prop,
          "That car is already posted on Instagram, so Luna left the record alone.",
        );
      }
    }
    const before = { ig_row: intent };
    const { error } = await svc.from("instagram_posts")
      .delete()
      .eq("id", intent.id)
      .eq("status", "failed");
    if (error) {
      return json(
        { ok: false, message: "The clear didn't go through — nothing was changed." },
        200,
      );
    }
    await markApplied(svc, prop, before, { deleted: true }, actor);
    return json({
      ok: true,
      message:
        "Cleared — tap the car's Instagram button any time to post it fresh.",
    });
  }

  // release_stuck_ig_intent
  if (!intent) {
    return markExpired(svc, prop, "That Instagram post is already gone.");
  }
  if (intent.status !== "awaiting_reel" || !intent.vin) {
    return markExpired(
      svc, prop,
      "That Instagram post is no longer waiting, so there's nothing to re-arm.",
    );
  }
  const { data: reel } = await svc.from("vin_reels")
    .select("status, video_url")
    .eq("user_id", userId)
    .eq("vin", intent.vin)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!reel || reel.status !== "ready" || !reel.video_url) {
    return markExpired(
      svc, prop,
      "The car's video isn't ready anymore, so Luna left the parked post alone.",
    );
  }
  const front = new Date(Date.now() - IG_FRONT_MS).toISOString();
  const before = { created_at: intent.created_at };
  const { error } = await svc.from("instagram_posts")
    .update({ created_at: front })
    .eq("id", intent.id)
    .eq("status", "awaiting_reel");
  if (error) {
    return json(
      { ok: false, message: "The re-arm didn't go through — nothing was changed." },
      200,
    );
  }
  await markApplied(svc, prop, before, { created_at: front }, actor);
  return json({
    ok: true,
    message:
      "Re-armed — the post goes out on the next automatic pass, or as soon as the app is open on the car.",
  });
}

// ---------------------------------------------------------------------
// Phase 2 auto-apply (spec §12). Runs ONLY from the sweep handler —
// interactive evaluate never auto-applies. A proposal may auto-apply
// only when ALL of these hold:
//   - its class is one of AUTO_APPLY_ACTIONS and the owner kill
//     switch for that class is ON in luna_repairs_config;
//   - the user has not opted out (luna_ask_before_fixing);
//   - the evidence bar is already met: verify-gated classes must be
//     "ready" (a verdict proved the fix); the hold release is
//     "proposed" on a DB fact that executeRepair re-checks live;
//   - the recurrence guard has not tripped for (user, class).
// clear_phantom_stamp can never appear here: it is not in
// AUTO_APPLY_ACTIONS, has no config row, and has no applier.
// ---------------------------------------------------------------------

async function loadAutoConfig(svc: any): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  const { data } = await svc.from("luna_repairs_config")
    .select("action, auto_apply");
  for (const r of data ?? []) map.set(r.action, r.auto_apply === true);
  return map;
}

// ---------------------------------------------------------------------
// Bounded auto-retry for isolated transient post failures. Runs in
// the sweep after detection and auto-apply (so a cluster raised by
// this same pass already pauses retries). Returns the number of
// rows actually re-queued.
// ---------------------------------------------------------------------
async function autoRetryForUser(
  svc: any, userId: string, config: Map<string, boolean>,
): Promise<number> {
  if (config.get("auto_retry_post") !== true) return 0;

  const { data: settings } = await svc.from("user_settings")
    .select("luna_ask_before_fixing").eq("user_id", userId).maybeSingle();
  const optedOut = settings?.luna_ask_before_fixing === true;

  const { data: failedPosts } = await svc.from("auto_posting_queue")
    .select("*").eq("user_id", userId)
    .eq("action", "post").eq("status", "failed")
    .order("created_at", { ascending: true }).limit(100);
  const rows = (failedPosts ?? []).filter((r: any) =>
    AUTO_RETRY_ALLOWLIST.includes(
      postFailureSignature(
        typeof r.error_message === "string" ? r.error_message : "") ?? ""));
  if (!rows.length) return 0;

  // Precondition (d): an open cluster for the same signature
  // pauses individual retries — retrying into a known cluster is
  // the harm case; the cluster escalates instead.
  const { data: openClusters } = await svc.from("luna_repairs")
    .select("evidence").eq("user_id", userId)
    .eq("action", "post_failure_cluster")
    .in("status", ["proposed", "needs_verify", "ready"]).limit(20);
  const clustered = new Set(
    (openClusters ?? []).map((p: any) => p.evidence?.signature).filter(Boolean));

  // Precondition (c) + the recurrence guard read the same history:
  // every auto-retry that actually happened for this user.
  const { data: priorRetries } = await svc.from("luna_repairs")
    .select("queue_row_id, before_state, applied_at")
    .eq("user_id", userId).eq("action", "auto_retry_post")
    .eq("status", "applied").limit(200);
  const retriedRowIds = new Set(
    (priorRetries ?? []).map((p: any) => p.queue_row_id).filter(Boolean));
  const windowStart = Date.now() - AUTO_RECURRENCE_WINDOW_MS;
  const priorBySig = new Map<string, number>();
  for (const p of priorRetries ?? []) {
    const sig = p.before_state?.signature;
    if (sig && p.applied_at &&
        new Date(p.applied_at).getTime() >= windowStart) {
      priorBySig.set(sig, (priorBySig.get(sig) ?? 0) + 1);
    }
  }

  // Open auto-retry proposals (the opt-out path) already claim
  // their row — never double-offer or double-retry.
  const { data: openRetryProps } = await svc.from("luna_repairs")
    .select("queue_row_id").eq("user_id", userId)
    .eq("action", "auto_retry_post")
    .in("status", ["proposed", "needs_verify", "ready"]).limit(100);
  const proposedRowIds = new Set(
    (openRetryProps ?? []).map((p: any) => p.queue_row_id).filter(Boolean));

  const reelMap = await latestReelByVin(
    svc, userId, [...new Set(rows.map((r: any) => r.vin))]);

  const now = Date.now();
  let retried = 0;
  for (const row of rows) {
    const sig = postFailureSignature(
      typeof row.error_message === "string" ? row.error_message : "");
    if (!sig) continue;
    if (clustered.has(sig)) continue;                       // (d)
    if (retriedRowIds.has(row.id)) continue;                // (c)
    if (proposedRowIds.has(row.id)) continue;               // already offered
    if (now - new Date(row.created_at).getTime() <
        AUTO_RETRY_COOLDOWN_MS) continue;                   // (b)
    const reel = reelMap.get(row.vin);
    if (!reel || reel.status !== "ready") continue;         // (a)

    if ((priorBySig.get(sig) ?? 0) >= AUTO_RECURRENCE_PRIOR_LIMIT) {
      // Recurrence guard: stop retrying this failure mode and
      // escalate instead (the watchdog evidence shape, so the
      // digest surfaces it like every other escalation).
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "auto_retry_post",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "proposed",
        evidence: {
          signature: sig,
          failure: (row.error_message ?? "").slice(0, 400),
          escalated: {
            at: new Date().toISOString(),
            reason: `auto-retry paused: ${sig} has already been auto-retried ${AUTO_RECURRENCE_PRIOR_LIMIT} times in 14 days — repeated identical failures are a defect signal, not maintenance`,
            failure: null,
            reported: false,
          },
        },
        summary: "This post keeps failing the same way, and Luna has already retried this failure a couple of times in the last two weeks — so she stopped retrying it on her own and flagged it for a closer look.",
      });
      if (ok) proposedRowIds.add(row.id);
      continue;
    }

    if (optedOut) {
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "auto_retry_post",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "proposed",
        evidence: {
          signature: sig,
          failure: (row.error_message ?? "").slice(0, 400),
        },
        summary: "This post failed at the video gate, which is usually temporary. Luna can queue it to try once more.",
      });
      if (ok) proposedRowIds.add(row.id);
      continue;
    }

    // The retry itself: exactly one data move — re-queue the row.
    const { error } = await svc.from("auto_posting_queue").update({
      status: "pending", error_message: null, awaiting_reel: false,
    }).eq("id", row.id).eq("status", "failed");
    if (error) {
      console.error("luna-repairs autoRetry requeue", error);
      continue;
    }
    await svc.from("luna_repairs").insert({
      user_id: userId,
      action: "auto_retry_post",
      vin: row.vin,
      queue_row_id: row.id,
      lane: "auto",
      actor: "luna",
      status: "applied",
      evidence: { signature: sig },
      before_state: { status: "failed", signature: sig },
      after_state: { status: "pending" },
      summary: "This post failed at the video gate, which is usually temporary — Luna queued it to try once more.",
      applied_at: new Date().toISOString(),
    });
    retriedRowIds.add(row.id);
    priorBySig.set(sig, (priorBySig.get(sig) ?? 0) + 1);
    retried++;
  }
  return retried;
}

async function autoApplyForUser(
  svc: any, userId: string, config: Map<string, boolean>,
): Promise<number> {
  const enabled = AUTO_APPLY_ACTIONS.filter((a) => config.get(a) === true);
  if (!enabled.length) return 0;

  // Per-user opt-out (spec §12): "Ask me before fixing" demotes
  // every auto-fix for this account back to an ASK proposal.
  const { data: settings } = await svc.from("user_settings")
    .select("luna_ask_before_fixing").eq("user_id", userId).maybeSingle();
  if (settings?.luna_ask_before_fixing === true) return 0;

  const { data: open } = await svc.from("luna_repairs")
    .select("*").eq("user_id", userId)
    .in("action", enabled)
    .in("status", ["proposed", "ready"])
    .order("created_at", { ascending: true }).limit(20);

  // Evidence bar per class: verify-gated classes only at "ready"
  // (verdict-proven); the hold release at "proposed" (DB fact,
  // re-checked inside executeRepair against the live rows).
  const candidates = (open ?? []).filter((p: any) =>
    !p.evidence?.escalated &&
    (p.action === "release_stuck_reel_hold" || p.status === "ready"));
  if (!candidates.length) return 0;

  // Recurrence guard (spec §12): count this user's auto-applies per
  // class inside the window once, then track locally as we apply.
  const since = new Date(Date.now() - AUTO_RECURRENCE_WINDOW_MS).toISOString();
  const priorByAction = new Map<string, number>();
  for (const a of enabled) {
    const { count } = await svc.from("luna_repairs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("action", a)
      .eq("actor", "auto").eq("status", "applied")
      .gte("applied_at", since);
    priorByAction.set(a, count ?? 0);
  }

  let applied = 0;
  for (const prop of candidates) {
    if ((priorByAction.get(prop.action) ?? 0) >= AUTO_RECURRENCE_PRIOR_LIMIT) {
      // The guard trips: stop fixing this class for this user and
      // escalate (same evidence shape as the verify escalation, so
      // the watchdog digest surfaces it). The proposal stays open —
      // the user can still tap Fix; Luna just stops doing it alone.
      await svc.from("luna_repairs").update({
        evidence: {
          ...prop.evidence,
          escalated: {
            at: new Date().toISOString(),
            reason: `auto-fix paused: this is the 3rd ${prop.action} case in 14 days — repeated identical repairs are a defect signal, not maintenance`,
            failure: null,
            reported: false,
          },
        },
        summary: `Luna has fixed this same kind of problem several times in the last two weeks, so she stopped fixing it on her own and flagged it for a closer look. You can still tap Fix here — but if this keeps happening, something upstream is broken.`,
        updated_at: new Date().toISOString(),
      }).eq("id", prop.id);
      continue;
    }
    await executeRepair(svc, userId, prop, "auto");
    const { data: after } = await svc.from("luna_repairs")
      .select("status").eq("id", prop.id).maybeSingle();
    if (after?.status === "applied") {
      applied++;
      priorByAction.set(prop.action, (priorByAction.get(prop.action) ?? 0) + 1);
    }
  }
  return applied;
}

// ---------------------------------------------------------------------
// Undo. Restores before_state within the window. Deletions re-insert
// the snapshotted row (same id) in its failed state.
// ---------------------------------------------------------------------

async function undoRepair(svc: any, userId: string, prop: any) {
  if (prop.status !== "applied" || !prop.applied_at) {
    return json({ ok: false, message: "Only an applied repair can be undone." }, 200);
  }
  if (Date.now() - new Date(prop.applied_at).getTime() > UNDO_WINDOW_MS) {
    return json({ ok: false, message: "The 7-day undo window has closed for this repair." }, 200);
  }
  const before = prop.before_state ?? {};
  const nowIso = new Date().toISOString();

  if (prop.action === "release_stuck_reel_hold") {
    await svc.from("auto_posting_queue").update({
      awaiting_reel: before.awaiting_reel ?? true,
      error_message: before.error_message ?? null,
    }).eq("id", prop.queue_row_id).eq("user_id", userId);
  } else if (prop.action === "bump_starved_attaches") {
    await svc.from("auto_posting_queue").update({
      created_at: before.created_at,
    }).eq("id", prop.queue_row_id).eq("user_id", userId);
  } else if (prop.action === "correct_stamp_price") {
    await svc.from("scraped_inventory").update({
      marketplace_posted_price: before.marketplace_posted_price ?? null,
    }).eq("user_id", userId).eq("vin", prop.vin);
    if (before.row) {
      const r = { ...before.row };
      await svc.from("auto_posting_queue").insert(r);
    }
  } else if (prop.action === "remove_dead_row" || prop.action === "clear_false_attach_failure") {
    if (before.row) {
      const r = { ...before.row };
      await svc.from("auto_posting_queue").insert(r);
    }
  } else if (prop.action === "clear_failed_ig_intent") {
    // Re-insert the snapshotted instagram_posts row exactly as it
    // was (same id, same failure, same timestamps).
    if (before.ig_row) {
      await svc.from("instagram_posts").insert({ ...before.ig_row });
    }
  } else if (prop.action === "release_stuck_ig_intent") {
    // Restore the intent's original created_at (drop it back out of
    // the front of the finisher's line). If the post already went
    // out, the row's status has moved on and this only restores a
    // timestamp on a published record — harmless.
    await svc.from("instagram_posts")
      .update({ created_at: before.created_at })
      .eq("id", prop.queue_row_id)
      .eq("user_id", userId);
  }

  await svc.from("luna_repairs").update({
    status: "undone", undone_at: nowIso, updated_at: nowIso,
  }).eq("id", prop.id);
  return json({ ok: true, message: "Repair undone — the record is back as it was." });
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const action = body?.action;
  const svc = serviceClient();

  // Daily sweep: secret-gated (spec §12). Detection + verdict
  // consumption for every account, then the Phase 2 auto-apply pass
  // (a no-op unless a class is enabled in luna_repairs_config — with
  // every class off, the sweep's outcome is exactly Phase 1's:
  // proposals only). "only_user" scopes the run to one account for
  // smoke tests; the nightly cron never sends it.
  if (action === "sweep") {
    const secret = Deno.env.get("LUNA_SWEEP_SECRET") ?? "";
    if (!secret || body?.secret !== secret) return json({ error: "unauthorized" }, 401);
    const onlyUser = typeof body?.only_user === "string" && body.only_user
      ? body.only_user : null;
    const config = await loadAutoConfig(svc);
    const { data: users } = onlyUser
      ? { data: [{ user_id: onlyUser }] }
      : await svc.from("user_settings").select("user_id").limit(2000);
    let proposals = 0;
    let autoApplied = 0;
    let autoRetried = 0;
    for (const u of users ?? []) {
      await consumeVerdicts(svc, u.user_id);
      proposals += await runDetection(svc, u.user_id);
      autoApplied += await autoApplyForUser(svc, u.user_id, config);
      autoRetried += await autoRetryForUser(svc, u.user_id, config);
    }
    return json({
      ok: true, users: (users ?? []).length,
      proposals_created: proposals, auto_applied: autoApplied, auto_retried: autoRetried,
    });
  }

  const user = await verifyUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const userId = user.id as string;

  if (action === "evaluate" || action === "list") {
    if (action === "evaluate") {
      await consumeVerdicts(svc, userId);
      await runDetection(svc, userId);
    }
    const [{ data: open }, { data: activity }] = await Promise.all([
      svc.from("luna_repairs").select("*").eq("user_id", userId)
        .in("status", ["proposed", "needs_verify", "ready"])
        .order("created_at", { ascending: true }).limit(50),
      svc.from("luna_repairs").select("*").eq("user_id", userId)
        .in("status", ["applied", "undone", "failed", "expired"])
        .order("updated_at", { ascending: false }).limit(20),
    ]);
    return json({ ok: true, proposals: open ?? [], activity: activity ?? [] });
  }

  if (action === "execute" || action === "dismiss" || action === "undo") {
    const repairId = body?.repair_id;
    if (!repairId) return json({ error: "repair_id required" }, 400);
    const { data: prop } = await svc.from("luna_repairs")
      .select("*").eq("id", repairId).eq("user_id", userId).maybeSingle();
    if (!prop) return json({ error: "not found" }, 404);

    if (action === "dismiss") {
      if (!["proposed", "needs_verify", "ready"].includes(prop.status)) {
        return json({ ok: false, message: "That proposal is already closed." }, 200);
      }
      // A dismissed verify-gated proposal also retires its verify job
      // so it never lingers in the helper's claim window.
      if (prop.verify_queue_id) {
        await svc.from("auto_posting_queue").delete()
          .eq("id", prop.verify_queue_id).eq("status", "pending");
      }
      await svc.from("luna_repairs").update({
        status: "dismissed", updated_at: new Date().toISOString(),
      }).eq("id", prop.id);
      return json({ ok: true, message: "Proposal dismissed." });
    }

    if (action === "undo") return undoRepair(svc, userId, prop);

    if (!["proposed", "ready"].includes(prop.status)) {
      return json({ ok: false, message: "That repair isn't in a state Luna can apply." }, 200);
    }
    return executeRepair(svc, userId, prop);
  }

  return json({ error: "unknown action" }, 400);
});
