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


// =====================================================================
// [IG-AUTO-354] Auto-Instagram (Matthew, 2026-11-20): "Also post to
// Instagram, like Marketplace." Three pieces live here:
//   1. holdIntent — the one way an auto-post intent is held, shared
//      by the JWT intent mode above and the finisher's auto pass,
//      with the one-post-per-car dedupe (awaiting_reel OR published
//      already satisfies a car — never duplicate either).
//   2. A publish-path guard (in the handler): a stale intent_id, or
//      a live intent the caller didn't carry, turns a publish away
//      with intent_already_resolved so a second tap/tab can't slip
//      a duplicate past the finisher.
//   3. finishPending — the server-side finisher, invoked by cron as
//      { action: "finish_pending", secret } and gated by the
//      IG_FINISH_SECRET env (the luna-repairs sweep pattern; there
//      is deliberately NO user-JWT path into it, and it is the only
//      mode that runs without one). It parks intents for
//      automation-queued cars on opted-in accounts and completes
//      parked intents whose reels are ready — no app tab involved,
//      so a locked or closed PC can no longer freeze a post the
//      way it froze the client watcher on 2026-11-20.
// =====================================================================

type Db = ReturnType<typeof serviceClient>;

interface ConnCheck {
  conn: ConnectionRow | null;
  err: "lookup_failed" | "not_connected" | "token_expired" | null;
}

// The connection gate every intent/publish path shares: the row
// must exist with a token and an IG user id, and the token must
// not be expired. Same checks (and order) the intent mode has
// always made.
async function checkConnection(db: Db, userId: string): Promise<ConnCheck> {
  const { data, error } = await db
    .from("instagram_connections")
    .select("user_id, ig_user_id, access_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("instagram-post: connection lookup failed: " + error.message);
    return { conn: null, err: "lookup_failed" };
  }
  const conn = data as ConnectionRow | null;
  if (!conn || !conn.access_token || !conn.ig_user_id) {
    return { conn: null, err: "not_connected" };
  }
  if (conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now()) {
    return { conn: null, err: "token_expired" };
  }
  return { conn, err: null };
}

type HoldResult =
  | { kind: "held"; intentId: string; deduped: boolean }
  | { kind: "already_posted" }
  | { kind: "not_connected" }
  | { kind: "token_expired" }
  | { kind: "lookup_failed" }
  | { kind: "record_failed" };

// Hold (or find) the one live auto-post intent for a car. The
// insert is backstopped by the instagram_posts_one_live_intent
// partial unique index (awaiting_reel/finishing per user+VIN): a
// 23505 means a racing caller held it first — the deduped state.
async function holdIntent(
  db: Db,
  userId: string,
  vin: string,
  stockNumber: string | null,
): Promise<HoldResult> {
  const chk = await checkConnection(db, userId);
  if (chk.err === "lookup_failed") return { kind: "lookup_failed" };
  if (chk.err === "not_connected") return { kind: "not_connected" };
  if (chk.err === "token_expired") return { kind: "token_expired" };
  // One post per car, ever: already published is already done.
  const { data: posted } = await db
    .from("instagram_posts")
    .select("id")
    .eq("user_id", userId)
    .eq("vin", vin)
    .eq("status", "published")
    .limit(1);
  if (posted && posted.length) return { kind: "already_posted" };
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
    return { kind: "held", intentId: existing[0].id, deduped: true };
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
    if ((insErr as { code?: string } | null)?.code === "23505") {
      const { data: raced } = await db
        .from("instagram_posts")
        .select("id")
        .eq("user_id", userId)
        .eq("vin", vin)
        .eq("status", "awaiting_reel")
        .order("created_at", { ascending: true })
        .limit(1);
      if (raced && raced.length) {
        return { kind: "held", intentId: raced[0].id, deduped: true };
      }
    }
    console.error("instagram-post: intent record failed: " + (insErr?.message ?? "no row returned"));
    return { kind: "record_failed" };
  }
  return { kind: "held", intentId: inserted.id, deduped: false };
}

