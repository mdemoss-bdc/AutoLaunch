// =====================================================================
// dealership-admin — AutoLaunch dealership accounts, Phases 1–2
// (2026-10-26, see TIERS.md "Dealership accounts").
//
// A dealership account lets one admin manage member logins up to a
// seat limit. Members of a COVERED dealership (trial in window, or
// active) get their access through the dealership; their own
// billing_status is never used while covered. ALL writes to
// dealership_accounts / dealership_account_members happen here,
// through the service role — the tables carry SELECT-only RLS
// policies for members and no client write policies at all, so
// every rule below is enforced server-side, never trusted to the
// caller:
//
//   create_dealership {name, seat_limit}
//     OWNER accounts only (the same two ids hardcoded in the app).
//     plan_key derives from the seat tier: 10/20/50/100 ->
//     dealer_10/20/50/100, NULL seat_limit -> dealer_unlimited.
//     The caller becomes the dealership's first member (role
//     'admin'). A caller who already belongs to a dealership gets
//     409 already_in_a_dealership (Phase 1: one dealership per user).
//   register_dealership {name}   (Phase 1.5, 2026-10-26; Phase 2
//   trial semantics the same day)
//     Self-serve registration from the app's Register page, where a
//     new account picks Individual vs Dealership. ANY signed-in user
//     with NO existing membership registers their store: the
//     dealership row is created with status 'trial', seat_limit 2,
//     trial_ends_at = created_at + 5 days, billing_status
//     'trialing', and the caller becomes its admin member. The
//     trial is a WORKING trial: the store tastes the full Group
//     flavor with up to 2 seats, and member management is enabled.
//     (Phase 1.5 created status 'pending' with no powers; the
//     Phase 2 migration moved pending rows to this trial state and
//     dealer checkout — billing-checkout kind 'dealership' — is
//     what flips a trial to 'active' with the bought seat count
//     and flavor.) A caller who already belongs to a dealership
//     gets that dealership back unchanged (idempotent — the app
//     may call this on more than one load).
//   list_members {dealership_id}
//     Caller must be an ADMIN member. Returns the roster (email,
//     role, joined) plus seat usage.
//   create_member {dealership_id, email, password, role}
//     Caller must be an admin member, and the dealership must be
//     in a seat-powered state: status 'trial' or 'active' —
//     anything else (e.g. 'expired') refuses with 409
//     dealership_not_active. Seat enforcement: when seat_limit is
//     set and the roster is full -> 409 seat_limit_reached (the
//     trial cap is seat_limit = 2). The auth user is created
//     through the Admin API with email_confirm=true (admin-created
//     accounts skip the verification email), then the membership
//     is inserted; if that insert fails the just-created auth user
//     is deleted again — no orphans either way.
//   delete_member {dealership_id, user_id}
//     Caller must be an admin member; nobody can delete themselves;
//     an ADMIN target can only be deleted by the dealership's
//     created_by owner. Deletes the membership and the auth user
//     (either step failing compensates the other). The deleted
//     user's app data is NOT touched — it stays in the database
//     under their user id (Phase 2: dealership ownership tagging +
//     reassignment).
//   reset_member_password {dealership_id, user_id, new_password}
//     Caller must be an admin member; the target must belong to the
//     dealership. Admin API updateUserById.
//
// verify_jwt=false at the platform level; the caller's JWT is
// verified manually (same pattern as trial-start). Browser-invoked
// through supabase-js, so the CORS allow-headers list is the full
// one (apikey, authorization, content-type, x-client-info,
// x-supabase-api-version).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Owner accounts (Matthew's hard rule — the same ids the app
// hardcodes in OWNER_USER_IDS). Only owners can provision a new
// dealership in Phase 1; dealer self-serve checkout is Phase 2.
const OWNER_USER_IDS = [
  "40a95557-504a-460f-a891-462bb2b4f25c", // Matthew
  "9cdba37e-ac31-464d-92b9-0745772fbf00", // Jourdan
];

const SEAT_TIERS = [10, 20, 50, 100];

// Phase 2: the columns every dealership read in this function
// returns — includes the trial + Stripe state the app renders.
const DEALER_SELECT =
  "id, name, created_by, seat_limit, plan_key, status, created_at, plan_flavor, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_end, billing_status" as const;

