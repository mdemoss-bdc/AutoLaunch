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
//     Comp a TRIALING user to the full sold "Automate" tier — the
//     $100 shape (internal plan_tier 'group': every feature incl.
//     teams, 6-hour sync cadence) — until their trial ends. Writes
//     exactly three fields on user_settings: billing_status ->
//     'active', current_period_end -> the user's own trial_ends_at,
//     plan_tier -> 'group'. (v1, earlier on 2026-10-28, wrote only
//     the first two fields and left plan_tier at 'trial', which
//     resolved to the legacy 12h/no-teams shape; v2 makes the grant
//     the real tier at Matthew's direction.) The app's own term
//     machinery then self-expires the grant at trial end (active +
//     no subscription + a period end -> the standard purchase gate),
//     so no revert job exists.
//     Refusals (200, {ok:false, error, message} — plain reason for
//     the UI): no such user; target is an owner account; target has
//     a stripe_subscription_id (paying customer — never disturb);
//     target is not trialing; target's trial already ended. Every
//     successful grant writes an owner_grants audit row.
//   revoke {target_user_id}
//     Only against a LIVE grant (billing_status 'active' AND no
//     subscription AND an open audit row): restores all three grant
//     fields — billing_status -> 'trialing', current_period_end ->
//     NULL, plan_tier -> 'trial' — and closes the audit row.
//     Anything else refuses — a real subscriber can never be
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
//   users_list
//     Every registered user for the Owner console's Users section:
//     display name (auth metadata name, else the settings'
//     dealership_name / store_name, else the email local part),
//     email, user_id, plan/billing state, signup date. Read live
//     from Auth + user_settings on every call (the panel fetches
//     when the Owner tab opens, so new registrations appear).
//     Newest first. The known test accounts in
//     OWNER_LIST_HIDDEN_USER_IDS are excluded server-side, so
//     they never reach the panel at all.
//   force_scrape {target_user_id}
//     Queue an inventory sync for another user — the EXACT row the
//     app's own Sync Inventory button inserts (scrape_jobs,
//     status 'pending', sync_mode 'full'), which the Refresh
//     webhook dispatches to the scraper workflow for that user.
//     The one honest limit: the production scraper's cadence guard
//     enforces the plan sync window (trial 24h / Post 18h /
//     Automate 12h / Group 6h) on user-requested jobs and there is
//     no sanctioned force flag that skips it for a full scrape —
//     so this action pre-checks the same cadence (mirroring the
//     scraper's rules: owners exempt, 'test' rows never set the
//     clock, a first sync is never blocked, dealership-covered
//     members resolve to the dealership flavor) and refuses with
//     the next-open time instead of queueing a job the scraper
//     would fail. Refusals: no such user; account has no settings
//     row (setup never finished — nothing to scrape); a sync is
//     already pending for them. Every outcome (queued /
//     already_pending / cadence_refused) is audit-logged in
//     public.owner_actions.
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

// Accounts hidden from the Owner console's Users list: test and
// review fixtures, not customers — Matthew asked (2026-10-28) not
// to see them in the list. Add future test accounts here, one line
// each; everyone else stays listed.
const OWNER_LIST_HIDDEN_USER_IDS = [
  "5f972cd9-0e17-41ef-9d83-c54b4aae55e7", // Luna test (luna-test@autolaunch.org)
  "0e3d831b-b090-4b09-9562-c272425a8acb", // test@test.com
  "29265328-5d3f-4c13-8168-aeb418a96270", // TikTok reviewer (matthewdemoss+tiktokreview@gmail.com)
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

// Page through every auth user (roster is small, but never trust a
// single page).
async function listAllUsers(svc: any): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data || !Array.isArray(data.users)) break;
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}

