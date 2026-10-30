// =====================================================================
// trial-source-claim — one free trial per dealership SOURCE
// (2026-10-30, see TIERS.md "Trial + Billing" staged-trial update).
//
// Called by the app for a SOLO TRIALING account at the moments it
// reaches for an inventory source: finishing dealer setup, saving
// sources in Settings, and pressing Sync Inventory. The body is
// { urls: string[] } — the account's raw inventory source URLs
// (used / new / certified). Each URL is normalized to its
// dealership domain (below) and checked against
// trial_dealer_claims:
//
//   unclaimed            -> the claim is recorded for this account
//                           and the call proceeds.
//   claimed by THIS user -> proceeds (idempotent).
//   claimed by ANOTHER   -> CONFLICT: this account's trial stops —
//     account               user_settings.billing_status flips to
//                           'trial_blocked' with
//                           trial_block_reason =
//                           'dealership_trial_used', and the app
//                           renders "Free trial has already been
//                           used for this dealership." The account
//                           is NOT deleted and can still buy a plan.
//
// EXEMPT — never checked, never blocked, never written: any account
// whose billing_status is not 'trialing' (paid/active, blocked,
// undecided), and any account holding a dealership membership
// (dealership trials run on the org's own clock; their members'
// personal rows are inert anyway). Owners hold 'active' rows, so
// they are exempt by the same rule. The registry started EMPTY:
// no claims exist for trials granted before this function shipped,
// and nothing here backfills them.
//
// Normalization (deliberately public-info plaintext — Matthew must
// be able to inspect and release claims by hand): lowercase host,
// scheme stripped, leading "www." stripped, reduced to the LAST
// TWO DNS labels (US dealer-market assumption). Known v1 limit:
// group platforms that host many stores under subdomains of one
// registrable domain collapse to that domain — one claim covers
// the platform. Subdomain-precise claims are a v2 question.
//
// Owner release (v1, no UI): delete the claim row —
//   delete from public.trial_dealer_claims where domain = '<domain>';
// A released source does NOT auto-restore a stopped account;
// Matthew decides per case (restore = set the account's
// billing_status back to 'trialing' and trial_block_reason to
// null by hand, if he chooses).
//
// verify_jwt=false at the platform level; the caller's JWT is
// verified manually (same pattern as trial-start). All writes go
// through the service role — trial_dealer_claims has RLS on with
// no policies, so browsers can't read or write it at all.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// Verify the caller's JWT against the Auth API; returns the user
// object or null (same helper as trial-start).
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

// Reduce a raw inventory source URL to its dealership domain:
// lowercase host, no scheme, no leading "www.", last two DNS
// labels. Returns null when the input carries no usable host.
function normalizeDealerDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  host = host.split("/")[0].split("?")[0].split("#")[0]; // path/query/fragment
  host = host.split("@").pop() || ""; // stray userinfo
  host = host.split(":")[0]; // port
  if (host.startsWith("www.")) host = host.slice(4);
  const labels = host.split(".").filter((l) => /^[a-z0-9-]+$/.test(l));
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const userId = user.id as string;

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const urls: unknown[] = Array.isArray(body?.urls) ? body.urls : [];
  const domains: string[] = [];
  for (const u of urls) {
    const d = normalizeDealerDomain(u);
    if (d && domains.indexOf(d) === -1) domains.push(d);
  }
  if (!domains.length) return json({ ok: true, status: "ok", claimed: [] });

  const svc = serviceClient();

  // EXEMPTIONS. Only a solo trialing account is claim-checked:
  // anything else (paid, blocked, undecided, grandfathered) passes
  // without a lookup or a write.
  const { data: settings } = await svc
    .from("user_settings")
    .select("billing_status")
    .eq("user_id", userId)
    .maybeSingle();
  if (!settings || settings.billing_status !== "trialing") {
    return json({ ok: true, status: "exempt" });
  }
  // A dealership membership (any role, trial or paid org) exempts:
  // dealership trials are the org's own, never source-claimed.
  const { data: membership } = await svc
    .from("dealership_account_members")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (membership) return json({ ok: true, status: "exempt" });

  // CHECK phase — every domain first, writes after: a conflict
  // anywhere stops the trial and binds nothing new.
  const toClaim: string[] = [];
  for (const domain of domains) {
    const { data: claim } = await svc
      .from("trial_dealer_claims")
      .select("user_id")
      .eq("domain", domain)
      .maybeSingle();
    const owner = claim && typeof claim.user_id === "string" ? claim.user_id : null;
    if (owner && owner !== userId) {
      const { error } = await svc
        .from("user_settings")
        .update({
          billing_status: "trial_blocked",
          trial_block_reason: "dealership_trial_used",
        })
        .eq("user_id", userId)
        .eq("billing_status", "trialing");
      if (error) return json({ ok: false, error: "settings_write_failed" }, 500);
      console.log("dealership trial stopped", { domain, user_id: userId });
      return json({
        ok: true,
        status: "blocked",
        reason: "dealership_trial_used",
        domain,
      });
    }
    if (!owner) toClaim.push(domain);
  }

  // CLAIM phase: record every unclaimed domain for this account.
  // A duplicate-key error means a concurrent call from the same
  // account won the race — not a failure.
  for (const domain of toClaim) {
    const { error: claimErr } = await svc
      .from("trial_dealer_claims")
      .insert({ domain, user_id: userId });
    if (claimErr && !/duplicate|conflict/i.test(claimErr.message || "")) {
      return json({ ok: false, error: "claim_write_failed" }, 500);
    }
  }

  return json({ ok: true, status: "ok", claimed: toClaim });
});
