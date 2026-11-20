// =====================================================================
// instagram-post — Publish to the caller's connected Instagram via the
// Content Publishing API (graph.facebook.com), modeled on tiktok-post
// (same manual JWT verification, same connection-row lookup, same
// error honesty). Built and deployed 2026-11-19 (rebuild scope).
// Until Meta App Review grants instagram_content_publish Advanced
// Access on the "Auto Launch Feed" app, real publishes from accounts
// without an app role fail at Meta with a permissions error — that is
// EXPECTED, and this function reports it cleanly as
// { error: "instagram_permission_pending" } carrying Meta's verbatim
// message, never as a crash or a fake success. See
// luna-rebuild/INSTAGRAM_APP_REVIEW.md.
//
// POST body, exactly one media shape:
//   { image_url: string, caption?: string }    single photo post
//   { image_urls: string[2..10], caption? }    carousel post
//   { video_url: string, caption?: string }    Reel (the VIN Reel)
// plus optional bookkeeping fields the app passes for the outcome
// record: { vin?: string, stock_number?: string }.
//
// [IG-AUTO-REEL-353] Intent modes (no media shape — the app sends
// these when a car's owner taps Instagram before its VIN Reel
// exists; the app queues the render and this function holds the
// post intent, because instagram_posts is service-role-write
// only):
//   { intent: true, vin, stock_number? }     -> insert (or return
//     the existing) instagram_posts row at status "awaiting_reel".
//   { intent_id, intent_close: "<reason>" }  -> close a held
//     intent whose post will never run (the render failed): the
//     row is marked failed with the reason as its error_code.
// A publish call may also carry intent_id: recordOutcome then
// resolves that awaiting_reel row to the outcome instead of
// inserting a second row, so one row carries the whole lifecycle.
//
// Flow: verify the caller's Supabase JWT -> load their
// instagram_connections row -> create the media container(s)
// (POST /{ig-user-id}/media) -> poll the container's status_code
// until FINISHED (video + carousel; photo containers are ready
// immediately) -> publish (POST /{ig-user-id}/media_publish) ->
// record the outcome in public.instagram_posts (the caller's own
// rows only — the row is always keyed by the JWT-verified user id,
// never by anything in the request body).
//
// Supported subset, deliberately: single JPEG photo, photo carousel
// (2–10 images), and one mp4 Reel. Stories, albums mixed with video,
// and multi-video carousels are not supported by this endpoint.
//
// Instagram specifics that differ from TikTok:
//   - Media must be hosted at a PUBLIC https URL Meta's servers can
//     fetch (Supabase Storage public URLs qualify); photos must be
//     JPEG. There is no byte-upload path like TikTok's FILE_UPLOAD.
//   - Publishing is capped by Meta (25 published posts per IG account
//     per 24h at build time); the app's daily pacing stays the
//     rep-facing control, this function executes one post per call.
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
const MAX_CAROUSEL_ITEMS = 10;

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

interface GraphBody {
  id?: string;
  status_code?: string;
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
  [key: string]: unknown;
}

// A Graph error is the not-yet-approved permission state when Meta
// says the app lacks a publishing permission: OAuthException with
// code 10 or 200, or any error body naming the permission / a
// permission requirement. Token failures (code 190) are NOT this —
// they keep their own expired-token path.
function isPermissionError(body: GraphBody): boolean {
  const err = body?.error;
  if (!err) return false;
  if (err.code === 190) return false;
  const msg = `${err.message ?? ""}`;
  if (/instagram_content_publish/i.test(msg)) return true;
  if ((err.code === 10 || err.code === 200) && err.type === "OAuthException") return true;
  if ((err.code === 10 || err.code === 200) && /permission/i.test(msg)) return true;
  return false;
}

