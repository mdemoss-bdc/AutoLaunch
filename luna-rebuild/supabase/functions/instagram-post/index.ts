// =====================================================================
// DRAFT — NOT DEPLOYED. PREPARED 2026-10-26 (overnight audit pass) so
// the Instagram channel is ready the day Meta business verification
// lands. Lives in the rebuild folder for review only. Deploy (by
// Matthew, at promotion time — see luna-rebuild/INSTAGRAM.md):
//   supabase functions deploy instagram-post --no-verify-jwt
// Requires instagram-auth deployed with the same secrets
// (META_APP_ID / META_APP_SECRET) and the instagram_connections table
// to exist (see the draft migration).
//
// instagram-post — Publish to the caller's connected Instagram via the
// Content Publishing API, modeled on tiktok-post (same manual JWT
// verification, same connection-row lookup, same error shape). POST
// body, one of:
//   { image_url: string, caption?: string }   photo post / carousel
//                                             item (public https URL;
//                                             JPEG required by Meta)
//   { video_url: string, caption?: string }   Reels post (public
//                                             https URL of an .mp4)
//
// Flow: verify the caller's Supabase JWT -> load their
// instagram_connections row -> create the media container
// (POST /{ig-user-id}/media) -> for video, poll the container's
// status_code until FINISHED (Meta processes uploads async) ->
// publish (POST /{ig-user-id}/media_publish) -> return the media id.
//
// Instagram specifics that differ from TikTok:
//   - Media must be hosted at a PUBLIC URL Meta's servers can fetch —
//     in practice a public Supabase Storage URL (the car's photos as
//     scraped, or a stitched intro-video file). There is no
//     byte-upload path like TikTok's FILE_UPLOAD.
//   - Publishing is capped by Meta (25 published posts per IG account
//     per 24h at drafting time); the app's channel fan-out and daily
//     pacing stay the rep-facing control, this function just executes
//     one post per call.
//   - User tokens are long-lived (~60 days) and are NOT refreshable
//     in place the way TikTok's are — an expired token means the rep
//     reconnects Instagram in Settings (instagram-auth /exchange).
//
// Meta tokens are never returned to the browser or logged.
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
// tiktok-post / instagram-auth: ask Supabase Auth who the token is).
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
  ig_user_id: string | null;
  access_token: string | null;
  token_expires_at: string | null;
}

// Pull Meta's own error message out of a Graph response.
function metaError(step: string, body: Record<string, unknown>, status = 502): Response {
  const err = body?.error as { message?: string; code?: number } | undefined;
  const message = err?.message ?? "Meta returned an error.";
  console.error(`instagram-post: ${step} failed: ${err?.code ?? "?"} ${message}`);
  return json({ error: "meta_error", step, code: err?.code ?? null, message }, status);
}

async function graphPost(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const form = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { res, body };
}

async function graphGet(
  path: string,
  accessToken: string,
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const url = `${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { res, body };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userId = await verifyUser(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let imageUrl = "";
  let videoUrl = "";
  let caption = "";
  try {
    const body = await req.json();
    imageUrl = typeof body?.image_url === "string" ? body.image_url : "";
    videoUrl = typeof body?.video_url === "string" ? body.video_url : "";
    caption = typeof body?.caption === "string" ? body.caption : "";
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if ((imageUrl && videoUrl) || (!imageUrl && !videoUrl)) {
    return json({ error: "send_exactly_one_of_image_url_or_video_url" }, 400);
  }
  const mediaUrl = imageUrl || videoUrl;
  if (!/^https:\/\//i.test(mediaUrl)) {
    return json({ error: "media_url_must_be_public_https" }, 400);
  }
  const isVideo = Boolean(videoUrl);

  // Load the caller's Instagram connection.
  const db = serviceClient();
  const { data: connData, error: connErr } = await db
    .from("instagram_connections")
    .select("user_id, ig_user_id, access_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (connErr) {
    console.error("instagram-post: connection lookup failed: " + connErr.message);
    return json({ error: "connection_lookup_failed" }, 500);
  }
  const conn = connData as ConnectionRow | null;
  if (!conn || !conn.access_token || !conn.ig_user_id) {
    return json(
      { error: "instagram_not_connected", message: "Connect Instagram in Settings first." },
      409,
    );
  }
  if (conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now()) {
    return json(
      {
        error: "instagram_token_expired",
        message: "Instagram login expired — reconnect Instagram in Settings.",
      },
      409,
    );
  }
  const accessToken = conn.access_token;
  const igUserId = conn.ig_user_id;

  // 1) Create the media container. Photos post as-is; videos post as
  //    Reels (media_type=REELS) — the listing-video format.
  const createParams: Record<string, string> = isVideo
    ? { media_type: "REELS", video_url: videoUrl, caption }
    : { image_url: imageUrl, caption };
  const created = await graphPost(`/${igUserId}/media`, accessToken, createParams);
  const creationId = created.body?.id as string | undefined;
  if (!created.res.ok || !creationId) {
    return metaError("media_create", created.body);
  }

  // 2) Video containers are processed asynchronously: poll until
  //    FINISHED (up to ~10 checks, 3 seconds apart — same cadence as
  //    tiktok-post's publish polling). Photo containers are ready
  //    immediately; skip the poll for them.
  if (isVideo) {
    let statusCode = "";
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await graphGet(`/${creationId}?fields=status_code`, accessToken);
      statusCode = (st.body?.status_code as string) ?? "";
      if (statusCode === "FINISHED") break;
      if (statusCode === "ERROR") {
        return metaError("media_processing", st.body);
      }
    }
    if (statusCode !== "FINISHED") {
      return json(
        {
          ok: false,
          creation_id: creationId,
          status: statusCode || "IN_PROGRESS",
          error: "media_processing_timeout",
          message: "Instagram is still processing the video — retry the post shortly.",
        },
        502,
      );
    }
  }

  // 3) Publish the container.
  const published = await graphPost(`/${igUserId}/media_publish`, accessToken, {
    creation_id: creationId,
  });
  const mediaId = published.body?.id as string | undefined;
  if (!published.res.ok || !mediaId) {
    return metaError("media_publish", published.body);
  }

  return json({ ok: true, media_id: mediaId, kind: isVideo ? "reel" : "photo" });
});
