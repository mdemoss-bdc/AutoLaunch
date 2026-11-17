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
//   { action: "sweep", secret }      → propose-mode detection for ALL
//                                       accounts (daily sweep, §12).
//                                       Gated by LUNA_SWEEP_SECRET.
//                                       NEVER executes a fix.
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

  // --- Verify enqueueing for needs_verify proposals ------------------
  if (versionGte(helperVersion, VERIFY_MIN_HELPER)) {
    const { data: waiting } = await svc.from("luna_repairs")
      .select("*")
      .eq("user_id", userId).eq("status", "needs_verify")
      .is("verify_queue_id", null)
      .limit(10);
    for (const prop of waiting ?? []) {
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
          // Verify job failed without a verdict: allow a later retry
          // by clearing the pointer; the proposal stays needs_verify.
          await svc.from("luna_repairs").update({
            verify_queue_id: null,
            updated_at: new Date().toISOString(),
          }).eq("id", prop.id);
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

async function markApplied(svc: any, prop: any, before: any, after: any) {
  await svc.from("luna_repairs").update({
    status: "applied",
    actor: "user_tap",
    before_state: before,
    after_state: after,
    applied_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", prop.id);
}

async function markExpired(svc: any, prop: any, note: string) {
  await svc.from("luna_repairs").update({
    status: "expired",
    summary: note,
    updated_at: new Date().toISOString(),
  }).eq("id", prop.id);
  return json({ ok: false, expired: true, message: note }, 200);
}

async function executeRepair(svc: any, userId: string, prop: any) {
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
      await markApplied(svc, prop, before, { awaiting_reel: false, error_message: cleaned });
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
      await markApplied(svc, prop, before, { created_at: front });
      return json({ ok: true, message: "Moved to the front — the video attach runs next." });
    }

    case "remove_dead_row": {
      if (!row || row.status !== "failed") {
        return markExpired(svc, prop, "That row is no longer in a failed state, so there's nothing to remove.");
      }
      const before = { row };
      const { error } = await svc.from("auto_posting_queue").delete().eq("id", row.id);
      if (error) return json({ ok: false, message: "The removal didn't go through — nothing was changed." }, 200);
      await markApplied(svc, prop, before, { deleted: true });
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
      await markApplied(svc, prop, before, { deleted: true });
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
      await markApplied(svc, prop, before, { marketplace_posted_price: target, row_deleted: true });
      return json({ ok: true, message: "Record corrected to the live price and the failed row cleared." });
    }

    default:
      return json({ ok: false, message: "Unknown repair action." }, 200);
  }
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

  // Daily sweep: propose-only, secret-gated (spec §12).
  if (action === "sweep") {
    const secret = Deno.env.get("LUNA_SWEEP_SECRET") ?? "";
    if (!secret || body?.secret !== secret) return json({ error: "unauthorized" }, 401);
    const { data: users } = await svc.from("user_settings").select("user_id").limit(2000);
    let proposals = 0;
    for (const u of users ?? []) {
      await consumeVerdicts(svc, u.user_id);
      proposals += await runDetection(svc, u.user_id);
    }
    return json({ ok: true, users: (users ?? []).length, proposals_created: proposals });
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
