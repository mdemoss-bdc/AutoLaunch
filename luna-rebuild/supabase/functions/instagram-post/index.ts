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
//   - Reel containers carry thumb_offset (see REEL_THUMB_OFFSET
//     below): the grid cover comes from inside the title card,
//     never the black frame 0.
//   - User tokens are long-lived (~60 days) and are NOT refreshable
//     in place the way TikTok's are — an expired token means the rep
//     reconnects Instagram in Settings (instagram-auth /exchange).
//
// [IG-UVID-357] A car's own uploaded video (Your Video —
// user_vehicle_videos, normalized into the PRIVATE user-videos
// bucket) outranks the rendered VIN Reel on Instagram too, the
// same precedence Marketplace has had since .166: when a Reel
// container is created for a car whose latest user video is
// ready, the container carries the user's video. Because Meta
// fetches media from a public URL and the bucket is private,
// the function stages a copy in the PUBLIC vin-reels bucket at
// <user_id>/<vin>-ig-<user_video_row_id>.mp4 — at intent-hold
// time and again at publish time — so a Marketplace consume
// (which deletes the private object and nulls the row's paths)
// can never strand a pending Instagram post. Resolution is
// fail-open: any miss falls back to the rendered reel, exactly
// as before. See ensureInstagramUserVideo.
//
// [IG-RACE-358] Duplicate-post race (proven live 2026-11-20 on
// the Sierra: one intent, two published posts — the client
// watcher and this finisher published the same intent seconds
// apart). The handler publish path now CLAIMS an intent
// atomically (awaiting_reel -> finishing) before any container
// work, so exactly one publisher ever proceeds; the loser gets
// the existing 409 intent_already_resolved. A direct publish
// (no intent) for a car that already has a published row is
// refused with the intent mode's already_posted answer — the
// re-tap-after-success duplicate class dies here too.
//
// [IG-SOLD-359] Sold = ads down everywhere (Matthew, 2026-11-21):
// when a vehicle sells or exits the feed, its Instagram post comes
// down too — the same rule Marketplace has always had, gated by
// the SAME user_settings.auto_delete_on_exit_enabled switch (no
// new setting, no per-platform toggle). The finisher's sold sweep
// (inside finish_pending, so no new cron) closes awaiting_reel
// intents for sold/exited cars before they can publish, and
// deletes published posts via DELETE /{media-id}. Deletion is
// two-sweep confirmed (a candidate mark on one pass, the delete
// on a later pass where the car still reads sold/exited) so a
// feed glitch can never wipe a grid. Meta gates DELETE behind
// instagram_manage_contents — NOT in the submitted App Review
// draft; until that round passes, deletes land only for app-role
// accounts (the owner unlock), and everyone else's rows park at
// delete_permission_pending instead of retrying every run.
//
// [IG-SOLDLOCK-362] The same switch carries a per-account
// sold MODE (user_settings.ig_sold_mode, default "delete").
// Accounts in "mark" mode keep the post up as social proof:
// on the confirming sweep the finisher simply locks the
// post's comments (comment_enabled=false) — no comment (the
// v11 comment design died on live proof that closing a
// post's replies hides every reply already on it, including
// a SOLD reply), no delete, no repost (the v12 caption
// repost died on the owner's call: a repost takes the
// newest grid slot and a fresh feed push for a car that
// can't be bought, pushing for-sale cars down). The post
// keeps its slot, date and likes; the lock IS the marker,
// and every caption the finisher publishes for a mark-mode
// account carries the legend line that explains what a
// locked post means (see SOLD_CAPTION_LEGEND).
// "sold_reposted" remains a recognized terminal status —
// one live row carries it (the Tundra's v12 replacement)
// and it stays invisible to all machinery. The candidate
// discipline, the shared per-run budget and the close-out
// phase are mode-independent.
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

// [IG-COVER-356] Reel grid cover (Matthew, 2026-11-20): a VIN
// Reel's frame 0 is pure black — the render fades in from
// black over 0.4s and the title card reaches full strength at
// ~0.9s, holding until 3.3s (generator.py: TITLE_DUR 3.3,
// title_alpha, head gain) — and Instagram takes frame 0 as
// the grid cover when no offset is given, so the Reels grid
// showed black tiles until a reel was tapped. thumb_offset
// (milliseconds) moves the cover to 1.5s in: past the fade,
// comfortably inside the title card. It rides BOTH REELS
// container-creation sites below — the handler's publish
// path and the finisher's finishOneIntent — via this one
// constant, so the two paths can never drift apart.
const REEL_THUMB_OFFSET = "1500";

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
      // update its row in place so one row carries the whole
      // lifecycle (awaiting_reel -> outcome). If the row was
      // already resolved, fall back to a fresh outcome row —
      // the result is never lost.
      // [IG-RACE-358] The match now also accepts "finishing":
      // the handler publish path CLAIMS its intent
      // (awaiting_reel -> finishing) before creating anything,
      // and the outcome must resolve from that claimed state.
      // recordOutcome is handler-only — the finisher resolves
      // through resolveIntentRow (its own finishing guard,
      // unchanged) and intent_close keeps its awaiting_reel
      // guard, so neither path's semantics move.
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
        .in("status", ["awaiting_reel", "finishing"])
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

