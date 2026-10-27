// =====================================================================
// billing-webhook — Stripe → AutoLaunch subscription sync
// (2026-10-26, see TIERS.md "Trial + Billing").
//
// No JWT: authenticity comes from the Stripe signature, verified
// against STRIPE_WEBHOOK_SECRET. If that secret (or STRIPE_SECRET_KEY)
// is not set, the function returns 503 and processes NOTHING — there
// is deliberately no accept-and-log mode, so a half-configured
// endpoint can never half-process payments.
//
// SETUP (once Matthew connects Stripe): register this function's URL
// as a webhook endpoint in the Stripe dashboard for the events
//   checkout.session.completed
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.paid
//   charge.refunded
// (the last two were added 2026-10-26 for the referral program) and
// store the endpoint's signing secret as STRIPE_WEBHOOK_SECRET.
//
// Handled events (all writes via the service role). Routing is by the
// `kind` metadata billing-checkout stamps on every session and
// subscription: post / group (monthly plan subscriptions),
// post_1y / post_2y / post_3y and group_1y / group_2y / group_3y
// (multi-year prepaid terms — ONE-TIME payments since the
// 2026-10-26 design change: no subscription exists; completion
// extends current_period_end by the term's years, stacking), support (the
// $199/year Support Plan — a standalone add-on any account can buy,
// Matthew 2026-10-26). RETIRED kinds: post_annual / group_annual
// (superseded annuals) and lifetime_post / lifetime_group (Founding
// Lifetime, dropped 2026-10-26 before any sale) — billing-checkout
// refuses to create them now; the lifetime branches below remain
// only as harmless history for events that can no longer occur:
//   checkout.session.completed, kind post/group → billing_status
//     'active', plan_tier from the session metadata plan, stripe ids
//     + current_period_end stored. The subscription itself carries
//     the user_id/plan in its metadata too (set by billing-checkout).
//   checkout.session.completed, kind lifetime_* → billing_status
//     'active' PERMANENTLY for that tier: plan_tier + lifetime_tier
//     set, lifetime_purchased_at stamped, stripe_customer_id stored.
//     NO subscription fields — a lifetime account's
//     current_period_end stays NULL forever and nothing may expire it.
//   checkout.session.completed, kind support → ONLY the support
//     fields (support_plan_status / support_period_end) plus the
//     Stripe customer id are written — the customer id is what gives
//     a support-only buyer their Billing Portal path; billing_status
//     and plan_tier are never touched by a support event.
//   customer.subscription.updated / deleted → for kind 'support'
//     subscriptions, ONLY the support fields are written — a support
//     subscription event can never touch billing_status or plan_tier
//     (a lifetime account cancelling support stays active forever).
//     For plan subscriptions: status sync — active/trialing →
//     'active'; past_due → stays 'active' (card problem, Stripe is
//     retrying — access is not cut); canceled → 'expired' with
//     current_period_end recorded. A price change that matches
//     STRIPE_PRICE_POST / STRIPE_PRICE_GROUP also updates plan_tier.
//     deleted → billing_status 'expired' (this fires when a portal
//     cancellation reaches the end of the paid period — so cancelling
//     keeps access until then). EXCEPTION: if the account's row
//     carries a lifetime_tier, plan-subscription events never move
//     billing_status at all — the lifetime purchase outranks any
//     leftover monthly subscription (e.g. one the buyer cancels after
//     upgrading to lifetime).
//   DEALERSHIP subscriptions (Phase 2, 2026-10-26) route by kind
//   "dealership" and write ONLY dealership_accounts — never the
//   admin's user_settings: checkout.session.completed flips the
//   dealership to status 'active' with seat_limit = the
//   subscription quantity, plan_flavor from the session metadata,
//   and the Stripe ids + current_period_end stored;
//   customer.subscription.updated re-syncs seats/flavor/period
//   (past_due keeps access, billing_status notes it);
//   customer.subscription.deleted (or a canceled status) expires
//   the dealership. Dealership invoices NEVER accrue referral
//   bonuses: kind "dealership" is not a solo plan kind, so
//   handleInvoicePaid returns before any accrual.
//   invoice.paid → REFERRAL ACCRUAL (see TIERS.md "Referrals"): when
//     the payer is a claimed referee on a solo plan kind, their paid
//     months advance by the PRICE's interval (a monthly price +1;
//     the interval math remains for any yearly price) with the
//     eligibility window capped at 12; prepaid TERM purchases have
//     no invoice — they accrue at checkout.session.completed
//     instead (12 × years, ledger-keyed by the session id). Every
//     completed block of 3 paid months grants the
//     referrer one free month as STRIPE CUSTOMER BALANCE at the
//     referrer's own monthly price (Group $100, otherwise $75) — max
//     4 free months per referral. Idempotent per invoice via the
//     referral_invoices ledger: a redelivered event never
//     double-counts. Dealership-covered referees generate no solo
//     invoices, so they never accrue — the rule falls out of the
//     event stream rather than a special case.
//   charge.refunded → reverses exactly what the refunded charge's
//     invoice granted: paid months come back off, and granted bonus
//     months are revoked by a positive balance transaction up to the
//     credit still unapplied on the referrer's customer (any part
//     already consumed is logged as a shortfall on the ledger row —
//     see the limitation note in TIERS.md).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "stripe-signature, content-type",
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

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verify a Stripe webhook signature header (t=…,v1=…). Returns true
// only if some v1 matches HMAC_SHA256(secret, `${t}.${rawBody}`) and
// the timestamp is within 5 minutes.
async function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  let t = "";
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") t = v;
    if (k === "v1") v1s.push(v);
  }
  if (!t || !v1s.length) return false;
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const expected = await hmacHex(secret, t + "." + rawBody);
  return v1s.some((v1) => timingSafeEqual(v1, expected));
}

