// =====================================================================
// instagram-auth — Instagram (Meta) account connection for AutoLaunch,
// modeled directly on tiktok-auth (same routes, same manual JWT
// verification, same service-role-only writes). Built and deployed
// 2026-11-19 (rebuild scope). The flow sits DARK until two Meta-side
// gates clear: (1) the META_APP_ID / META_APP_SECRET function secrets
// are set, and (2) Meta App Review grants instagram_content_publish
// Advanced Access on the "Auto Launch Feed" app (1442518901327928) and
// the app is flipped Live. Until then /exchange still connects the
// account (identity + Page/IG resolution work under Standard Access
// for app-role users) but reports publish_permission: "pending", and
// instagram-post answers instagram_permission_pending. See
// luna-rebuild/INSTAGRAM_APP_REVIEW.md.
//
// Routes (path suffix after /functions/v1/instagram-auth):
//   POST /exchange    body { code } — exchange the Facebook Login auth
//                     code for a short-lived user token, upgrade it
//                     to a long-lived token (~60 days), read the
//                     granted permissions (/me/permissions), resolve
//                     the caller's Facebook Pages and their linked
//                     Instagram business accounts, and upsert the
//                     caller's instagram_connections row (first
//                     Page/IG pair wins; multi-Page selection is a
//                     promotion-time refinement).
//   GET  /status      — { connected, username, display_name,
//                     publish_permission } for the caller's
//                     AutoLaunch account.
//   POST /disconnect  — delete the caller's connection row.
//
// OAuth is Facebook Login requesting the Facebook-Login permission
// set: instagram_basic, instagram_content_publish, pages_show_list.
// Publishing runs through graph.facebook.com against the IG user id
// resolved from the linked Page (Instagram Graph API).
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
  "https://autolaunch.org/instagram-callback.html";
// The Facebook-Login permissions the connect dialog requests. Stored
// as the fallback scope when /me/permissions cannot be read.
const REQUESTED_PERMISSIONS = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
];

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

  // 3) Read the permissions Meta actually granted. This decides the
  //    publish_permission state the app shows: "granted" only when
  //    instagram_content_publish is on the granted list (App Review
  //    Advanced Access, or an app-role user under Standard Access).
  //    If the read fails we cannot prove the grant, so the state is
  //    "unknown" and the stored scope falls back to the requested set.
  let grantedPermissions: string[] | null = null;
  try {
    const perms = await graphGet("/me/permissions", accessToken);
    if (perms.res.ok && Array.isArray(perms.body?.data)) {
      grantedPermissions = (perms.body.data as Record<string, unknown>[])
        .filter((p) => p?.status === "granted" && typeof p?.permission === "string")
        .map((p) => p.permission as string);
    }
  } catch (e) {
    console.error("instagram-auth: permissions read failed: " + e);
  }
  const scope = grantedPermissions
    ? grantedPermissions.join(",")
    : REQUESTED_PERMISSIONS.join(",");
  const publishPermission = grantedPermissions
    ? grantedPermissions.includes("instagram_content_publish")
      ? "granted"
      : "pending"
    : "unknown";

  // 4) Resolve the user's Pages and their linked Instagram business
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

  // 5) Upsert the connection row (service role — the browser gets no
  //    write access to this table at all; see the applied migration).
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
    scope,
    publish_permission: publishPermission,
    updated_at: new Date(now).toISOString(),
  };
  const { error } = await serviceClient()
    .from("instagram_connections")
    .upsert(row, { onConflict: "user_id" });
  if (error) {
    console.error("instagram-auth: connection upsert failed: " + error.message);
    return json({ error: "connection_save_failed" }, 500);
  }

  // [IG-MSG-355] Subscribe this IG account to the app's messaging
  // webhooks (subscribed_apps, messages field) so Instagram DMs
  // reach the instagram-webhook receiver and land in the in-app
  // inbox. Best-effort: a failure here never fails the connect —
  // the account simply won't stream messages until a reconnect
  // (or a manual subscribe) lands it.
  try {
    const subRes = await fetch(
      `${GRAPH}/${igUserId}/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(accessToken)}`,
      { method: "POST" },
    );
    const subBody = await subRes.json().catch(() => null);
    if (!subRes.ok || subBody?.success !== true) {
      console.error(
        "instagram-auth: subscribed_apps failed: " +
          (subBody?.error?.message ?? subRes.status),
      );
    }
  } catch (e) {
    console.error("instagram-auth: subscribed_apps fetch failed: " + e);
  }

  // Never return the token — identity display fields + grant state.
  return json({
    ok: true,
    username,
    display_name: displayName,
    publish_permission: publishPermission,
  });
}

async function handleStatus(userId: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from("instagram_connections")
    .select("username, display_name, publish_permission")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("instagram-auth: status lookup failed: " + error.message);
    return json({ error: "status_lookup_failed" }, 500);
  }
  if (!data) {
    return json({
      connected: false,
      username: null,
      display_name: null,
      publish_permission: null,
    });
  }
  return json({
    connected: true,
    username: data.username ?? null,
    display_name: data.display_name ?? null,
    publish_permission: data.publish_permission ?? "unknown",
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