// The finisher's caption: instagramCaptionFor's exact recipe, built
// from the car's scraped_inventory row (server-side there is no
// browser car object). The car's own data only — nothing invented.
function buildCaption(car: Record<string, unknown> | null): string {
  if (!car) return "";
  const parts: string[] = [];
  const title = [car.year, car.make, car.model, car.trim]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (title) parts.push(title);
  if (car.price) parts.push("$" + Number(car.price).toLocaleString("en-US"));
  if (car.mileage) parts.push(Number(car.mileage).toLocaleString("en-US") + " miles");
  if (car.stock_number) parts.push("Stock #" + car.stock_number);
  if (car.location_name) parts.push(String(car.location_name));
  const tags = ["#AutoLaunch", "#CarsForSale"];
  if (car.make) tags.push("#" + String(car.make).replace(/[^A-Za-z0-9]/g, ""));
  parts.push(tags.join(" "));
  return parts.join("\n");
}

// Resolve a claimed intent row in place. The finisher owns the row
// once its claim lands; the status guard keeps the write honest if
// anything else resolved it first.
async function resolveIntentRow(
  db: Db,
  intentId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await db
      .from("instagram_posts")
      .update(fields)
      .eq("id", intentId)
      .eq("status", "finishing");
    if (error) console.error("instagram-post: intent resolve failed: " + error.message);
  } catch (e) {
    console.error("instagram-post: intent resolve threw: " + e);
  }
}

interface FinishSummary {
  parked: string[];
  reels_queued: string[];
  published: string[];
  closed: string[];
  resolved_failed: string[];
  reclaimed: number;
  skipped: number;
}

// Per-run caps: a publish can poll Meta for ~30s, so the finish
// pass stays small and the cron's cadence does the volume.
const FINISH_PUBLISH_LIMIT = 3;
const FINISH_PARK_LIMIT = 25;

async function latestReel(db: Db, userId: string, vin: string) {
  const { data } = await db
    .from("vin_reels")
    .select("id, status, video_url")
    .eq("user_id", userId)
    .eq("vin", vin)
    .order("created_at", { ascending: false })
    .limit(1);
  return data && data.length ? data[0] : null;
}

