// =====================================================================
// billing-checkout — creates a Stripe Checkout Session for:
//   post / group            monthly subscriptions ($75 / $100)
//   post_1y / post_2y /     multi-year prepaid terms on the same two
//   post_3y, group_1y /     products (Matthew's ladder, 2026-10-26:
//   group_2y / group_3y     1 year $855/$1,140 = 5% off, 2 years
//                           $1,620/$2,160 = 10% off, 3 years
//                           $2,295/$3,060 = 15% off the monthly×term
//                           totals). DESIGN CHANGE (Matthew,
//                           2026-10-26 21:26 EDT): the terms are
//                           ONE-TIME purchases (mode "payment",
//                           one-time prices), NOT subscriptions —
//                           so buyers can pay with Affirm/Klarna and
//                           AutoLaunch is paid in full upfront. The
//                           webhook's term-completion branch sets
//                           the access window (stacking period_end)
//                           from metadata {kind, plan, years}; there
//                           is no term subscription and no renewal.
//   support                 Support Plan subscription ($199/year) —
//                           a standalone add-on ANY account can buy
//                           (Matthew, 2026-10-26: NOT lifetime-gated).
//   dealership              Dealership seats (Phase 2, 2026-10-26;
//                           prepaid terms added 2026-10-27): body
//                           { plan: "dealership", dealership_id,
//                           flavor: "post"|"group", seats: 1..50,
//                           term_years?: 0|1|2|3 }. term_years 0 or
//                           absent = the monthly seat subscription
//                           below. term_years 1/2/3 = a ONE-TIME
//                           payment of the FULL term amount up front
//                           (mode "payment", inline price_data on the
//                           flavor's dealer product; total computed
//                           HERE from the canonical seat brackets and
//                           the solo term ladder — 1yr 5% off, 2yr
//                           10% off, 3yr 15% off — never from a
//                           client-supplied amount). The webhook
//                           routes those sessions by metadata.kind
//                           "dealership_term". The caller MUST be an
//                           admin member of that dealership (verified
//                           against dealership_account_members with
//                           the service role). Quantity = seats on
//                           the flavor's VOLUME-tiered price (every
//                           seat billed at the bracket rate for the
//                           total count — Post 1-24 $75 /
//                           25+ $69; Group 1-9 $99 / 10-24 $95 /
//                           25+ $89 — the server enforces the 1..50
//                           range, so the open tier never serves
//                           51+). The Stripe customer belongs to the
//                           DEALERSHIP (created with the admin's
//                           email, stored on the dealership row) —
//                           the webhook routes these subscriptions
//                           by metadata.kind "dealership" and never
//                           touches the admin's personal billing.
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
//   STRIPE_PRICE_SUPPORT, STRIPE_PRICE_DEALER_POST,
//   STRIPE_PRICE_DEALER_GROUP, STRIPE_TAX_ENABLED (optional, above).
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

const PLANS: Record<string, { priceEnv: string; mode: string; tier: string | null; years?: number }> = {
  post: { priceEnv: "STRIPE_PRICE_POST", mode: "subscription", tier: "post" },
  group: { priceEnv: "STRIPE_PRICE_GROUP", mode: "subscription", tier: "group" },
  // Prepaid terms: ONE-TIME prices, payment mode. `years` rides to
  // the webhook in the session metadata — the term grants that many
  // years of access from the (stacked) period end.
  post_1y: { priceEnv: "STRIPE_PRICE_POST_1Y", mode: "payment", tier: "post", years: 1 },
  post_2y: { priceEnv: "STRIPE_PRICE_POST_2Y", mode: "payment", tier: "post", years: 2 },
  post_3y: { priceEnv: "STRIPE_PRICE_POST_3Y", mode: "payment", tier: "post", years: 3 },
  group_1y: { priceEnv: "STRIPE_PRICE_GROUP_1Y", mode: "payment", tier: "group", years: 1 },
  group_2y: { priceEnv: "STRIPE_PRICE_GROUP_2Y", mode: "payment", tier: "group", years: 2 },
  group_3y: { priceEnv: "STRIPE_PRICE_GROUP_3Y", mode: "payment", tier: "group", years: 3 },
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


// ---- Dealership checkout helpers (Phase 2) -------------------------
// Raw PostgREST with the service key, same pattern as
// countLifetimeBuyers above — this function deliberately carries no
// supabase-js import.
async function svcRest(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !svc) return { ok: false, status: 0, data: null };
  try {
    const headers: Record<string, string> = {
      "apikey": svc,
      "Authorization": `Bearer ${svc}`,
    };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method: init?.method || "GET",
      headers,
      body,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// A minimal Stripe form POST (customers are the only non-session
// call this function makes).
async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
): Promise<any | null> {
  try {
    const res = await fetch("https://api.stripe.com/v1" + path, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        "billing-checkout: Stripe POST " + path + " failed: " +
          (out?.error?.message || res.status),
      );
      return null;
    }
    return out;
  } catch (e) {
    console.error("billing-checkout: Stripe POST " + path + " threw: " + e);
    return null;
  }
}

