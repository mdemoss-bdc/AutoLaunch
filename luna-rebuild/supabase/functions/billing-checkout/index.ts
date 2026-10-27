// =====================================================================
// billing-checkout — creates a Stripe Checkout Session for:
//   post / group            monthly subscriptions ($75 / $100)
//   post_1y / post_2y /     multi-year prepaid terms on the same two
//   post_3y, group_1y /     products (Matthew's ladder, 2026-10-26:
//   group_2y / group_3y     1 year $855/$1,140 = 5% off, 2 years
//                           $1,620/$2,160 = 10% off, 3 years
//                           $2,295/$3,060 = 15% off the monthly×term
//                           totals; prices live ON the Post/Group
//                           products so portal switching groups
//                           cleanly). The webhook maps every term
//                           kind to its base tier, and referral
//                           accrual counts paid months from the
//                           price's interval (12 × interval_count).
//   support                 Support Plan subscription ($199/year) —
//                           a standalone add-on ANY account can buy
//                           (Matthew, 2026-10-26: NOT lifetime-gated).
// RETIRED kinds — post_annual / group_annual (the $750/$1,000
// "2 months free" annuals, superseded by the term ladder) and
// lifetime_post / lifetime_group (the Founding Lifetime offer,
// dropped 2026-10-26 before a single sale; multi-year prepaid
// replaces it) — return 400 { error: "no_longer_available" }.
// { action: "lifetime_status" } is kept for compatibility and now
// always answers available: false (the sold count may still ride
// along). See TIERS.md "Price restructure".
//
// SALES TAX (decided 2026-10-26): sessions carry
// automatic_tax { enabled: true } ONLY when the STRIPE_TAX_ENABLED
// function secret is exactly "true" — Matthew activates Stripe Tax
// and registers West Virginia in the Stripe dashboard first, then
// the secret flips. Until then checkout is byte-identical to before.
//
// BILLING-CYCLE RULE (Matthew, 2026-10-26): the monthly charge must
// recur on the SAME day of the month the subscription starts. That is
// Stripe's DEFAULT billing-cycle anchor, so this function deliberately
// does NOT pass billing_cycle_anchor or any anchor/trial settings —
// the subscription starts the day checkout completes and renews on
// that day each month.
//
// FINAL-SALE CONSENT (Matthew, 2026-10-26): ALL sales are final, no
// refunds, on every plan. The buyer accepts twice — the in-app
// confirm modal records a terms_acceptances row BEFORE this function
// is ever called, and every session here also carries
// consent_collection { terms_of_service: "required" } plus an
// after-submit custom_text line restating the policy. Verified live
// 2026-10-26: Stripe ACCEPTED consent_collection on real sessions
// even though the account's business_profile.terms_of_service_url is
// unset (session read-back: terms_of_service "required"). As
// insurance — and because the Stripe connector cannot write account
// settings — a refused session is retried ONCE without
// consent_collection (custom_text stays) and the omission is logged.
// Setting the Terms/Privacy URLs in the Stripe dashboard is still
// recommended so Checkout's Terms link points at AutoLaunch's own
// terms page. See TIERS.md "Refund policy".
//
// Config comes from function secrets only (never the app, never code):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_POST, STRIPE_PRICE_GROUP,
//   STRIPE_PRICE_POST_1Y, STRIPE_PRICE_POST_2Y, STRIPE_PRICE_POST_3Y,
//   STRIPE_PRICE_GROUP_1Y, STRIPE_PRICE_GROUP_2Y, STRIPE_PRICE_GROUP_3Y,
//   STRIPE_PRICE_SUPPORT, STRIPE_TAX_ENABLED (optional, see above).
// (The retired STRIPE_PRICE_*_ANNUAL and STRIPE_PRICE_LIFETIME_*
// secrets may still be set on the project — nothing reads them.)
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

// The founding cap was 50 lifetime buyers TOTAL, both tiers combined.
// The offer was retired 2026-10-26 before any sale; the constant
// stays only because lifetime_status still reports it.
const LIFETIME_CAP = 50;

// Kinds that once existed and must now refuse cleanly (the app no
// longer sends them; a stale client gets an honest answer, not a
// session for an archived price).
const RETIRED_PLANS = new Set([
  "post_annual",
  "group_annual",
  "lifetime_post",
  "lifetime_group",
]);

