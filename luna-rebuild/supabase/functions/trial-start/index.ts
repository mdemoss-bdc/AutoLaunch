// =====================================================================
// trial-start — AutoLaunch 5-day trial + one-trial-per-IP lock
// (2026-10-26, see TIERS.md "Trial + Billing").
//
// Called by the app on sign-in when an account has no billing status
// yet. Idempotent: an account whose user_settings.billing_status is
// already set gets it back unchanged.
//
// Rules, in order:
//   1. Accounts created before the trial system existed
//      (auth created_at < 2026-10-26T00:00:00Z) are grandfathered:
//      billing_status = 'active', no trial, no IP claim.
//   2. Otherwise the caller's IP (x-forwarded-for first entry, else
//      cf-connecting-ip) is salted + SHA-256 hashed (TRIAL_IP_SALT
//      secret; the raw IP is never stored or logged). One trial per
//      IP: if trial_ip_claims already holds the hash for a DIFFERENT
//      account, this account is 'trial_blocked' — no trial.
//   3. Otherwise the claim is recorded and the account gets
//      billing_status = 'trialing', trial window = now .. now + 5 days.
//   4. FAIL-OPEN: if no IP header is present (or the salt secret is
//      missing), the trial is granted WITHOUT a claim — a missing
//      header must never lock out a legitimate user.
//
// verify_jwt=false at the platform level; the caller's JWT is verified
// manually (same pattern as tiktok-auth / listing-copy). All writes go
// through the service role — trial_ip_claims has RLS on with no
// policies, so browsers can't read or write it at all.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const userId = user.id as string;
  const svc = serviceClient();

  // Current billing state — idempotent return if already decided.
  const { data: row } = await svc
    .from("user_settings")
    .select("billing_status, trial_started_at, trial_ends_at, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (row && row.billing_status) {
    return json({
      ok: true,
      status: row.billing_status,
      trial_started_at: row.trial_started_at ?? null,
      trial_ends_at: row.trial_ends_at ?? null,
      current_period_end: row.current_period_end ?? null,
      decided: "existing",
    });
  }

  // Grandfather: account predates the trial system.
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

  // IP claim check.
  const ip = clientIp(req);
  let ipClaim = "skipped_no_ip";
  let ipHashPrefix: string | null = null;
  if (ip) {
    const salt = Deno.env.get("TRIAL_IP_SALT") || "";
    if (!salt) {
      ipClaim = "skipped_no_salt"; // fail-open: never lock out over config
    } else {
      const ipHash = await sha256Hex(salt + ":" + ip);
      ipHashPrefix = ipHash.slice(0, 8);
      const { data: claim } = await svc
        .from("trial_ip_claims")
        .select("user_id")
        .eq("ip_hash", ipHash)
        .maybeSingle();
      if (claim && claim.user_id !== userId) {
        const { error } = await svc
          .from("user_settings")
          .upsert(
            { user_id: userId, billing_status: "trial_blocked" },
            { onConflict: "user_id" },
          );
        if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
        return json({
          ok: true,
          status: "trial_blocked",
          trial_started_at: null,
          trial_ends_at: null,
          current_period_end: null,
          decided: "ip_already_claimed",
          ip_claim: "blocked_other_user",
          ip_hash_prefix: ipHashPrefix,
        });
      }
      if (!claim) {
        const { error: claimErr } = await svc
          .from("trial_ip_claims")
          .insert({ ip_hash: ipHash, user_id: userId });
        // A duplicate-key error just means a concurrent call from the
        // same account won the race — not a failure.
        if (claimErr && !/duplicate|conflict/i.test(claimErr.message || "")) {
          return json({ ok: false, error: "claim_write_failed" }, 500);
        }
        ipClaim = "claimed";
      } else {
        ipClaim = "already_claimed_same_user";
      }
    }
  }

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
    ip_claim: ipClaim,
    ip_hash_prefix: ipHashPrefix,
  });
});