// [IG-SOLD-359] DELETE on a Graph object — the sold sweep's one
// call (DELETE /{ig-media-id}). Same version handling as every
// other Graph call in this function (GRAPH_VERSION, v21.0 by
// default); the version is deliberately NOT bumped for delete
// alone — whether v21 serves DELETE is what the first live
// proof answers.
async function graphDelete(
  path: string,
  accessToken: string,
): Promise<{ res: Response; body: GraphBody }> {
  const url = `${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, { method: "DELETE" });
  let body: GraphBody = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { res, body };
}

// [IG-SOLD-359] A DELETE failure is the not-yet-approved
// permission state when Meta says the app lacks the contents
// permission: the delete sibling of isPermissionError, naming
// instagram_manage_contents instead of instagram_content_publish.
// Token failures (code 190) are NOT this.
function isDeletePermissionError(body: GraphBody): boolean {
  const err = body?.error;
  if (!err) return false;
  if (err.code === 190) return false;
  const msg = `${err.message ?? ""}`;
  if (/instagram_manage_contents/i.test(msg)) return true;
  if ((err.code === 10 || err.code === 200) && err.type === "OAuthException") return true;
  if ((err.code === 10 || err.code === 200) && /permission/i.test(msg)) return true;
  return false;
}

// [IG-SOLDLOCK-362] The mark path's permission classifier: the
// same shape as isDeletePermissionError, naming
// instagram_manage_comments — the permission the comment lock
// rides on. Token failures (code 190) are NOT this.
function isMarkPermissionError(body: GraphBody): boolean {
  const err = body?.error;
  if (!err) return false;
  if (err.code === 190) return false;
  const msg = `${err.message ?? ""}`;
  if (/instagram_manage_comments/i.test(msg)) return true;
  if ((err.code === 10 || err.code === 200) && err.type === "OAuthException") return true;
  if ((err.code === 10 || err.code === 200) && /permission/i.test(msg)) return true;
  return false;
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


interface ReelPublishResult {
  ok: boolean;
  mediaId?: string;
  containerId?: string | null;
  body?: GraphBody;
  timeout?: boolean;
}

// Create, process and publish one Reel container — the
// finisher's single container path, so media selection,
// cover offset and Meta error shapes cannot drift apart.
async function publishReel(
  accessToken: string,
  igUserId: string,
  videoUrl: string,
  caption: string,
): Promise<ReelPublishResult> {
  const created = await graphPost(`/${igUserId}/media`, accessToken, {
    media_type: "REELS",
    video_url: videoUrl,
    thumb_offset: REEL_THUMB_OFFSET,
    caption,
  });
  if (!created.res.ok || !created.body?.id) {
    return { ok: false, body: created.body, containerId: null };
  }
  const creationId = created.body.id;
  const statusCode = await pollContainer(accessToken, creationId);
  if (statusCode === "ERROR") {
    return {
      ok: false,
      containerId: creationId,
      body: { error: { message: "Meta reported the media container in ERROR state while processing." } },
    };
  }
  if (statusCode !== "FINISHED") {
    return {
      ok: false,
      timeout: true,
      containerId: creationId,
      body: { error: { message: "Instagram is still processing the media — retry the post shortly." } },
    };
  }
  const published = await graphPost(`/${igUserId}/media_publish`, accessToken, {
    creation_id: creationId,
  });
  const mediaId = published.body?.id as string | undefined;
  if (!published.res.ok || !mediaId) {
    return { ok: false, body: published.body, containerId: creationId };
  }
  return { ok: true, mediaId, containerId: creationId };
}

// Resolve the video a Reel publish for this car must use: the
// user's own ready/staged video first, then an explicit fallback
// supplied by the caller, then the latest ready rendered reel.
async function resolveReelVideoUrl(
  db: Db,
  userId: string,
  vin: string,
  fallbackUrl: string | null,
): Promise<string | null> {
  const userVideoUrl = await ensureInstagramUserVideo(db, userId, vin);
  if (userVideoUrl) return userVideoUrl;
  if (fallbackUrl) return fallbackUrl;
  const reel = await latestReel(db, userId, vin);
  if (reel && reel.status === "ready" && reel.video_url) {
    return reel.video_url as string;
  }
  return null;
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
    // [IG-UVID-357] An intent is live for this car: stage the
    // public copy of its user video NOW, while the private
    // object certainly exists — a Marketplace consume can
    // delete it long before this intent publishes. Best-effort
    // by design (the resolver never throws and its result is
    // not needed to hold the intent).
    await ensureInstagramUserVideo(db, userId, vin);
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
        await ensureInstagramUserVideo(db, userId, vin);
        return { kind: "held", intentId: raced[0].id, deduped: true };
      }
    }
    console.error("instagram-post: intent record failed: " + (insErr?.message ?? "no row returned"));
    return { kind: "record_failed" };
  }
  await ensureInstagramUserVideo(db, userId, vin);
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

// [IG-SOLDLOCK-362] The caption legend for mark-mode accounts:
// printed on every caption the finisher publishes for them,
// as its own line just above the hashtags. When a car sells,
// its post's comments are locked — the lock is the marker,
// and this line is what tells a viewer what a locked post
// means. The sentence is Matthew's wording (2026-11-21),
// rendered in Unicode mathematical bold (Instagram captions
// have no markdown bold) with a 💥 at each end.
const SOLD_CAPTION_LEGEND =
  "💥 𝐈𝐟 𝐜𝐨𝐦𝐦𝐞𝐧𝐭𝐬 𝐚𝐫𝐞 𝐥𝐨𝐜𝐤𝐞𝐝, 𝐭𝐡𝐢𝐬 𝐯𝐞𝐡𝐢𝐜𝐥𝐞 𝐢𝐬 𝐧𝐨 𝐥𝐨𝐧𝐠𝐞𝐫 𝐚𝐯𝐚𝐢𝐥𝐚𝐛𝐥𝐞, 𝐨𝐫 𝐡𝐚𝐬 𝐛𝐞𝐞𝐧 𝐬𝐨𝐥𝐝 💥";

// Insert the legend as its own line immediately above the
// caption's hashtag line (the final line of our captions).
// A caption with no hashtag line gets the legend as its
// final line instead; an empty caption stays empty.
function applySoldLegend(caption: string, enabled: boolean): string {
  if (!enabled || !caption) return caption;
  const lines = caption.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last.trimStart().startsWith("#")) {
    lines.splice(lines.length - 1, 0, SOLD_CAPTION_LEGEND);
  } else {
    lines.push(SOLD_CAPTION_LEGEND);
  }
  return lines.join("\n");
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
  // [IG-SOLD-359] The sold sweep's outcomes, by VIN.
  sold_closed: string[];
  sold_marked: string[];
  sold_unmarked: string[];
  sold_deleted: string[];
  sold_delete_pending: string[];
  sold_delete_failed: string[];
  // [IG-SOLDMARK-360] The mark mode's outcomes, by VIN.
  marked: string[];
  mark_pending: string[];
  mark_failed: string[];
}

// Per-run caps: a publish can poll Meta for ~30s, so the finish
// pass stays small and the cron's cadence does the volume.
const FINISH_PUBLISH_LIMIT = 3;
const FINISH_PARK_LIMIT = 25;

// =====================================================================
// [IG-SOLD-359] The sold sweep — two phases inside finish_pending,
// sharing one per-run action budget (SOLD_SWEEP_LIMIT, mirroring
// the exit-delete cap on the Marketplace side):
//
//   soldSweepCloseIntents runs after the auto pass and BEFORE the
//   finish pass: an awaiting_reel intent whose car is now Sold or
//   inactive is closed with the intent_close vocabulary
//   (failed / vehicle_sold), so the finish pass can never publish
//   a car that already sold. This phase is NOT gated by the
//   auto-delete setting — the setting governs takedown of live
//   posts, not whether a sold car gets posted in the first place.
//
//   soldSweepPublished runs after the finish pass: every
//   published row (duplicates included — never stop at the first
//   row for a VIN) whose car reads Sold/inactive, on an account
//   whose auto_delete_on_exit_enabled switch is on, is taken
//   down in two passes. Pass one only MARKS the row
//   (error_code "sold_delete_candidate"); a later pass where the
//   car STILL reads sold/inactive executes the DELETE. A car
//   that comes back (deal unwinds, trade returns) has its mark
//   cleared instead. Outcomes: success -> status "deleted";
//   Meta permission error -> status "delete_permission_pending"
//   (out of the sweep's selection for good — no per-run retry
//   while instagram_manage_contents awaits its review round);
//   any other Meta error -> the row stays published with
//   error_code "sold_delete_error" and is parked out of the
//   sweep, surfaced in the finisher summary.
//
//   [IG-SOLDLOCK-362] In "mark" mode the confirming pass
//   performs the comment lock instead of a delete: one
//   comment_enabled=false POST, nothing else — the post
//   stays up with its slot, date and likes, and the caption
//   legend (printed at publish time on every mark-mode
//   post) explains that a locked post means sold. A
//   comments-permission refusal parks the row at
//   "mark_permission_pending" (out of the sweep's selection
//   for good — the v11 semantics); any other Meta error
//   parks it at "sold_mark_error" with Meta's message
//   verbatim. A legacy v11 partial (error_code
//   "sold_comment_posted") is a confirmed candidate like
//   any other and completes via the lock — its hidden
//   comment is harmless.
// =====================================================================

const SOLD_SWEEP_LIMIT = 25;
const SOLD_DELETE_CANDIDATE = "sold_delete_candidate";
// Legacy v11 partial state (a SOLD reply landed but its
// follow-up step failed). Rows carrying it are treated as
// confirmed candidates and completed by the comment lock.
const LEGACY_SOLD_COMMENT_POSTED = "sold_comment_posted";

// The canonical sold/exit read (the Marketplace contract): the
// app writes status "Sold" on a manual mark-sold (comparisons
// lowercase it) and is_active=false on a feed exit or manual
// remove. known=false when the inventory row itself is gone —
// no positive evidence either way, and the sweep never acts on
// an unconfirmed state.
async function inventoryState(
  db: Db,
  userId: string,
  vin: string,
): Promise<{ known: boolean; sold: boolean }> {
  const { data } = await db
    .from("scraped_inventory")
    .select("status, is_active")
    .eq("user_id", userId)
    .eq("vin", vin)
    .maybeSingle();
  if (!data) return { known: false, sold: false };
  const status = (data as { status?: unknown }).status;
  const isActive = (data as { is_active?: unknown }).is_active;
  const sold =
    (typeof status === "string" && status.toLowerCase() === "sold") ||
    isActive === false;
  return { known: true, sold };
}

// The Marketplace takedown switch itself — the same
// user_settings.auto_delete_on_exit_enabled the scraper's exit
// pass reads — plus [IG-SOLDMARK-360] the per-account sold mode
// (user_settings.ig_sold_mode). A missing settings row reads as
// the columns' own defaults (switch on, mode "delete"); any mode
// value other than "mark" reads as "delete".
async function soldSweepSettings(
  db: Db,
  userId: string,
): Promise<{ enabled: boolean; mode: "delete" | "mark" }> {
  const { data } = await db
    .from("user_settings")
    .select("auto_delete_on_exit_enabled, ig_sold_mode")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { enabled: true, mode: "delete" };
  const row = data as {
    auto_delete_on_exit_enabled?: unknown;
    ig_sold_mode?: unknown;
  };
  return {
    enabled: row.auto_delete_on_exit_enabled !== false,
    mode: row.ig_sold_mode === "mark" ? "mark" : "delete",
  };
}

async function soldSweepCloseIntents(
  db: Db,
  summary: FinishSummary,
  dryRun: boolean,
  budget: { used: number },
): Promise<void> {
  const { data: intents } = await db
    .from("instagram_posts")
    .select("id, user_id, vin")
    .eq("status", "awaiting_reel")
    .order("created_at", { ascending: true })
    .limit(SOLD_SWEEP_LIMIT);
  for (const intent of intents ?? []) {
    if (budget.used >= SOLD_SWEEP_LIMIT) break;
    const vin = intent.vin as string | null;
    if (!vin) continue;
    const state = await inventoryState(db, intent.user_id as string, vin);
    if (!state.known || !state.sold) continue;
    budget.used++;
    if (dryRun) {
      summary.sold_closed.push(vin);
      continue;
    }
    const { data: closed, error } = await db
      .from("instagram_posts")
      .update({
        status: "failed",
        error_code: "vehicle_sold",
        error_message: "Auto-post intent closed before publishing: vehicle_sold",
      })
      .eq("id", intent.id)
      .eq("status", "awaiting_reel")
      .select("id");
    if (error || !closed || !closed.length) {
      summary.skipped++;
      continue;
    }
    summary.sold_closed.push(vin);
  }
}

async function soldSweepPublished(
  db: Db,
  summary: FinishSummary,
  dryRun: boolean,
  budget: { used: number },
): Promise<void> {
  const { data: rows } = await db
    .from("instagram_posts")
    .select("id, user_id, vin, stock_number, media_id, error_code, error_message")
    .eq("status", "published")
    .order("created_at", { ascending: true })
    .limit(100);
  const settingCache = new Map<string, { enabled: boolean; mode: "delete" | "mark" }>();
  const stateCache = new Map<string, { known: boolean; sold: boolean }>();

  for (const row of rows ?? []) {
    const userId = row.user_id as string;
    const vin = row.vin as string | null;
    const mediaId = row.media_id as string | null;
    if (!vin || !mediaId) continue;
    const errorCode = (row.error_code as string | null) ?? null;

    const stateKey = userId + "|" + vin;
    let state = stateCache.get(stateKey);
    if (!state) {
      state = await inventoryState(db, userId, vin);
      stateCache.set(stateKey, state);
    }
    if (!state.known) continue;
    if (!state.sold) {
      // The car came back: a stale candidate mark is cleared so
      // a later genuine sale starts the two-sweep confirmation
      // fresh. Nothing else about the row changes.
      if (errorCode !== SOLD_DELETE_CANDIDATE) continue;
      if (budget.used >= SOLD_SWEEP_LIMIT) break;
      budget.used++;
      if (!dryRun) {
        const { error } = await db
          .from("instagram_posts")
          .update({ error_code: null, error_message: null })
          .eq("id", row.id)
          .eq("status", "published")
          .eq("error_code", SOLD_DELETE_CANDIDATE);
        if (error) {
          summary.skipped++;
          continue;
        }
      }
      summary.sold_unmarked.push(vin);
      continue;
    }
    let settings = settingCache.get(userId);
    if (settings === undefined) {
      settings = await soldSweepSettings(db, userId);
      settingCache.set(userId, settings);
    }
    if (!settings.enabled) continue;
    if (errorCode === SOLD_DELETE_CANDIDATE || errorCode === LEGACY_SOLD_COMMENT_POSTED) {
      // Second consecutive sold read: the action itself — the
      // delete, or in mark mode the comment lock. One action
      // from the shared budget either way.
      if (budget.used + 1 > SOLD_SWEEP_LIMIT) continue;
      budget.used += 1;
      if (dryRun) {
        if (settings.mode === "mark") summary.marked.push(vin);
        else summary.sold_deleted.push(vin);
        continue;
      }
      const chk = await checkConnection(db, userId);
      if (chk.err || !chk.conn) {
        // No usable token right now — leave the candidate mark
        // in place; a later sweep retries once the connection
        // is healthy. Never wedge the sweep on one account.
        summary.skipped++;
        continue;
      }
      if (settings.mode === "mark") {
        const token = chk.conn.access_token as string;
        // [IG-SOLDLOCK-362] The entire mark: lock the post's
        // comments. No comment (locking would hide it), no
        // delete, no repost — the post keeps its grid slot,
        // its date and its likes, and the legend printed in
        // every mark-mode caption explains the lock.
        const tog = await graphPost(`/${mediaId}`, token, {
          comment_enabled: "false",
        });
        if (!tog.res.ok || tog.body?.error) {
          const err = tog.body?.error;
          const message = err?.message ?? "Meta returned an error.";
          const code = err?.code ?? null;
          console.error(`instagram-post: sold mark lock failed: ${code ?? "?"} ${message}`);
          if (isMarkPermissionError(tog.body)) {
            // Parked for good (out of the sweep's selection):
            // no retry loop while instagram_manage_comments
            // awaits its review round.
            const { error: updErr } = await db
              .from("instagram_posts")
              .update({
                status: "mark_permission_pending",
                error_code: "mark_permission_pending",
                error_message: message,
              })
              .eq("id", row.id)
              .eq("status", "published");
            if (updErr) {
              summary.skipped++;
              continue;
            }
            summary.mark_pending.push(vin);
            continue;
          }
          const { error: updErr } = await db
            .from("instagram_posts")
            .update({
              error_code: "sold_mark_error",
              error_message: (code !== null ? String(code) + ": " : "") + message,
            })
            .eq("id", row.id)
            .eq("status", "published");
          if (updErr) {
            summary.skipped++;
            continue;
          }
          summary.mark_failed.push(vin);
          continue;
        }
        const { error: updErr } = await db
          .from("instagram_posts")
          .update({ status: "sold_marked", error_code: null, error_message: null })
          .eq("id", row.id)
          .eq("status", "published");
        if (updErr) {
          summary.skipped++;
          continue;
        }
        summary.marked.push(vin);
        continue;
      }
      const del = await graphDelete(`/${mediaId}`, chk.conn.access_token as string);
      const err = del.body?.error;
      if (!del.res.ok || err) {
        const message = err?.message ?? "Meta returned an error.";
        const code = err?.code ?? null;
        console.error(`instagram-post: sold delete failed: ${code ?? "?"} ${message}`);
        if (isDeletePermissionError(del.body)) {
          const { error: updErr } = await db
            .from("instagram_posts")
            .update({
              status: "delete_permission_pending",
              error_code: "delete_permission_pending",
              error_message: message,
            })
            .eq("id", row.id)
            .eq("status", "published");
          if (updErr) {
            summary.skipped++;
            continue;
          }
          summary.sold_delete_pending.push(vin);
        } else {
          const { error: updErr } = await db
            .from("instagram_posts")
            .update({
              error_code: "sold_delete_error",
              error_message: (code !== null ? String(code) + ": " : "") + message,
            })
            .eq("id", row.id)
            .eq("status", "published");
          if (updErr) {
            summary.skipped++;
            continue;
          }
          summary.sold_delete_failed.push(vin);
        }
        continue;
      }
      const { error: updErr } = await db
        .from("instagram_posts")
        .update({ status: "deleted", error_code: null, error_message: null })
        .eq("id", row.id)
        .eq("status", "published");
      if (updErr) {
        summary.skipped++;
        continue;
      }
      summary.sold_deleted.push(vin);
      continue;
    }
    if (errorCode === null) {
      // First sold read: mark only. The delete waits for a
      // later sweep where the car still reads sold.
      if (budget.used >= SOLD_SWEEP_LIMIT) break;
      budget.used++;
      if (!dryRun) {
        const { error } = await db
          .from("instagram_posts")
          .update({ error_code: SOLD_DELETE_CANDIDATE, error_message: null })
          .eq("id", row.id)
          .eq("status", "published");
        if (error) {
          summary.skipped++;
          continue;
        }
      }
      summary.sold_marked.push(vin);
      continue;
    }
    // Any other error_code (a parked sold_delete_error, a stale
    // note from an earlier flow) leaves the row out of the sweep.
  }
}
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

// =====================================================================
// [IG-UVID-357] The user's own uploaded video on Instagram
// (Matthew, 2026-11-20): "make sure insta will use their
// uploaded videos too." Same precedence as Marketplace: a READY
// user video beats the rendered VIN Reel.
//
// The normalized file lives in the PRIVATE user-videos bucket
// (storage_path = <user_id>/<vin>.mp4 on the ready row), but
// Meta can only fetch public URLs — so the video is staged into
// the PUBLIC vin-reels bucket (the same bucket every rendered
// reel already publishes from) at the deterministic path
//   <user_id>/<vin>-ig-<user_vehicle_videos row id>.mp4
// The row id in the path pins the copy to one exact video: a
// re-record is a new row with a new path, so a stale copy can
// never be served for a newer video, and no clock comparison
// is needed to tell versions apart.
//
// THE CONSUME INTERACTION: the helper deletes the private
// object and nulls the row's paths once a Marketplace post is
// confirmed with the video attached. An Instagram intent can
// still be pending at that moment — so the copy is staged
// EARLY, when the intent is held (holdIntent below), not only
// when the publish finally runs. After a consume, the row
// survives (status "consumed", id intact), the publish-time
// resolver recomputes the same deterministic path from that
// row, finds the staged copy, and Meta fetches the copy. No
// helper change is needed: the consume only ever touches the
// private bucket and the row, never the staged public copy.
// If nothing was ever staged and the private object is gone,
// resolution returns null and the post falls back to the
// rendered reel — fail-open, like the rest of the user-video
// system. Staged copies are one small file per (user, car,
// video version); they are left in place deliberately (a
// failed post's retry may still need one) — cleanup is a
// possible follow-up, never a correctness need.
// =====================================================================

const USER_VIDEO_BUCKET = "user-videos";
const REEL_BUCKET = "vin-reels";

function igUserVideoDestPath(userId: string, vin: string, rowId: string): string {
  return `${userId}/${vin}-ig-${rowId}.mp4`;
}

function publicStorageUrl(bucket: string, path: string): string {
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  return `${base}/storage/v1/object/public/${bucket}/${path}`;
}

async function latestUserVideo(db: Db, userId: string, vin: string) {
  const { data } = await db
    .from("user_vehicle_videos")
    .select("id, status, storage_path")
    .eq("user_id", userId)
    .eq("vin", vin)
    .order("created_at", { ascending: false })
    .limit(1);
  return data && data.length ? data[0] : null;
}

async function igCopyExists(db: Db, destPath: string): Promise<boolean> {
  const slash = destPath.lastIndexOf("/");
  const folder = destPath.slice(0, slash);
  const name = destPath.slice(slash + 1);
  const { data, error } = await db.storage
    .from(REEL_BUCKET)
    .list(folder, { search: name });
  if (error || !data) return false;
  return data.some((o: { name?: string }) => o?.name === name);
}

// Ensure the staged public copy of the car's current user
// video exists and return its public URL — or null when this
// car has no usable user video for Instagram (none recorded,
// still processing, failed, or consumed before any copy was
// staged). NEVER throws: every failure is a null, and every
// caller falls back to the rendered reel. With stage=false
// (the finisher's dry run) nothing is written: the URL is
// returned when the copy exists or the private object is
// verifiably there for a real run to stage.
async function ensureInstagramUserVideo(
  db: Db,
  userId: string,
  vin: string,
  stage = true,
): Promise<string | null> {
  try {
    const row = await latestUserVideo(db, userId, vin);
    if (!row || !row.id) return null;
    const dest = igUserVideoDestPath(userId, vin, row.id as string);
    const url = publicStorageUrl(REEL_BUCKET, dest);
    if (row.status === "ready" && row.storage_path) {
      if (await igCopyExists(db, dest)) return url;
      const { data: blob, error: dlErr } = await db.storage
        .from(USER_VIDEO_BUCKET)
        .download(row.storage_path as string);
      if (dlErr || !blob) {
        console.error("instagram-post: user video download failed: " + (dlErr?.message ?? "no data"));
        return (await igCopyExists(db, dest)) ? url : null;
      }
      if (!stage) return url;
      const { error: upErr } = await db.storage
        .from(REEL_BUCKET)
        .upload(dest, blob, { contentType: "video/mp4", upsert: true });
      if (upErr) {
        console.error("instagram-post: user video staging failed: " + upErr.message);
        return null;
      }
      return url;
    }
    if (row.status === "consumed") {
      // The private object is gone (Marketplace consumed it);
      // only a copy staged while the video was ready can serve.
      return (await igCopyExists(db, dest)) ? url : null;
    }
    return null;
  } catch (e) {
    console.error("instagram-post: user video resolve threw: " + e);
    return null;
  }
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
  // [IG-SOLDLOCK-362] Mark-mode accounts carry the sold legend
  // in every caption the finisher publishes (the comment lock
  // is the sold marker; the legend is what explains it). The
  // mode is read the same way the sold sweep reads it.
  const { mode: soldMode } = await soldSweepSettings(db, userId);
  const caption = applySoldLegend(
    buildCaption(car ?? (intent.stock_number ? { stock_number: intent.stock_number } : null)),
    soldMode === "mark",
  );
  const stockNumber = intent.stock_number ?? ((car?.stock_number as string) ?? null);
  // [IG-UVID-357] The user's own video outranks the reel URL
  // this publish was handed — resolve here, at the one place
  // the finisher creates its container, so the precedence
  // holds whatever the caller passed.
  const effectiveVideoUrl = vin
    ? await resolveReelVideoUrl(db, userId, vin, videoUrl)
    : videoUrl;

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

  if (!effectiveVideoUrl) {
    await failInPlace(
      { error: { message: "No ready reel or user video is available for this post." } },
      null,
    );
    return;
  }
  const result = await publishReel(accessToken, igUserId, effectiveVideoUrl, caption);
  if (!result.ok) {
    if (result.timeout) {
      await resolveIntentRow(db, intent.id, {
        status: "failed", container_id: result.containerId ?? null,
        error_code: "media_processing_timeout",
        error_message: "Instagram is still processing the media — retry the post shortly.",
      });
      summary.resolved_failed.push(vin ?? "");
      return;
    }
    await failInPlace(result.body ?? {}, result.containerId ?? null);
    return;
  }
  await resolveIntentRow(db, intent.id, {
    status: "published", media_id: result.mediaId, container_id: result.containerId,
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
    sold_closed: [], sold_marked: [], sold_unmarked: [],
    sold_deleted: [], sold_delete_pending: [], sold_delete_failed: [],
    marked: [], mark_pending: [], mark_failed: [],
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
      if (priorRows.some((r) => r.status !== "sold_reposted" && Date.parse(r.created_at as string) > dayAgo)) {
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

  // [IG-SOLD-359] Close the front door BEFORE the finish pass:
  // intents for cars that sold (or exited) while their reels
  // were rendering are closed here, so the finish pass below can
  // never publish one. The sweep shares its action budget with
  // the delete phase after the finish pass.
  const sweepBudget = { used: 0 };
  await soldSweepCloseIntents(db, summary, dryRun, sweepBudget);

  // Claim one parked intent atomically (awaiting_reel ->
  // finishing): exactly one publisher may ever proceed with it,
  // and the claim turns the client watcher away (its own claim
  // in the handler matches nothing once the row has moved).
  const claimIntent = async (intentId: string): Promise<boolean> => {
    const { data: claimed, error: claimErr } = await db
      .from("instagram_posts")
      .update({ status: "finishing" })
      .eq("id", intentId)
      .eq("status", "awaiting_reel")
      .select("id");
    return !claimErr && !!claimed && claimed.length > 0;
  };

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
    // [IG-UVID-357] A usable user video finishes the intent on
    // its own — the reel's state is irrelevant (it may still be
    // rendering, or have failed outright): the user's video IS
    // this post's video, the same precedence as Marketplace.
    const userVideoUrl = await ensureInstagramUserVideo(db, userId, vin, !dryRun);
    if (userVideoUrl) {
      if (dryRun) {
        summary.published.push(vin);
        continue;
      }
      if (!(await claimIntent(intent.id))) {
        summary.skipped++;
        continue;
      }
      await finishOneIntent(
        db,
        { id: intent.id, user_id: userId, vin, stock_number: intent.stock_number ?? null },
        userVideoUrl,
        summary,
      );
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
    if (!(await claimIntent(intent.id))) {
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

  // [IG-SOLD-359] The delete sweep proper: two-sweep-confirmed
  // takedowns of published posts for sold/exited cars, gated on
  // the same auto-delete-on-exit switch as Marketplace.
  await soldSweepPublished(db, summary, dryRun, sweepBudget);
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

  // [IG-RACE-358] Already-posted guard (direct publishes only):
  // one post per car, ever — the rule holdIntent has always
  // enforced for held intents, now enforced on the tap path
  // too. A re-tap after a successful post (the Terrain
  // triple-post pattern: grid lag hid the success and the rep
  // tapped again) gets the intent mode's already_posted
  // answer, which the app already reads as
  // success-without-posting. Checked before the connection
  // load and before any container work: nothing is created,
  // recorded, or sent to Meta.
  if (!intentId && vin) {
    const { data: postedRows } = await db
      .from("instagram_posts")
      .select("id")
      .eq("user_id", userId)
      .eq("vin", vin)
      .eq("status", "published")
      .limit(1);
    if (postedRows && postedRows.length) {
      return json({ ok: true, already_posted: true, status: "published" });
    }
  }

  // [IG-RACE-358] Atomic claim: a publish carrying an intent
  // must OWN the intent before any container work. The update
  // lands only while the row is still awaiting_reel; the
  // finisher claims the same way, so exactly one publisher can
  // ever hold the row — the loser creates nothing and gets the
  // existing intent_already_resolved answer. (The read-only
  // guard above still answers first for intents resolved long
  // ago; this claim closes the window between that check and
  // the container calls — the window the Sierra duplicate
  // went through.) Outcomes resolve the claimed row in place
  // via recordOutcome, which matches "finishing" now too.
  if (intentId) {
    const { data: claimedRows, error: claimErr } = await db
      .from("instagram_posts")
      .update({ status: "finishing" })
      .eq("id", intentId)
      .eq("user_id", userId)
      .eq("status", "awaiting_reel")
      .select("id");
    if (claimErr || !claimedRows || !claimedRows.length) {
      const { data: current } = await db
        .from("instagram_posts")
        .select("status")
        .eq("id", intentId)
        .eq("user_id", userId)
        .maybeSingle();
      return json(
        {
          ok: false,
          error: "intent_already_resolved",
          status: (current?.status as string) ?? "unknown",
        },
        409,
      );
    }
  }

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

  // [IG-UVID-357] Reel publishes: the car's own uploaded video,
  // when one is ready, replaces the reel URL the client passed
  // — resolution is server-side (the client cannot see into
  // the private bucket), keyed by the JWT-verified caller and
  // the request's VIN, and fail-open to the reel.
  if (kind === "reel" && vin) {
    const userVideoUrl = await ensureInstagramUserVideo(db, userId, vin);
    if (userVideoUrl) videoUrl = userVideoUrl;
  }

  // 1) Create the media container(s). A Reel posts as media_type
  //    REELS; a carousel is one child container per photo plus a
  //    CAROUSEL parent; a single photo posts as-is.
  let creationId = "";
  if (kind === "reel") {
    const created = await graphPost(`/${igUserId}/media`, accessToken, {
      media_type: "REELS",
      video_url: videoUrl,
      thumb_offset: REEL_THUMB_OFFSET,
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
