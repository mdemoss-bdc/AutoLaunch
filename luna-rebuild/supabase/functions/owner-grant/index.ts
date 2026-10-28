// =====================================================================
// owner-grant — Matthew's self-service owner tools (2026-10-28).
//
// One caller only: the account whose id is in the OWNER_GRANT_USER_ID
// function secret (production: Matthew). The app renders the Owner
// tools card only for him, but that is courtesy — THIS check is the
// wall: every action re-verifies the caller's JWT and refuses (403)
// anyone whose id is not the secret's value.
//
// Actions:
//   grant {email}
//     Comp a TRIALING user to full Automate until their trial ends —
//     exactly the transformation Luna applied by hand for Rachel
//     Mallory (2026-10-28): user_settings.billing_status -> 'active',
//     current_period_end -> the user's own trial_ends_at, nothing
//     else on the row. The app's own term machinery then self-expires
//     the grant at trial end (active + no subscription + a period
//     end -> the standard purchase gate), so no revert job exists.
//     Refusals (200, {ok:false, error, message} — plain reason for
//     the UI): no such user; target is an owner account; target has
//     a stripe_subscription_id (paying customer — never disturb);
//     target is not trialing; target's trial already ended. Every
//     successful grant writes an owner_grants audit row.
//   revoke {target_user_id}
//     Only against a LIVE grant (billing_status 'active' AND no
//     subscription AND an open audit row): restores billing_status
//     -> 'trialing', current_period_end -> NULL, closes the audit
//     row. Anything else refuses — a real subscriber can never be
//     "revoked" through here.
//   list
//     All grant audit rows, newest first.
//   suggestions_list {filter}
//     The owner inbox for user suggestions (public.suggestions; the
//     daily review writes verdict + verdict_note and flips status
//     to 'reviewed'). filter: unviewed (not yet reviewed) |
//     accepted (verdict 'do') | denied (verdict 'no') | parked
//     (verdict 'park') | all. Submitter email is resolved
//     server-side from user_id. Read-only. Newest first, cap 100.
//
// verify_jwt=false at the platform level; the caller's JWT is
// verified manually (same pattern as trial-start / dealership-admin).
// Browser-invoked through supabase-js, so the CORS allow-headers list
// is the full one (apikey, authorization, content-type, x-client-info,
// x-supabase-api-version).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Owner accounts can never be grant TARGETS (they already hold full
// access permanently — the same two ids the app hardcodes).
const OWNER_USER_IDS = [
  "40a95557-504a-460f-a891-462bb2b4f25c", // Matthew
  "9cdba37e-ac31-464d-92b9-0745772fbf00", // Jourdan
];

const SUGGESTION_LIMIT = 100;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function refuse(error: string, message: string) {
  return json({ ok: false, error, message });
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

// Verify the caller's JWT against the Auth API; returns the full user
// object (id, email, created_at) or null.
async function verifyUser(req: Request): Promise<any | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supabaseUrl || !anon || !token) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "apikey": anon, "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === "string" ? user : null;
  } catch {
    return null;
  }
}

// Resolve an email to an auth user (case-insensitive). The roster is
// small; page through the Admin API until found or exhausted.
async function findUserByEmail(svc: any, email: string): Promise<any | null> {
  const want = email.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data || !Array.isArray(data.users)) return null;
    for (const u of data.users) {
      if (typeof u.email === "string" && u.email.toLowerCase() === want) return u;
    }
    if (data.users.length < 1000) break;
  }
  return null;
}

