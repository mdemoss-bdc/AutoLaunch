// =====================================================================
// DRAFT — NOT DEPLOYED. Lives in the rebuild folder for review only.
// Deploy (by Matthew, when the TikTok build is approved):
//   supabase functions deploy tiktok-auth
// Plus, BEFORE it can work:
//   1. Apply supabase/migrations_draft/tiktok_connections_DRAFT.sql
//      (creates public.tiktok_connections).
//   2. Set the function secrets in the Supabase dashboard:
//        TIKTOK_SBX_CLIENT_KEY     Sandbox client key from the TikTok
//                                  developer portal (app "BDC Testing"
//                                  sandbox) — Matthew's, server-side only
//        TIKTOK_SBX_CLIENT_SECRET  Sandbox client secret — Matthew's,
//                                  server-side only, never in code
//      Optional:
//        TIKTOK_REDIRECT_URI       defaults to the rebuild callback page
//      SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
//      injected by the Supabase runtime automatically.
//
// tiktok-auth — TikTok (Sandbox) account connection for AutoLaunch.
//
// Routes (path suffix after /functions/v1/tiktok-auth):
//   POST /exchange    body { code } — exchange the Login Kit auth code
//                     for TikTok tokens, fetch the TikTok profile, and
//                     upsert the caller's tiktok_connections row.
//   GET  /status      — { connected, username, display_name } for the
//                     caller's AutoLaunch account.
//   POST /disconnect  — delete the caller's connection row.
//
// The caller is always identified by their Supabase session JWT
// (Authorization: Bearer …), verified against the Auth API the same
// manual way photo-proxy checks its key — no token is ever trusted
// without asking Supabase who it belongs to. TikTok tokens are stored
// server-side only and are NEVER returned to the browser or logged.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_REDIRECT_URI =
  "https://mdemoss-bdc.github.io/AutoLaunch/tiktok-callback.html";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_INFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify the caller's Supabase session JWT and return their user id.
// Mirrors photo-proxy's manual header check: ask Supabase Auth who this
// token belongs to instead of trusting anything the client claims.
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
  );
}

interface TikTokTokenResponse {
  open_id?: string;
  scope?: string;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
}

async function handleExchange(req: Request, userId: string): Promise<Response> {
  const clientKey = Deno.env.get("TIKTOK_SBX_CLIENT_KEY") ?? "";
  const clientSecret = Deno.env.get("TIKTOK_SBX_CLIENT_SECRET") ?? "";
  const redirectUri = Deno.env.get("TIKTOK_REDIRECT_URI") ?? DEFAULT_REDIRECT_URI;
  if (!clientKey || !clientSecret) {
    console.error("tiktok-auth: missing TikTok sandbox secrets");
    return json({ error: "function_not_configured" }, 500);
  }

  let code = "";
  try {
    const body = await req.json();
    code = typeof body?.code === "string" ? body.code : "";
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!code) return json({ error: "missing_code" }, 400);

  // 1) Exchange the auth code for TikTok tokens (server-side only —
  //    the client secret never leaves this function).
  const form = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  let tokens: TikTokTokenResponse;
  try {
    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    tokens = await res.json();
  } catch (e) {
    console.error("tiktok-auth: token exchange fetch failed: " + e);
    return json({ error: "tiktok_unreachable" }, 502);
  }
  if (!tokens.access_token) {
    console.error(
      `tiktok-auth: token exchange rejected: ${tokens.error ?? "unknown"} ${tokens.error_description ?? ""}`,
    );
    return json(
      {
        error: "tiktok_exchange_failed",
        tiktok_error: tokens.error ?? null,
        message: tokens.error_description ?? "TikTok rejected the login code.",
      },
      502,
    );
  }

  // 2) Fetch the TikTok profile so the app can show who is connected.
  let username: string | null = null;
  let displayName: string | null = null;
  let openId: string | null = tokens.open_id ?? null;
  try {
    const res = await fetch(TIKTOK_USER_INFO_URL, {
      headers: { "Authorization": `Bearer ${tokens.access_token}` },
    });
    const info = await res.json();
    const user = info?.data?.user;
    if (user) {
      openId = user.open_id ?? openId;
      displayName = user.display_name ?? null;
    }
  } catch (e) {
    // Profile fetch is best-effort: the connection itself succeeded.
    console.error("tiktok-auth: user info fetch failed: " + e);
  }

  // 3) Upsert the connection row (service role — the browser gets no
  //    write access to this table at all; see the draft migration).
  const now = Date.now();
  const row = {
    user_id: userId,
    open_id: openId,
    username,
    display_name: displayName,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    access_expires_at: tokens.expires_in
      ? new Date(now + tokens.expires_in * 1000).toISOString()
      : null,
    refresh_expires_at: tokens.refresh_expires_in
      ? new Date(now + tokens.refresh_expires_in * 1000).toISOString()
      : null,
    scope: tokens.scope ?? null,
    updated_at: new Date(now).toISOString(),
  };
  const { error } = await serviceClient()
    .from("tiktok_connections")
    .upsert(row, { onConflict: "user_id" });
  if (error) {
    console.error("tiktok-auth: connection upsert failed: " + error.message);
    return json({ error: "connection_save_failed" }, 500);
  }

  // Never return the tokens — identity display fields only.
  return json({ ok: true, username, display_name: displayName });
}

async function handleStatus(userId: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from("tiktok_connections")
    .select("username, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("tiktok-auth: status lookup failed: " + error.message);
    return json({ error: "status_lookup_failed" }, 500);
  }
  if (!data) return json({ connected: false, username: null, display_name: null });
  return json({
    connected: true,
    username: data.username ?? null,
    display_name: data.display_name ?? null,
  });
}

async function handleDisconnect(userId: string): Promise<Response> {
  const { error } = await serviceClient()
    .from("tiktok_connections")
    .delete()
    .eq("user_id", userId);
  if (error) {
    console.error("tiktok-auth: disconnect failed: " + error.message);
    return json({ error: "disconnect_failed" }, 500);
  }
  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  const userId = await verifyUser(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  if (req.method === "POST" && route === "exchange") return handleExchange(req, userId);
  if (req.method === "GET" && route === "status") return handleStatus(userId);
  if (req.method === "POST" && route === "disconnect") return handleDisconnect(userId);

  return json({ error: "not_found" }, 404);
});