async function fetchSubscription(secretKey: string, subId: string) {
  try {
    const res = await fetch(
      "https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subId),
      { headers: { "Authorization": "Bearer " + secretKey } },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function periodEndIso(sub: any): string | null {
  const s = Number(sub?.current_period_end);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null;
}

function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  if (priceId === (Deno.env.get("STRIPE_PRICE_POST") || "")) return "post";
  if (priceId === (Deno.env.get("STRIPE_PRICE_GROUP") || "")) return "group";
  // Multi-year prepaid terms (2026-10-26): every term price maps to
  // its base tier. The retired *_ANNUAL price secrets are no longer
  // consulted — those prices are archived in Stripe.
  for (const term of ["1Y", "2Y", "3Y"]) {
    if (priceId === (Deno.env.get("STRIPE_PRICE_POST_" + term) || "")) return "post";
    if (priceId === (Deno.env.get("STRIPE_PRICE_GROUP_" + term) || "")) return "group";
  }
  return null;
}

// The routing kind: billing-checkout stamps metadata.kind on every
// session AND on every subscription it creates. Session metadata wins
// on checkout events; subscription events read their own metadata.
function kindOf(session: any, sub: any): string {
  return String(session?.metadata?.kind || sub?.metadata?.kind || "");
}

function lifetimeTierOf(kind: string): string | null {
  if (kind === "lifetime_post") return "post";
  if (kind === "lifetime_group") return "group";
  return null;
}

// ---- Dealership routing (Phase 2) -----------------------------------
// The dealership a session/subscription belongs to: checkout stamps
// metadata.dealership_id on both; subscriptions created before a
// metadata fix could still be found by their stored subscription id.
function dealershipIdOf(session: any, sub: any): string {
  return String(
    session?.metadata?.dealership_id || sub?.metadata?.dealership_id || "",
  );
}

function dealerFlavorOf(session: any, sub: any): string | null {
  const f = String(session?.metadata?.flavor || sub?.metadata?.flavor || "");
  if (f === "post" || f === "group") return f;
  const priceId = sub?.items?.data?.[0]?.price?.id || "";
  if (priceId && priceId === (Deno.env.get("STRIPE_PRICE_DEALER_POST") || "")) {
    return "post";
  }
  if (priceId && priceId === (Deno.env.get("STRIPE_PRICE_DEALER_GROUP") || "")) {
    return "group";
  }
  return null;
}

function dealerQuantity(sub: any): number | null {
  const q = Number(sub?.items?.data?.[0]?.quantity);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : null;
}

async function findDealership(svc: any, session: any, sub: any) {
  const did = dealershipIdOf(session, sub);
  if (did) {
    const { data } = await svc
      .from("dealership_accounts")
      .select("id")
      .eq("id", did)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }
  if (sub?.id) {
    const { data } = await svc
      .from("dealership_accounts")
      .select("id")
      .eq("stripe_subscription_id", sub.id)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }
  return null;
}

async function handleDealershipCheckout(svc: any, session: any, sub: any) {
  const did = await findDealership(svc, session, sub);
  if (!did) {
    console.error("billing-webhook: dealership checkout, dealership not resolvable");
    return;
  }
  const update: Record<string, unknown> = {
    status: "active",
    billing_status: "active",
    plan_flavor: dealerFlavorOf(session, sub),
    stripe_customer_id: session.customer ? String(session.customer) : null,
    stripe_subscription_id: sub?.id ? String(sub.id) : null,
    current_period_end: periodEndIso(sub),
  };
  const qty = dealerQuantity(sub);
  if (qty !== null) update.seat_limit = qty;
  const { error } = await svc
    .from("dealership_accounts")
    .update(update)
    .eq("id", did);
  if (error) throw error;
}

async function handleDealershipSubscription(svc: any, sub: any, deleted: boolean) {
  const did = await findDealership(svc, null, sub);
  if (!did) {
    console.error("billing-webhook: dealership subscription event, dealership not resolvable");
    return;
  }
  const update: Record<string, unknown> = {
    stripe_subscription_id: sub.id || null,
    current_period_end: periodEndIso(sub),
  };
  const flavor = dealerFlavorOf(null, sub);
  if (flavor) update.plan_flavor = flavor;
  const qty = dealerQuantity(sub);
  if (qty !== null && !deleted) update.seat_limit = qty;
  if (deleted || sub.status === "canceled") {
    update.status = "expired";
    update.billing_status = "expired";
  } else if (sub.status === "past_due") {
    // Card problem, Stripe is retrying: access stays, note the state.
    console.log("billing-webhook: dealership subscription past_due for " + did);
    update.billing_status = "past_due";
  } else if (sub.status === "active" || sub.status === "trialing") {
    update.status = "active";
    update.billing_status = "active";
  }
  const { error } = await svc
    .from("dealership_accounts")
    .update(update)
    .eq("id", did);
  if (error) throw error;
}

function supportStatusOf(subStatus: string | undefined, deleted: boolean): string {
  if (deleted) return "canceled";
  if (subStatus === "active" || subStatus === "trialing") return "active";
  if (subStatus === "past_due") return "past_due";
  return "canceled";
}

// Resolve which AutoLaunch user a subscription belongs to: its own
// metadata (set at checkout) first, then the stored subscription id,
// then the stored customer id.
async function findUserId(svc: any, sub: any, session?: any): Promise<string | null> {
  const metaUser = sub?.metadata?.user_id || session?.metadata?.user_id ||
    session?.client_reference_id;
  if (metaUser) return String(metaUser);
  if (sub?.id) {
    const { data } = await svc
      .from("user_settings")
      .select("user_id")
      .eq("stripe_subscription_id", sub.id)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }
  const customerId = sub?.customer || session?.customer;
  if (customerId) {
    const { data } = await svc
      .from("user_settings")
      .select("user_id")
      .eq("stripe_customer_id", String(customerId))
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }
  return null;
}

// =====================================================================
// Referral accrual — Matthew's program (TIERS.md "Referrals"):
// paid_months counts 1 per monthly payment, 12 per annual payment;
// bonus_due = min(4, floor(paid_months / 3)); accrual only while the
// referee is under 12 paid months and only from bonus-eligible rows.
// One formula covers the monthly path and the year-up-front path.
// =====================================================================

const SOLO_PLAN_KINDS = [
  "post", "group",
  "post_1y", "post_2y", "post_3y",
  "group_1y", "group_2y", "group_3y",
];

// Prepaid terms (design change 2026-10-26): the term kinds are
// ONE-TIME purchases. A completed term checkout grants `years` of
// access by extending current_period_end — stacked on top of any
// time already remaining (early re-buys extend, never restart).
const TERM_YEARS: Record<string, number> = {
  post_1y: 1, post_2y: 2, post_3y: 3,
  group_1y: 1, group_2y: 2, group_3y: 3,
};

function addYearsISO(baseMs: number, years: number): string {
  const d = new Date(baseMs);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}
const REFERRAL_PAID_MONTH_CAP = 12;
const REFERRAL_BONUS_CAP = 4;

// Paid months a price represents on an invoice — PRICE-INTERVAL-
// DRIVEN (2026-10-26): the invoice line's expanded price object
// carries `recurring: { interval, interval_count }`; a monthly
// price counts its interval_count (1), a yearly price counts
// 12 × interval_count (1y → 12, 2y → 24, 3y → 36). Anything else
// (support, add-ons, unknown prices) counts 0 — a 0 means this
// invoice can never be a referral payment. Fallback, for payloads
// whose line price is NOT expanded (no `recurring` object): match
// the price id against the configured plan prices — monthly ids →
// 1, term ids → 12/24/36, and the RETIRED annual ids → 12 (an
// in-flight legacy annual subscription, if one ever existed, would
// still count its year; those prices are archived, so this is
// belt-and-braces only).
function paidMonthsForPrice(price: any): number {
  if (!price) return 0;
  const rec = typeof price === "object" ? price.recurring : null;
  if (rec && typeof rec.interval === "string") {
    const count = Number(rec.interval_count) || 1;
    if (rec.interval === "month") return count;
    if (rec.interval === "year") return 12 * count;
    return 0;
  }
  const priceId = typeof price === "string" ? price : price.id;
  if (!priceId) return 0;
  if (
    priceId === (Deno.env.get("STRIPE_PRICE_POST") || "") ||
    priceId === (Deno.env.get("STRIPE_PRICE_GROUP") || "")
  ) return 1;
  const terms: Array<[string, number]> = [
    ["STRIPE_PRICE_POST_1Y", 12], ["STRIPE_PRICE_GROUP_1Y", 12],
    ["STRIPE_PRICE_POST_2Y", 24], ["STRIPE_PRICE_GROUP_2Y", 24],
    ["STRIPE_PRICE_POST_3Y", 36], ["STRIPE_PRICE_GROUP_3Y", 36],
    ["STRIPE_PRICE_POST_ANNUAL", 12], ["STRIPE_PRICE_GROUP_ANNUAL", 12],
  ];
  for (const [env, months] of terms) {
    if (priceId === (Deno.env.get(env) || "")) return months;
  }
  return 0;
}

// A free month is worth the REFERRER's own monthly price: Group
// (plan or lifetime) $100, anything else $75 (Post monthly value;
// annual buyers' credit is denominated in months of their plan).
function referrerMonthlyCents(row: any): number {
  const tier = row?.lifetime_tier || row?.plan_tier || "";
  return tier === "group" ? 10000 : 7500;
}

// Minimal Stripe API caller for the customer-balance writes (the
// subscription fetch above is GET-only and bespoke).
async function stripeCall(
  secretKey: string,
  method: string,
  path: string,
  form?: Record<string, string>,
): Promise<any | null> {
  try {
    const init: RequestInit = {
      method,
      headers: { "Authorization": "Bearer " + secretKey },
    };
    if (form) {
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    const res = await fetch("https://api.stripe.com/v1" + path, init);
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        "billing-webhook: Stripe " + method + " " + path + " failed: " +
          (out?.error?.message || res.status),
      );
      return null;
    }
    return out;
  } catch (e) {
    console.error("billing-webhook: Stripe " + method + " " + path + " threw: " + e);
    return null;
  }
}

// The referrer's Stripe customer: the stored id when there is one;
// otherwise create the customer (email from the Auth record) and
// store the id, so a credit is never lost for want of a customer.
async function ensureReferrerCustomer(
  svc: any,
  secretKey: string,
  referrerId: string,
  row: any,
): Promise<string | null> {
  if (row?.stripe_customer_id) return String(row.stripe_customer_id);
  let email = "";
  try {
    const { data } = await svc.auth.admin.getUserById(referrerId);
    email = String(data?.user?.email || "");
  } catch { /* fall through — customer can exist without an email */ }
  const cust = await stripeCall(secretKey, "POST", "/customers", {
    ...(email ? { email } : {}),
    "metadata[user_id]": referrerId,
    description: "AutoLaunch account (created for referral credit)",
  });
  if (!cust?.id) return null;
  await svc
    .from("user_settings")
    .upsert(
      { user_id: referrerId, stripe_customer_id: String(cust.id) },
      { onConflict: "user_id" },
    );
  return String(cust.id);
}

async function handleInvoicePaid(svc: any, secretKey: string, invoice: any) {
  const invoiceId = String(invoice?.id || "");
  const subId = typeof invoice?.subscription === "string" ? invoice.subscription : "";
  if (!invoiceId || !subId) return; // one-time payments have no subscription
  const sub = await fetchSubscription(secretKey, subId);
  if (!SOLO_PLAN_KINDS.includes(kindOf(null, sub))) return; // support etc.
  const refereeId = await findUserId(svc, sub, null);
  if (!refereeId) {
    console.error("billing-webhook: invoice.paid, user not resolvable for " + invoiceId);
    return;
  }
  const { data: ref } = await svc
    .from("referrals")
    .select("*")
    .eq("referee_user_id", refereeId)
    .maybeSingle();
  if (!ref) return; // not a referred account — nothing accrues

  // The invoice line's price object first (expanded prices carry
  // the recurring interval that drives the month count); the
  // subscription item's price object as the fallback source.
  const priceObj = invoice.lines?.data?.[0]?.price ||
    sub.items?.data?.[0]?.price || null;
  await accrueReferralMonths(
    svc, secretKey, ref, refereeId, paidMonthsForPrice(priceObj), invoiceId,
  );
}

// Shared accrual core (invoice path above; prepaid-term checkout
// completions below): claims the ledger key FIRST (the invoice id,
// or the checkout session id for a term purchase — the PK makes any
// redelivery a no-op), then advances the referee's paid months by
// rawMonths (window-capped at REFERRAL_PAID_MONTH_CAP) and grants
// any newly due bonus months as referrer customer balance.
async function accrueReferralMonths(
  svc: any,
  secretKey: string,
  ref: any,
  refereeId: string,
  rawMonths: number,
  ledgerKey: string,
) {
  // Claim the ledger key FIRST: a PK conflict means a redelivery of
  // an event already processed — never double-count.
  const { error: claimErr } = await svc.from("referral_invoices").insert({
    invoice_id: ledgerKey,
    referral_id: ref.id,
    referee_user_id: refereeId,
  });
  if (claimErr) {
    if (String(claimErr.code || "").includes("23505")) return;
    throw claimErr;
  }

  let monthsAdded = 0;
  let delta = 0;
  let creditCents = 0;
  let creditTxnId: string | null = null;
  try {
    const months = rawMonths;
    if (ref.bonus_eligible && months > 0) {
      const room = Math.max(0, REFERRAL_PAID_MONTH_CAP - (ref.referee_paid_months || 0));
      monthsAdded = Math.min(months, room);
      const newMonths = (ref.referee_paid_months || 0) + monthsAdded;
      const bonusDue = Math.min(
        REFERRAL_BONUS_CAP,
        Math.floor(newMonths / 3),
      );
      delta = Math.max(0, bonusDue - (ref.bonuses_granted || 0));
      if (delta > 0) {
        const { data: rrow } = await svc
          .from("user_settings")
          .select("plan_tier, lifetime_tier, stripe_customer_id")
          .eq("user_id", ref.referrer_user_id)
          .maybeSingle();
        creditCents = delta * referrerMonthlyCents(rrow);
        const custId = await ensureReferrerCustomer(
          svc, secretKey, ref.referrer_user_id, rrow,
        );
        const txn = custId
          ? await stripeCall(
            secretKey, "POST",
            "/customers/" + encodeURIComponent(custId) + "/balance_transactions",
            {
              amount: String(-creditCents),
              currency: "usd",
              description: "AutoLaunch referral bonus — free month credit",
            },
          )
          : null;
        if (txn?.id) {
          creditTxnId = String(txn.id);
        } else {
          // The credit didn't land — don't count the bonus. The
          // months still count, so a later payment re-derives the
          // same due bonus and retries the grant.
          console.error(
            "billing-webhook: referral credit failed for referrer " +
              ref.referrer_user_id + " (ledger " + ledgerKey + ")",
          );
          creditCents = 0;
          delta = 0;
        }
      }
      if (monthsAdded > 0 || delta > 0) {
        const { error: upErr } = await svc
          .from("referrals")
          .update({
            referee_paid_months: newMonths,
            bonuses_granted: (ref.bonuses_granted || 0) + delta,
          })
          .eq("id", ref.id);
        if (upErr) throw upErr;
      }
    }
  } catch (e) {
    // If the credit already landed before the failure, persist the
    // ledger facts so the retry (which will see the claim row and
    // skip) can't double-grant; otherwise release the claim so
    // Stripe's retry reprocesses cleanly.
    if (creditTxnId) {
      await svc.from("referral_invoices").update({
        months_added: monthsAdded,
        bonuses_delta: delta,
        credit_amount_cents: creditCents,
        credit_txn_id: creditTxnId,
      }).eq("invoice_id", ledgerKey);
    } else {
      await svc.from("referral_invoices").delete().eq("invoice_id", ledgerKey);
    }
    throw e;
  }

  const { error: ledErr } = await svc.from("referral_invoices").update({
    months_added: monthsAdded,
    bonuses_delta: delta,
    credit_amount_cents: creditCents,
    credit_txn_id: creditTxnId,
  }).eq("invoice_id", ledgerKey);
  if (ledErr) throw ledErr;
}

async function handleChargeRefunded(svc: any, secretKey: string, charge: any) {
  const invoiceId = typeof charge?.invoice === "string" ? charge.invoice : "";
  if (!invoiceId) return;
  const { data: inv } = await svc
    .from("referral_invoices")
    .select("*")
    .eq("invoice_id", invoiceId)
    .maybeSingle();
  if (!inv || inv.refund_status === "reversed") return;

  let revokedCents = 0;
  let note: string | null = null;
  if ((inv.months_added || 0) > 0 || (inv.bonuses_delta || 0) > 0) {
    const { data: ref } = await svc
      .from("referrals")
      .select("*")
      .eq("id", inv.referral_id)
      .maybeSingle();
    if (ref) {
      const newMonths = Math.max(
        0,
        (ref.referee_paid_months || 0) - (inv.months_added || 0),
      );
      const bonusDue = Math.min(REFERRAL_BONUS_CAP, Math.floor(newMonths / 3));
      const revokeMonths = Math.max(
        0,
        Math.min(inv.bonuses_delta || 0, (ref.bonuses_granted || 0) - bonusDue),
      );
      if (revokeMonths > 0 && (inv.credit_amount_cents || 0) > 0) {
        const perMonth = Math.floor(
          inv.credit_amount_cents / Math.max(1, inv.bonuses_delta || 1),
        );
        const intended = perMonth * revokeMonths;
        const { data: rrow } = await svc
          .from("user_settings")
          .select("stripe_customer_id")
          .eq("user_id", ref.referrer_user_id)
          .maybeSingle();
        const custId = rrow?.stripe_customer_id
          ? String(rrow.stripe_customer_id)
          : null;
        const cust = custId
          ? await stripeCall(
            secretKey, "GET",
            "/customers/" + encodeURIComponent(custId),
          )
          : null;
        // Only the still-unapplied part of the credit can come back:
        // the customer's negative balance is the credit sitting there.
        const sitting = cust ? Math.max(0, -Number(cust.balance || 0)) : 0;
        revokedCents = Math.min(intended, sitting);
        if (revokedCents > 0 && custId) {
          const txn = await stripeCall(
            secretKey, "POST",
            "/customers/" + encodeURIComponent(custId) + "/balance_transactions",
            {
              amount: String(revokedCents),
              currency: "usd",
              description:
                "AutoLaunch referral bonus revoked — referred payment refunded",
            },
          );
          if (!txn?.id) revokedCents = 0;
        }
        if (revokedCents < intended) {
          note = "shortfall: intended " + intended + "c, revoked " +
            revokedCents + "c (remainder already consumed)";
          console.error(
            "billing-webhook: referral refund " + note + " for invoice " +
              invoiceId,
          );
        }
      }
      const { error: upErr } = await svc
        .from("referrals")
        .update({
          referee_paid_months: newMonths,
          bonuses_granted: Math.max(
            0,
            (ref.bonuses_granted || 0) - revokeMonths,
          ),
        })
        .eq("id", ref.id);
      if (upErr) throw upErr;
    }
  }
  const { error } = await svc.from("referral_invoices").update({
    refund_status: "reversed",
    revoked_cents: revokedCents,
    refund_note: note,
  }).eq("invoice_id", invoiceId);
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!webhookSecret || !secretKey) {
    return json({ ok: false, error: "webhook_not_configured" }, 503);
  }

  const rawBody = await req.text();
  const sigOk = await verifyStripeSignature(
    rawBody,
    req.headers.get("stripe-signature") || "",
    webhookSecret,
  );
  if (!sigOk) return json({ ok: false, error: "invalid_signature" }, 400);

  let event: any = null;
  try { event = JSON.parse(rawBody); } catch { /* handled below */ }
  if (!event || !event.type) return json({ ok: false, error: "invalid_event" }, 400);

  const svc = serviceClient();
  const obj = event.data?.object || {};

  try {
    if (event.type === "checkout.session.completed") {
      const subId = typeof obj.subscription === "string" ? obj.subscription : "";
      const sub = subId ? await fetchSubscription(secretKey, subId) : null;
      const kind = kindOf(obj, sub);
      if (kind === "dealership") {
        // Dealership purchase: writes ONLY the dealership row. The
        // admin's personal billing is never touched by a store
        // subscription.
        await handleDealershipCheckout(svc, obj, sub);
        return json({ received: true });
      }
      const userId = await findUserId(svc, sub, obj);
      const lifetimeTier = lifetimeTierOf(kind);
      const plan = obj.metadata?.plan || sub?.metadata?.plan || "";
      if (userId) {
        let update: Record<string, unknown>;
        let handled = false;
        if (TERM_YEARS[kind]) {
          // Prepaid term purchase (ONE-TIME payment — no
          // subscription exists). Grant: billing active at the
          // term's tier, current_period_end = max(existing end,
          // now) + years (re-buys STACK). stripe_subscription_id is
          // deliberately untouched. Two side effects, both
          // fail-soft after the grant lands:
          //  - SWITCH RULE: a monthly subscriber moving to a term
          //    keeps their subscription only until its current
          //    period ends (cancel_at_period_end) — the term
          //    already covers them from today.
          //  - REFERRALS: no subscription invoice exists, so
          //    accrual happens here, keyed by the SESSION id.
          const years = TERM_YEARS[kind];
          const { data: trow } = await svc
            .from("user_settings")
            .select("current_period_end, stripe_subscription_id, stripe_customer_id")
            .eq("user_id", userId)
            .maybeSingle();
          const nowMs = Date.now();
          const existingEnd = trow?.current_period_end
            ? Date.parse(trow.current_period_end)
            : NaN;
          const baseMs = Number.isFinite(existingEnd) && existingEnd > nowMs
            ? existingEnd
            : nowMs;
          update = {
            user_id: userId,
            billing_status: "active",
            plan_tier: kind.startsWith("group") ? "group" : "post",
            current_period_end: addYearsISO(baseMs, years),
            stripe_customer_id: obj.customer
              ? String(obj.customer)
              : (trow?.stripe_customer_id ?? null),
          };
          const { error } = await svc
            .from("user_settings")
            .upsert(update, { onConflict: "user_id" });
          if (error) throw error;
          handled = true;
          const existingSubId = trow?.stripe_subscription_id || "";
          if (existingSubId) {
            const cx = await stripeCall(
              secretKey, "POST",
              "/subscriptions/" + encodeURIComponent(existingSubId),
              { cancel_at_period_end: "true" },
            );
            if (!cx) {
              console.error(
                "billing-webhook: term switch — cancel_at_period_end failed for sub " +
                  existingSubId + " (user " + userId + ")",
              );
            }
          }
          try {
            const { data: ref } = await svc
              .from("referrals")
              .select("*")
              .eq("referee_user_id", userId)
              .maybeSingle();
            if (ref) {
              await accrueReferralMonths(
                svc, secretKey, ref, userId, 12 * years, String(obj.id || ""),
              );
            }
          } catch (e) {
            console.error("billing-webhook: term referral accrual failed: " + e);
          }
        } else if (lifetimeTier) {
          // Founding Lifetime: active forever at the bought tier.
          // Deliberately NO subscription fields — stripe_subscription_id
          // and current_period_end stay whatever they were (NULL for a
          // fresh account) and nothing downstream may expire the row.
          update = {
            user_id: userId,
            billing_status: "active",
            plan_tier: lifetimeTier,
            lifetime_tier: lifetimeTier,
            lifetime_purchased_at: new Date().toISOString(),
            stripe_customer_id: obj.customer ? String(obj.customer) : null,
          };
        } else if (kind === "support") {
          // Support Plan purchase (a standalone add-on any account
          // can buy): the support fields ONLY, plus the Stripe
          // customer id — a support-only buyer needs it for the
          // Billing Portal manage path. billing_status / plan_tier
          // are never touched by a support purchase.
          update = {
            user_id: userId,
            support_plan_status: "active",
            support_period_end: periodEndIso(sub),
            stripe_customer_id: obj.customer ? String(obj.customer) : null,
          };
        } else {
          update = {
            user_id: userId,
            billing_status: "active",
            stripe_customer_id: obj.customer ? String(obj.customer) : null,
            stripe_subscription_id: subId || null,
            current_period_end: periodEndIso(sub),
          };
          if (plan === "post" || plan === "group") update.plan_tier = plan;
        }
        if (!handled) {
          const { error } = await svc
            .from("user_settings")
            .upsert(update, { onConflict: "user_id" });
          if (error) throw error;
        }
      } else {
        console.error("billing-webhook: checkout completed, user not resolvable");
      }
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = obj;
      const deleted = event.type === "customer.subscription.deleted";
      if (kindOf(null, sub) === "dealership") {
        await handleDealershipSubscription(svc, sub, deleted);
        return json({ received: true });
      }
      const userId = await findUserId(svc, sub);
      if (userId) {
        if (kindOf(null, sub) === "support") {
          // Support Plan subscription: support fields ONLY, whatever
          // the event. billing_status / plan_tier are never touched —
          // cancelling support can never cost a lifetime account its
          // access.
          const { error } = await svc
            .from("user_settings")
            .upsert({
              user_id: userId,
              support_plan_status: supportStatusOf(sub.status, deleted),
              support_period_end: periodEndIso(sub),
            }, { onConflict: "user_id" });
          if (error) throw error;
        } else {
          // Plan subscription. Two protections outrank it:
          //  - a lifetime account (historical): a leftover monthly
          //    subscription's lifecycle must never expire the row;
          //  - a TERM-PROTECTED row: the account holds prepaid term
          //    time beyond anything this subscription granted (the
          //    monthly sub a term buyer switched away from is
          //    cancelled at period end, and its eventual deletion
          //    must not expire the term or overwrite its end date).
          const { data: row } = await svc
            .from("user_settings")
            .select("lifetime_tier, current_period_end")
            .eq("user_id", userId)
            .maybeSingle();
          // Protection test: the row holds time THIS subscription
          // never granted (a stacked term end far beyond the sub's
          // own end). An ordinary subscriber's row end EQUALS their
          // sub's end, so their deletion still expires them exactly
          // as before — mid-period or at period end alike.
          const rowEndMs = row?.current_period_end
            ? Date.parse(row.current_period_end)
            : NaN;
          const subEndIso = periodEndIso(sub);
          const subEndMs = subEndIso ? Date.parse(subEndIso) : NaN;
          const termProtected = Number.isFinite(rowEndMs) &&
            (Number.isFinite(subEndMs)
              ? rowEndMs > subEndMs + 60000
              : rowEndMs > Date.now() + 60000);
          const update: Record<string, unknown> = {
            user_id: userId,
            stripe_subscription_id: sub.id || null,
            current_period_end: periodEndIso(sub),
          };
          if (row?.lifetime_tier || termProtected) {
            console.log(
              "billing-webhook: plan subscription event for protected user " +
                userId + " — billing_status + period end untouched",
            );
            delete update.current_period_end;
            delete update.billing_status;
          } else if (deleted) {
            update.billing_status = "expired";
          } else if (sub.status === "active" || sub.status === "trialing") {
            update.billing_status = "active";
          } else if (sub.status === "past_due") {
            // Card problem, Stripe is retrying: keep access ('active'),
            // just note it in the log.
            console.log("billing-webhook: subscription past_due for user " + userId);
            update.billing_status = "active";
          } else if (sub.status === "canceled") {
            update.billing_status = "expired";
          }
          const priceId = sub.items?.data?.[0]?.price?.id;
          const plan = planFromPriceId(priceId);
          if (plan && !deleted && !row?.lifetime_tier && !termProtected) {
            update.plan_tier = plan;
          }
          const { error } = await svc
            .from("user_settings")
            .upsert(update, { onConflict: "user_id" });
          if (error) throw error;
        }
      } else {
        console.error("billing-webhook: subscription event, user not resolvable");
      }
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(svc, secretKey, obj);
    } else if (event.type === "charge.refunded") {
      await handleChargeRefunded(svc, secretKey, obj);
    }
    // All other event types: acknowledged and ignored.
  } catch (e) {
    console.error("billing-webhook: handler failed: " + e);
    // 500 so Stripe retries — a transient DB failure shouldn't lose
    // a billing state change.
    return json({ ok: false, error: "handler_failed" }, 500);
  }

  return json({ received: true });
});
