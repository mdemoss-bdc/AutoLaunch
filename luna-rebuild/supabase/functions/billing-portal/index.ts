// =====================================================================
// billing-portal — the in-app "Manage or cancel subscription" path
// (2026-10-26, see TIERS.md "Trial + Billing").
//
// Creates a Stripe Billing Portal session for the signed-in user's
// stored stripe_customer_id and returns its URL. The portal is where
// the user updates their card and CANCELS; Stripe's portal cancel
// defaults to cancel-at-period-end, so access continues until the end
// of the paid month, and billing-webhook flips the account to
// 'expired' when the subscription actually ends (deleted event).
//
// Config: STRIPE_SECRET_KEY secret. Until it's set → 503
// { error: "billing_not_configured" }. A signed-in user with no Stripe
// customer on file (never checked out) → 400 { error: "no_customer" }.
//
// DEALERSHIP subscriptions (Phase 2, 2026-10-26): a body of
// { dealership_id } opens the portal for the DEALERSHIP's own
// Stripe customer instead — the caller must be an admin member of
// that dealership (verified server-side), and the customer id comes
// from the dealership row. This is how a store admin changes seats
// or flavor and cancels: the account's default portal configuration
// carries subscription_update products for the solo AND dealer
// prices. A dealership with no customer yet → 400 no_customer,
// exactly like the solo path.
//
// verify_jwt=false at the platform level; JWT verified manually
// (tiktok-auth pattern). The customer id is read with the service role.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FALLBACK_APP_URL = "https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/";

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

function appReturnUrl(req: Request): string {
  const referer = (req.headers.get("referer") || "").split("?")[0];
  if (/^https?:\/\//i.test(referer)) return referer;
  return FALLBACK_APP_URL;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!secretKey) {
    return json({ ok: false, error: "billing_not_configured" }, 503);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = solo path */ }

  const svc = serviceClient();
  let customerId = "";
  const dealershipId = typeof body?.dealership_id === "string"
    ? body.dealership_id
    : "";
  if (dealershipId) {
    // Dealership path: admin members manage the STORE's
    // subscription (seats / flavor / cancel) in the portal.
    const { data: mem } = await svc
      .from("dealership_account_members")
      .select("role")
      .eq("dealership_id", dealershipId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!mem || mem.role !== "admin") {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const { data: dealer } = await svc
      .from("dealership_accounts")
      .select("stripe_customer_id")
      .eq("id", dealershipId)
      .maybeSingle();
    customerId = dealer?.stripe_customer_id || "";
    if (!customerId) return json({ ok: false, error: "no_customer" }, 400);
  } else {
    const { data: row } = await svc
      .from("user_settings")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    customerId = row?.stripe_customer_id || "";
    if (!customerId) return json({ ok: false, error: "no_customer" }, 400);
  }

  const form = new URLSearchParams({
    "customer": customerId,
    "return_url": appReturnUrl(req),
  });
  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error("billing-portal: Stripe unreachable: " + e);
    return json({ ok: false, error: "stripe_unreachable" }, 502);
  }
  const session = await res.json().catch(() => null);
  if (!res.ok || !session?.url) {
    console.error(
      "billing-portal: Stripe rejected session: " +
        (session?.error?.message || res.status),
    );
    return json({ ok: false, error: "stripe_error" }, 502);
  }
  return json({ ok: true, url: session.url });
});
