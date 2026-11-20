// =====================================================================
// AutoLaunch — instagram-send (rebuild scope) [IG-MSG-355]
//
// The write side of the in-app Instagram inbox (the read side is
// the owner's own RLS-scoped select on instagram_messages; inbound
// rows arrive through instagram-webhook). JWT-verified like
// instagram-post; all writes use the service role.
//
// Modes (POST body):
//   { participant_id, text }            — reply to a thread through
//      the stored instagram_connections token (Graph Send API).
//      The outbound row is recorded either way: status "sent" with
//      Meta's message_id, or "failed" with Meta's error code and
//      message VERBATIM — including the 24-hour-window rejections
//      Meta answers outside its messaging window. Nothing is
//      hidden and nothing is retried behind the rep's back.
//   { action: "mark_read", participant_id } — mark the thread's
//      inbound rows read (the client has no update policy on
//      instagram_messages, deliberately: this is the only write
//      path besides the webhook and the send above).
//
// The proven instagram-post publish actions are untouched — this
// sibling exists so messaging can never regress posting.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify the caller's Supabase session JWT (same manual pattern as
// instagram-post / tiktok-post).
async function verifyUser(req: Request): Promise<string | null> {
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
    return typeof user?.id === "string" ? user.id : null;
  } catch {
    return null;
  }
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

type Db = ReturnType<typeof serviceClient>;

interface ConnectionRow {
  ig_user_id: string | null;
  access_token: string | null;
  token_expires_at: string | null;
}

// The same connection gate the publish path applies (exists, has a
// token + IG user id, token not expired) with the same answers.
async function loadConnection(
  db: Db,
  userId: string,
): Promise<{ conn: ConnectionRow | null; resp: Response | null }> {
  const { data, error } = await db
    .from("instagram_connections")
    .select("ig_user_id, access_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("instagram-send: connection lookup failed: " + error.message);
    return { conn: null, resp: json({ error: "connection_lookup_failed" }, 500) };
  }
  const conn = data as ConnectionRow | null;
  if (!conn || !conn.access_token || !conn.ig_user_id) {
    return {
      conn: null,
      resp: json(
        { error: "instagram_not_connected", message: "Connect Instagram in Settings first." },
        409,
      ),
    };
  }
  if (conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now()) {
    return {
      conn: null,
      resp: json(
        {
          error: "instagram_token_expired",
          message: "Instagram login expired — reconnect Instagram in Settings.",
        },
        409,
      ),
    };
  }
  return { conn, resp: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userId = await verifyUser(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const participantId = typeof body?.participant_id === "string" ? body.participant_id : "";
  if (!participantId) return json({ error: "participant_required" }, 400);

  const db = serviceClient();

  // ---- mark_read ----
  if (body?.action === "mark_read") {
    const { error } = await db
      .from("instagram_messages")
      .update({ is_read: true })
      .eq("user_id", userId)
      .eq("participant_id", participantId)
      .eq("direction", "in")
      .eq("is_read", false);
    if (error) {
      console.error("instagram-send: mark_read failed: " + error.message);
      return json({ error: "mark_read_failed" }, 500);
    }
    return json({ ok: true });
  }

  // ---- send a reply ----
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "text_required" }, 400);

  const { conn, resp } = await loadConnection(db, userId);
  if (resp || !conn) return resp ?? json({ error: "connection_lookup_failed" }, 500);
  const accessToken = conn.access_token as string;
  const igUserId = conn.ig_user_id as string;

  let metaRes: Response;
  let metaBody: Record<string, unknown> | null = null;
  try {
    metaRes = await fetch(
      `${GRAPH}/${igUserId}/messages?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: participantId },
          messaging_type: "RESPONSE",
          message: { text },
        }),
      },
    );
    metaBody = await metaRes.json().catch(() => null);
  } catch (e) {
    console.error("instagram-send: Meta fetch failed: " + e);
    return json({ error: "meta_unreachable", message: String(e) }, 502);
  }

  const errObj = (metaBody?.error ?? null) as Record<string, unknown> | null;
  const messageId = typeof metaBody?.message_id === "string" ? metaBody.message_id : null;
  const sent = metaRes.ok && !!messageId && !errObj;

  const row = {
    user_id: userId,
    ig_user_id: igUserId,
    participant_id: participantId,
    participant_username: null,
    direction: "out",
    text,
    meta_mid: sent ? messageId : null,
    status: sent ? "sent" : "failed",
    error_code: sent ? null : (errObj?.code != null ? String(errObj.code) : "meta_error"),
    error_message: sent
      ? null
      : (typeof errObj?.message === "string" ? errObj.message : "Meta returned an error."),
    is_read: true,
  };
  const { data: inserted, error: insErr } = await db
    .from("instagram_messages")
    .insert(row)
    .select("id, created_at")
    .single();
  if (insErr) {
    console.error("instagram-send: outbound record failed: " + insErr.message);
  }

  if (!sent) {
    console.error(
      `instagram-send: Meta refused the reply: ${row.error_code} ${row.error_message}`,
    );
    return json(
      {
        ok: false,
        error: row.error_code,
        message: row.error_message,
        recorded: !insErr,
        row_id: inserted?.id ?? null,
      },
      metaRes.status === 200 ? 400 : metaRes.status,
    );
  }
  return json({
    ok: true,
    message_id: messageId,
    row_id: inserted?.id ?? null,
    created_at: inserted?.created_at ?? null,
  });
});
