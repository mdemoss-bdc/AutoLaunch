// =====================================================================
// trial-start — AutoLaunch 5-day trial + one-trial-per-claim locks
// (2026-10-26, see TIERS.md "Trial + Billing" and "Trial abuse
// defenses").
//
// Called by the app on sign-in when an account has no billing status
// yet, and on load while an account is trialing (the first-use
// re-check, rule 2b). Idempotent: an account whose
// user_settings.billing_status is already set gets it back unchanged,
// except that a trialing account is claim-re-checked first.
//
// Rules, in order:
//   1. Accounts created before the trial system existed
//      (auth created_at < 2026-10-26T00:00:00Z) are grandfathered:
//      billing_status = 'active', no trial, no claims of any kind.
//   2. Otherwise up to THREE independent one-trial claims are checked
//      (each is a salted SHA-256, TRIAL_IP_SALT; raw values are never
//      stored or logged):
//        IP    — the caller's IP (x-forwarded-for first entry, else
//                cf-connecting-ip) in trial_ip_claims. The hash
//                formula (salt + ":" + ip) is the v1 original, kept
//                byte-identical so claims written before v4 keep
//                matching.
//        EXT   — the helper's per-install id (v2.45+; the app passes
//                ext_install_id in the body when the helper answered)
//                in trial_ext_claims, hashed as salt + ":ext:" + id.
//        EMAIL — the account's normalized email (from the verified
//                JWT) in trial_email_claims, hashed as
//                salt + ":email:" + normalized. Normalization:
//                lowercase + trim; gmail.com / googlemail.com strip
//                dots AND +tag from the local part and fold to
//                gmail.com (same inbox by Google's own rules);
//                outlook.com / hotmail.com / live.com / msn.com strip
//                the +tag only; every other domain is used exactly as
//                written. Letters and digits are never altered.
//      If ANY claim is already held by a DIFFERENT account, this
//      account is 'trial_blocked' — no trial, and no new claims are
//      written for it. Otherwise all available claims are recorded
//      for this account (same-account repeats are idempotent).
//   2b. FIRST-USE RE-CHECK: an account already 'trialing' is
//      re-checked on every call (the app calls on load while
//      trialing). A trial minted on a phone carries no helper
//      binding, so the EXT and EMAIL claims are checked again here:
//      one held by a DIFFERENT account flips this account to
//      'trial_blocked' (same generic 'not_eligible' response); an
//      unclaimed one is recorded for this account, binding the
//      trial to the first helper it is actually used with. IP is
//      NOT re-checked or claimed on this path — roaming and shared
//      dealership IPs make post-grant IP enforcement a
//      false-positive machine; IP stays a grant-time gate only.
//      Accounts in any other state are never re-checked or flipped:
//      a paying customer cannot be claim-blocked.
//   3. On pass, the account gets billing_status = 'trialing' with a
//      trial window of now .. now + 5 days.
//   4. FAIL-OPEN: a missing IP, a missing/invalid ext id, or a
//      missing salt secret skips that claim only — missing data must
//      never lock out a legitimate user.
//
// verify_jwt=false at the platform level; the caller's JWT is verified
// manually (same pattern as tiktok-auth / listing-copy). All writes go
// through the service role — the claims tables have RLS on with no
// policies, so browsers can't read or write them at all.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Accounts created before this instant predate the trial system and
// are grandfathered to 'active' forever.
const GRANDFATHER_CUTOFF = Date.parse("2026-10-26T00:00:00Z");
const TRIAL_MS = 5 * 24 * 60 * 60 * 1000;

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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  if (first) return first;
  return (req.headers.get("cf-connecting-ip") || "").trim();
}

// [normalizer:start]
// Normalize an account email for the one-trial-per-inbox claim.
// Returns "local@domain" or null when the address is unusable.
// gmail/googlemail: dots and +tag are not part of the inbox identity
// (Google's own rule — both spellings deliver to one mailbox, and the
// dotted variant cannot be registered by anyone else). Outlook family:
// only the +tag is an alias. All other domains: exactly as written —
// dots there can be genuinely different people. Letters and digits
// are NEVER altered on any domain.
function normalizeEmailForClaim(email: string): string | null {
  const cleaned = (email || "").trim().toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at < 1 || at === cleaned.length - 1) return null;
  let local: string = cleaned.slice(0, at);
  let domain: string = cleaned.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.split(".").join("");
  } else if (
    domain === "outlook.com" || domain === "hotmail.com" ||
    domain === "live.com" || domain === "msn.com"
  ) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
  }
  if (!local || !domain) return null;
  return local + "@" + domain;
}
// [normalizer:end]