// Resolve a user id to its email (for the suggestions inbox).
async function emailForUserId(svc: any, userId: string): Promise<string | null> {
  try {
    const { data } = await svc.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const callerId = user.id as string;

  // THE WALL: only the account named by OWNER_GRANT_USER_ID may use
  // any action in this function. Fail closed if the secret is unset.
  const ownerGrantUserId = (Deno.env.get("OWNER_GRANT_USER_ID") ?? "").trim();
  if (!ownerGrantUserId || callerId !== ownerGrantUserId) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const svc = serviceClient();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const action = body && typeof body.action === "string" ? body.action : "";

  // ------------------------------------------------------------- grant
  if (action === "grant") {
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || email.indexOf("@") === -1) {
      return refuse("invalid_email", "Enter the trial user's email address.");
    }
    const target = await findUserByEmail(svc, email);
    if (!target) {
      return refuse("user_not_found", "No AutoLaunch account uses that email.");
    }
    if (OWNER_USER_IDS.indexOf(target.id) !== -1) {
      return refuse("owner_account", "That's an owner account — it already has full access.");
    }
    const { data: settings } = await svc
      .from("user_settings")
      .select("user_id, billing_status, trial_ends_at, stripe_subscription_id")
      .eq("user_id", target.id)
      .maybeSingle();
    if (!settings) {
      return refuse("no_trial", "That account has no trial to upgrade.");
    }
    if (settings.stripe_subscription_id) {
      return refuse("paying_customer", "That account has a paid subscription — nothing was changed.");
    }
    if (settings.billing_status !== "trialing") {
      return refuse("not_trialing", "That account isn't on a free trial right now.");
    }
    const trialEndsAt = settings.trial_ends_at as string | null;
    if (!trialEndsAt || new Date(trialEndsAt).getTime() <= Date.now()) {
      return refuse("trial_ended", "That account's trial has already ended.");
    }

    // The Rachel transformation — exactly two fields.
    const { error: updErr } = await svc
      .from("user_settings")
      .update({ billing_status: "active", current_period_end: trialEndsAt })
      .eq("user_id", target.id);
    if (updErr) {
      return refuse("update_failed", "The grant didn't save — try again.");
    }
    const { error: auditErr } = await svc.from("owner_grants").insert({
      granter_user_id: callerId,
      target_user_id: target.id,
      target_email: target.email,
      ends_at: trialEndsAt,
    });
    if (auditErr) {
      // Compensate: never leave a grant with no audit trail.
      await svc
        .from("user_settings")
        .update({ billing_status: "trialing", current_period_end: null })
        .eq("user_id", target.id);
      return refuse("audit_failed", "The grant didn't save — try again.");
    }
    return json({ ok: true, target_email: target.email, ends_at: trialEndsAt });
  }

  // ------------------------------------------------------------ revoke
  if (action === "revoke") {
    const targetId = typeof body.target_user_id === "string" ? body.target_user_id : "";
    if (!targetId) return refuse("invalid_target", "Missing the account to revoke.");
    const { data: settings } = await svc
      .from("user_settings")
      .select("user_id, billing_status, stripe_subscription_id")
      .eq("user_id", targetId)
      .maybeSingle();
    if (settings && settings.stripe_subscription_id) {
      return refuse("paying_customer", "That account has a paid subscription — nothing was changed.");
    }
    const { data: openRows } = await svc
      .from("owner_grants")
      .select("id")
      .eq("target_user_id", targetId)
      .is("revoked_at", null)
      .order("granted_at", { ascending: false })
      .limit(1);
    const openRow = openRows && openRows.length ? openRows[0] : null;
    if (!settings || settings.billing_status !== "active" || !openRow) {
      return refuse("no_live_grant", "That account doesn't have an active grant to revoke.");
    }
    const { error: updErr } = await svc
      .from("user_settings")
      .update({ billing_status: "trialing", current_period_end: null })
      .eq("user_id", targetId);
    if (updErr) {
      return refuse("update_failed", "The revoke didn't save — try again.");
    }
    await svc
      .from("owner_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", openRow.id);
    return json({ ok: true, target_user_id: targetId });
  }

  // -------------------------------------------------------------- list
  if (action === "list") {
    const { data: rows, error } = await svc
      .from("owner_grants")
      .select("id, target_user_id, target_email, granted_at, ends_at, revoked_at")
      .order("granted_at", { ascending: false });
    if (error) return refuse("list_failed", "Couldn't load the grants list.");
    return json({ ok: true, grants: rows || [] });
  }

  // -------------------------------------------------- suggestions_list
  if (action === "suggestions_list") {
    const filter = typeof body.filter === "string" ? body.filter : "unviewed";
    let q = svc
      .from("suggestions")
      .select("id, user_id, body, created_at, status, verdict, verdict_note")
      .order("created_at", { ascending: false })
      .limit(SUGGESTION_LIMIT);
    if (filter === "unviewed") q = q.neq("status", "reviewed");
    else if (filter === "accepted") q = q.eq("verdict", "do");
    else if (filter === "denied") q = q.eq("verdict", "no");
    else if (filter === "parked") q = q.eq("verdict", "park");
    else if (filter !== "all") {
      return refuse("invalid_filter", "Pick one of the suggestion views.");
    }
    const { data: rows, error } = await q;
    if (error) return refuse("list_failed", "Couldn't load the suggestions.");
    const out = [];
    for (const r of rows || []) {
      out.push({
        id: r.id,
        body: r.body,
        created_at: r.created_at,
        submitter_email: await emailForUserId(svc, r.user_id),
        status: r.status,
        verdict: r.verdict,
        verdict_note: r.verdict_note,
      });
    }
    return json({ ok: true, suggestions: out });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