// Record one attempt's outcome on the caller's own rows. Best-effort
// by design: a failed insert is logged and never masks the real
// result the caller is owed.
async function recordOutcome(
  db: ReturnType<typeof serviceClient>,
  row: {
    user_id: string;
    vin: string | null;
    stock_number: string | null;
    kind: string;
    media_id: string | null;
    container_id: string | null;
    status: string;
    error_code: string | null;
    error_message: string | null;
  },
  intentId?: string | null,
): Promise<void> {
  try {
    if (intentId) {
      // [IG-AUTO-REEL-353] A held auto-post intent is resolving:
      // update its awaiting_reel row in place so one row carries
      // the whole lifecycle (awaiting_reel -> outcome). If the row
      // was already resolved, fall back to a fresh outcome row —
      // the result is never lost.
      const { data: updated, error: updErr } = await db
        .from("instagram_posts")
        .update({
          vin: row.vin,
          stock_number: row.stock_number,
          kind: row.kind,
          media_id: row.media_id,
          container_id: row.container_id,
          status: row.status,
          error_code: row.error_code,
          error_message: row.error_message,
        })
        .eq("id", intentId)
        .eq("user_id", row.user_id)
        .eq("status", "awaiting_reel")
        .select("id");
      if (!updErr && updated && updated.length === 1) return;
    }
    const { error } = await db.from("instagram_posts").insert(row);
    if (error) console.error("instagram-post: outcome record failed: " + error.message);
  } catch (e) {
    console.error("instagram-post: outcome record threw: " + e);
  }
}