// Display-name precedence for the Users list: the name on the auth
// account, else what they called their store in settings, else the
// part of the email before the @.
function displayNameFor(authUser: any, settings: any): string {
  const meta = authUser?.user_metadata || {};
  const candidates = [
    meta.full_name,
    meta.name,
    settings?.dealership_name,
    settings?.store_name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const email = typeof authUser?.email === "string" ? authUser.email : "";
  return email.split("@")[0] || "Unknown";
}

// Audit for owner-console actions that are not grants (grants keep
// their own owner_grants trail). Never blocks the action itself.
async function auditOwnerAction(
  svc: any,
  actorId: string,
  action: string,
  targetId: string | null,
  targetEmail: string | null,
  detail: any,
) {
  try {
    await svc.from("owner_actions").insert({
      actor_user_id: actorId,
      action,
      target_user_id: targetId,
      target_email: targetEmail,
      detail: detail || {},
    });
  } catch (e) {
    console.error("owner_actions audit failed:", e);
  }
}

// ---- force_scrape cadence mirror ---------------------------------
// Mirrors the production scraper's sync-cadence guard
// (luna-rebuild/scraper.py, _sync_cooldown_hours /
// _sync_cadence_block_reason / _dealership_covered) so a force
// request can be answered truthfully BEFORE anything is queued.
const SYNC_COOLDOWN_HOURS: Record<string, number> = {
  trial: 24,
  post: 18,
  automate: 12,
  group: 6,
};

function resolveTierScraper(raw: any): string {
  if (raw === "post" || raw === "automate" || raw === "group") return raw;
  if (raw === null || raw === undefined || raw === "") return "post";
  return "automate";
}

// The coverage tier ('post'/'group') when this user is a covered
// dealership MEMBER, else null. The dealership leader (role
// 'admin') is never covered — same rule as the scraper.
async function dealershipCoveredTier(svc: any, uid: string): Promise<string | null> {
  try {
    const { data: members } = await svc
      .from("dealership_account_members")
      .select("dealership_id, role")
      .eq("user_id", uid);
    for (const m of members || []) {
      if (m.role !== "member") continue;
      const { data: dealers } = await svc
        .from("dealership_accounts")
        .select("status, plan_flavor, trial_ends_at")
        .eq("id", m.dealership_id);
      const d = (dealers || [])[0];
      if (!d) continue;
      if (d.status === "active") return d.plan_flavor || "group";
      if (d.status === "trial" && d.trial_ends_at) {
        if (new Date(d.trial_ends_at).getTime() > Date.now()) return "group";
      }
    }
  } catch {
    // best-effort, like the scraper: any read problem answers null
  }
  return null;
}

// Returns { hours, lastSyncAt, nextAt } when a fresh user-requested
// sync for this account would be cadence-refused right now, else
// null (owners, first syncs, and elapsed windows all pass).
async function cadenceBlock(
  svc: any,
  uid: string,
  settings: any,
): Promise<{ hours: number; lastSyncAt: string; nextAt: string } | null> {
  if (OWNER_USER_IDS.indexOf(uid) !== -1) return null; // owners exempt
  const covered = await dealershipCoveredTier(svc, uid);
  let hours: number;
  if (covered) hours = SYNC_COOLDOWN_HOURS[covered] ?? SYNC_COOLDOWN_HOURS.group;
  else if (settings?.billing_status === "trialing") hours = SYNC_COOLDOWN_HOURS.trial;
  else hours = SYNC_COOLDOWN_HOURS[resolveTierScraper(settings?.plan_tier)];
  // The clock is the most recent NON-TEST job; 'test' rows never
  // set it (scraper rule — filtered here in code, exactly like the
  // scraper, so legacy rows with no mode still count). No prior
  // non-test job -> the initial scrape never counts.
  const { data: recent } = await svc
    .from("scrape_jobs")
    .select("started_at, sync_mode")
    .eq("user_id", uid)
    .order("started_at", { ascending: false })
    .limit(50);
  const last = (recent || []).find((j: any) => j.sync_mode !== "test");
  if (!last || !last.started_at) return null;
  const startedMs = new Date(last.started_at).getTime();
  if (!isFinite(startedMs)) return null; // fail-open, like the scraper
  const nextMs = startedMs + hours * 3600 * 1000;
  if (Date.now() >= nextMs) return null;
  return {
    hours,
    lastSyncAt: last.started_at,
    nextAt: new Date(nextMs).toISOString(),
  };
}

// "Oct 28, 2:14 PM" in Matthew's timezone, for plain result lines.
function fmtET(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
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
      .select("user_id, billing_status, trial_ends_at, stripe_subscription_id, plan_tier, current_period_end")
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

    // The grant — exactly three fields: an active term ending at
    // the trial's end, on the full 'group' tier shape.
    const { error: updErr } = await svc
      .from("user_settings")
      .update({ billing_status: "active", current_period_end: trialEndsAt, plan_tier: "group" })
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
      // Compensate: never leave a grant with no audit trail —
      // restore the row's captured pre-grant values on all three
      // grant fields.
      await svc
        .from("user_settings")
        .update({
          billing_status: settings.billing_status,
          current_period_end: settings.current_period_end ?? null,
          plan_tier: settings.plan_tier,
        })
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
      .update({ billing_status: "trialing", current_period_end: null, plan_tier: "trial" })
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

  // --------------------------------------------------------- users_list
  if (action === "users_list") {
    // Server-side: hidden test accounts never leave this function.
    const users = (await listAllUsers(svc)).filter(
      (u: any) => OWNER_LIST_HIDDEN_USER_IDS.indexOf(u.id) === -1,
    );
    // Plan/billing state lives on user_settings (one row per user).
    // Page past the PostgREST row cap rather than trusting one read.
    const settingsById = new Map<string, any>();
    for (let from = 0; ; from += 1000) {
      const { data: rows, error } = await svc
        .from("user_settings")
        .select("user_id, plan_tier, billing_status, trial_ends_at, current_period_end, dealership_name, store_name")
        .order("user_id", { ascending: true })
        .range(from, from + 999);
      if (error) return refuse("list_failed", "Couldn't load the user list.");
      for (const r of rows || []) settingsById.set(r.user_id, r);
      if (!rows || rows.length < 1000) break;
    }
    const out = users.map((u: any) => {
      const s = settingsById.get(u.id) || null;
      return {
        user_id: u.id,
        email: u.email ?? null,
        display_name: displayNameFor(u, s),
        plan_tier: s?.plan_tier ?? null,
        billing_status: s?.billing_status ?? null,
        trial_ends_at: s?.trial_ends_at ?? null,
        current_period_end: s?.current_period_end ?? null,
        signed_up_at: u.created_at ?? null,
      };
    });
    out.sort((a: any, b: any) =>
      String(b.signed_up_at || "").localeCompare(String(a.signed_up_at || ""))
    );
    return json({ ok: true, users: out });
  }

  // ------------------------------------------------------- force_scrape
  if (action === "force_scrape") {
    const targetId = typeof body.target_user_id === "string" ? body.target_user_id.trim() : "";
    if (!targetId) return refuse("invalid_target", "Missing the account to scrape for.");
    let target: any = null;
    try {
      const { data } = await svc.auth.admin.getUserById(targetId);
      target = data?.user ?? null;
    } catch {
      target = null;
    }
    if (!target) {
      return refuse("user_not_found", "No AutoLaunch account has that user ID.");
    }
    const targetEmail = target.email ?? null;
    const { data: settings } = await svc
      .from("user_settings")
      .select("user_id, plan_tier, billing_status")
      .eq("user_id", targetId)
      .maybeSingle();
    if (!settings) {
      await auditOwnerAction(svc, callerId, "force_scrape", targetId, targetEmail, { outcome: "no_settings" });
      return refuse("no_settings", "That account hasn't finished setting up — there's no inventory to scrape yet.");
    }
    // Same dedupe the scraper itself applies (it serves the latest
    // pending job): a second pending row would change nothing.
    const { data: pending } = await svc
      .from("scrape_jobs")
      .select("id")
      .eq("user_id", targetId)
      .eq("status", "pending")
      .limit(1);
    if (pending && pending.length) {
      await auditOwnerAction(svc, callerId, "force_scrape", targetId, targetEmail, { outcome: "already_pending", job_id: pending[0].id });
      return refuse("already_pending", "A sync is already queued for " + (targetEmail || "that account") + " — it'll run next, no need to queue another.");
    }
    // The scraper's cadence guard would fail a full job queued
    // inside the plan window. Answer truthfully instead of
    // queueing a doomed row (see the cadence mirror above).
    const block = await cadenceBlock(svc, targetId, settings);
    if (block) {
      await auditOwnerAction(svc, callerId, "force_scrape", targetId, targetEmail, {
        outcome: "cadence_refused",
        hours: block.hours,
        last_sync_at: block.lastSyncAt,
        next_at: block.nextAt,
      });
      return refuse(
        "cadence_blocked",
        "Can't force one yet — " + (targetEmail || "that account") + " synced " + fmtET(block.lastSyncAt) +
          " and their plan's next sync opens " + fmtET(block.nextAt) + ". A forced sync uses the same path as their Sync button, and the plan cadence still applies.",
      );
    }
    // The trigger artifact: the same row the app's Sync Inventory
    // button inserts. Mode is deliberately 'full': the app's own
    // button sends the capped 'test' mode only until an account's
    // first successful sync (a setup proof), while an owner's force
    // is a support action whose intent is a complete refresh —
    // 'full' is the mode every set-up account's button sends.
    const callerEmail = typeof user.email === "string" ? user.email : "";
    const { data: job, error: jobErr } = await svc
      .from("scrape_jobs")
      .insert({
        user_id: targetId,
        status: "pending",
        triggered_by: "owner-force" + (callerEmail ? ":" + callerEmail : ""),
        sync_mode: "full",
      })
      .select("id")
      .single();
    if (jobErr || !job) {
      return refuse("queue_failed", "The scrape didn't queue — try again.");
    }
    await auditOwnerAction(svc, callerId, "force_scrape", targetId, targetEmail, { outcome: "queued", job_id: job.id });
    return json({ ok: true, target_email: targetEmail, job_id: job.id });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