const DEALER_FLAVOR_PRICE_ENV: Record<string, string> = {
  post: "STRIPE_PRICE_DEALER_POST",
  group: "STRIPE_PRICE_DEALER_GROUP",
};
const DEALER_MAX_SEATS = 50;

// Canonical dealership seat pricing (Phase 2 numbers, Matthew
// 2026-10-26; Post 1-9 amended $79 -> $75 on 2026-10-27 — solo
// parity, Matthew): EVERY seat bills at the bracket rate for the total
// seat count. This table is the server-side source of truth for the
// prepaid-term totals below — it mirrors the app's
// DEALER_PRICE_TIERS and the volume tiers on the Stripe prices.
const DEALER_SEAT_BRACKETS: Record<string, Array<[number, number]>> = {
  post: [[9, 75], [24, 75], [50, 69]],
  group: [[9, 99], [24, 95], [50, 89]],
};
// The solo multi-year ladder (Matthew, 2026-10-26), applied to
// dealership terms unchanged: 1yr 5% off, 2yr 10%, 3yr 15%.
const DEALER_TERM_DISCOUNT_PCT: Record<number, number> = {
  1: 5,
  2: 10,
  3: 15,
};

function dealerSeatRateDollars(flavor: string, seats: number): number {
  const brackets = DEALER_SEAT_BRACKETS[flavor] || DEALER_SEAT_BRACKETS.group;
  for (const [upTo, rate] of brackets) {
    if (seats <= upTo) return rate;
  }
  return brackets[brackets.length - 1][1];
}

// Full up-front term total, in cents:
//   perSeat × seats × 12 × years × (1 − discount).
// monthlyDollars × 12 × years × (100 − pct) is already the cent
// amount (dollars × 100 × (100 − pct)/100), and every factor is an
// integer, so the result is always exact — e.g. 10 Group seats for
// 1 year: $950 × 12 × 95 = 1,083,000¢ = $10,830.00.
function dealerTermTotalCents(
  flavor: string,
  seats: number,
  years: number,
): number {
  const monthlyDollars = dealerSeatRateDollars(flavor, seats) * seats;
  return monthlyDollars * 12 * years * (100 - DEALER_TERM_DISCOUNT_PCT[years]);
}

// A minimal Stripe GET (the term flow reads the flavor's monthly
// price to reuse its product for inline price_data).
async function stripeGet(
  secretKey: string,
  path: string,
): Promise<any | null> {
  try {
    const res = await fetch("https://api.stripe.com/v1" + path, {
      headers: { "Authorization": "Bearer " + secretKey },
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        "billing-checkout: Stripe GET " + path + " failed: " +
          (out?.error?.message || res.status),
      );
      return null;
    }
    return out;
  } catch (e) {
    console.error("billing-checkout: Stripe GET " + path + " threw: " + e);
    return null;
  }
}

