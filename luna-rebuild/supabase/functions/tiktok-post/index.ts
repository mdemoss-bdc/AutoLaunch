// =====================================================================
// DRAFT — NOT DEPLOYED. Lives in the rebuild folder for review only.
// Deploy (by Matthew, when the TikTok build is approved):
//   supabase functions deploy tiktok-post
// Requires tiktok-auth to be deployed with the same secrets
// (TIKTOK_SBX_CLIENT_KEY / TIKTOK_SBX_CLIENT_SECRET) and the
// tiktok_connections table to exist (see the draft migration).
//
// tiktok-post — Direct Post a video to the caller's connected TikTok
// (Sandbox client for now). POST body:
//   { video_url: string,            public URL of an .mp4 (in practice a
//                                   public Supabase Storage URL)
//     title: string,                caption for the post
//     privacy_level?: string }      requested privacy; honoured only if
//                                   TikTok's creator_info allows it
//
// Flow: verify the caller's Supabase JWT -> load their
// tiktok_connections row -> refresh the TikTok token if it is expired
// (or about to be) -> ask TikTok creator_info which privacy levels are
// allowed -> fetch the video bytes -> Direct Post init with
// FILE_UPLOAD -> PUT the single chunk -> poll the publish status.
//
// FILE_UPLOAD is used instead of PULL_FROM_URL so no video-domain
// verification is needed for the Storage host. Single-chunk only:
// chunk_size = video_size, total_chunk_count = 1, up to 64 MB.
//
// Videos posted through the Sandbox / unaudited client are forced to
// SELF_ONLY by TikTok — expected until the app passes TikTok's audit.
//
// TikTok tokens are never returned to the browser or logged.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR_INFO_URL =
  "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // 64 MB single-chunk cap

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify the caller's Supabase session JWT (same manual pattern as
// photo-proxy / tiktok-auth: ask Supabase Auth who the token is).
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

interface ConnectionRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: string | null;
}

interface TikTokEnvelope {
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; log_id?: string };
}

// Pull TikTok's own error code/message out of an API envelope.
function tiktokError(step: string, env: TikTokEnvelope | null, status = 502): Response {
  const code = env?.error?.code ?? "unknown";
  const message = env?.error?.message ?? "TikTok returned an error.";
  console.error(`tiktok-post: ${step} failed: ${code} ${message}`);
  return json({ error: "tiktok_error", step, code, message }, status);
}