// Seat-powered states (Phase 2): member management (create / delete
// / reset) is allowed while the dealership is trialing or active.
// Anything else — an expired dealership above all — refuses with
// 409 dealership_not_active.
function seatActionsAllowed(dealer: any): boolean {
  return !!dealer && (dealer.status === "trial" || dealer.status === "active");
}

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

async function getDealership(svc: any, dealershipId: string) {
  const { data } = await svc
    .from("dealership_accounts")
    .select(DEALER_SELECT)
    .eq("id", dealershipId)
    .maybeSingle();
  return data || null;
}

async function getMembership(svc: any, dealershipId: string, userId: string) {
  const { data } = await svc
    .from("dealership_account_members")
    .select("dealership_id, user_id, role, created_at")
    .eq("dealership_id", dealershipId)
    .eq("user_id", userId)
    .maybeSingle();
  return data || null;
}

// The caller's admin membership in this dealership, or null. Every
// management action funnels through this check.
async function requireAdmin(svc: any, dealershipId: string, userId: string) {
  const m = await getMembership(svc, dealershipId, userId);
  return m && m.role === "admin" ? m : null;
}

// Seats used = MEMBER rows only (Matthew, 2026-10-26 leader rule):
// the dealership leader (role 'admin') is manage-only and NEVER
// counts as a seat — trial cap 2 means 2 salesperson seats, and a
// paid seat_limit is likewise a member-seat count (mirroring the
// Stripe quantity the store bought).
async function memberCount(svc: any, dealershipId: string): Promise<number> {
  const { count } = await svc
    .from("dealership_account_members")
    .select("user_id", { count: "exact", head: true })
    .eq("dealership_id", dealershipId)
    .eq("role", "member");
  return typeof count === "number" ? count : 0;
}

function planKeyForSeatLimit(seatLimit: number | null): string | null {
  if (seatLimit === null) return "dealer_unlimited";
  // Named tiers get a plan key; a custom seat count gets none.
  return SEAT_TIERS.indexOf(seatLimit) !== -1 ? "dealer_" + seatLimit : null;
}