const PLANS: Record<string, { priceEnv: string; mode: string; tier: string | null }> = {
  post: { priceEnv: "STRIPE_PRICE_POST", mode: "subscription", tier: "post" },
  group: { priceEnv: "STRIPE_PRICE_GROUP", mode: "subscription", tier: "group" },
  post_1y: { priceEnv: "STRIPE_PRICE_POST_1Y", mode: "subscription", tier: "post" },
  post_2y: { priceEnv: "STRIPE_PRICE_POST_2Y", mode: "subscription", tier: "post" },
  post_3y: { priceEnv: "STRIPE_PRICE_POST_3Y", mode: "subscription", tier: "post" },
  group_1y: { priceEnv: "STRIPE_PRICE_GROUP_1Y", mode: "subscription", tier: "group" },
  group_2y: { priceEnv: "STRIPE_PRICE_GROUP_2Y", mode: "subscription", tier: "group" },
  group_3y: { priceEnv: "STRIPE_PRICE_GROUP_3Y", mode: "subscription", tier: "group" },
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

// Service-role PostgREST helper (the historical lifetime count,
// still reported by lifetime_status). The service key never leaves
// the function; the query is keyed to a fixed column.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }

  // Founding-offer availability, kept for compatibility: the offer
  // was retired 2026-10-26 (zero sales), so this always answers
  // available: false. The historical sold count may ride along.
  if (body?.action === "lifetime_status") {
    const sold = await countLifetimeBuyers();
    return json({ ok: true, sold, cap: LIFETIME_CAP, available: false });
  }

  const plan = String(body?.plan || "");
  if (RETIRED_PLANS.has(plan)) {
    return json({ ok: false, error: "no_longer_available" }, 400);
  }
  const spec = PLANS[plan];
  if (!spec) {
    return json({ ok: false, error: "invalid_plan" }, 400);
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const priceId = Deno.env.get(spec.priceEnv) || "";
  if (!secretKey || !priceId) {
    return json({ ok: false, error: "billing_not_configured" }, 503);
  }

  // The Support Plan is a standalone add-on: any authenticated
  // account may buy it (Matthew, 2026-10-26). No gate here — the
  // webhook writes only the support fields for kind 'support'.

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
    // Final-sale consent: the buyer must accept the Terms (which
    // carry the no-refund policy) inside Checkout itself, and the
    // after-submit message restates the policy once more. See the
    // header note — consent_collection is dropped on a one-time
    // retry if the account has no Terms URL configured yet.
    "consent_collection[terms_of_service]": "required",
    "custom_text[after_submit][message]":
      "All sales are final — no refunds. Subscriptions can be cancelled anytime in Settings; access continues to the end of the paid period.",
  });
  if (spec.tier) form.set("metadata[plan]", spec.tier);
  if (spec.mode === "subscription") {
    form.set("subscription_data[metadata][user_id]", user.id);
    form.set("subscription_data[metadata][kind]", plan);
    if (spec.tier) form.set("subscription_data[metadata][plan]", spec.tier);
  }
  // Sales-tax scaffold (decided 2026-10-26, see the header note):
  // Stripe Tax computes and collects ONLY once Matthew activates it
  // in the dashboard and the STRIPE_TAX_ENABLED secret is flipped to
  // "true". Unset (the default) → the parameter is never sent and
  // checkout behaves exactly as before.
  if ((Deno.env.get("STRIPE_TAX_ENABLED") || "") === "true") {
    form.set("automatic_tax[enabled]", "true");
  }
  if (user.email) form.set("customer_email", String(user.email));
  // NOTE: no billing_cycle_anchor — Stripe's default anchors the
  // monthly renewal to the subscription's start day, per spec.

  const createSession = async (withConsent: boolean) => {
    const f = new URLSearchParams(form);
    if (!withConsent) f.delete("consent_collection[terms_of_service]");
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: f.toString(),
    });
    const s = await r.json().catch(() => null);
    return { r, s };
  };

  let res: Response;
  let session: any;
  try {
    ({ r: res, s: session } = await createSession(true));
    if ((!res.ok || !session?.url) && session?.error) {
      // Insurance: if Stripe ever refuses the session over
      // consent_collection, retry once without it — custom_text and
      // the in-app recorded acceptance still stand, and checkout is
      // never taken down by a consent error.
      console.warn(
        "billing-checkout: session with consent_collection failed (" +
          (session.error.message || res.status) +
          ") — retrying without consent_collection",
      );
      ({ r: res, s: session } = await createSession(false));
    }
  } catch (e) {
    console.error("billing-checkout: Stripe unreachable: " + e);
    return json({ ok: false, error: "stripe_unreachable" }, 502);
  }
  if (!res.ok || !session?.url) {
    console.error(
      "billing-checkout: Stripe rejected session: " +
        (session?.error?.message || res.status),
    );
    return json({ ok: false, error: "stripe_error" }, 502);
  }
  return json({ ok: true, url: session.url });
});
