// =====================================================================
// billing-checkout — creates a Stripe Checkout Session (subscription)
// for the Post ($75/mo) or Group ($100/mo) plan. See TIERS.md.
//
// BILLING-CYCLE RULE (Matthew, 2026-10-26): the monthly charge must
// recur on the SAME day of the month the subscription starts. That is
// Stripe's DEFAULT billing-cycle anchor, so this function deliberately
// does NOT pass billing_cycle_anchor or any anchor/trial settings —
// the subscription starts the day checkout completes and renews on
// that day each month.
//
// Config comes from function secrets only (never the app, never code):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_POST, STRIPE_PRICE_GROUP
// Until Matthew connects Stripe and those are set, every call returns
// 503 { error: "billing_not_configured" } and the app shows an honest
// "checkout opens as soon as billing is switched on" message.
//
// verify_jwt=false at the platform level; the caller's JWT is verified
// manually (tiktok-auth pattern). The user id + plan ride in the
// session metadata AND the subscription metadata, and the id is also
// client_reference_id — the billing-webhook keys off them.
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FALLBACK_APP_URL = "https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let plan = "";
  try {
    const body = await req.json();
    plan = String(body?.plan || "");
  } catch { /* handled below */ }
  if (plan !== "post" && plan !== "group") {
    return json({ ok: false, error: "invalid_plan" }, 400);
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const priceId = plan === "post"
    ? (Deno.env.get("STRIPE_PRICE_POST") || "")
    : (Deno.env.get("STRIPE_PRICE_GROUP") || "");
  if (!secretKey || !priceId) {
    return json({ ok: false, error: "billing_not_configured" }, 503);
  }

  const appUrl = appReturnUrl(req);
  const form = new URLSearchParams({
    "mode": "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "success_url": appUrl + "?checkout=success",
    "cancel_url": appUrl + "?checkout=cancel",
    "client_reference_id": user.id,
    "metadata[user_id]": user.id,
    "metadata[plan]": plan,
    "subscription_data[metadata][user_id]": user.id,
    "subscription_data[metadata][plan]": plan,
  });
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