async function tiktokJson(
  url: string,
  accessToken: string,
  body: unknown,
): Promise<{ res: Response; env: TikTokEnvelope | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body ?? {}),
  });
  let env: TikTokEnvelope | null = null;
  try {
    env = await res.json();
  } catch {
    env = null;
  }
  return { res, env };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const clientKey = Deno.env.get("TIKTOK_SBX_CLIENT_KEY") ?? "";
  const clientSecret = Deno.env.get("TIKTOK_SBX_CLIENT_SECRET") ?? "";
  if (!clientKey || !clientSecret) {
    console.error("tiktok-post: missing TikTok sandbox secrets");
    return json({ error: "function_not_configured" }, 500);
  }

  const userId = await verifyUser(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let videoUrl = "";
  let title = "";
  let requestedPrivacy = "";
  try {
    const body = await req.json();
    videoUrl = typeof body?.video_url === "string" ? body.video_url : "";
    title = typeof body?.title === "string" ? body.title : "";
    requestedPrivacy =
      typeof body?.privacy_level === "string" ? body.privacy_level : "";
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
    return json({ error: "missing_or_bad_video_url" }, 400);
  }
  if (!title) return json({ error: "missing_title" }, 400);

  // Load the caller's TikTok connection.
  const db = serviceClient();
  const { data: connData, error: connErr } = await db
    .from("tiktok_connections")
    .select("user_id, access_token, refresh_token, access_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (connErr) {
    console.error("tiktok-post: connection lookup failed: " + connErr.message);
    return json({ error: "connection_lookup_failed" }, 500);
  }
  const conn = connData as ConnectionRow | null;
  if (!conn || !conn.access_token) {
    return json(
      { error: "tiktok_not_connected", message: "Connect TikTok in Settings first." },
      409,
    );
  }

  let accessToken = conn.access_token;

  // Refresh the TikTok token if it has expired or is within 60 seconds
  // of expiring, and persist the rotated tokens.
  const expiresAtMs = conn.access_expires_at
    ? Date.parse(conn.access_expires_at)
    : 0;
  if (!expiresAtMs || expiresAtMs - Date.now() < 60_000) {
    if (!conn.refresh_token) {
      return json(
        {
          error: "tiktok_token_expired",
          message: "TikTok login expired — reconnect TikTok in Settings.",
        },
        409,
      );
    }
    const form = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    });
    let tokens: {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    } = {};
    try {
      const res = await fetch(TIKTOK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      tokens = await res.json();
    } catch (e) {
      console.error("tiktok-post: token refresh fetch failed: " + e);
      return json({ error: "tiktok_unreachable" }, 502);
    }
    if (!tokens.access_token) {
      console.error(
        `tiktok-post: token refresh rejected: ${tokens.error ?? "unknown"} ${tokens.error_description ?? ""}`,
      );
      return json(
        {
          error: "tiktok_refresh_failed",
          tiktok_error: tokens.error ?? null,
          message:
            tokens.error_description ??
            "TikTok refused to refresh the login — reconnect TikTok in Settings.",
        },
        502,
      );
    }
    accessToken = tokens.access_token;
    const now = Date.now();
    const { error: updErr } = await db
      .from("tiktok_connections")
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? conn.refresh_token,
        access_expires_at: tokens.expires_in
          ? new Date(now + tokens.expires_in * 1000).toISOString()
          : conn.access_expires_at,
        refresh_expires_at: tokens.refresh_expires_in
          ? new Date(now + tokens.refresh_expires_in * 1000).toISOString()
          : undefined,
        scope: tokens.scope ?? undefined,
        updated_at: new Date(now).toISOString(),
      })
      .eq("user_id", userId);
    if (updErr) {
      // Non-fatal for this post — the fresh token is in hand — but log it.
      console.error("tiktok-post: refreshed-token save failed: " + updErr.message);
    }
  }

  // Ask TikTok which privacy levels this creator may use, then pick:
  // the requested one if allowed, else SELF_ONLY, else the first option.
  const creator = await tiktokJson(CREATOR_INFO_URL, accessToken, {});
  if (!creator.res.ok || (creator.env?.error?.code && creator.env.error.code !== "ok")) {
    return tiktokError("creator_info", creator.env);
  }
  const options = (creator.env?.data?.privacy_level_options ?? []) as string[];
  if (!Array.isArray(options) || options.length === 0) {
    return json(
      {
        error: "tiktok_no_privacy_options",
        message: "TikTok offered no privacy levels for this account.",
      },
      502,
    );
  }
  const privacyLevel = options.includes(requestedPrivacy)
    ? requestedPrivacy
    : options.includes("SELF_ONLY")
    ? "SELF_ONLY"
    : options[0];

  // Fetch the video bytes (public Supabase Storage URL).
  let videoBuf: ArrayBuffer;
  try {
    const vRes = await fetch(videoUrl);
    if (!vRes.ok) {
      return json(
        { error: "video_fetch_failed", message: `Video URL returned ${vRes.status}.` },
        502,
      );
    }
    videoBuf = await vRes.arrayBuffer();
  } catch (e) {
    console.error("tiktok-post: video fetch failed: " + e);
    return json({ error: "video_fetch_failed", message: "Could not download the video." }, 502);
  }
  const videoSize = videoBuf.byteLength;
  if (videoSize === 0) {
    return json({ error: "video_empty", message: "The video file is empty." }, 400);
  }
  if (videoSize > MAX_VIDEO_BYTES) {
    return json(
      {
        error: "video_too_large",
        message:
          `Video is ${(videoSize / 1024 / 1024).toFixed(1)} MB — single-chunk ` +
          "upload supports up to 64 MB. Trim the video and retry.",
      },
      413,
    );
  }

  // Direct Post init (FILE_UPLOAD, one chunk).
  const init = await tiktokJson(INIT_URL, accessToken, {
    post_info: {
      title,
      privacy_level: privacyLevel,
      disable_comment: false,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
  });
  const publishId = init.env?.data?.publish_id as string | undefined;
  const uploadUrl = init.env?.data?.upload_url as string | undefined;
  if (!init.res.ok || !publishId || !uploadUrl) {
    return tiktokError("init", init.env);
  }

  // Upload the single chunk. TikTok requires a Content-Range header
  // covering the whole file for chunk 0 of 1.
  let upRes: Response;
  try {
    upRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(videoSize),
        "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: videoBuf,
    });
  } catch (e) {
    console.error("tiktok-post: chunk upload fetch failed: " + e);
    return json({ error: "upload_failed", publish_id: publishId }, 502);
  }
  if (upRes.status !== 200 && upRes.status !== 201 && upRes.status !== 206) {
    const detail = await upRes.text().catch(() => "");
    console.error(`tiktok-post: chunk upload HTTP ${upRes.status}: ${detail.slice(0, 300)}`);
    return json(
      { error: "upload_failed", publish_id: publishId, status: upRes.status },
      502,
    );
  }

  // Poll the publish status: up to ~10 checks, 3 seconds apart.
  let finalStatus = "PROCESSING_UPLOAD";
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await tiktokJson(STATUS_URL, accessToken, { publish_id: publishId });
    const status = st.env?.data?.status as string | undefined;
    if (status) finalStatus = status;
    if (
      finalStatus === "PUBLISH_COMPLETE" ||
      finalStatus === "FAILED" ||
      finalStatus === "SEND_TO_USER_INBOX"
    ) {
      if (finalStatus === "FAILED") {
        const failReason = (st.env?.data?.fail_reason as string) ?? "unknown";
        return json(
          {
            ok: false,
            publish_id: publishId,
            status: finalStatus,
            error: "tiktok_publish_failed",
            message: `TikTok failed the publish: ${failReason}`,
          },
          502,
        );
      }
      break;
    }
  }

  return json({
    ok: finalStatus === "PUBLISH_COMPLETE" || finalStatus === "SEND_TO_USER_INBOX",
    publish_id: publishId,
    status: finalStatus,
    privacy_level: privacyLevel,
  });
});
