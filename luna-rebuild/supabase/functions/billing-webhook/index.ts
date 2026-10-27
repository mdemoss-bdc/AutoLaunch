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
// post_annual / group_annual (annual plan subscriptions — same tiers,
// counted as 12 paid months), lifetime_post / lifetime_group
// (one-time Founding Lifetime payments), support (the $199/year
// Support Plan for Lifetime accounts):
//   checkout.session.completed, kind post/group → billing_status
//     'active', plan_tier from the session metadata plan, stripe ids
//     + current_period_end stored. The subscription itself carries
//     the user_id/plan in its metadata too (set by billing-checkout).
//   checkout.session.completed, kind lifetime_* → billing_status
//     'active' PERMANENTLY for that tier: plan_tier + lifetime_tier
//     set, lifetime_purchased_at stamped, stripe_customer_id stored.
//     NO subscription fields — a lifetime account's
//     current_period_end stays NULL forever and nothing may expire it.
//   checkout.session.completed, kind support → ONLY
//     support_plan_status / support_period_end are written.
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
//   invoice.paid → REFERRAL ACCRUAL (see TIERS.md "Referrals"): when
//     the payer is a claimed referee on a solo plan kind, their paid
//     months advance (monthly price +1, annual price +12, capped at
//     12) and every completed block of 3 paid months grants the
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
  if (priceId === (Deno.env.get("STRIPE_PRICE_POST_ANNUAL") || "")) return "post";
  if (priceId === (Deno.env.get("STRIPE_PRICE_GROUP") || "")) return "group";
  if (priceId === (Deno.env.get("STRIPE_PRICE_GROUP_ANNUAL") || "")) return "group";
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

const SOLO_PLAN_KINDS = ["post", "group", "post_annual", "group_annual"];
const REFERRAL_PAID_MONTH_CAP = 12;
const REFERRAL_BONUS_CAP = 4;

// Paid months a price represents on an invoice: annual prices count
// 12, monthly prices count 1, anything else (support, add-ons) 0 —
// a 0 means this invoice can never be a referral payment.
function paidMonthsForPrice(priceId: string | null | undefined): number {
  if (!priceId) return 0;
  if (
    priceId === (Deno.env.get("STRIPE_PRICE_POST_ANNUAL") || "") ||
    priceId === (Deno.env.get("STRIPE_PRICE_GROUP_ANNUAL") || "")
  ) return 12;
  if (
    priceId === (Deno.env.get("STRIPE_PRICE_POST") || "") ||
    priceId === (Deno.env.get("STRIPE_PRICE_GROUP") || "")
  ) return 1;
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

  // Claim the invoice in the ledger FIRST: a PK conflict means a
  // redelivery of an event already processed — never double-count.
  const { error: claimErr } = await svc.from("referral_invoices").insert({
    invoice_id: invoiceId,
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
    const priceId = invoice.lines?.data?.[0]?.price?.id ||
      sub.items?.data?.[0]?.price?.id;
    const months = paidMonthsForPrice(priceId);
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
              ref.referrer_user_id + " (invoice " + invoiceId + ")",
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
      }).eq("invoice_id", invoiceId);
    } else {
      await svc.from("referral_invoices").delete().eq("invoice_id", invoiceId);
    }
    throw e;
  }

  const { error: ledErr } = await svc.from("referral_invoices").update({
    months_added: monthsAdded,
    bonuses_delta: delta,
    credit_amount_cents: creditCents,
    credit_txn_id: creditTxnId,
  }).eq("invoice_id", invoiceId);
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
      const userId = await findUserId(svc, sub, obj);
      const kind = kindOf(obj, sub);
      const lifetimeTier = lifetimeTierOf(kind);
      const plan = obj.metadata?.plan || sub?.metadata?.plan || "";
      if (userId) {
        let update: Record<string, unknown>;
        if (lifetimeTier) {
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
          // Support Plan purchase: support fields ONLY. Access was
          // already settled by the lifetime purchase behind it.
          update = {
            user_id: userId,
            support_plan_status: "active",
            support_period_end: periodEndIso(sub),
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
        const { error } = await svc
          .from("user_settings")
          .upsert(update, { onConflict: "user_id" });
        if (error) throw error;
      } else {
        console.error("billing-webhook: checkout completed, user not resolvable");
      }
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = obj;
      const deleted = event.type === "customer.subscription.deleted";
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
          // Plan subscription. A lifetime account outranks it: if the
          // row carries a lifetime_tier, a leftover monthly
          // subscription's lifecycle (including the cancel the buyer
          // does right after upgrading) must never expire the account.
          const { data: row } = await svc
            .from("user_settings")
            .select("lifetime_tier")
            .eq("user_id", userId)
            .maybeSingle();
          const update: Record<string, unknown> = {
            user_id: userId,
            stripe_subscription_id: sub.id || null,
            current_period_end: periodEndIso(sub),
          };
          if (row?.lifetime_tier) {
            console.log(
              "billing-webhook: plan subscription event for lifetime user " +
                userId + " — billing_status untouched",
            );
            delete update.current_period_end;
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
          if (plan && !deleted && !row?.lifetime_tier) {
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
