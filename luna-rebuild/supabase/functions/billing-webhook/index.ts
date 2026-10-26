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
// and store the endpoint's signing secret as STRIPE_WEBHOOK_SECRET.
//
// Handled events (all writes via the service role):
//   checkout.session.completed → billing_status 'active', plan_tier
//     from the session metadata plan, stripe ids + current_period_end
//     stored. The subscription itself carries the user_id/plan in its
//     metadata too (set by billing-checkout).
//   customer.subscription.updated → status sync: active/trialing →
//     'active'; past_due → stays 'active' (card problem, Stripe is
//     retrying — access is not cut); canceled → 'expired' with
//     current_period_end recorded. A price change that matches
//     STRIPE_PRICE_POST / STRIPE_PRICE_GROUP also updates plan_tier.
//   customer.subscription.deleted → billing_status 'expired'. This is
//     the event that fires when a portal cancellation reaches the end
//     of the paid period — so cancelling keeps access until then.
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
  return null;
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
      const plan = obj.metadata?.plan || sub?.metadata?.plan || "";
      if (userId) {
        const update: Record<string, unknown> = {
          user_id: userId,
          billing_status: "active",
          stripe_customer_id: obj.customer ? String(obj.customer) : null,
          stripe_subscription_id: subId || null,
          current_period_end: periodEndIso(sub),
        };
        if (plan === "post" || plan === "group") update.plan_tier = plan;
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
      const userId = await findUserId(svc, sub);
      if (userId) {
        const update: Record<string, unknown> = {
          user_id: userId,
          stripe_subscription_id: sub.id || null,
          current_period_end: periodEndIso(sub),
        };
        if (event.type === "customer.subscription.deleted") {
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
        if (plan && event.type !== "customer.subscription.deleted") {
          update.plan_tier = plan;
        }
        const { error } = await svc
          .from("user_settings")
          .upsert(update, { onConflict: "user_id" });
        if (error) throw error;
      } else {
        console.error("billing-webhook: subscription event, user not resolvable");
      }
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