async function graphPost(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<{ res: Response; body: GraphBody }> {
  const form = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  let body: GraphBody = {};
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
): Promise<{ res: Response; body: GraphBody }> {
  const url = `${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  let body: GraphBody = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { res, body };
}

// Poll a container until Meta finishes processing it (up to ~10
// checks, 3 seconds apart — same cadence as tiktok-post's publish
// polling). Returns the final status_code.
async function pollContainer(accessToken: string, creationId: string): Promise<string> {
  let statusCode = "";
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await graphGet(`/${creationId}?fields=status_code`, accessToken);
    statusCode = (st.body?.status_code as string) ?? statusCode;
    if (statusCode === "FINISHED" || statusCode === "ERROR") break;
  }
  return statusCode;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userId = await verifyUser(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let imageUrl = "";
  let imageUrls: string[] = [];
  let videoUrl = "";
  let caption = "";
  let vin: string | null = null;
  let stockNumber: string | null = null;
  let intentCreate = false;
  let intentId: string | null = null;
  let intentClose = "";
  try {
    const body = await req.json();
    intentCreate = body?.intent === true;
    intentId =
      typeof body?.intent_id === "string" && body.intent_id
        ? body.intent_id
        : null;
    intentClose = typeof body?.intent_close === "string" ? body.intent_close : "";
    imageUrl = typeof body?.image_url === "string" ? body.image_url : "";
    imageUrls = Array.isArray(body?.image_urls)
      ? body.image_urls.filter((u: unknown) => typeof u === "string" && u)
      : [];
    videoUrl = typeof body?.video_url === "string" ? body.video_url : "";
    caption = typeof body?.caption === "string" ? body.caption : "";
    vin = typeof body?.vin === "string" && body.vin ? body.vin : null;
    stockNumber =
      typeof body?.stock_number === "string" && body.stock_number
        ? body.stock_number
        : null;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const db = serviceClient();

  // [IG-AUTO-REEL-353] Intent modes: no media attached, so they
  // are handled before the media-shape validation. Both are keyed
  // by the JWT-verified caller, never by anything in the body.
  if (intentClose) {
    if (!intentId) return json({ error: "intent_id_required" }, 400);
    const reason = intentClose.slice(0, 80);
    const { data: closed, error: closeErr } = await db
      .from("instagram_posts")
      .update({
        status: "failed",
        error_code: reason,
        error_message: "Auto-post intent closed before publishing: " + reason,
      })
      .eq("id", intentId)
      .eq("user_id", userId)
      .eq("status", "awaiting_reel")
      .select("id");
    if (closeErr) {
      console.error("instagram-post: intent close failed: " + closeErr.message);
      return json({ error: "intent_close_failed" }, 500);
    }
    return json({ ok: true, closed: !!(closed && closed.length) });
  }
  if (intentCreate) {
    if (!vin) return json({ error: "vin_required" }, 400);
    // The connection must be real before an intent is held — the
    // same checks the publish path makes, with the same answers.
    const { data: intentConnData, error: intentConnErr } = await db
      .from("instagram_connections")
      .select("user_id, ig_user_id, access_token, token_expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (intentConnErr) {
      console.error("instagram-post: intent connection lookup failed: " + intentConnErr.message);
      return json({ error: "connection_lookup_failed" }, 500);
    }
    const intentConn = intentConnData as ConnectionRow | null;
    if (!intentConn || !intentConn.access_token || !intentConn.ig_user_id) {
      return json(
        { error: "instagram_not_connected", message: "Connect Instagram in Settings first." },
        409,
      );
    }
    if (intentConn.token_expires_at && Date.parse(intentConn.token_expires_at) < Date.now()) {
      return json(
        {
          error: "instagram_token_expired",
          message: "Instagram login expired — reconnect Instagram in Settings.",
        },
        409,
      );
    }
    // One live intent per car: an existing awaiting_reel row for
    // this VIN already is the intent — return it, never duplicate.
    const { data: existing } = await db
      .from("instagram_posts")
      .select("id")
      .eq("user_id", userId)
      .eq("vin", vin)
      .eq("status", "awaiting_reel")
      .order("created_at", { ascending: true })
      .limit(1);
    if (existing && existing.length) {
      return json({ ok: true, intent_id: existing[0].id, status: "awaiting_reel", deduped: true });
    }
    const { data: inserted, error: insErr } = await db
      .from("instagram_posts")
      .insert({
        user_id: userId, vin, stock_number: stockNumber, kind: "reel",
        media_id: null, container_id: null, status: "awaiting_reel",
        error_code: null, error_message: null,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("instagram-post: intent record failed: " + (insErr?.message ?? "no row returned"));
      return json({ error: "intent_record_failed" }, 500);
    }
    return json({ ok: true, intent_id: inserted.id, status: "awaiting_reel" });
  }

  const shapes = [imageUrl ? 1 : 0, imageUrls.length ? 1 : 0, videoUrl ? 1 : 0]
    .reduce((a, b) => a + b, 0);
  if (shapes !== 1) {
    return json(
      { error: "send_exactly_one_of_image_url_image_urls_or_video_url" },
      400,
    );
  }
  if (imageUrls.length === 1) {
    return json(
      { error: "carousel_needs_at_least_two_images", message: "Send a single photo as image_url instead." },
      400,
    );
  }
  if (imageUrls.length > MAX_CAROUSEL_ITEMS) {
    imageUrls = imageUrls.slice(0, MAX_CAROUSEL_ITEMS);
  }
  const allUrls = videoUrl ? [videoUrl] : imageUrls.length ? imageUrls : [imageUrl];
  if (!allUrls.every((u) => /^https:\/\//i.test(u))) {
    return json({ error: "media_url_must_be_public_https" }, 400);
  }
  const kind = videoUrl ? "reel" : imageUrls.length ? "carousel" : "photo";

  // Load the caller's Instagram connection.
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
    await recordOutcome(db, {
      user_id: userId, vin, stock_number: stockNumber, kind,
      media_id: null, container_id: null, status: "failed",
      error_code: "instagram_not_connected",
      error_message: "Connect Instagram in Settings first.",
    }, intentId);
    return json(
      { error: "instagram_not_connected", message: "Connect Instagram in Settings first." },
      409,
    );
  }
  if (conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now()) {
    await recordOutcome(db, {
      user_id: userId, vin, stock_number: stockNumber, kind,
      media_id: null, container_id: null, status: "failed",
      error_code: "instagram_token_expired",
      error_message: "Instagram login expired — reconnect Instagram in Settings.",
    }, intentId);
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

  // Shared failure exit: classify, record, and answer honestly. The
  // Graph message is always carried verbatim in `message`.
  async function failWith(
    step: string,
    body: GraphBody,
    containerId: string | null,
  ): Promise<Response> {
    const err = body?.error;
    const message = err?.message ?? "Meta returned an error.";
    const code = err?.code ?? null;
    console.error(`instagram-post: ${step} failed: ${code ?? "?"} ${message}`);
    if (isPermissionError(body)) {
      await recordOutcome(db, {
        user_id: userId, vin, stock_number: stockNumber, kind,
        media_id: null, container_id: containerId, status: "permission_pending",
        error_code: "instagram_permission_pending", error_message: message,
      }, intentId);
      return json(
        {
          ok: false,
          error: "instagram_permission_pending",
          step,
          code,
          message,
          detail:
            "Instagram posting is awaiting Meta's App Review approval for the " +
            "instagram_content_publish permission. The post was not published.",
        },
        403,
      );
    }
    await recordOutcome(db, {
      user_id: userId, vin, stock_number: stockNumber, kind,
      media_id: null, container_id: containerId, status: "failed",
      error_code: code !== null ? String(code) : "meta_error",
      error_message: message,
    }, intentId);
    return json({ error: "meta_error", step, code, message }, 502);
  }

  // 1) Create the media container(s). A Reel posts as media_type
  //    REELS; a carousel is one child container per photo plus a
  //    CAROUSEL parent; a single photo posts as-is.
  let creationId = "";
  if (kind === "reel") {
    const created = await graphPost(`/${igUserId}/media`, accessToken, {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
    });
    if (!created.res.ok || !created.body?.id) {
      return failWith("media_create", created.body, null);
    }
    creationId = created.body.id;
  } else if (kind === "carousel") {
    const childIds: string[] = [];
    for (const url of imageUrls) {
      const child = await graphPost(`/${igUserId}/media`, accessToken, {
        image_url: url,
        is_carousel_item: "true",
      });
      if (!child.res.ok || !child.body?.id) {
        return failWith("media_create_child", child.body, null);
      }
      childIds.push(child.body.id);
    }
    const parent = await graphPost(`/${igUserId}/media`, accessToken, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption,
    });
    if (!parent.res.ok || !parent.body?.id) {
      return failWith("media_create", parent.body, null);
    }
    creationId = parent.body.id;
  } else {
    const created = await graphPost(`/${igUserId}/media`, accessToken, {
      image_url: imageUrl,
      caption,
    });
    if (!created.res.ok || !created.body?.id) {
      return failWith("media_create", created.body, null);
    }
    creationId = created.body.id;
  }

  // 2) Video and carousel containers are processed asynchronously:
  //    poll until FINISHED. Photo containers are ready immediately;
  //    skip the poll for them.
  if (kind !== "photo") {
    const statusCode = await pollContainer(accessToken, creationId);
    if (statusCode === "ERROR") {
      return failWith("media_processing", { error: { message: "Meta reported the media container in ERROR state while processing." } }, creationId);
    }
    if (statusCode !== "FINISHED") {
      await recordOutcome(db, {
        user_id: userId, vin, stock_number: stockNumber, kind,
        media_id: null, container_id: creationId, status: "failed",
        error_code: "media_processing_timeout",
        error_message: "Instagram is still processing the media — retry the post shortly.",
      }, intentId);
      return json(
        {
          ok: false,
          creation_id: creationId,
          status: statusCode || "IN_PROGRESS",
          error: "media_processing_timeout",
          message: "Instagram is still processing the media — retry the post shortly.",
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
    return failWith("media_publish", published.body, creationId);
  }

  await recordOutcome(db, {
    user_id: userId, vin, stock_number: stockNumber, kind,
    media_id: mediaId, container_id: creationId, status: "published",
    error_code: null, error_message: null,
  }, intentId);
  return json({ ok: true, media_id: mediaId, kind });
});