// Accept seat_limit as a number, a numeric string, or null/"unlimited".
// The app offers the named tiers (10/20/50/100), but the server accepts
// any positive integer — the seat COUNT is the enforced contract; the
// tier list is presentation. Returns { ok, value } — anything else 400.
function parseSeatLimit(raw: unknown): { ok: boolean; value: number | null } {
  if (raw === null || raw === undefined || raw === "" || raw === "unlimited") {
    return { ok: true, value: null };
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= 1) {
    return { ok: true, value: n };
  }
  return { ok: false, value: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const callerId = user.id as string;
  const svc = serviceClient();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const action = body && typeof body.action === "string" ? body.action : "";

  // ------------------------------------------------ create_dealership
  if (action === "create_dealership") {
    if (OWNER_USER_IDS.indexOf(callerId) === -1) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json({ ok: false, error: "name_required" }, 400);
    const seat = parseSeatLimit(body.seat_limit);
    if (!seat.ok) return json({ ok: false, error: "invalid_seat_limit" }, 400);

    // Phase 1: one dealership per user — a caller who already
    // belongs to one can't provision another.
    const { data: existing } = await svc
      .from("dealership_account_members")
      .select("dealership_id")
      .eq("user_id", callerId)
      .maybeSingle();
    if (existing) {
      return json({ ok: false, error: "already_in_a_dealership" }, 409);
    }

    const { data: dealer, error: dErr } = await svc
      .from("dealership_accounts")
      .insert({
        name,
        created_by: callerId,
        seat_limit: seat.value,
        plan_key: planKeyForSeatLimit(seat.value),
        status: "active",
      })
      .select(DEALER_SELECT)
      .single();
    if (dErr || !dealer) {
      return json({ ok: false, error: "dealership_create_failed" }, 500);
    }
    const { error: mErr } = await svc
      .from("dealership_account_members")
      .insert({ dealership_id: dealer.id, user_id: callerId, role: "admin" });
    if (mErr) {
      // Compensate: don't leave a dealership with no admin behind.
      await svc.from("dealership_accounts").delete().eq("id", dealer.id);
      return json({ ok: false, error: "membership_create_failed" }, 500);
    }
    return json({ ok: true, dealership: dealer, seats_used: 0 }); // leader is not a seat
  }

  // ------------------------------------------------- register_dealership
  // Self-serve registration (Register page, Dealership choice).
  // Phase 2: creates a TRIAL dealership — a working 5-day trial at
  // the full Group flavor with seat_limit 2 and member management
  // enabled — with the caller as its admin. Idempotent: a caller
  // who already belongs to a dealership gets it back unchanged.
  if (action === "register_dealership") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json({ ok: false, error: "name_required" }, 400);

    const { data: existing } = await svc
      .from("dealership_account_members")
      .select("dealership_id")
      .eq("user_id", callerId)
      .maybeSingle();
    if (existing) {
      const dealer = await getDealership(svc, existing.dealership_id);
      if (dealer) return json({ ok: true, dealership: dealer, existing: true });
      return json({ ok: false, error: "dealership_not_found" }, 404);
    }

    const trialEndsAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const { data: dealer, error: dErr } = await svc
      .from("dealership_accounts")
      .insert({
        name,
        created_by: callerId,
        seat_limit: 2,
        plan_key: null,
        status: "trial",
        trial_ends_at: trialEndsAt,
        billing_status: "trialing",
      })
      .select(DEALER_SELECT)
      .single();
    if (dErr || !dealer) {
      return json({ ok: false, error: "dealership_create_failed" }, 500);
    }
    const { error: mErr } = await svc
      .from("dealership_account_members")
      .insert({ dealership_id: dealer.id, user_id: callerId, role: "admin" });
    if (mErr) {
      // Compensate: don't leave a dealership with no admin behind.
      await svc.from("dealership_accounts").delete().eq("id", dealer.id);
      return json({ ok: false, error: "membership_create_failed" }, 500);
    }
    return json({ ok: true, dealership: dealer, seats_used: 0 }); // leader is not a seat
  }

  // ------------------------------------------------------- list_members
  if (action === "list_members") {
    const dealershipId = typeof body.dealership_id === "string" ? body.dealership_id : "";
    if (!dealershipId) return json({ ok: false, error: "dealership_required" }, 400);
    if (!(await requireAdmin(svc, dealershipId, callerId))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const dealer = await getDealership(svc, dealershipId);
    if (!dealer) return json({ ok: false, error: "dealership_not_found" }, 404);
    const { data: rows, error } = await svc
      .from("dealership_account_members")
      .select("user_id, role, created_at")
      .eq("dealership_id", dealershipId)
      .order("created_at", { ascending: true });
    if (error) return json({ ok: false, error: "list_failed" }, 500);
    const members = [];
    for (const row of rows || []) {
      let email: string | null = null;
      try {
        const { data: u } = await svc.auth.admin.getUserById(row.user_id);
        if (u && u.user) email = u.user.email ?? null;
      } catch {
        /* email stays null — the row itself is still listed */
      }
      members.push({
        user_id: row.user_id,
        email,
        role: row.role,
        created_at: row.created_at,
      });
    }
    return json({
      ok: true,
      dealership: dealer,
      members,
      // Leader rule: seats_used counts MEMBER rows only.
      seats_used: members.filter((m) => m.role === "member").length,
      seat_limit: dealer.seat_limit,
    });
  }

  // ------------------------------------------------------ create_member
  if (action === "create_member") {
    const dealershipId = typeof body.dealership_id === "string" ? body.dealership_id : "";
    if (!dealershipId) return json({ ok: false, error: "dealership_required" }, 400);
    if (!(await requireAdmin(svc, dealershipId, callerId))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const dealer = await getDealership(svc, dealershipId);
    if (!dealer) return json({ ok: false, error: "dealership_not_found" }, 404);
    if (!seatActionsAllowed(dealer)) {
      return json({ ok: false, error: "dealership_not_active" }, 409);
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.indexOf("@") < 1) {
      return json({ ok: false, error: "invalid_email" }, 400);
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      return json({ ok: false, error: "password_too_short" }, 400);
    }
    const role = body.role === "admin" ? "admin" : "member";

    // Seat enforcement, server-side: a full roster refuses the
    // create before any auth user exists.
    if (dealer.seat_limit !== null && dealer.seat_limit !== undefined) {
      const used = await memberCount(svc, dealershipId);
      if (used >= dealer.seat_limit) {
        return json({ ok: false, error: "seat_limit_reached" }, 409);
      }
    }

    const { data: created, error: cErr } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (cErr || !created || !created.user) {
      const msg = (cErr && cErr.message) || "";
      if (/already|exists|registered/i.test(msg)) {
        return json({ ok: false, error: "email_already_registered" }, 400);
      }
      return json({ ok: false, error: "user_create_failed" }, 500);
    }
    const newUserId = created.user.id as string;
    const { error: mErr } = await svc
      .from("dealership_account_members")
      .insert({ dealership_id: dealershipId, user_id: newUserId, role });
    if (mErr) {
      // No orphans: the membership couldn't be recorded (e.g. the
      // address already belongs to another dealership), so the
      // just-created login goes away again.
      try {
        await svc.auth.admin.deleteUser(newUserId);
      } catch {
        /* best effort — the error below still reports the failure */
      }
      return json({ ok: false, error: "membership_create_failed" }, 500);
    }
    return json({
      ok: true,
      member: { user_id: newUserId, email, role },
      seats_used: await memberCount(svc, dealershipId),
      seat_limit: dealer.seat_limit,
    });
  }

  // ------------------------------------------------------ delete_member
  if (action === "delete_member") {
    const dealershipId = typeof body.dealership_id === "string" ? body.dealership_id : "";
    const targetId = typeof body.user_id === "string" ? body.user_id : "";
    if (!dealershipId || !targetId) {
      return json({ ok: false, error: "dealership_and_user_required" }, 400);
    }
    if (!(await requireAdmin(svc, dealershipId, callerId))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    if (targetId === callerId) {
      return json({ ok: false, error: "cannot_delete_self" }, 400);
    }
    const dealer = await getDealership(svc, dealershipId);
    if (!dealer) return json({ ok: false, error: "dealership_not_found" }, 404);
    if (!seatActionsAllowed(dealer)) {
      return json({ ok: false, error: "dealership_not_active" }, 409);
    }
    const target = await getMembership(svc, dealershipId, targetId);
    if (!target) return json({ ok: false, error: "member_not_found" }, 404);
    if (target.role === "admin" && dealer.created_by !== callerId) {
      return json({ ok: false, error: "only_owner_can_delete_admin" }, 403);
    }

    // Membership first, then the login; if the login delete fails,
    // the membership is restored so nothing is half-deleted.
    const { error: mErr } = await svc
      .from("dealership_account_members")
      .delete()
      .eq("dealership_id", dealershipId)
      .eq("user_id", targetId);
    if (mErr) return json({ ok: false, error: "membership_delete_failed" }, 500);
    const { error: uErr } = await svc.auth.admin.deleteUser(targetId);
    if (uErr) {
      await svc
        .from("dealership_account_members")
        .insert({ dealership_id: dealershipId, user_id: targetId, role: target.role });
      return json({ ok: false, error: "user_delete_failed" }, 500);
    }
    // NOTE (Phase 1): the deleted user's app data (settings,
    // inventory, prospects) is deliberately left in place under
    // their user id. Phase 2 adds dealership ownership tagging and
    // reassignment; nothing here destroys store data.
    return json({
      ok: true,
      seats_used: await memberCount(svc, dealershipId),
      seat_limit: dealer.seat_limit,
    });
  }

  // ----------------------------------------------- reset_member_password
  if (action === "reset_member_password") {
    const dealershipId = typeof body.dealership_id === "string" ? body.dealership_id : "";
    const targetId = typeof body.user_id === "string" ? body.user_id : "";
    if (!dealershipId || !targetId) {
      return json({ ok: false, error: "dealership_and_user_required" }, 400);
    }
    if (!(await requireAdmin(svc, dealershipId, callerId))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const dealer = await getDealership(svc, dealershipId);
    if (!dealer) return json({ ok: false, error: "dealership_not_found" }, 404);
    if (!seatActionsAllowed(dealer)) {
      return json({ ok: false, error: "dealership_not_active" }, 409);
    }
    const target = await getMembership(svc, dealershipId, targetId);
    if (!target) return json({ ok: false, error: "member_not_found" }, 404);
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (newPassword.length < 8) {
      return json({ ok: false, error: "password_too_short" }, 400);
    }
    const { error } = await svc.auth.admin.updateUserById(targetId, {
      password: newPassword,
    });
    if (error) return json({ ok: false, error: "password_update_failed" }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
