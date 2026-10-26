// =====================================================================
// DRAFT — NOT DEPLOYED. PREPARED 2026-10-26 (overnight audit pass) so
// the Instagram channel is ready the day Meta business verification
// lands. Lives in the rebuild folder for review only. Deploy (by
// Matthew, at promotion time — see luna-rebuild/INSTAGRAM.md):
//   supabase functions deploy instagram-auth --no-verify-jwt
// Plus, BEFORE it can work:
//   1. Meta business verification APPROVED for the "Auto Launch"
//      business portfolio (blocked on the bank letter as of drafting).
//   2. App Review approval for instagram_business_content_publish
//      (Advanced Access) on the Meta app "Auto Launch Feed"
//      (app id 1442518901327928), then flip the app to Live.
//   3. Apply supabase/migrations_draft/instagram_connections_DRAFT.sql
//      (creates public.instagram_connections).
//   4. Set the function secrets in the Supabase dashboard:
//        META_APP_ID      Meta app id (1442518901327928)
//        META_APP_SECRET  Meta app secret — server-side only, never
//                         in code, never logged
//      Optional:
//        META_REDIRECT_URI  defaults to the rebuild callback page
//        META_GRAPH_VERSION defaults to v21.0 (one constant below)
//      SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
//      are injected by the Supabase runtime automatically.
//
// instagram-auth — Instagram (Meta) account connection for AutoLaunch,
// modeled directly on tiktok-auth (same routes, same manual JWT
// verification, same service-role-only writes).
//
// Routes (path suffix after /functions/v1/instagram-auth):
//   POST /exchange    body { code } — exchange the Facebook Login auth
//                     code for a short-lived user token, upgrade it
//                     to a long-lived token (~60 days), resolve the
//                     caller's Facebook Pages and their linked
//                     Instagram business accounts, and upsert the
//                     caller's instagram_connections row (first
//                     Page/IG pair wins; multi-Page selection is a
//                     promotion-time refinement).
//   GET  /status      — { connected, username, display_name } for the
//                     caller's AutoLaunch account.
//   POST /disconnect  — delete the caller's connection row.
//
// The caller is always identified by their Supabase session JWT
// (Authorization: Bearer …), verified against the Auth API the same
// manual way tiktok-auth does it — no token is ever trusted without
// asking Supabase who it belongs to. Meta tokens are stored
// server-side only and are NEVER returned to the browser or logged.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_REDIRECT_URI =
  "https://mdemoss-bdc.github.io/AutoLaunch/instagram-callback.html";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify the caller's Supabase session JWT and return their user id.
// Same manual pattern as tiktok-auth / photo-proxy: ask Supabase Auth
// who this token belongs to instead of trusting anything the client
// claims.
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

interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

