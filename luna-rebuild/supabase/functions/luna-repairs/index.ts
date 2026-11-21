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
// Toolbox expansion (2026-11-21, Matthew's direction: "fix
// anything that can go wrong, as long as she doesn't have to
// write code"). Eight new DATA-only classes join the registry,
// each following the standing pattern — detector, verify-before-
// repair from positive evidence, before/after snapshot, 7-day
// undo, report-after, opt-out + recurrence guard respected:
//   release_orphaned_claim    — a queue row stuck in "processing"
//     (helper claimed it and never settled) is handed back to the
//     normal claim/hold machinery. ASK first; config row exists.
//   requeue_failed_render     — a vin_reels row that failed on a
//     proven transport error (or starved for photos it has since
//     gained) is queued to render again. Per-VIN recurrence guard
//     (2 per 14 days) replaces the per-user one for this class.
//     Auto-apply ON at ship (owner config row).
//   retry_failed_delete       — a failed Marketplace delete for a
//     car that is still posted and still gone gets ONE bounded
//     re-queue (never for identity/auth signatures). ASK first.
//   rearm_parked_ig_sold_action — an Instagram sold-delete/mark
//     row the finisher parked forever (permission or Meta error)
//     is flipped back into the sold sweep's selection shape
//     (published + error_code "sold_delete_candidate"); the
//     finisher re-verifies and executes. The permission subclass
//     auto-applies once the connection's scope PROVES the grant;
//     the error subclass stays ASK.
//   unstick_verify_proposal   — Luna's own proposals wedged in
//     needs_verify by a vanished verify row (or gone stale over a
//     vanished target) are un-wedged / expired by the sweep. Zero
//     blast radius (her own bookkeeping). Auto-apply ON at ship.
//   dedupe_pending_queue_rows — duplicate live queue intents for
//     the same car+action: keep the oldest (newest for price
//     updates), remove the rest. ASK only.
//   resolve_dead_reel_hold    — a post held by a reel that failed
//     for a content reason (e.g. too few photos) is cleared so
//     the car can be queued fresh once fixed. ASK forever — it
//     cancels a post intent; it NEVER posts a car bare.
//   correct_stale_stamp       — verify-gated sibling of
//     correct_stamp_price for a stamp that diverged from the
//     advertised price with NO failed row behind it (hard $500
//     gate; Luna never creates update_price rows — the drift
//     pass owns those). Own config row, OFF at ship.
// Plus detector extensions: remove_dead_row gains two DB-fact
// subsets (E1), clear_failed_ig_intent gains a weekly slow-path
// re-proposal for records older than 24h (E2), and the hold
// detector's marker list is completed from the E3 enumeration —
// the helper/worker hold encodings are the awaiting_reel flag
// plus the reel_claim_hold / reel_gate_hold / reel_gate_abort
// error markers (reel_needs_attention settles a row FAILED, so
// it is not a hold; reel_failed is a completion flag on posted
// rows, never a hold encoding).
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

// Toolbox expansion (2026-11-21) tuning. A claimed queue row's
// job life is minutes; 6h in "processing" is an orphan by any
// measure (the row has no updated_at — created_at is its clock).
const ORPHAN_CLAIM_MS = 6 * 3600 * 1000;
// A failed render younger than this may still be settling in a
// report somewhere; older is a settled failure Luna may requeue.
const FAILED_RENDER_MIN_AGE_MS = 3600 * 1000;
// A post held by a content-failed reel is "dead" once the reel
// has been failed a full day (a same-day failure may still be a
// photo upload in progress on the user's side).
const DEAD_REEL_HOLD_MS = 24 * 3600 * 1000;
// IG sold-action error subclass: the finisher parks on the first
// Meta error; Luna waits a day before offering a re-arm so a
// transient Meta wobble settles on its own first.
const IG_SOLD_ERROR_COOLDOWN_MS = 24 * 3600 * 1000;
// Luna's own wedged proposals: a verify row that vanished, or a
// target that vanished, is provable after a day of no movement.
const UNSTICK_MIN_AGE_MS = 24 * 3600 * 1000;
// correct_stale_stamp: the $500 price gate (Matthew, 2026-11-18)
// bounds the class — sub-$500 divergence is intentional drift
// behaviour, never a defect — and the stamp must be settled
// (>48h) before Luna questions it.
const STALE_STAMP_GATE = 500;
const STALE_STAMP_MIN_AGE_MS = 48 * 3600 * 1000;
// requeue_failed_render's per-VIN recurrence guard: this many
// Luna requeues of one car's render inside 14 days, then she
// stops proposing — repeat transport failures on one car are an
// infrastructure signal, not maintenance.
const REQUEUE_VIN_LIMIT = 2;

// Phase 2 auto-apply (spec §12). Exactly these classes may ever
// auto-apply; clear_phantom_stamp is deliberately absent — absence
// evidence never auto-fixes.
const AUTO_APPLY_ACTIONS = [
  "clear_false_attach_failure",
  "release_stuck_reel_hold",
  "correct_stamp_price",
  // Toolbox expansion (2026-11-21). Membership only makes a
  // class ELIGIBLE; its luna_repairs_config row still gates it.
  // dedupe_pending_queue_rows and resolve_dead_reel_hold are
  // deliberately absent (ASK classes — they remove intents).
  "release_orphaned_claim",
  "requeue_failed_render",
  "retry_failed_delete",
  "rearm_parked_ig_sold_action",
  "unstick_verify_proposal",
  "correct_stale_stamp",
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
  release_orphaned_claim:
    "Luna fixed this on her own overnight: a job that got stuck mid-flight was handed back to the queue, so the work can go ahead.",
  requeue_failed_render:
    "Luna fixed this on her own overnight: the video render had failed on a connection error, so she queued it to render again. (Undo only takes it back if the render hasn't started yet.)",
  retry_failed_delete:
    "Luna fixed this on her own overnight: she re-queued the delete for a car that has sold, so its listing comes down.",
  rearm_parked_ig_sold_action:
    "Luna fixed this on her own overnight: the permission Instagram needed is granted now, so she put the sold car's post back in line to be taken down.",
  unstick_verify_proposal:
    "Luna fixed this on her own overnight: one of her own checks had gotten stuck, so she un-wedged it.",
  correct_stale_stamp:
    "Luna fixed this on her own overnight: she checked the live listing, it already showed the current price, and she corrected your records.",
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

// Proven-transient render failures (toolbox expansion, N2).
// The allowlist philosophy mirrors AUTO_RETRY_ALLOWLIST: only
// error shapes that are PROVEN transport faults — a truncated or
// dropped photo download/upload, a broken pipe, a connection the
// remote end closed — never content or render-logic failures.
const TRANSPORT_ERROR_PATTERNS = [
  "incomplete", "broken pipe", "remote end closed",
  "photo download incomplete", "row_finish",
  "connection reset", "connection aborted", "socket hang up",
];
function isTransportRenderError(err: string): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  if (TRANSPORT_ERROR_PATTERNS.some((p) => e.includes(p))) return true;
  // TTS synthesis dying on a network fault names the stage plus
  // a transport word; a plain TTS content failure does not.
  return e.includes("tts") &&
    (e.includes("connection") || e.includes("transport") ||
     e.includes("unreachable") || e.includes("socket"));
}