// Create the Checkout Session for a fully-built form, with the
// final-sale consent insurance: if Stripe ever refuses the session
// over consent_collection, retry ONCE without it (custom_text and
// the in-app recorded acceptance still stand) and log the omission.
// Shared by the solo plans and the dealership kind.
async function finishCheckout(
  secretKey: string,
  form: URLSearchParams,
): Promise<Response> {
  const attempt = async (withConsent: boolean) => {
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
    ({ r: res, s: session } = await attempt(true));
    if ((!res.ok || !session?.url) && session?.error) {
      console.warn(
        "billing-checkout: session with consent_collection failed (" +
          (session.error.message || res.status) +
          ") \u2014 retrying without consent_collection",
      );
      ({ r: res, s: session } = await attempt(false));
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

  // ---------------------------------------------------------------
  // Dealership seats (Phase 2). Everything about this purchase
  // hangs off the DEALERSHIP, not the buyer's personal billing:
  // admin membership is verified server-side, the seat count is
  // range-checked (1..50), the Stripe customer is the dealership's
  // own (created on first purchase with the admin's email), and
  // the session/subscription metadata carries kind "dealership" +
  // dealership_id + flavor for the webhook.
  if (plan === "dealership") {
    const dealershipId = String(body?.dealership_id || "");
    const flavor = String(body?.flavor || "");
    const seats = Number(body?.seats);
    // Prepaid term selector: 0/absent = monthly subscription;
    // 1/2/3 = that many years billed in full up front.
    const termYears = Number(body?.term_years ?? body?.years ?? 0);
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(dealershipId)) {
      return json({ ok: false, error: "invalid_dealership" }, 400);
    }
    if (flavor !== "post" && flavor !== "group") {
      return json({ ok: false, error: "invalid_flavor" }, 400);
    }
    if (!Number.isInteger(seats) || seats < 1 || seats > DEALER_MAX_SEATS) {
      return json({ ok: false, error: "invalid_seats" }, 400);
    }
    if (![0, 1, 2, 3].includes(termYears)) {
      return json({ ok: false, error: "invalid_term" }, 400);
    }
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const priceId = Deno.env.get(DEALER_FLAVOR_PRICE_ENV[flavor]) || "";
    if (!secretKey || !priceId) {
      return json({ ok: false, error: "billing_not_configured" }, 503);
    }
    const mem = await svcRest(
      "dealership_account_members?user_id=eq." + user.id +
        "&dealership_id=eq." + dealershipId + "&select=role",
    );
    const memRow = Array.isArray(mem.data) ? mem.data[0] : null;
    if (!mem.ok || !memRow || memRow.role !== "admin") {
      return json({ ok: false, error: "not_dealer_admin" }, 403);
    }
    const dres = await svcRest(
      "dealership_accounts?id=eq." + dealershipId +
        "&select=id,name,status,stripe_customer_id",
    );
    const dealer = Array.isArray(dres.data) ? dres.data[0] : null;
    if (!dres.ok || !dealer) {
      return json({ ok: false, error: "dealership_not_found" }, 404);
    }
    let customerId = dealer.stripe_customer_id
      ? String(dealer.stripe_customer_id)
      : "";
    if (!customerId) {
      const cust = await stripePost(secretKey, "/customers", {
        ...(user.email ? { email: String(user.email) } : {}),
        name: String(dealer.name || "AutoLaunch dealership"),
        "metadata[dealership_id]": dealershipId,
        description: "AutoLaunch dealership account",
      });
      if (!cust?.id) return json({ ok: false, error: "stripe_error" }, 502);
      customerId = String(cust.id);
      await svcRest("dealership_accounts?id=eq." + dealershipId, {
        method: "PATCH",
        body: { stripe_customer_id: customerId },
      });
    }
    const appUrl = appReturnUrl(req);
    const form = new URLSearchParams({
      "customer": customerId,
      "success_url": appUrl + "?checkout=success",
      "cancel_url": appUrl + "?checkout=cancel",
      "client_reference_id": user.id,
      "metadata[user_id]": user.id,
      "metadata[dealership_id]": dealershipId,
      "metadata[flavor]": flavor,
      "consent_collection[terms_of_service]": "required",
    });
    if (termYears > 0) {
      // Prepaid term: ONE-TIME payment of the full term amount,
      // computed server-side above. The line item rides on the
      // flavor's existing dealer product (read off its monthly
      // price) via inline price_data — no new Stripe prices, and
      // the amount can never be influenced by the client.
      const price = await stripeGet(
        secretKey,
        "/prices/" + encodeURIComponent(priceId),
      );
      const productId = typeof price?.product === "string"
        ? price.product
        : (price?.product?.id ? String(price.product.id) : "");
      if (!productId) {
        return json({ ok: false, error: "stripe_error" }, 502);
      }
      form.set("mode", "payment");
      form.set("line_items[0][quantity]", "1");
      form.set("line_items[0][price_data][currency]", "usd");
      form.set(
        "line_items[0][price_data][unit_amount]",
        String(dealerTermTotalCents(flavor, seats, termYears)),
      );
      form.set("line_items[0][price_data][product]", productId);
      form.set("metadata[kind]", "dealership_term");
      form.set("metadata[seats]", String(seats));
      form.set("metadata[years]", String(termYears));
      form.set(
        "custom_text[after_submit][message]",
        "All sales are final \u2014 no refunds. This is a one-time payment for the full term; it does not renew automatically.",
      );
      // NOTE: no subscription_data — a term purchase creates no
      // subscription. The webhook grants the paid-through window.
    } else {
      form.set("mode", "subscription");
      form.set("line_items[0][price]", priceId);
      form.set("line_items[0][quantity]", String(seats));
      form.set("metadata[kind]", "dealership");
      form.set("subscription_data[metadata][user_id]", user.id);
      form.set("subscription_data[metadata][kind]", "dealership");
      form.set("subscription_data[metadata][dealership_id]", dealershipId);
      form.set("subscription_data[metadata][flavor]", flavor);
      form.set(
        "custom_text[after_submit][message]",
        "All sales are final \u2014 no refunds. Subscriptions can be cancelled anytime in Settings; access continues to the end of the paid period.",
      );
    }
    if ((Deno.env.get("STRIPE_TAX_ENABLED") || "") === "true") {
      form.set("automatic_tax[enabled]", "true");
    }
    // NOTE: no billing_cycle_anchor — same rule as the solo plans.
    return await finishCheckout(secretKey, form);
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
  if (spec.years) form.set("metadata[years]", String(spec.years));
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

  return await finishCheckout(secretKey, form);
});