async function graphGet(
  path: string,
  accessToken: string,
): Promise<{ res: Response; body: Record<string, unknown> & MetaErrorBody }> {
  const url = `${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  let body: Record<string, unknown> & MetaErrorBody = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { res, body };
}

async function handleExchange(req: Request, userId: string): Promise<Response> {
  const appId = Deno.env.get("META_APP_ID") ?? "";
  const appSecret = Deno.env.get("META_APP_SECRET") ?? "";
  const redirectUri = Deno.env.get("META_REDIRECT_URI") ?? DEFAULT_REDIRECT_URI;
  if (!appId || !appSecret) {
    console.error("instagram-auth: missing Meta app secrets");
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

  // 1) Exchange the auth code for a short-lived user token
  //    (server-side only — the app secret never leaves this function).
  const exchangeUrl =
    `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;
  let shortToken = "";
  let shortExpiresIn: number | null = null;
  try {
    const res = await fetch(exchangeUrl);
    const body = await res.json();
    if (!res.ok || typeof body?.access_token !== "string") {
      console.error(
        `instagram-auth: code exchange rejected: ${body?.error?.message ?? res.status}`,
      );
      return json(
        {
          error: "meta_exchange_failed",
          message: body?.error?.message ?? "Meta rejected the login code.",
        },
        502,
      );
    }
    shortToken = body.access_token;
    shortExpiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  } catch (e) {
    console.error("instagram-auth: code exchange fetch failed: " + e);
    return json({ error: "meta_unreachable" }, 502);
  }

  // 2) Upgrade to a long-lived user token (~60 days). Best-effort: if
  //    the exchange fails, keep the short-lived token and its expiry
  //    so the connection still works until it lapses.
  let accessToken = shortToken;
  let expiresIn = shortExpiresIn;
  try {
    const llUrl =
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(shortToken)}`;
    const res = await fetch(llUrl);
    const body = await res.json();
    if (res.ok && typeof body?.access_token === "string") {
      accessToken = body.access_token;
      expiresIn = typeof body.expires_in === "number" ? body.expires_in : expiresIn;
    }
  } catch (e) {
    console.error("instagram-auth: long-lived exchange failed (keeping short-lived): " + e);
  }

  // 3) Resolve the user's Pages and their linked Instagram business
  //    accounts. Content publishing runs against the IG user id, and
  //    an IG account is only usable here when it is linked to a Page
  //    the user manages.
  const pages = await graphGet(
    "/me/accounts?fields=id,name,instagram_business_account{id,username,name}",
    accessToken,
  );
  if (!pages.res.ok) {
    console.error(
      `instagram-auth: page lookup rejected: ${pages.body?.error?.message ?? pages.res.status}`,
    );
    return json(
      {
        error: "meta_pages_failed",
        message:
          pages.body?.error?.message ??
          "Meta would not list your Pages — reconnect and approve Page access.",
      },
      502,
    );
  }
  const pageList = Array.isArray(pages.body?.data)
    ? (pages.body.data as Record<string, unknown>[])
    : [];
  let pageId: string | null = null;
  let igUserId: string | null = null;
  let username: string | null = null;
  let displayName: string | null = null;
  for (const p of pageList) {
    const ig = p?.instagram_business_account as Record<string, unknown> | undefined;
    if (ig && typeof ig.id === "string") {
      pageId = typeof p.id === "string" ? p.id : null;
      igUserId = ig.id;
      username = typeof ig.username === "string" ? ig.username : null;
      displayName = typeof ig.name === "string" ? ig.name : null;
      break;
    }
  }
  if (!igUserId) {
    return json(
      {
        error: "no_instagram_business_account",
        message:
          "No Instagram business/creator account is linked to a Facebook Page you manage. " +
          "Link Instagram to your Page in Meta Business Settings, then reconnect.",
      },
      409,
    );
  }

  // 4) Upsert the connection row (service role — the browser gets no
  //    write access to this table at all; see the draft migration).
  const now = Date.now();
  const row = {
    user_id: userId,
    ig_user_id: igUserId,
    page_id: pageId,
    username,
    display_name: displayName,
    access_token: accessToken,
    token_expires_at: expiresIn
      ? new Date(now + expiresIn * 1000).toISOString()
      : null,
    scope: "instagram_business_basic,instagram_business_content_publish",
    updated_at: new Date(now).toISOString(),
  };
  const { error } = await serviceClient()
    .from("instagram_connections")
    .upsert(row, { onConflict: "user_id" });
  if (error) {
    console.error("instagram-auth: connection upsert failed: " + error.message);
    return json({ error: "connection_save_failed" }, 500);
  }

  // Never return the token — identity display fields only.
  return json({ ok: true, username, display_name: displayName });
}

async function handleStatus(userId: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from("instagram_connections")
    .select("username, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("instagram-auth: status lookup failed: " + error.message);
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
    .from("instagram_connections")
    .delete()
    .eq("user_id", userId);
  if (error) {
    console.error("instagram-auth: disconnect failed: " + error.message);
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