// Photo-starved render failures: "only N usable photos (need M)".
// Returns { have, need } when the error is that class, else null.
function photoStarvedNeed(err: string): { have: number; need: number } | null {
  if (!err) return null;
  const m = err.match(/only\s+(\d+)\s+usable photos\s*\(need\s*(\d+)\)/i);
  if (!m) return null;
  return { have: parseInt(m[1]), need: parseInt(m[2]) };
}

// Delete failures Luna must never retry on her own (N3): a
// retry must never be able to do the wrong thing twice, so
// identity uncertainty and dead sessions are excluded outright.
const DELETE_NEVER_RETRY_PATTERNS = [
  "vin mismatch", "vin does not match", "identity not confirmed",
  "identity_ok=false", "identity check", "not logged in",
  "session expired", "auth error", "permission denied",
  "wrong listing", "wrong vehicle",
];
function deleteRetryBlocked(err: string): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return DELETE_NEVER_RETRY_PATTERNS.some((p) => e.includes(p));
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
    .select("vin, marketplace_posted_price, marketplace_posted_at, is_active, status, price, stock_number, year, make, model, usable_photo_count")
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
          r.error_message.includes("reel_gate_hold") ||
          r.error_message.includes("reel_gate_abort")))));
  const pendingPosts = pending.filter((r: any) => r.action === "post");
  const pendingAttaches = pending.filter((r: any) => r.action === "attach_video");

  const reelMap = await latestReelByVin(
    svc, userId,
    [...new Set(heldPosts.map((r: any) => r.vin))],
  );
  const invMap = await inventoryByVin(
    svc, userId,
    [...new Set([...failed, ...pending].map((r: any) => r.vin))],
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
    .in("action", ["clear_false_attach_failure", "correct_stamp_price", "correct_stale_stamp"]);
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

  // N3 history: rows Luna has already delete-retried once are
  // never offered again (the auto_retry_post one-retry rule).
  const { data: priorDeleteRetries } = await svc.from("luna_repairs")
    .select("queue_row_id")
    .eq("user_id", userId).eq("action", "retry_failed_delete")
    .eq("status", "applied");
  const deleteRetriedRows = new Set(
    (priorDeleteRetries ?? []).map((r: any) => r.queue_row_id).filter(Boolean),
  );

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

    // N3: retry_failed_delete — the car is still posted AND
    // still gone (sold/exited), so the delete's reason still
    // holds and the listing is still advertising a car the rep
    // can't sell. One bounded re-queue; identity/auth failure
    // signatures are never retried (deleteRetryBlocked).
    if (row.action === "delete" && inv && inv.marketplace_posted_at &&
        (inv.is_active === false ||
          (typeof inv.status === "string" && inv.status.toLowerCase() === "sold")) &&
        !deleteRetryBlocked(err) && !deleteRetriedRows.has(row.id)) {
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "retry_failed_delete",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "proposed",
        evidence: {
          failure: err.slice(0, 400),
          signature: postFailureSignature(err),
        },
        summary: `The delete for your ${carLabel(row)} failed, and the car has sold — so its listing is still up, advertising a car you can't sell. Luna can queue the delete once more; the posting tool re-checks the listing's identity before removing anything.`,
      });
      if (ok) created++;
      continue;
    }

    // Action 5: remove_dead_row (DB-only subsets) --------------------
    let deadReason: string | null = null;
    // E1 subset (i): a failed attach on a car that was never
    // posted and has no post waiting — debris from a post that
    // never landed; there is nothing for it to attach to.
    if (row.action === "attach_video" && inv && !inv.marketplace_posted_at &&
        !pending.some((o: any) => o.vin === row.vin && o.action === "post")) {
      deadReason = "the car was never posted, so this failed video attach has nothing to attach to";
    }
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

  // E1 subset (ii): a PENDING update_price row whose target the
  // stamp already shows — the goal is achieved and the row is
  // pure claim-window clutter. Same DB-fact evidence class as
  // the failed subsets; the executor re-checks before deleting.
  for (const row of pending) {
    if (row.action !== "update_price" || typeof row.price !== "number") continue;
    const inv = invMap.get(row.vin);
    if (!inv || inv.marketplace_posted_price !== row.price) continue;
    const ok = await insertProposal(svc, {
      user_id: userId,
      action: "remove_dead_row",
      vin: row.vin,
      queue_row_id: row.id,
      lane: "ask",
      status: "proposed",
      evidence: {
        reason: "your records already show the target price, so this waiting row is just debris",
        subset: "pending_update_price_achieved",
        failure: "",
      },
      summary: `A waiting price-change job for your ${carLabel(row)} is already done — your records show the target price of $${row.price}. Luna can remove the row so it stops cluttering your queue.`,
    });
    if (ok) created++;
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

  // --- N1: release_orphaned_claim -----------------------------------
  // A queue row the helper claimed (status "processing") and
  // never settled — PC locked mid-job, helper killed, claim
  // response eaten. The claim query only takes "pending", so
  // the row is invisible forever. Queue rows have no updated_at;
  // created_at + status is the only clock, and 6h is far beyond
  // any real job's minutes-long life.
  {
    const { data: processing } = await svc.from("auto_posting_queue")
      .select("*")
      .eq("user_id", userId).eq("status", "processing")
      .order("created_at", { ascending: true }).limit(100);
    for (const row of processing ?? []) {
      if (now - new Date(row.created_at).getTime() < ORPHAN_CLAIM_MS) continue;
      const reel = (await latestReelByVin(svc, userId, [row.vin])).get(row.vin);
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "release_orphaned_claim",
        vin: row.vin,
        queue_row_id: row.id,
        lane: "ask",
        status: "proposed",
        evidence: {
          stuck_since: row.created_at,
          action_kind: row.action,
          reel_status_now: reel ? reel.status : null,
          failure: (typeof row.error_message === "string"
            ? row.error_message : "").slice(0, 400),
        },
        summary: `A job for your ${carLabel(row)} got claimed and then stuck — it has been sitting mid-flight for hours, so the work silently never happens. Luna can hand the job back to the queue so it can run (or wait for its video) normally.`,
      });
      if (ok) created++;
    }
  }

  // --- N2: requeue_failed_render -------------------------------------
  // The newest reel row per VIN decides: only a LATEST reel that
  // is failed is a candidate (a newer queued/generating/ready/
  // consumed row means the pipeline already moved on). Eligible
  // evidence: a proven transport error, or a photo-starved
  // failure whose car has since gained enough usable photos.
  {
    const { data: recentReels } = await svc.from("vin_reels")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(300);
    const latestByVin = new Map<string, any>();
    for (const r of recentReels ?? []) {
      if (!latestByVin.has(r.vin)) latestByVin.set(r.vin, r);
    }
    const windowStart = now - AUTO_RECURRENCE_WINDOW_MS;
    const { data: priorRequeues } = await svc.from("luna_repairs")
      .select("vin, applied_at")
      .eq("user_id", userId).eq("action", "requeue_failed_render")
      .eq("status", "applied")
      .gte("applied_at", new Date(windowStart).toISOString());
    const requeuesByVin = new Map<string, number>();
    for (const r of priorRequeues ?? []) {
      if (r.vin) requeuesByVin.set(r.vin, (requeuesByVin.get(r.vin) ?? 0) + 1);
    }
    for (const reel of latestByVin.values()) {
      if (reel.status !== "failed") continue;
      if (now - new Date(reel.created_at).getTime() < FAILED_RENDER_MIN_AGE_MS) continue;
      const err = typeof reel.error === "string" ? reel.error : "";
      const transport = isTransportRenderError(err);
      const starved = transport ? null : photoStarvedNeed(err);
      let errorClass: string | null = null;
      if (transport) {
        errorClass = "transport";
      } else if (starved) {
        let inv = invMap.get(reel.vin);
        if (!inv) {
          const { data: invRow } = await svc.from("scraped_inventory")
            .select("vin, usable_photo_count, year, make, model")
            .eq("user_id", userId).eq("vin", reel.vin).maybeSingle();
          inv = invRow ?? undefined;
        }
        if (inv && typeof inv.usable_photo_count === "number" &&
            inv.usable_photo_count >= starved.need) {
          errorClass = "photos_ready";
        }
      }
      if (!errorClass) continue;
      if ((requeuesByVin.get(reel.vin) ?? 0) >= REQUEUE_VIN_LIMIT) continue;
      const label = carLabel(invMap.get(reel.vin) ?? reel);
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "requeue_failed_render",
        vin: reel.vin,
        queue_row_id: reel.id,
        lane: "ask",
        status: "proposed",
        evidence: {
          reel_id: reel.id,
          error_class: errorClass,
          failure: err.slice(0, 400),
          requeues_14d: requeuesByVin.get(reel.vin) ?? 0,
        },
        summary: errorClass === "transport"
          ? `The video for your ${label} failed to render on a connection error — the kind that usually just works on another try. Luna can queue it to render again.`
          : `The video for your ${label} couldn't render before because there weren't enough usable photos — there are now. Luna can queue it to render again.`,
      });
      if (ok) created++;
    }
  }

  // --- N6: dedupe_pending_queue_rows ---------------------------------
  // Duplicate live intents for the same car + action + channel.
  // Keep the OLDEST (the first intent), except update_price,
  // where the NEWEST target supersedes. Verify rows are Luna's
  // own machinery and are never deduped here.
  {
    const groups = new Map<string, any[]>();
    for (const row of pending) {
      if (!["post", "delete", "update_price", "attach_video"].includes(row.action)) continue;
      const key = `${row.vin}|${row.action}|${row.target_channel ?? ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const sorted = [...rows].sort((a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const keep = sorted[0].action === "update_price"
        ? sorted[sorted.length - 1] : sorted[0];
      for (const dup of sorted) {
        if (dup.id === keep.id) continue;
        const ok = await insertProposal(svc, {
          user_id: userId,
          action: "dedupe_pending_queue_rows",
          vin: dup.vin,
          queue_row_id: dup.id,
          lane: "ask",
          status: "proposed",
          evidence: {
            keep_row_id: keep.id,
            kept_created_at: keep.created_at,
            dup_created_at: dup.created_at,
            group_size: sorted.length,
            action_kind: dup.action,
          },
          summary: `Your ${carLabel(dup)} has ${sorted.length} identical ${dup.action === "post" ? "post" : dup.action} jobs waiting — a duplicate from a double-tap or a re-queue. Running both would do the same work twice. Luna can remove the extra one and keep the ${dup.action === "update_price" ? "newest" : "first"}.`,
        });
        if (ok) created++;
      }
    }
  }

  // --- N7: resolve_dead_reel_hold -------------------------------------
  // A held post whose latest reel failed for a CONTENT reason:
  // it can never post (no-video is a hard rule), the release
  // detector needs a ready reel so it never fires, and where the
  // row carries a helper marker the worker's reconcile won't
  // touch it either. Transport failures are N2's domain, not
  // this one's — a render that may succeed on retry is not dead.
  for (const row of heldPosts) {
    const reel = reelMap.get(row.vin);
    if (!reel || reel.status !== "failed") continue;
    const reelStamp = reel.updated_at ?? reel.created_at;
    if (now - new Date(reelStamp).getTime() < DEAD_REEL_HOLD_MS) continue;
    const err = typeof reel.error === "string" ? reel.error : "";
    if (isTransportRenderError(err)) continue;
    const starved = photoStarvedNeed(err);
    const inv = invMap.get(row.vin);
    const ok = await insertProposal(svc, {
      user_id: userId,
      action: "resolve_dead_reel_hold",
      vin: row.vin,
      queue_row_id: row.id,
      lane: "ask",
      status: "proposed",
      evidence: {
        reel_id: reel.id,
        failure: err.slice(0, 400),
        usable_photos: inv && typeof inv.usable_photo_count === "number"
          ? inv.usable_photo_count : null,
      },
      summary: starved
        ? `Your ${carLabel(row)} is waiting to post, but its video can't be made — the car only has ${starved.have} usable photo${starved.have === 1 ? "" : "s"} (it needs ${starved.need}). The post will sit forever as-is. Luna can clear the stuck post; once the car has more photos, you can queue it fresh.`
        : `Your ${carLabel(row)} is waiting to post, but its video failed in a way a retry won't fix. The post will sit forever as-is. Luna can clear the stuck post so the car can be queued fresh once the video problem is sorted.`,
    });
    if (ok) created++;
  }

  // --- N5: unstick_verify_proposal (Luna's own wedges) ----------------
  // Branch (i): a needs_verify proposal whose verify job vanished
  // without a verdict — detection never re-enqueues because
  // verify_queue_id is non-null, so the card can never become
  // actionable. Branch (ii): a proposed/ready proposal older than
  // a day whose target row no longer exists — execute would only
  // expire it on tap; the sweep garbage-collects it instead.
  // Escalated proposals are intentionally parked for agent-Luna
  // and are never touched here.
  {
    const { data: ownProps } = await svc.from("luna_repairs")
      .select("*")
      .eq("user_id", userId)
      .in("status", ["needs_verify", "proposed", "ready"])
      .lt("created_at", new Date(now - UNSTICK_MIN_AGE_MS).toISOString())
      .limit(100);
    for (const target of ownProps ?? []) {
      if (target.action === "unstick_verify_proposal" ||
          target.action === "post_failure_cluster") continue;
      if (target.evidence?.escalated) continue;
      if (target.status === "needs_verify") {
        if (!target.verify_queue_id) continue;
        const { data: vrow } = await svc.from("auto_posting_queue")
          .select("id").eq("id", target.verify_queue_id).maybeSingle();
        if (vrow) continue;
        const ok = await insertProposal(svc, {
          user_id: userId,
          action: "unstick_verify_proposal",
          vin: target.vin,
          queue_row_id: target.id,
          lane: "ask",
          status: "proposed",
          evidence: {
            branch: "verify_orphan",
            target_action: target.action,
            verify_orphans: target.evidence?.verify_orphans ?? 0,
          },
          summary: `One of Luna's own checks got stuck — the live-listing check for a repair disappeared before it could report back, so the repair card could never move. Luna can un-wedge her own check so it runs again.`,
        });
        if (ok) created++;
      } else {
        if (!target.queue_row_id) continue;
        const igClass = target.action === "clear_failed_ig_intent" ||
          target.action === "release_stuck_ig_intent" ||
          target.action === "rearm_parked_ig_sold_action";
        const table = igClass ? "instagram_posts"
          : target.action === "requeue_failed_render" ? "vin_reels"
          : "auto_posting_queue";
        const { data: trow } = await svc.from(table)
          .select("id").eq("id", target.queue_row_id).maybeSingle();
        if (trow) continue;
        const ok = await insertProposal(svc, {
          user_id: userId,
          action: "unstick_verify_proposal",
          vin: target.vin,
          queue_row_id: target.id,
          lane: "ask",
          status: "proposed",
          evidence: {
            branch: "dead_target",
            target_action: target.action,
          },
          summary: `One of Luna's repair cards points at a record that no longer exists, so it can never be acted on. Luna can close the stale card out.`,
        });
        if (ok) created++;
      }
    }
  }

  // --- N8: correct_stale_stamp (verify-gated) --------------------------
  // A stamp diverged from the advertised price with NO update_
  // price row behind it. Bounded by the $500 gate and a 48h
  // settle; Luna never manufactures the missing row (the drift
  // pass owns update_price rows) — she only corrects the record
  // when a live verdict proves the listing already shows the
  // current price. Manual dedupe (queue_row_id is null, like
  // the cluster class) + a verdict-failed guard keyed on the
  // (stamp, target) pair the verdict already judged.
  {
    const { data: openStale } = await svc.from("luna_repairs")
      .select("vin")
      .eq("user_id", userId).eq("action", "correct_stale_stamp")
      .in("status", ["proposed", "needs_verify", "ready"]);
    const openStaleVins = new Set((openStale ?? []).map((r: any) => r.vin));
    const { data: failedStale } = await svc.from("luna_repairs")
      .select("vin, evidence")
      .eq("user_id", userId).eq("action", "correct_stale_stamp")
      .eq("status", "failed");
    const judgedPairs = new Set((failedStale ?? []).map((r: any) =>
      `${r.vin}|${r.evidence?.stamp_price}|${r.evidence?.target_price}`));
    const priceRowVins = new Set(
      [...failed, ...pending]
        .filter((r: any) => r.action === "update_price")
        .map((r: any) => r.vin),
    );
    const { data: invRows } = await svc.from("scraped_inventory")
      .select("vin, year, make, model, price, marketplace_posted_price, marketplace_posted_at")
      .eq("user_id", userId)
      .not("marketplace_posted_at", "is", null)
      .limit(500);
    for (const inv of invRows ?? []) {
      if (typeof inv.price !== "number" ||
          typeof inv.marketplace_posted_price !== "number") continue;
      if (Math.abs(inv.marketplace_posted_price - inv.price) < STALE_STAMP_GATE) continue;
      if (now - new Date(inv.marketplace_posted_at).getTime() < STALE_STAMP_MIN_AGE_MS) continue;
      if (priceRowVins.has(inv.vin) || openStaleVins.has(inv.vin)) continue;
      if (judgedPairs.has(`${inv.vin}|${inv.marketplace_posted_price}|${inv.price}`)) continue;
      const ok = await insertProposal(svc, {
        user_id: userId,
        action: "correct_stale_stamp",
        vin: inv.vin,
        queue_row_id: null,
        lane: "ask",
        status: "needs_verify",
        evidence: {
          target_price: inv.price,
          stamp_price: inv.marketplace_posted_price,
          checks: ["listing_present", "live_price"],
        },
        summary: `Your records say your ${carLabel(inv)} posted at $${inv.marketplace_posted_price}, but its advertised price is $${inv.price} — and no price-change job explains the gap. Luna can check the live listing first: if it already shows $${inv.price}, she'll correct the record; if it doesn't, she'll leave everything exactly as it is.`,
      });
      if (ok) created++;
    }
  }

  // --- Instagram: failed records + stuck intents -------------------
  created += await runIgDetection(svc, userId, now);

  // --- N4: parked Instagram sold actions ------------------------------
  created += await runIgSoldDetection(svc, userId, now);

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
      // correct_stale_stamp carries no queue row (that absence
      // is the point of the class): its verify job is built from
      // the inventory record, priced at the verdict target.
      let qrow: any = null;
      if (prop.action === "correct_stale_stamp") {
        const { data: inv } = await svc.from("scraped_inventory")
          .select("vin, year, make, model, stock_number")
          .eq("user_id", userId).eq("vin", prop.vin).maybeSingle();
        if (inv) {
          qrow = {
            vin: inv.vin, year: inv.year, make: inv.make,
            model: inv.model, stock_num: inv.stock_number,
            price: typeof prop.evidence?.target_price === "number"
              ? prop.evidence.target_price : null,
          };
        }
      } else {
        const { data } = await svc.from("auto_posting_queue")
          .select("*").eq("id", prop.queue_row_id).maybeSingle();
        qrow = data;
      }
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

  // E2 slow path: a failed record older than the 24h window is
  // re-proposed at most once a week — the freshness window must
  // not make an old failure invisible forever while it still
  // blocks a clean retry.
  const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const { data: recentIgProps } = await svc.from("luna_repairs")
    .select("queue_row_id")
    .eq("user_id", userId).eq("action", "clear_failed_ig_intent")
    .gte("created_at", weekAgo)
    .in("queue_row_id", igIds);
  const recentlyProposed = new Set(
    (recentIgProps ?? []).map((r: any) => r.queue_row_id),
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
      if (age > IG_FAILED_WINDOW_MS && recentlyProposed.has(row.id)) continue;
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
// N4: parked Instagram sold actions. The instagram-post finisher's
// sold sweep selects status "published" rows and keys on
// error_code: null = mark on this pass, "sold_delete_candidate" =
// execute (delete, or comment-lock in mark mode) on this pass.
// Its failure outcomes park the row OUT of that selection for
// good (ig-post v14 source, soldSweepPublished):
//   permission error -> status "delete_permission_pending" /
//     "mark_permission_pending" (error_code mirrors the status)
//   other Meta error -> status stays "published" with
//     error_code "sold_delete_error" / "sold_mark_error"
// Nothing ever retries them — even after the user reconnects and
// grants the missing permission. Luna's repair flips the row
// back into the selection shape (published +
// sold_delete_candidate); the finisher then re-reads the car's
// sold state, the account settings and its connection itself
// before acting. Luna never calls Meta.
// ---------------------------------------------------------------------

const IG_SOLD_PERMISSION_STATUSES = [
  "delete_permission_pending", "mark_permission_pending",
];
const IG_SOLD_ERROR_CODES = ["sold_delete_error", "sold_mark_error"];

async function runIgSoldDetection(
  svc: any, userId: string, now: number,
): Promise<number> {
  let created = 0;
  const [{ data: permRows }, { data: errRows }, { data: conn }] =
    await Promise.all([
      svc.from("instagram_posts").select("*")
        .eq("user_id", userId)
        .in("status", IG_SOLD_PERMISSION_STATUSES)
        .order("created_at", { ascending: true }).limit(100),
      svc.from("instagram_posts").select("*")
        .eq("user_id", userId)
        .eq("status", "published")
        .in("error_code", IG_SOLD_ERROR_CODES)
        .order("created_at", { ascending: true }).limit(100),
      svc.from("instagram_connections")
        .select("scope")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false }).limit(1),
    ]);
  const scope = typeof conn?.[0]?.scope === "string" ? conn[0].scope : "";
  const scopeHas = (perm: string) =>
    scope.split(/[ ,]+/).filter(Boolean).includes(perm);

  const candidates: { row: any; subclass: string }[] = [];
  for (const row of permRows ?? []) {
    // Positive evidence for the permission subclass: the grant
    // the finisher was missing is now IN the connection scope.
    const needed = row.status === "delete_permission_pending"
      ? "instagram_manage_contents" : "instagram_manage_comments";
    if (!scopeHas(needed)) continue;
    candidates.push({ row, subclass: "permission" });
  }
  for (const row of errRows ?? []) {
    if (now - new Date(row.created_at).getTime() <
        IG_SOLD_ERROR_COOLDOWN_MS) continue;
    candidates.push({ row, subclass: "error" });
  }
  if (!candidates.length) return 0;

  const { data: invRows } = await svc.from("scraped_inventory")
    .select("vin, year, make, model, is_active, status")
    .eq("user_id", userId)
    .in("vin", [...new Set(candidates.map((c) => c.row.vin).filter(Boolean))]);
  const invByVin = new Map((invRows ?? []).map((r: any) => [r.vin, r]));

  const igIds = candidates.map((c) => c.row.id);
  const { data: closedProps } = await svc.from("luna_repairs")
    .select("queue_row_id")
    .eq("user_id", userId).eq("action", "rearm_parked_ig_sold_action")
    .in("status", ["dismissed", "undone"])
    .in("queue_row_id", igIds);
  const suppressed = new Set(
    (closedProps ?? []).map((r: any) => r.queue_row_id),
  );

  for (const { row, subclass } of candidates) {
    if (!row.media_id || !row.vin) continue;
    if (suppressed.has(row.id)) continue;
    const inv = invByVin.get(row.vin);
    // The car must STILL read sold/gone — the finisher's own
    // canonical state read. A car that came back needs no
    // takedown, and a missing record is no evidence at all.
    if (!inv) continue;
    const stillGone = inv.is_active === false ||
      (typeof inv.status === "string" && inv.status.toLowerCase() === "sold");
    if (!stillGone) continue;
    const label = carLabel(inv);
    const isMark = row.status === "mark_permission_pending" ||
      row.error_code === "sold_mark_error";
    const ok = await insertProposal(svc, {
      user_id: userId,
      queue_row_id: row.id,
      vin: row.vin,
      action: "rearm_parked_ig_sold_action",
      lane: "ask",
      status: "proposed",
      evidence: {
        source: "instagram_posts",
        ig_post_id: row.id,
        subclass,
        parked_status: row.status,
        parked_error_code: row.error_code ?? null,
        failure: (row.error_message ?? "").slice(0, 400),
        car_label: label,
      },
      summary: subclass === "permission"
        ? `Your ${label} has sold, but its Instagram post is still up — the takedown stalled because Instagram hadn't granted Luna the permission yet. It has now. Luna can put the post back in line ${isMark ? "to be marked sold" : "to come down"} on the next automatic pass.`
        : `Your ${label} has sold, but its Instagram post is still up — the takedown hit an Instagram error and was parked. Luna can put the post back in line ${isMark ? "to be marked sold" : "to come down"} on the next automatic pass.`,
    });
    if (ok) created++;
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
          } else if ((prop.action === "correct_stamp_price" ||
                      prop.action === "correct_stale_stamp") &&
                     typeof verdict.live_price === "number" &&
                     verdict.live_price === prop.evidence?.target_price) {
            await svc.from("luna_repairs").update({
              status: "ready",
              evidence: { ...prop.evidence, verdict },
              summary: prop.action === "correct_stale_stamp"
                ? `Checked live: the listing already shows the current price. Luna can correct your records now.`
                : `Checked live: the listing already shows the new price. Luna can correct your records and clear the failed row now.`,
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
    prop.action === "release_stuck_ig_intent" ||
    prop.action === "rearm_parked_ig_sold_action"
  ) {
    return executeIgRepair(svc, userId, prop, actor);
  }
  // Toolbox expansion: classes whose target is not a queue row
  // route to their own executors (reel row / Luna's own rows /
  // the inventory stamp).
  if (prop.action === "requeue_failed_render") {
    return executeReelRequeue(svc, userId, prop, actor);
  }
  if (prop.action === "unstick_verify_proposal") {
    return executeUnstick(svc, userId, prop, actor);
  }
  if (prop.action === "correct_stale_stamp") {
    return executeStaleStamp(svc, userId, prop, actor);
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
      if (!row) {
        return markExpired(svc, prop, "That row is no longer in a failed state, so there's nothing to remove.");
      }
      if (row.status !== "failed") {
        // E1 subset (ii): a PENDING update_price row is only
        // removable while its target still equals the stamp —
        // re-prove that fact before deleting a live row.
        const isPendingPrice = row.status === "pending" &&
          row.action === "update_price" &&
          prop.evidence?.subset === "pending_update_price_achieved" &&
          typeof row.price === "number";
        if (!isPendingPrice) {
          return markExpired(svc, prop, "That row is no longer in a failed state, so there's nothing to remove.");
        }
        const { data: invNow } = await svc.from("scraped_inventory")
          .select("marketplace_posted_price")
          .eq("user_id", userId).eq("vin", row.vin).maybeSingle();
        if (!invNow || invNow.marketplace_posted_price !== row.price) {
          return markExpired(svc, prop, "The price picture changed, so Luna left that row alone.");
        }
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

    case "release_orphaned_claim": {
      if (!row || row.status !== "processing") {
        return markExpired(svc, prop, "That job is no longer stuck mid-flight, so there's nothing to release.");
      }
      // Hand the row back to the normal machinery: a post waits
      // for its reel only when the reel isn't ready; other job
      // kinds never wait on a reel at all.
      let awaiting = false;
      if (row.action === "post") {
        const { data: reel } = await svc.from("vin_reels")
          .select("status").eq("user_id", userId).eq("vin", row.vin)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        awaiting = !reel || reel.status !== "ready";
      }
      const before = {
        status: row.status, awaiting_reel: row.awaiting_reel,
        error_message: row.error_message,
      };
      const { error } = await svc.from("auto_posting_queue").update({
        status: "pending", awaiting_reel: awaiting,
      }).eq("id", row.id).eq("status", "processing");
      if (error) return json({ ok: false, message: "The release didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before,
        { status: "pending", awaiting_reel: awaiting }, actor);
      return json({ ok: true, message: "Released — the job is back in the queue where the normal flow can reach it." });
    }

    case "retry_failed_delete": {
      if (!row || row.action !== "delete" || row.status !== "failed") {
        return markExpired(svc, prop, "That delete is no longer in a failed state, so there's nothing to retry.");
      }
      if (deleteRetryBlocked(
          typeof row.error_message === "string" ? row.error_message : "")) {
        return markExpired(svc, prop, "That delete failed in a way Luna doesn't retry — it needs a human look instead.");
      }
      const { data: priorRetry } = await svc.from("luna_repairs")
        .select("id").eq("user_id", userId).eq("action", "retry_failed_delete")
        .eq("status", "applied").eq("queue_row_id", row.id).limit(1);
      if (priorRetry && priorRetry.length) {
        return markExpired(svc, prop, "Luna already retried this delete once — a second retry is a human call.");
      }
      const { data: inv } = await svc.from("scraped_inventory")
        .select("marketplace_posted_at, is_active, status")
        .eq("user_id", userId).eq("vin", row.vin).maybeSingle();
      const stillGone = !!inv && (inv.is_active === false ||
        (typeof inv.status === "string" && inv.status.toLowerCase() === "sold"));
      if (!inv || !inv.marketplace_posted_at || !stillGone) {
        return markExpired(svc, prop, "The car's state changed, so Luna left the delete alone.");
      }
      const sig = postFailureSignature(
        typeof row.error_message === "string" ? row.error_message : "");
      const before = {
        status: "failed", error_message: row.error_message, signature: sig,
      };
      const { error } = await svc.from("auto_posting_queue").update({
        status: "pending", error_message: null,
      }).eq("id", row.id).eq("status", "failed");
      if (error) return json({ ok: false, message: "The re-queue didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { status: "pending" }, actor);
      return json({ ok: true, message: "Delete queued once more — the listing comes down on the next pass." });
    }

    case "dedupe_pending_queue_rows": {
      if (!row || row.status !== "pending") {
        return markExpired(svc, prop, "That duplicate job is already gone.");
      }
      const keepId = prop.evidence?.keep_row_id;
      if (!keepId) {
        return markExpired(svc, prop, "The proposal lost track of which job it keeps, so Luna didn't touch anything.");
      }
      const { data: keep } = await svc.from("auto_posting_queue")
        .select("id, status").eq("id", keepId).eq("user_id", userId).maybeSingle();
      if (!keep || keep.status !== "pending") {
        // Never delete the last live intent for a car.
        return markExpired(svc, prop, "The job Luna was keeping is no longer waiting, so she left this one alone — it's the only copy left.");
      }
      const before = { row };
      const { error } = await svc.from("auto_posting_queue")
        .delete().eq("id", row.id).eq("status", "pending");
      if (error) return json({ ok: false, message: "The removal didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { deleted: true }, actor);
      return json({ ok: true, message: "Duplicate removed — one job kept." });
    }

    case "resolve_dead_reel_hold": {
      if (!row || row.action !== "post" || row.status !== "pending") {
        return markExpired(svc, prop, "That post is no longer waiting, so there's nothing to clear.");
      }
      const { data: reel } = await svc.from("vin_reels")
        .select("status, error").eq("user_id", userId).eq("vin", row.vin)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!reel || reel.status !== "failed" ||
          isTransportRenderError(typeof reel.error === "string" ? reel.error : "")) {
        return markExpired(svc, prop, "The video situation changed, so Luna left the post alone.");
      }
      const before = { row };
      const { error } = await svc.from("auto_posting_queue")
        .delete().eq("id", row.id).eq("status", "pending");
      if (error) return json({ ok: false, message: "The clear didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { deleted: true }, actor);
      return json({ ok: true, message: "Stuck post cleared — queue the car fresh once its video can be made." });
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

  if (prop.action === "rearm_parked_ig_sold_action") {
    if (!intent) {
      return markExpired(
        svc, prop,
        "That Instagram post record is already gone.",
      );
    }
    const isPermPark = IG_SOLD_PERMISSION_STATUSES.includes(intent.status);
    const isErrPark = intent.status === "published" &&
      IG_SOLD_ERROR_CODES.includes(intent.error_code ?? "");
    if (!isPermPark && !isErrPark) {
      return markExpired(
        svc, prop,
        "That Instagram post is no longer parked, so there's nothing to re-arm.",
      );
    }
    // The car must STILL read sold/gone (the finisher re-checks
    // this too, but Luna never re-arms on stale evidence).
    const { data: inv } = await svc.from("scraped_inventory")
      .select("is_active, status")
      .eq("user_id", userId).eq("vin", intent.vin).maybeSingle();
    const stillGone = !!inv && (inv.is_active === false ||
      (typeof inv.status === "string" && inv.status.toLowerCase() === "sold"));
    if (!stillGone) {
      return markExpired(
        svc, prop,
        "That car no longer reads as sold, so Luna left its Instagram post alone.",
      );
    }
    if (isPermPark) {
      // Positive evidence, re-read at execute: the grant is in
      // the connection's scope NOW.
      const needed = intent.status === "delete_permission_pending"
        ? "instagram_manage_contents" : "instagram_manage_comments";
      const { data: conn } = await svc.from("instagram_connections")
        .select("scope").eq("user_id", userId)
        .order("updated_at", { ascending: false }).limit(1);
      const scope = typeof conn?.[0]?.scope === "string" ? conn[0].scope : "";
      if (!scope.split(/[ ,]+/).filter(Boolean).includes(needed)) {
        return markExpired(
          svc, prop,
          "Instagram still hasn't granted the permission this needs, so Luna left the post parked.",
        );
      }
    }
    const before = {
      status: intent.status,
      error_code: intent.error_code ?? null,
      error_message: intent.error_message ?? null,
    };
    // Back into the sold sweep's selection shape, byte-for-byte
    // the state its confirming pass executes on.
    const { error } = await svc.from("instagram_posts")
      .update({
        status: "published",
        error_code: "sold_delete_candidate",
        error_message: null,
      })
      .eq("id", intent.id)
      .eq("status", intent.status);
    if (error) {
      return json(
        { ok: false, message: "The re-arm didn't go through — nothing was changed." },
        200,
      );
    }
    await markApplied(svc, prop, before,
      { status: "published", error_code: "sold_delete_candidate" }, actor);
    return json({
      ok: true,
      message:
        "Back in line — the takedown runs on the next automatic Instagram pass.",
    });
  }

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
// Toolbox-expansion executors for classes whose target is not a
// queue row. Same contract as every applier: re-check the world
// against live rows, expire rather than guess, snapshot first.
// ---------------------------------------------------------------------

async function executeReelRequeue(
  svc: any, userId: string, prop: any, actor: string,
) {
  const { data: reel } = await svc.from("vin_reels")
    .select("*")
    .eq("id", prop.queue_row_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!reel) {
    return markExpired(svc, prop, "That failed video record is already gone.");
  }
  if (reel.status !== "failed") {
    return markExpired(svc, prop, "That video is no longer in a failed state, so there's nothing to requeue.");
  }
  const { data: latest } = await svc.from("vin_reels")
    .select("id").eq("user_id", userId).eq("vin", reel.vin)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!latest || latest.id !== reel.id) {
    return markExpired(svc, prop, "A newer video attempt exists for this car, so Luna left the old failure alone.");
  }
  const err = typeof reel.error === "string" ? reel.error : "";
  let eligible = isTransportRenderError(err);
  if (!eligible) {
    const starved = photoStarvedNeed(err);
    if (starved) {
      const { data: inv } = await svc.from("scraped_inventory")
        .select("usable_photo_count")
        .eq("user_id", userId).eq("vin", reel.vin).maybeSingle();
      eligible = !!inv && typeof inv.usable_photo_count === "number" &&
        inv.usable_photo_count >= starved.need;
    }
  }
  if (!eligible) {
    return markExpired(svc, prop, "That failure no longer looks like one a re-render can fix, so Luna left it alone.");
  }
  const before = { status: "failed", error: reel.error };
  const { error } = await svc.from("vin_reels").update({
    status: "queued", error: null,
  }).eq("id", reel.id).eq("status", "failed");
  if (error) {
    return json({ ok: false, message: "The requeue didn't go through — nothing was changed." }, 200);
  }
  await markApplied(svc, prop, before, { status: "queued" }, actor);
  return json({ ok: true, message: "Queued — the video renders again on the next pass." });
}

async function executeUnstick(
  svc: any, userId: string, prop: any, actor: string,
) {
  const { data: target } = await svc.from("luna_repairs")
    .select("*")
    .eq("id", prop.queue_row_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) {
    return markExpired(svc, prop, "That stuck card is already gone.");
  }
  const before = {
    target_status: target.status,
    target_verify_queue_id: target.verify_queue_id ?? null,
  };

  if (prop.evidence?.branch === "verify_orphan") {
    if (target.status !== "needs_verify" || !target.verify_queue_id) {
      return markExpired(svc, prop, "That check is no longer stuck, so there's nothing to un-wedge.");
    }
    const { data: vrow } = await svc.from("auto_posting_queue")
      .select("id").eq("id", target.verify_queue_id).maybeSingle();
    if (vrow) {
      return markExpired(svc, prop, "The check came back on its own, so Luna left it alone.");
    }
    const orphans = (Number(target.evidence?.verify_orphans) || 0) + 1;
    if (orphans >= 2) {
      // The verify job vanished TWICE: the checker itself is
      // dropping rows. Close the card and escalate the pattern
      // (watchdog evidence shape) instead of re-asking forever.
      await svc.from("luna_repairs").update({
        status: "expired",
        evidence: {
          ...target.evidence,
          verify_orphans: orphans,
          escalated: {
            at: new Date().toISOString(),
            reason: "the verify job vanished twice in a row — the check that proves fixes is itself dropping rows",
            failure: null,
            reported: false,
          },
        },
        summary: "Luna's live check disappeared twice in a row, so she closed this card and flagged the pattern — the checking tool itself needs a look. Nothing about the car was changed.",
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);
      await markApplied(svc, prop, before,
        { target_status: "expired", verify_orphans: orphans }, actor);
      return json({ ok: true, message: "Closed and flagged — the check itself keeps dropping, so Luna escalated the pattern." });
    }
    // Nulling verify_queue_id is the whole repair: the existing
    // enqueue pass re-issues a fresh verify on the next evaluate
    // or sweep, exactly as it does for a first-run proposal.
    await svc.from("luna_repairs").update({
      verify_queue_id: null,
      evidence: { ...target.evidence, verify_orphans: orphans },
      updated_at: new Date().toISOString(),
    }).eq("id", target.id);
    await markApplied(svc, prop, before,
      { target_verify_queue_id: null, verify_orphans: orphans }, actor);
    return json({ ok: true, message: "Un-wedged — the check will run again on the next pass." });
  }

  // dead_target branch: expire a proposal whose record is gone.
  if (!["proposed", "ready"].includes(target.status) ||
      !target.queue_row_id) {
    return markExpired(svc, prop, "That card is no longer in a state Luna can close out.");
  }
  const igClass = target.action === "clear_failed_ig_intent" ||
    target.action === "release_stuck_ig_intent" ||
    target.action === "rearm_parked_ig_sold_action";
  const table = igClass ? "instagram_posts"
    : target.action === "requeue_failed_render" ? "vin_reels"
    : "auto_posting_queue";
  const { data: trow } = await svc.from(table)
    .select("id").eq("id", target.queue_row_id).maybeSingle();
  if (trow) {
    return markExpired(svc, prop, "The record came back, so Luna left the card alone.");
  }
  await svc.from("luna_repairs").update({
    status: "expired",
    summary: "Luna closed this card: the record it pointed at no longer exists, so there was nothing left to fix.",
    updated_at: new Date().toISOString(),
  }).eq("id", target.id);
  await markApplied(svc, prop, before, { target_status: "expired" }, actor);
  return json({ ok: true, message: "Stale card closed." });
}

async function executeStaleStamp(
  svc: any, userId: string, prop: any, actor: string,
) {
  if (prop.status !== "ready") {
    return json({ ok: false, message: "Luna still needs the live price check to come back before this can be corrected." }, 200);
  }
  const target = prop.evidence?.target_price;
  if (typeof target !== "number") {
    return markExpired(svc, prop, "The target price is missing from the proposal, so Luna didn't touch the record.");
  }
  const { data: inv } = await svc.from("scraped_inventory")
    .select("marketplace_posted_price, marketplace_posted_at, price")
    .eq("user_id", userId).eq("vin", prop.vin).maybeSingle();
  if (!inv || !inv.marketplace_posted_at) {
    return markExpired(svc, prop, "The car is no longer marked as posted, so there's nothing to correct.");
  }
  if (inv.price !== target) {
    return markExpired(svc, prop, "The advertised price moved again, so Luna left the record alone — the normal price flow will sort it out.");
  }
  if (inv.marketplace_posted_price === target) {
    return markExpired(svc, prop, "The record already shows the current price.");
  }
  const before = { marketplace_posted_price: inv.marketplace_posted_price };
  const { error } = await svc.from("scraped_inventory").update({
    marketplace_posted_price: target,
  }).eq("user_id", userId).eq("vin", prop.vin);
  if (error) {
    return json({ ok: false, message: "The record update didn't go through — nothing was changed." }, 200);
  }
  await markApplied(svc, prop, before,
    { marketplace_posted_price: target }, actor);
  return json({ ok: true, message: "Record corrected to the live price." });
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
      summary: "This post failed at the video gate, which is usually temporary — Luna queued it to try once more. (Once the helper picks the job up, the retry can't be undone.)",
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
  // (verdict-proven); DB-fact classes at "proposed" (their facts
  // are re-checked inside the executor against the live rows).
  // rearm_parked_ig_sold_action auto-applies ONLY its permission
  // subclass — the scope grant is the positive proof; the error
  // subclass stays ASK even with the class switch on.
  const DB_FACT_AUTO_ACTIONS = [
    "release_stuck_reel_hold",
    "release_orphaned_claim",
    "unstick_verify_proposal",
    "requeue_failed_render",
    "retry_failed_delete",
  ];
  const candidates = (open ?? []).filter((p: any) => {
    if (p.evidence?.escalated) return false;
    if (p.status === "ready") return true;
    if (DB_FACT_AUTO_ACTIONS.includes(p.action)) return true;
    if (p.action === "rearm_parked_ig_sold_action") {
      return p.evidence?.subclass === "permission";
    }
    return false;
  });
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
    // requeue_failed_render carries its own PER-VIN recurrence
    // guard (detector + history): transport failures legitimately
    // hit many different cars in one night, so the per-user class
    // count would strangle exactly the population it exists for.
    if (prop.action !== "requeue_failed_render" &&
        (priorByAction.get(prop.action) ?? 0) >= AUTO_RECURRENCE_PRIOR_LIMIT) {
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
  } else if (prop.action === "release_orphaned_claim") {
    await svc.from("auto_posting_queue").update({
      status: before.status ?? "processing",
      awaiting_reel: before.awaiting_reel ?? false,
      error_message: before.error_message ?? null,
    }).eq("id", prop.queue_row_id).eq("user_id", userId);
  } else if (prop.action === "retry_failed_delete") {
    // Meaningful only until the helper claims the re-queued row;
    // after that the delete has run and there is nothing to
    // restore (same honesty rule as auto_retry_post).
    await svc.from("auto_posting_queue").update({
      status: "failed",
      error_message: before.error_message ?? null,
    }).eq("id", prop.queue_row_id).eq("user_id", userId)
      .eq("status", "pending");
  } else if (prop.action === "dedupe_pending_queue_rows" ||
             prop.action === "resolve_dead_reel_hold") {
    if (before.row) {
      const r = { ...before.row };
      await svc.from("auto_posting_queue").insert(r);
    }
  } else if (prop.action === "requeue_failed_render") {
    // Only while the re-queued render hasn't been claimed yet:
    // once the worker picks it up, the render settles on its own
    // and undo just records the attempt (design §N2 honesty).
    await svc.from("vin_reels").update({
      status: "failed",
      error: before.error ?? null,
    }).eq("id", prop.queue_row_id).eq("user_id", userId)
      .eq("status", "queued");
  } else if (prop.action === "rearm_parked_ig_sold_action") {
    // Restore the parked state — but only while the row is still
    // in the re-armed shape; if the finisher already acted, its
    // outcome stands and undo leaves the record alone.
    await svc.from("instagram_posts").update({
      status: before.status,
      error_code: before.error_code ?? null,
      error_message: before.error_message ?? null,
    }).eq("id", prop.queue_row_id).eq("user_id", userId)
      .eq("status", "published")
      .eq("error_code", "sold_delete_candidate");
  } else if (prop.action === "unstick_verify_proposal") {
    if (before.target_status) {
      await svc.from("luna_repairs").update({
        status: before.target_status,
        verify_queue_id: before.target_verify_queue_id ?? null,
      }).eq("id", prop.queue_row_id).eq("user_id", userId);
    }
  } else if (prop.action === "correct_stale_stamp") {
    await svc.from("scraped_inventory").update({
      marketplace_posted_price: before.marketplace_posted_price ?? null,
    }).eq("user_id", userId).eq("vin", prop.vin);
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