async function inventoryRow(db: Db, userId: string, vin: string) {
  const { data } = await db
    .from("scraped_inventory")
    .select("year, make, model, trim, price, mileage, stock_number, location_name, image_url, photos, custom_photo_urls, is_active")
    .eq("user_id", userId)
    .eq("vin", vin)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

function rowHasPhoto(car: Record<string, unknown> | null): boolean {
  if (!car) return false;
  if (typeof car.image_url === "string" && car.image_url) return true;
  if (Array.isArray(car.photos) && car.photos.length) return true;
  if (Array.isArray(car.custom_photo_urls) && car.custom_photo_urls.length) return true;
  return false;
}

// The app's exact vin_reels queue insert (instagramQueueReel's
// shape). A 23505 means a live reel already exists for the VIN —
// the state we wanted.
async function queueReelRow(
  db: Db,
  userId: string,
  vin: string,
  stockNumber: string | null,
): Promise<boolean> {
  const { error } = await db.from("vin_reels").insert({
    user_id: userId, vin, stock_number: stockNumber, status: "queued",
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return true;
    console.error("instagram-post: finisher reel queue failed: " + error.message);
    return false;
  }
  return true;
}

// Publish one claimed intent's ready reel through the stored
// connection, resolving the row in place with the publish path's
// exact status/error vocabulary (published / permission_pending /
// failed + Meta's code and verbatim message).
async function finishOneIntent(
  db: Db,
  intent: { id: string; user_id: string; vin: string | null; stock_number: string | null },
  videoUrl: string,
  summary: FinishSummary,
): Promise<void> {
  const userId = intent.user_id;
  const vin = intent.vin;
  const chk = await checkConnection(db, userId);
  if (chk.err || !chk.conn) {
    await resolveIntentRow(db, intent.id, {
      status: "failed",
      error_code: chk.err === "token_expired" ? "instagram_token_expired" : "instagram_not_connected",
      error_message: chk.err === "token_expired"
        ? "Instagram login expired — reconnect Instagram in Settings."
        : "Connect Instagram in Settings first.",
    });
    summary.resolved_failed.push(vin ?? "");
    return;
  }
  const accessToken = chk.conn.access_token as string;
  const igUserId = chk.conn.ig_user_id as string;
  const car = vin ? await inventoryRow(db, userId, vin) : null;
  const caption = buildCaption(car ?? (intent.stock_number ? { stock_number: intent.stock_number } : null));
  const stockNumber = intent.stock_number ?? ((car?.stock_number as string) ?? null);

  const failInPlace = async (body: GraphBody, containerId: string | null) => {
    const err = body?.error;
    const message = err?.message ?? "Meta returned an error.";
    const code = err?.code ?? null;
    console.error(`instagram-post: finisher publish failed: ${code ?? "?"} ${message}`);
    if (isPermissionError(body)) {
      await resolveIntentRow(db, intent.id, {
        status: "permission_pending", container_id: containerId,
        error_code: "instagram_permission_pending", error_message: message,
      });
    } else {
      await resolveIntentRow(db, intent.id, {
        status: "failed", container_id: containerId,
        error_code: code !== null ? String(code) : "meta_error", error_message: message,
      });
    }
    summary.resolved_failed.push(vin ?? "");
  };

  const created = await graphPost(`/${igUserId}/media`, accessToken, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
  });
  if (!created.res.ok || !created.body?.id) {
    await failInPlace(created.body, null);
    return;
  }
  const creationId = created.body.id;
  const statusCode = await pollContainer(accessToken, creationId);
  if (statusCode === "ERROR") {
    await failInPlace(
      { error: { message: "Meta reported the media container in ERROR state while processing." } },
      creationId,
    );
    return;
  }
  if (statusCode !== "FINISHED") {
    await resolveIntentRow(db, intent.id, {
      status: "failed", container_id: creationId,
      error_code: "media_processing_timeout",
      error_message: "Instagram is still processing the media — retry the post shortly.",
    });
    summary.resolved_failed.push(vin ?? "");
    return;
  }
  const published = await graphPost(`/${igUserId}/media_publish`, accessToken, {
    creation_id: creationId,
  });
  const mediaId = published.body?.id as string | undefined;
  if (!published.res.ok || !mediaId) {
    await failInPlace(published.body, creationId);
    return;
  }
  await resolveIntentRow(db, intent.id, {
    status: "published", media_id: mediaId, container_id: creationId,
    stock_number: stockNumber, error_code: null, error_message: null,
  });
  summary.published.push(vin ?? "");
}

// The finisher itself. dryRun reports the same decisions with no
// writes and no Meta calls.
async function finishPending(db: Db, dryRun: boolean): Promise<FinishSummary> {
  const summary: FinishSummary = {
    parked: [], reels_queued: [], published: [], closed: [],
    resolved_failed: [], reclaimed: 0, skipped: 0,
  };

  // 0) Reclaim abandoned claims: a finisher that died mid-publish
  //    leaves its intent at "finishing". Past 30 minutes the claim
  //    is certainly dead — resolve it FAILED rather than re-firing:
  //    the publish may have reached Meta, and a double post is the
  //    one outcome this build exists to prevent. The owner re-taps
  //    if the car truly never appeared.
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: stale } = await db
    .from("instagram_posts")
    .select("id")
    .eq("status", "finishing")
    .lt("created_at", staleBefore);
  if (stale && stale.length) {
    summary.reclaimed = stale.length;
    if (!dryRun) {
      for (const row of stale) {
        await db
          .from("instagram_posts")
          .update({
            status: "failed",
            error_code: "finisher_interrupted",
            error_message: "The server-side Instagram finisher was interrupted mid-post; if this car never appeared on Instagram, tap its Instagram button to post it.",
          })
          .eq("id", row.id)
          .eq("status", "finishing");
      }
    }
  }

  // A) AUTO PASS — for every account that opted in ("Also post to
  //    Instagram") and has a live connection, park the shared-path
  //    intent for each car the automation queued for Marketplace,
  //    and queue the render behind it when no live reel exists.
  const { data: autoUsers } = await db
    .from("user_settings")
    .select("user_id")
    .eq("instagram_auto_post_enabled", true);
  let parks = 0;
  for (const u of autoUsers ?? []) {
    if (parks >= FINISH_PARK_LIMIT) break;
    const userId = u.user_id as string;
    const chk = await checkConnection(db, userId);
    if (chk.err) continue; // not connected / expired / unreadable — nothing to park
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: qrows } = await db
      .from("auto_posting_queue")
      .select("vin, stock_num, created_at")
      .eq("user_id", userId)
      .eq("target_channel", "marketplace")
      .eq("post_origin", "auto")
      .in("status", ["pending", "processing"])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(50);
    const seen = new Set<string>();
    for (const q of qrows ?? []) {
      if (parks >= FINISH_PARK_LIMIT) break;
      const vin = q.vin as string | null;
      if (!vin || seen.has(vin)) continue;
      seen.add(vin);
      // One post per car, ever: a live intent or a published row
      // already satisfies this car. Any row from the last 24h is a
      // recent attempt (failed / permission-pending) still cooling
      // down — never re-park over it.
      const { data: prior } = await db
        .from("instagram_posts")
        .select("status, created_at")
        .eq("user_id", userId)
        .eq("vin", vin)
        .order("created_at", { ascending: false })
        .limit(5);
      const priorRows = prior ?? [];
      if (priorRows.some((r) => r.status === "awaiting_reel" || r.status === "finishing" || r.status === "published")) {
        summary.skipped++;
        continue;
      }
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      if (priorRows.some((r) => Date.parse(r.created_at as string) > dayAgo)) {
        summary.skipped++;
        continue;
      }
      const car = await inventoryRow(db, userId, vin);
      if (!car || car.is_active === false || !rowHasPhoto(car)) {
        summary.skipped++;
        continue;
      }
      if (dryRun) {
        summary.parked.push(vin);
        parks++;
        continue;
      }
      const held = await holdIntent(
        db, userId, vin,
        (car.stock_number as string) ?? (q.stock_num as string) ?? null,
      );
      if (held.kind !== "held") {
        summary.skipped++;
        continue;
      }
      summary.parked.push(vin);
      parks++;
      const reel = await latestReel(db, userId, vin);
      const liveReel = reel && (reel.status === "queued" || reel.status === "generating" || reel.status === "ready");
      if (!liveReel) {
        if (await queueReelRow(db, userId, vin, (car.stock_number as string) ?? null)) {
          summary.reels_queued.push(vin);
        }
      }
    }
  }

  // B) FINISH PASS — every parked intent (manual or auto), oldest
  //    first: claim it atomically, then let its reel's state decide.
  const { data: intents } = await db
    .from("instagram_posts")
    .select("id, user_id, vin, stock_number, created_at")
    .eq("status", "awaiting_reel")
    .order("created_at", { ascending: true })
    .limit(FINISH_PUBLISH_LIMIT);
  for (const intent of intents ?? []) {
    const userId = intent.user_id as string;
    const vin = intent.vin as string | null;
    if (!vin) {
      summary.skipped++;
      continue;
    }
    const reel = await latestReel(db, userId, vin);
    if (!reel) {
      // The render row vanished under a held intent — re-queue it
      // (the client watcher's own remedy) and keep waiting.
      const car = await inventoryRow(db, userId, vin);
      if (car && car.is_active !== false && rowHasPhoto(car) && !dryRun) {
        if (await queueReelRow(db, userId, vin, (car.stock_number as string) ?? intent.stock_number ?? null)) {
          summary.reels_queued.push(vin);
        }
      }
      summary.skipped++;
      continue;
    }
    if (reel.status === "failed") {
      if (!dryRun) {
        const { error } = await db
          .from("instagram_posts")
          .update({
            status: "failed",
            error_code: "reel_render_failed",
            error_message: "Auto-post intent closed before publishing: reel_render_failed",
          })
          .eq("id", intent.id)
          .eq("status", "awaiting_reel");
        if (error) {
          summary.skipped++;
          continue;
        }
      }
      summary.closed.push(vin);
      continue;
    }
    if (reel.status !== "ready" || !reel.video_url) {
      summary.skipped++;
      continue;
    }
    if (dryRun) {
      summary.published.push(vin);
      continue;
    }
    // Claim the intent atomically: exactly one finisher may
    // publish it, and the publish-path guard turns the client
    // watcher away once the row leaves awaiting_reel.
    const { data: claimed, error: claimErr } = await db
      .from("instagram_posts")
      .update({ status: "finishing" })
      .eq("id", intent.id)
      .eq("status", "awaiting_reel")
      .select("id");
    if (claimErr || !claimed || !claimed.length) {
      summary.skipped++;
      continue;
    }
    await finishOneIntent(
      db,
      { id: intent.id, user_id: userId, vin, stock_number: intent.stock_number ?? null },
      reel.video_url as string,
      summary,
    );
  }
  return summary;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // [IG-AUTO-354] The body is read once, up front: the finisher
  // mode below is secret-gated and runs WITHOUT a user JWT (it is
  // invoked by a cron), and every other mode keeps its exact
  // JWT-first behavior — the parse result is reused, never re-read,
  // and a parse failure still answers invalid_json at the same
  // point it always has (after auth).
  let parsedBody: Record<string, unknown> | null = null;
  let bodyParseFailed = false;
  try {
    parsedBody = await req.json();
  } catch {
    bodyParseFailed = true;
  }
  if (!bodyParseFailed && parsedBody?.action === "finish_pending") {
    const finishSecret = Deno.env.get("IG_FINISH_SECRET") ?? "";
    if (!finishSecret || parsedBody?.secret !== finishSecret) {
      return json({ error: "unauthorized" }, 401);
    }
    const summary = await finishPending(
      serviceClient(),
      parsedBody?.dry_run === true,
    );
    return json({ ok: true, dry_run: parsedBody?.dry_run === true, ...summary });
  }

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
    const body = parsedBody;
    if (bodyParseFailed) throw new Error("invalid_json");
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
    // [IG-AUTO-354] The connection checks, the one-post-per-car
    // dedupe and the insert live in holdIntent now — shared with
    // the finisher's auto pass so an intent is held identically
    // whichever path parks it. The answers are the ones this mode
    // has always given, plus one: a car that already published
    // reports already_posted instead of holding a second intent.
    const held = await holdIntent(db, userId, vin, stockNumber);
    if (held.kind === "lookup_failed") {
      return json({ error: "connection_lookup_failed" }, 500);
    }
    if (held.kind === "not_connected") {
      return json(
        { error: "instagram_not_connected", message: "Connect Instagram in Settings first." },
        409,
      );
    }
    if (held.kind === "token_expired") {
      return json(
        {
          error: "instagram_token_expired",
          message: "Instagram login expired — reconnect Instagram in Settings.",
        },
        409,
      );
    }
    if (held.kind === "already_posted") {
      return json({ ok: true, already_posted: true, status: "published" });
    }
    if (held.kind === "record_failed") {
      return json({ error: "intent_record_failed" }, 500);
    }
    return json(
      held.deduped
        ? { ok: true, intent_id: held.intentId, status: "awaiting_reel", deduped: true }
        : { ok: true, intent_id: held.intentId, status: "awaiting_reel" },
    );
  }

  // [IG-AUTO-354] Publish-path intent guard: while an intent for
  // this car is live, exactly one finisher owns the publish. A
  // publish carrying a stale intent_id (already claimed or
  // resolved), or carrying none while a live intent exists, is
  // turned away — the parked intent completes server-side instead,
  // and no second post slips out of a second tap or second tab.
  if (intentId) {
    const { data: intentRow } = await db
      .from("instagram_posts")
      .select("id, status")
      .eq("id", intentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (intentRow && intentRow.status !== "awaiting_reel") {
      return json(
        { ok: false, error: "intent_already_resolved", status: intentRow.status },
        409,
      );
    }
  } else if (vin) {
    const { data: liveIntent } = await db
      .from("instagram_posts")
      .select("id")
      .eq("user_id", userId)
      .eq("vin", vin)
      .in("status", ["awaiting_reel", "finishing"])
      .limit(1);
    if (liveIntent && liveIntent.length) {
      return json({ ok: false, error: "intent_already_resolved" }, 409);
    }
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
