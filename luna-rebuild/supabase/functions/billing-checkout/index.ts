// =====================================================================
// billing-checkout — creates a Stripe Checkout Session for:
//   post / group            monthly subscriptions ($75 / $100)
//   post_annual /           annual subscriptions ($750 / $1,000/year —
//   group_annual            10 months' price, "2 months free"; the
//                           webhook maps them to the post/group tiers
//                           and counts them as 12 paid referral months)
//   lifetime_post / group   Founding Lifetime, one-time payment
//                           ($1,499 / $1,999; capped at 50 buyers total)
//   support                 Support Plan subscription ($199/year),
//                           Lifetime accounts only, after the included
//                           first year of priority support
// Also answers { action: "lifetime_status" } → { sold, cap, available }
// so the app can show (or retire) the founding offer. See TIERS.md
// "Founding Lifetime + Support Plan".
//
// BILLING-CYCLE RULE (Matthew, 2026-10-26): the monthly charge must
// recur on the SAME day of the month the subscription starts. That is
// Stripe's DEFAULT billing-cycle anchor, so this function deliberately
// does NOT pass billing_cycle_anchor or any anchor/trial settings —
// the subscription starts the day checkout completes and renews on
// that day each month.
//
// Config comes from function secrets only (never the app, never code):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_POST, STRIPE_PRICE_GROUP,
//   STRIPE_PRICE_POST_ANNUAL, STRIPE_PRICE_GROUP_ANNUAL,
//   STRIPE_PRICE_LIFETIME_POST, STRIPE_PRICE_LIFETIME_GROUP,
//   STRIPE_PRICE_SUPPORT
// A plan whose price secret is missing returns
// 503 { error: "billing_not_configured" } and the app says so honestly.
//
// verify_jwt=false at the platform level; the caller's JWT is verified
// manually (tiktok-auth pattern). Every session carries
// metadata { kind, user_id } and, for subscriptions,
// subscription_data.metadata { kind, user_id } — the billing-webhook
// routes on `kind`. client_reference_id is the user id.
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FALLBACK_APP_URL = "https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/";

// The founding cap: 50 lifetime buyers TOTAL, both tiers combined
// (Matthew, 2026-10-26). The 30-day post-launch close is NOT date
// logic yet — launch hasn't happened; availability = this cap plus
// the secrets being set.
const LIFETIME_CAP = 50;

const PLANS: Record<string, { priceEnv: string; mode: string; tier: string | null }> = {
  post: { priceEnv: "STRIPE_PRICE_POST", mode: "subscription", tier: "post" },
  group: { priceEnv: "STRIPE_PRICE_GROUP", mode: "subscription", tier: "group" },
  post_annual: { priceEnv: "STRIPE_PRICE_POST_ANNUAL", mode: "subscription", tier: "post" },
  group_annual: { priceEnv: "STRIPE_PRICE_GROUP_ANNUAL", mode: "subscription", tier: "group" },
  lifetime_post: { priceEnv: "STRIPE_PRICE_LIFETIME_POST", mode: "payment", tier: "post" },
  lifetime_group: { priceEnv: "STRIPE_PRICE_LIFETIME_GROUP", mode: "payment", tier: "group" },
  support: { priceEnv: "STRIPE_PRICE_SUPPORT", mode: "subscription", tier: null },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

// Service-role PostgREST helpers (the lifetime count + the caller's
// own settings row). The service key never leaves the function; the
// queries are keyed to fixed columns / the verified caller's id.
async function countLifetimeBuyers(): Promise<number | null> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !svc) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/user_settings?select=user_id&lifetime_tier=not.is.null`,
      {
        headers: {
          "apikey": svc,
          "Authorization": `Bearer ${svc}`,
          "Prefer": "count=exact",
          "Range": "0-0",
        },
      },
    );
    if (!res.ok) return null;
    const total = parseInt((res.headers.get("content-range") || "").split("/")[1] || "", 10);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

async function fetchSettingsRow(userId: string): Promise<any | null> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !svc) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/user_settings?select=user_id,lifetime_tier&user_id=eq.${encodeURIComponent(userId)}`,
      { headers: { "apikey": svc, "Authorization": `Bearer ${svc}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }

  // Founding-offer availability, for the app's plan surfaces. No
  // Stripe config needed — the count is the whole answer.
  if (body?.action === "lifetime_status") {
    const sold = await countLifetimeBuyers();
    if (sold === null) {
      return json({ ok: false, error: "billing_not_configured" }, 503);
    }
    return json({ ok: true, sold, cap: LIFETIME_CAP, available: sold < LIFETIME_CAP });
  }

  const plan = String(body?.plan || "");
  const spec = PLANS[plan];
  if (!spec) {
    return json({ ok: false, error: "invalid_plan" }, 400);
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const priceId = Deno.env.get(spec.priceEnv) || "";
  if (!secretKey || !priceId) {
    return json({ ok: false, error: "billing_not_configured" }, 503);
  }

  // Founding cap, enforced BEFORE any session exists: a sold-out
  // offer never reaches Stripe.
  if (spec.mode === "payment") {
    const sold = await countLifetimeBuyers();
    if (sold === null) {
      return json({ ok: false, error: "billing_not_configured" }, 503);
    }
    if (sold >= LIFETIME_CAP) {
      return json({ ok: false, error: "lifetime_sold_out" }, 409);
    }
  }

  // The Support Plan is an add-on for Lifetime accounts only.
  if (plan === "support") {
    const row = await fetchSettingsRow(user.id);
    if (!row?.lifetime_tier) {
      return json({ ok: false, error: "lifetime_required" }, 400);
    }
  }

  const appUrl = appReturnUrl(req);
  const form = new URLSearchParams({
    "mode": spec.mode,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "success_url": appUrl + "?checkout=success",
    "cancel_url": appUrl + "?checkout=cancel",
    "client_reference_id": user.id,
    "metadata[user_id]": user.id,
    "metadata[kind]": plan,
  });
  if (spec.tier) form.set("metadata[plan]", spec.tier);
  if (spec.mode === "subscription") {
    form.set("subscription_data[metadata][user_id]", user.id);
    form.set("subscription_data[metadata][kind]", plan);
    if (spec.tier) form.set("subscription_data[metadata][plan]", spec.tier);
  }
  if (user.email) form.set("customer_email", String(user.email));
  // NOTE: no billing_cycle_anchor — Stripe's default anchors the
  // monthly renewal to the subscription's start day, per spec.

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error("billing-checkout: Stripe unreachable: " + e);
    return json({ ok: false, error: "stripe_unreachable" }, 502);
  }
  const session = await res.json().catch(() => null);
  if (!res.ok || !session?.url) {
    console.error(
      "billing-checkout: Stripe rejected session: " +
        (session?.error?.message || res.status),
    );
    return json({ ok: false, error: "stripe_error" }, 502);
  }
  return json({ ok: true, url: session.url });
});
