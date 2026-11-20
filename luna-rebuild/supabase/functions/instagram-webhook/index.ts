// =====================================================================
// AutoLaunch — instagram-webhook (rebuild scope) [IG-MSG-355]
//
// Meta webhook receiver for Instagram messaging. Two jobs:
//   GET  — Meta's verification handshake: echo hub.challenge when
//          hub.mode=subscribe and hub.verify_token matches the
//          IG_WEBHOOK_VERIFY_TOKEN secret (never printed anywhere).
//   POST — messaging events for the app's connected IG accounts.
//          Each message event is stored in instagram_messages,
//          idempotently (meta_mid is unique — Meta's retries and
//          duplicate deliveries land once), mapped to the owning
//          AutoLaunch account through instagram_connections.
//
// Signature: Meta signs POSTs with X-Hub-Signature-256 (HMAC of the
// raw body under the app secret). When the header is present it is
// verified against META_APP_SECRET and a mismatch is refused. The
// receiver answers 200 for every well-formed delivery — including
// events for accounts it doesn't know and event kinds it doesn't
// store (read/delivery receipts, postbacks) — because a non-200
// makes Meta retry deliveries this receiver has already handled.
//
// Echoes (message.is_echo — messages the account itself sent from
// any surface) are stored as direction "out" so the in-app thread
// view shows the full conversation. Tokens never appear here at
// all: the receiver needs none.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

type Db = ReturnType<typeof serviceClient>;

async function signatureOk(rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return true; // unsigned delivery — Meta always signs; nothing to check against
  const secret = Deno.env.get("META_APP_SECRET") ?? "";
  if (!secret) {
    console.error("instagram-webhook: signature header present but META_APP_SECRET is not set — cannot verify");
    return false;
  }
  const expected = header.replace(/^sha256=/, "").trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface StoreResult {
  stored: number;
  skipped: number;
}

async function storeEvent(db: Db, entry: Record<string, unknown>): Promise<StoreResult> {
  const out: StoreResult = { stored: 0, skipped: 0 };
  const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
  for (const rawEv of messaging) {
    const ev = rawEv as Record<string, unknown>;
    const sender = (ev.sender ?? {}) as Record<string, unknown>;
    const recipient = (ev.recipient ?? {}) as Record<string, unknown>;
    const message = (ev.message ?? null) as Record<string, unknown> | null;
    if (!message || typeof message.mid !== "string") {
      out.skipped++; // read/delivery/postback/reaction events — not stored
      continue;
    }
    const isEcho = message.is_echo === true;
    const ourIgId = String(isEcho ? sender.id ?? "" : recipient.id ?? "");
    const participant = String(isEcho ? recipient.id ?? "" : sender.id ?? "");
    if (!ourIgId || !participant) {
      out.skipped++;
      continue;
    }
    // Map the IG account to its owning AutoLaunch account. Unknown
    // accounts (not connected here) are acknowledged and dropped.
    const { data: conn } = await db
      .from("instagram_connections")
      .select("user_id")
      .eq("ig_user_id", ourIgId)
      .maybeSingle();
    if (!conn) {
      out.skipped++;
      continue;
    }
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.now();
    const row = {
      user_id: conn.user_id,
      ig_user_id: ourIgId,
      participant_id: participant,
      participant_username: null,
      direction: isEcho ? "out" : "in",
      text: typeof message.text === "string" ? message.text : null,
      meta_mid: message.mid,
      status: isEcho ? "sent" : "received",
      is_read: isEcho,
      created_at: new Date(ts).toISOString(),
    };
    const { error } = await db
      .from("instagram_messages")
      .upsert(row, { onConflict: "meta_mid", ignoreDuplicates: true });
    if (error) {
      console.error("instagram-webhook: message store failed: " + error.message);
      out.skipped++;
    } else {
      out.stored++;
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = Deno.env.get("IG_WEBHOOK_VERIFY_TOKEN") ?? "";
    if (mode === "subscribe" && expected && token === expected && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }

  if (req.method === "POST") {
    const raw = await req.text();
    const sigOk = await signatureOk(raw, req.headers.get("x-hub-signature-256"));
    if (!sigOk) return new Response("invalid signature", { status: 401 });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (payload.object !== "instagram") {
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const db = serviceClient();
    const totals: StoreResult = { stored: 0, skipped: 0 };
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      try {
        const r = await storeEvent(db, entry as Record<string, unknown>);
        totals.stored += r.stored;
        totals.skipped += r.skipped;
      } catch (e) {
        console.error("instagram-webhook: entry processing failed: " + e);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...totals }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response("method not allowed", { status: 405 });
});
