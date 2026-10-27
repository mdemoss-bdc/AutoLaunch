// =====================================================================
// referral-claim — the referral program's two account actions
// (2026-10-26, see TIERS.md "Referrals"):
//
//   { action: "my_code" } → the caller's referral code, generated
//     lazily on first ask (8 chars from an unambiguous alphabet) and
//     stored on their user_settings row (UNIQUE). The app builds the
//     share link as <app origin>?ref=<code> — origin-relative, so the
//     link survives the autolaunch.org move untouched.
//
//   { code, ext_install_id? } → claim the caller as that code owner's
//     referee. Rules (Matthew's program): an account can be referred
//     ONCE; nobody can refer themselves — checked by account id, by
//     normalized email (trial-start's exact normalization: Gmail
//     dots/+tag fold, Outlook family +tag only), and, when the app
//     passes the helper install id, by the trial EXT claim (a claim
//     held by the code owner under the same helper install means the
//     same person) — the ext check fails open when the id or the
//     salt is absent, exactly like trial-start. Only the referrer's
//     FIRST THREE claimed referees (claim order) are bonus_eligible;
//     later referees are recorded with bonus_eligible=false — they
//     display as referrals but never accrue free months.
//
// verify_jwt=false at the platform level; the caller's JWT is
// verified manually (billing-checkout pattern). All writes use the
// service role — the referrals table has no client write policies.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Unambiguous alphabet: no 0/O, 1/I/L — a code read over the phone or
// typed from a screenshot can't be mis-copied between lookalikes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
// Matthew's cap: bonuses accrue from at most 3 referral accounts.
const BONUS_ACCOUNT_CAP = 3;

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

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
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

// Normalize an account email for the self-referral check — copied
// verbatim from trial-start (same claim discipline): gmail/googlemail
// strip dots AND +tag and fold to gmail.com (provably one inbox);
// outlook.com / hotmail.com / live.com / msn.com strip the +tag only
// (dots there can be different people); every other domain is used
// exactly as written. Letters and digits are never altered.
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

function validExtInstallId(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : "";
}

async function myCode(svc: any, userId: string) {
  const { data: row } = await svc
    .from("user_settings")
    .select("referral_code")
    .eq("user_id", userId)
    .maybeSingle();
  if (row?.referral_code) {
    return json({ ok: true, code: row.referral_code });
  }
  // Generate + store, retrying on the (astronomically unlikely)
  // UNIQUE collision. The upsert covers accounts whose settings row
  // doesn't exist yet — same partial-row pattern billing-webhook uses.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { error } = await svc
      .from("user_settings")
      .upsert({ user_id: userId, referral_code: code }, { onConflict: "user_id" });
    if (!error) return json({ ok: true, code });
    if (!String(error.code || "").includes("23505")) {
      console.error("referral-claim: my_code store failed: " + error.message);
      return json({ ok: false, error: "code_failed" }, 500);
    }
  }
  return json({ ok: false, error: "code_failed" }, 500);
}

async function claim(svc: any, user: any, body: any) {
  const code = String(body?.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    return json({ ok: false, error: "invalid_code" }, 400);
  }

  const { data: ownerRow } = await svc
    .from("user_settings")
    .select("user_id")
    .eq("referral_code", code)
    .maybeSingle();
  if (!ownerRow?.user_id) {
    return json({ ok: false, error: "invalid_code" }, 404);
  }
  const referrerId = String(ownerRow.user_id);
  if (referrerId === user.id) {
    return json({ ok: false, error: "self_referral" }, 400);
  }

  // Idempotent: an account is referred once; a repeat claim returns
  // the existing row untouched (even if it's someone else's code —
  // the first claim stands).
  const { data: existing } = await svc
    .from("referrals")
    .select("id, bonus_eligible")
    .eq("referee_user_id", user.id)
    .maybeSingle();
  if (existing) {
    return json({ ok: true, already_claimed: true, bonus_eligible: !!existing.bonus_eligible });
  }

  // Self-referral guard 1 — normalized email. The caller's email
  // comes from their verified JWT; the referrer's from the Auth
  // admin record. Equal normalized inboxes = the same person, even
  // across the Gmail dot/plus spellings.
  try {
    const { data: ownerUser } = await svc.auth.admin.getUserById(referrerId);
    const mine = normalizeEmailForClaim(String(user.email || ""));
    const theirs = normalizeEmailForClaim(String(ownerUser?.user?.email || ""));
    if (mine && theirs && mine === theirs) {
      return json({ ok: false, error: "self_referral" }, 400);
    }
  } catch (e) {
    console.error("referral-claim: email guard lookup failed: " + e);
  }

  // Self-referral guard 2 — helper install. If this install already
  // holds a trial EXT claim for the CODE OWNER, the claimant is on
  // the owner's own machine. Fail-open exactly like trial-start: no
  // id passed, no salt, or no claim → the check simply doesn't bite.
  const extId = validExtInstallId(body?.ext_install_id);
  const salt = Deno.env.get("TRIAL_IP_SALT") || "";
  if (extId && salt) {
    try {
      const hash = await sha256Hex(salt + ":ext:" + extId);
      const { data: extClaim } = await svc
        .from("trial_ext_claims")
        .select("user_id")
        .eq("ext_hash", hash)
        .maybeSingle();
      if (extClaim?.user_id === referrerId) {
        return json({ ok: false, error: "self_referral" }, 400);
      }
    } catch (e) {
      console.error("referral-claim: ext guard lookup failed: " + e);
    }
  }

  // Only the first BONUS_ACCOUNT_CAP bonus-eligible referees accrue;
  // the count is over eligible rows only, in claim order.
  const { count } = await svc
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", referrerId)
    .eq("bonus_eligible", true);
  const bonusEligible = (count ?? BONUS_ACCOUNT_CAP) < BONUS_ACCOUNT_CAP;

  const { error } = await svc.from("referrals").insert({
    referrer_user_id: referrerId,
    referee_user_id: user.id,
    bonus_eligible: bonusEligible,
  });
  if (error) {
    // A concurrent claim won the race for this referee — answer with
    // the row that landed.
    if (String(error.code || "").includes("23505")) {
      const { data: row } = await svc
        .from("referrals")
        .select("bonus_eligible")
        .eq("referee_user_id", user.id)
        .maybeSingle();
      return json({ ok: true, already_claimed: true, bonus_eligible: !!row?.bonus_eligible });
    }
    console.error("referral-claim: insert failed: " + error.message);
    return json({ ok: false, error: "claim_failed" }, 500);
  }
  return json({ ok: true, claimed: true, bonus_eligible: bonusEligible });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const svc = serviceClient();
  if (body?.action === "my_code") return myCode(svc, user.id);
  return claim(svc, user, body);
});