// Read an existing claim row's owner, or null when unclaimed.
async function claimOwner(
  svc: any,
  table: string,
  keyColumn: string,
  hash: string,
): Promise<string | null> {
  const { data } = await svc
    .from(table)
    .select("user_id")
    .eq(keyColumn, hash)
    .maybeSingle();
  return data && typeof data.user_id === "string" ? data.user_id : null;
}

// FIRST-USE RE-CHECK for an account already 'trialing' (rule 2b in
// the header). Checks the EXT (when a valid install id was passed)
// and EMAIL claims only — IP is grant-time only. Returns a Response
// when the account must be flipped to 'trial_blocked' (or on a write
// error), or null when the account may keep its trialing state.
// A claim held by THIS account is fine; an unclaimed claim is
// recorded for this account, which is what binds a phone-minted
// trial to the first helper it is used with. Fail-open like the
// grant path: a missing salt skips the whole re-check.
async function firstUseRecheck(
  svc: any,
  userId: string,
  email: unknown,
  extInstallId: string,
): Promise<Response | null> {
  const salt = Deno.env.get("TRIAL_IP_SALT") || "";
  if (!salt) return null;

  type RecheckPlan = { kind: "ext" | "email"; table: string; keyColumn: string; hash: string };
  const plans: RecheckPlan[] = [];
  if (extInstallId) {
    plans.push({
      kind: "ext", table: "trial_ext_claims", keyColumn: "ext_hash",
      hash: await sha256Hex(salt + ":ext:" + extInstallId),
    });
  }
  const normalizedEmail = normalizeEmailForClaim(
    typeof email === "string" ? email : "",
  );
  if (normalizedEmail) {
    plans.push({
      kind: "email", table: "trial_email_claims", keyColumn: "email_hash",
      hash: await sha256Hex(salt + ":email:" + normalizedEmail),
    });
  }

  // Check phase — all checks before any write, same discipline as
  // the grant path: a conflicting claim flips the account and binds
  // nothing new.
  const toBind: RecheckPlan[] = [];
  for (const plan of plans) {
    const owner = await claimOwner(svc, plan.table, plan.keyColumn, plan.hash);
    if (owner && owner !== userId) {
      const { error } = await svc
        .from("user_settings")
        .update({ billing_status: "trial_blocked" })
        .eq("user_id", userId);
      if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
      // Same generic-disclosure rule as the grant path: WHICH claim
      // fired stays server-side only.
      console.log("trial blocked", { kind: plan.kind, user_id: userId, via: "first_use" });
      return json({
        ok: true,
        status: "trial_blocked",
        trial_started_at: null,
        trial_ends_at: null,
        current_period_end: null,
        decided: "not_eligible",
      });
    }
    if (!owner) toBind.push(plan);
  }

  // Bind phase: record every claim this account doesn't already hold.
  for (const plan of toBind) {
    const insert: Record<string, unknown> = { user_id: userId };
    insert[plan.keyColumn] = plan.hash;
    const { error: claimErr } = await svc.from(plan.table).insert(insert);
    // Duplicate key = a concurrent call from the same account won.
    if (claimErr && !/duplicate|conflict/i.test(claimErr.message || "")) {
      return json({ ok: false, error: "claim_write_failed" }, 500);
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const userId = user.id as string;
  const svc = serviceClient();

  // Optional helper install id from the request body. Anything that
  // isn't a non-empty string of <= 64 chars is treated as absent.
  // Parsed up front: the first-use re-check below needs it too.
  let extInstallId = "";
  try {
    const body = await req.json();
    const raw = body && typeof body === "object" ? (body as any).ext_install_id : null;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length >= 1 && trimmed.length <= 64) extInstallId = trimmed;
    }
  } catch {
    /* no/invalid body — ext claim simply skipped */
  }

  // Current billing state — idempotent return if already decided,
  // EXCEPT 'trialing': a running trial is re-checked first (rule
  // 2b) so a phone-minted trial binds to — or is blocked by — the
  // claims of the account/helper it is first used with. Every other
  // decided state returns untouched: a paying customer is never
  // re-checked and can never be claim-flipped.
  const { data: row } = await svc
    .from("user_settings")
    .select("billing_status, trial_started_at, trial_ends_at, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (row && row.billing_status) {
    if (row.billing_status === "trialing") {
      const blocked = await firstUseRecheck(svc, userId, user.email, extInstallId);
      if (blocked) return blocked;
    }
    return json({
      ok: true,
      status: row.billing_status,
      trial_started_at: row.trial_started_at ?? null,
      trial_ends_at: row.trial_ends_at ?? null,
      current_period_end: row.current_period_end ?? null,
      decided: "existing",
    });
  }

  // Grandfather: account predates the trial system. Claims nothing.
  const createdAt = Date.parse(user.created_at || "");
  if (Number.isFinite(createdAt) && createdAt < GRANDFATHER_CUTOFF) {
    const { error } = await svc
      .from("user_settings")
      .upsert({ user_id: userId, billing_status: "active" }, { onConflict: "user_id" });
    if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
    return json({
      ok: true,
      status: "active",
      trial_started_at: null,
      trial_ends_at: null,
      current_period_end: null,
      decided: "grandfathered",
    });
  }

  // (ext_install_id was parsed before the billing-state read above.)

  // ---- Claims -------------------------------------------------------
  // All three checks run BEFORE any claim is written, so a blocked
  // account consumes nothing. A claim held by a different account
  // blocks; a claim held by this account is an idempotent repeat.
  const salt = Deno.env.get("TRIAL_IP_SALT") || "";
  const ip = clientIp(req);

  type ClaimPlan = {
    kind: "ip" | "ext" | "email";
    table: string;
    keyColumn: string;
    hash: string;
    status: string; // outcome label reported on grant
  };
  const plans: ClaimPlan[] = [];
  let ipClaimStatus = "skipped_no_ip";
  let extClaimStatus = extInstallId ? "skipped_no_salt" : "skipped_no_ext_id";
  let emailClaimStatus = "skipped_no_salt";

  if (!salt) {
    ipClaimStatus = ip ? "skipped_no_salt" : "skipped_no_ip";
  } else {
    if (ip) {
      plans.push({
        kind: "ip", table: "trial_ip_claims", keyColumn: "ip_hash",
        hash: await sha256Hex(salt + ":" + ip), status: "claimed",
      });
    }
    if (extInstallId) {
      plans.push({
        kind: "ext", table: "trial_ext_claims", keyColumn: "ext_hash",
        hash: await sha256Hex(salt + ":ext:" + extInstallId), status: "claimed",
      });
    }
    const normalizedEmail = normalizeEmailForClaim(
      typeof user.email === "string" ? user.email : "",
    );
    if (normalizedEmail) {
      plans.push({
        kind: "email", table: "trial_email_claims", keyColumn: "email_hash",
        hash: await sha256Hex(salt + ":email:" + normalizedEmail), status: "claimed",
      });
    } else {
      emailClaimStatus = "skipped_no_email";
    }
  }

  const ipPlan = plans.find((p) => p.kind === "ip") || null;
  const extPlan = plans.find((p) => p.kind === "ext") || null;
  const emailPlan = plans.find((p) => p.kind === "email") || null;

  // Check phase (order: IP, ext, email — first conflict wins).
  for (const plan of plans) {
    const owner = await claimOwner(svc, plan.table, plan.keyColumn, plan.hash);
    if (owner && owner !== userId) {
      const { error } = await svc
        .from("user_settings")
        .upsert(
          { user_id: userId, billing_status: "trial_blocked" },
          { onConflict: "user_id" },
        );
      if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
      // Client-facing copy is deliberately generic: WHICH claim
      // fired stays server-side only, so the response can't be used
      // to probe the trial defenses. Diagnostics: kind in the log.
      console.log("trial blocked", { kind: plan.kind, user_id: userId });
      return json({
        ok: true,
        status: "trial_blocked",
        trial_started_at: null,
        trial_ends_at: null,
        current_period_end: null,
        decided: "not_eligible",
      });
    }
    if (owner === userId) plan.status = "already_claimed_same_user";
  }

  // Write phase: record every claim this account doesn't already hold.
  for (const plan of plans) {
    if (plan.status !== "claimed") continue;
    const insert: Record<string, unknown> = { user_id: userId };
    insert[plan.keyColumn] = plan.hash;
    const { error: claimErr } = await svc.from(plan.table).insert(insert);
    // A duplicate-key error just means a concurrent call from the
    // same account won the race — not a failure.
    if (claimErr && !/duplicate|conflict/i.test(claimErr.message || "")) {
      return json({ ok: false, error: "claim_write_failed" }, 500);
    }
  }

  if (ipPlan) ipClaimStatus = ipPlan.status;
  if (extPlan) extClaimStatus = extPlan.status;
  if (emailPlan) emailClaimStatus = emailPlan.status;

  // Grant the 5-day trial.
  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL_MS);
  const { error } = await svc
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        billing_status: "trialing",
        trial_started_at: now.toISOString(),
        trial_ends_at: ends.toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
  return json({
    ok: true,
    status: "trialing",
    trial_started_at: now.toISOString(),
    trial_ends_at: ends.toISOString(),
    current_period_end: null,
    decided: "trial_granted",
    ip_claim: ipClaimStatus,
    ip_hash_prefix: ipPlan ? ipPlan.hash.slice(0, 8) : null,
    ext_claim: extClaimStatus,
    email_claim: emailClaimStatus,
  });
});
