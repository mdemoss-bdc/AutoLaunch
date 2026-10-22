// AutoLaunch Vehicle Assistant — background service worker (v2)
//
// Phase 2 changes vs the original:
//  1. HANDSHAKE: the user id now arrives from bridge.js, a content script
//     on the AutoLaunch origin that forwards the app's
//     AUTOLAUNCH_EXT_LOGIN window message. (The old code waited for
//     onMessageExternal "SET_USER_ID", which the app never sent and could
//     not send — a web page cannot message an extension it cannot name.)
//     The external listener is kept as a secondary path.
//  2. POLLING: chrome.alarms instead of setInterval. MV3 service workers
//     are killed when idle, which silently killed the 20s interval.
//  3. STATUS VOCABULARY: one vocabulary everywhere, matching the web UI —
//     pending -> processing -> posted / failed. The old code wrote
//     "completed", which the UI does not know.
//  4. CLAIMING: a queue row is claimed with a conditional PATCH
//     (status must still be pending) so two polls can never take the
//     same car twice.
//  5. DAILY LIMIT: before claiming, count today's posts from
//     scraped_inventory.marketplace_posted_at against the user's saved
//     daily_post_limit (user_settings). At the cap, nothing is claimed.
//  6. POSTED MEANS POSTED: this worker never marks a row posted. Only the
//     content script can do that, and only after it has detected a real
//     publish success on Facebook. Unconfirmed = failed, with a reason.
//  7. SESSION TOKEN: the queue / settings / inventory tables are
//     RLS-locked to the `authenticated` role with auth.uid() owner
//     policies, so the publishable key alone can see and claim NOTHING.
//     The app now sends the signed-in user's Supabase access token
//     through the bridge with the user id; the worker stores it in
//     chrome.storage.local and sends it as Authorization: Bearer on
//     every REST call. A 401/403 marks the session expired and stops
//     claiming until a NEW token arrives — no retry hammering. The
//     token is never logged and never written into any error record.
//  8. PHOTO RELAY: the content script runs on facebook.com, so its direct
//     fetch of a dealer photo URL is page-CORS-bound — and dealer photo
//     servers (mosescars.com proven) send no Access-Control-Allow-Origin,
//     so the fetch dies and the job fails with photo_download_failed.
//     Fetches from this worker are extension fetches: with host
//     permission for the origin they are NOT page-CORS-bound. The
//     content script now asks the worker for the bytes
//     (AUTOLAUNCH_FETCH_PHOTO) and rebuilds the File itself; its
//     fallback is the photo-proxy Edge Function, and only if both fail
//     does the job fail honestly — a photoless car is never posted.
//  9. CDP TRUSTED INPUT (filler v3): Year/Make/Model/Price resisted two
//     generations of DOM fills — Facebook commits those fields only
//     through its suggestion-listbox selection / trusted input pipeline,
//     and React resets values set any other way. The content script's
//     last-resort rung now asks this worker to drive REAL input through
//     the DevTools protocol (AUTOLAUNCH_CDP: attach / click /
//     insertText / key / detach via chrome.debugger on the Facebook
//     tab). While attached Chrome shows a "…is debugging this browser"
//     infobar; it disappears on detach, which happens when the fill
//     sequence ends or the job finishes/fails. An attach failure (e.g.
//     the user has DevTools open on the tab) is a structured error, and
//     the content script's verify-or-report still decides the outcome.
//     Field diagnostics (AUTOLAUNCH_FIELD_DIAG) ride the same path into
//     autolaunch_failure_log when a field defeats every rung.
// 10. DIAG-TO-DB (v3.1, fourth live test): run 4's installed build WAS
//     2.1.0 (card verified) and both attempts failed honestly with
//     fields_unfilled:Year,Make,Model,Price — but the field_diag
//     forensics NEVER appeared in autolaunch_failure_log: Matthew pulled
//     exactly two bare {at, queueId, reason} entries. The separate
//     diag-message → storage path could not be trusted, so the records
//     now ride the AUTOLAUNCH_JOB_FAILED message itself, and this
//     worker compacts them into the queue row's error_message column
//     in the same PATCH that marks the row failed (outerHTML ≤160
//     chars per field, whole string ≤3500) — the evidence lives in the
//     database, readable with a plain SELECT, no console archaeology.
//     If the error_message write is rejected, the row still ends
//     failed via a status-only PATCH. logFailure's storage writes are
//     also serialized through a promise chain now: the old
//     get-modify-write cycles from near-simultaneous callers (four
//     field diags + the job failure) could overwrite each other. And a
//     CDP attach refused with "Another debugger is already attached"
//     is retried ONCE after 3s before the reason is recorded — a
//     transient DevTools attach shouldn't cost the rung.
// 11. FORM MAP RIDES ALONG (v3.2, fifth live test): run 5's
//     error_message stayed NULL under a working diag-to-DB — the
//     content script's jobDiags was empty because the four fields
//     were never LOCATED, so the ladder (and its diagnostics) never
//     ran for them. Location is fixed content-side (container label
//     text); here, compactDiagError now also preserves each record's
//     `note` and the one-per-job `formMap` entry (the failing step's
//     visible controls with their computed container labels), and
//     the cap rises to 6000 chars — formMap entries are shed first,
//     so the field records always survive.
// 12. STEP NOTES RIDE ALONG (v2.1.3, filler v3.3): the first
//     successful post still needed Matthew's hands for the step-2
//     color dropdowns and the clean-title box — best-effort fields
//     whose misses were silent. The content script now records a
//     non-fatal "step note" for each step-2 outcome (color requested
//     -> option chosen -> read-back; clean-title click path) on the
//     same diagnostic channels. Here, compactDiagError also
//     preserves each record's `detail` string (shed with readBack
//     under cap pressure), and the FIELD_DIAG handler stores `note`
//     + `detail` in autolaunch_failure_log alongside the forensics.

const SUPABASE_URL = "https://tdsipiltwajwhzgjsupx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";
const POLL_ALARM = "autolaunch-queue-poll";
const POLL_MINUTES = 1;

class SbAuthError extends Error {
  constructor(status) {
    super(`Supabase rejected the session token (${status})`);
    this.status = status;
  }
}

async function storedAccessToken() {
  const { autolaunch_access_token: token } =
    await chrome.storage.local.get(["autolaunch_access_token"]);
  return token || null;
}

async function sbHeaders(extra) {
  const token = await storedAccessToken();
  return Object.assign({
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${token || SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json"
  }, extra || {});
}

// Record (once per expiry) that the stored token died, in the same
// autolaunch_last_error record the failure logger uses. Reason strings
// only — the token value itself never lands in storage logs or errors.
async function markSessionExpired() {
  const { autolaunch_session_expired: already } =
    await chrome.storage.local.get(["autolaunch_session_expired"]);
  if (already) return;
  await chrome.storage.local.set({
    autolaunch_session_expired: true,
    autolaunch_last_error: {
      queueId: null,
      reason: "session_expired — reopen the AutoLaunch tab",
      at: new Date().toISOString()
    }
  });
  console.warn("[AutoLaunch] Session token expired — reopen the AutoLaunch tab to reconnect the extension.");
}

async function noteWaitingForLogin() {
  const { autolaunch_last_error: last } =
    await chrome.storage.local.get(["autolaunch_last_error"]);
  if (last && last.reason === "waiting_for_login") return;
  await chrome.storage.local.set({
    autolaunch_last_error: {
      queueId: null,
      reason: "waiting_for_login",
      at: new Date().toISOString()
    }
  });
}

async function sbFetch(path, options) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (res.status === 401 || res.status === 403) {
    await markSessionExpired();
    throw new SbAuthError(res.status);
  }
  if (!res.ok) {
    throw new Error(`Supabase ${(options && options.method) || "GET"} ${path} -> ${res.status}`);
  }
  return res.json();
}

async function sbGet(path) {
  return sbFetch(path, { headers: await sbHeaders() });
}

async function sbPatch(path, body) {
  return sbFetch(path, {
    method: "PATCH",
    headers: await sbHeaders({ "Prefer": "return=representation" }),
    body: JSON.stringify(body)
  });
}

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function todaysPostCount(userId) {
  const rows = await sbGet(
    `scraped_inventory?user_id=eq.${userId}` +
    `&marketplace_posted_at=gte.${encodeURIComponent(startOfTodayISO())}` +
    `&select=vin`
  );
  return rows.length;
}

async function dailyLimit(userId) {
  const rows = await sbGet(`user_settings?user_id=eq.${userId}&select=daily_post_limit`);
  if (rows && rows.length && typeof rows[0].daily_post_limit === "number") {
    return rows[0].daily_post_limit;
  }
  return 10; // matches the app's own default when nothing is saved
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

let isChecking = false;

async function checkQueue() {
  if (isChecking) return;
  isChecking = true;
  try {
    const {
      autolaunch_user_id: userId,
      autolaunch_access_token: accessToken,
      autolaunch_session_expired: sessionExpired,
      current_posting_job: activeJob
    } = await chrome.storage.local.get([
      "autolaunch_user_id", "autolaunch_access_token",
      "autolaunch_session_expired", "current_posting_job"
    ]);
    if (!userId) return;               // not signed in to AutoLaunch yet
    if (sessionExpired) return;        // dead token — wait for a fresh one via the bridge
    if (!accessToken) {                // bridge hasn't delivered a session yet
      await noteWaitingForLogin();
      return;
    }
    if (activeJob) return;             // one car at a time, always

    // Daily safety limit — enforced here too, not just in the UI.
    const limit = await dailyLimit(userId);
    if (limit < 999) {
      const postedToday = await todaysPostCount(userId);
      if (postedToday >= limit) {
        console.log(`[AutoLaunch] Daily limit reached (${postedToday}/${limit}). Not claiming.`);
        return;
      }
    }

    const queueItems = await sbGet(
      `auto_posting_queue?user_id=eq.${userId}&status=eq.pending` +
      `&target_channel=eq.marketplace&order=created_at.asc&limit=1`
    );
    if (!queueItems.length) return;
    const item = queueItems[0];

    const cars = await sbGet(
      `scraped_inventory?vin=eq.${encodeURIComponent(item.vin)}&user_id=eq.${userId}&limit=1`
    );
    if (!cars.length) {
      // Queue row points at a car that no longer exists: fail it loudly
      // instead of leaving it pending forever.
      await sbPatch(`auto_posting_queue?id=eq.${item.id}&status=eq.pending`, { status: "failed" });
      await logFailure(item.id, "inventory_row_missing");
      return;
    }

    // NO-PHOTO RULE (mirrors hasRealPhoto in the web app): a vehicle with
    // no real photos is never posted — its photos may have vanished after
    // it was queued. Fail the row loudly, same as a missing car, instead
    // of handing a photo-less listing to Facebook.
    const FALLBACK_PHOTO = "https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=800&auto=format&fit=crop&q=80";
    const usablePhoto = u => {
      if (!u || typeof u !== "string") return false;
      let s = u.trim();
      if (s.startsWith("//")) s = "https:" + s;
      return /^https?:\/\//i.test(s) && !s.includes("/static/") && s !== FALLBACK_PHOTO;
    };
    const carRow = cars[0];
    const hasPhoto = usablePhoto(carRow.image_url) ||
      (Array.isArray(carRow.custom_photo_urls) && carRow.custom_photo_urls.some(usablePhoto));
    if (!hasPhoto) {
      await sbPatch(`auto_posting_queue?id=eq.${item.id}&status=eq.pending`, { status: "failed" });
      await logFailure(item.id, "no_photos");
      return;
    }

    // Conditional claim: only succeeds while the row is still pending.
    const claimed = await sbPatch(
      `auto_posting_queue?id=eq.${item.id}&status=eq.pending`,
      { status: "processing" }
    );
    if (!claimed.length) return; // someone/something else took it

    await chrome.storage.local.set({
      current_posting_job: {
        queueId: item.id,
        userId,
        car: cars[0],
        claimedAt: new Date().toISOString()
      }
    });

    await jitter(1500, 4000); // human pacing, never machine-gun tabs
    await chrome.tabs.create({ url: "https://www.facebook.com/marketplace/create/vehicle" });
  } catch (err) {
    console.error("[AutoLaunch] Queue check error:", err);
  } finally {
    isChecking = false;
  }
}

// --- Photo relay --------------------------------------------------------
// The content script (on facebook.com) cannot fetch dealer photo URLs
// itself — page CORS. This worker can: extension fetches backed by host
// permissions are not page-CORS-bound. Returns the bytes base64-encoded
// (chunked conversion — String.fromCharCode on a whole 15MB buffer would
// blow the argument limit) with the content type; every failure is a
// structured { ok:false, error } so the content script can fall through
// to the photo-proxy and, failing that, the honest job failure.
const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // ~15MB — dealer photos are ~50KB

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchPhotoForContent(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "photo_url_not_http" };
  }
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return { ok: false, error: "photo_fetch_threw" };
  }
  if (!res.ok) return { ok: false, error: `photo_http_${res.status}` };
  const contentType = res.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    return { ok: false, error: "photo_not_an_image" };
  }
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) return { ok: false, error: "photo_empty" };
  if (buffer.byteLength > PHOTO_MAX_BYTES) {
    return { ok: false, error: "photo_too_large" };
  }
  return {
    ok: true,
    base64: arrayBufferToBase64(buffer),
    contentType: contentType || "image/jpeg"
  };
}

// --- CDP trusted input (filler v3) ---------------------------------------
// Minimal protocol the content script drives:
//   { type: "AUTOLAUNCH_CDP", action: "attach" }
//   { type: "AUTOLAUNCH_CDP", action: "click", x, y }
//   { type: "AUTOLAUNCH_CDP", action: "insertText", text }
//   { type: "AUTOLAUNCH_CDP", action: "key", key, code, text?, modifiers? }
//   { type: "AUTOLAUNCH_CDP", action: "detach" }
// Every reply is { ok: true, ... } or { ok: false, error } — an attach
// failure (another debugger, e.g. the user's own DevTools, is attached)
// surfaces as an error, never a throw, so the caller's verify-or-report
// remains the arbiter. Sessions are tracked per tab; Chrome's own
// onDetach (tab closed, user cancels the infobar) cleans the map.
const cdpSessions = new Map(); // tabId -> protocol version

function cdpAttachOnce(tabId) {
  return new Promise(resolve => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: "cdp_attach_failed: " + (err.message || "unknown") });
        return;
      }
      cdpSessions.set(tabId, "1.3");
      resolve({ ok: true });
    });
  });
}

async function cdpAttach(tabId) {
  if (cdpSessions.has(tabId)) return { ok: true, already: true };
  let res = await cdpAttachOnce(tabId);
  // The classic refusal is the user having DevTools (or another
  // debugger) on the same tab. That can be transient — retry ONCE
  // after a pause before giving the rung up; the error string keeps
  // the browser's exact reason either way (v3.1).
  if (!res.ok && /another debugger is already attached/i.test(res.error || "")) {
    await sleep(3000);
    res = await cdpAttachOnce(tabId);
  }
  return res;
}

function cdpSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || "cdp_command_failed"));
      else resolve(result);
    });
  });
}

function cdpDetach(tabId) {
  if (!cdpSessions.has(tabId)) return Promise.resolve({ ok: true, already: false });
  return new Promise(resolve => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // detaching a dead session is fine
      cdpSessions.delete(tabId);
      resolve({ ok: true });
    });
  });
}

async function handleCdp(message, tabId) {
  switch (message.action) {
    case "attach":
      return cdpAttach(tabId);
    case "detach":
      return cdpDetach(tabId);
    case "click": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      const x = Number(message.x), y = Number(message.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, error: "cdp_bad_coordinates" };
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdpSendCommand(tabId, "Input.dispatchMouseEvent",
        { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return { ok: true };
    }
    case "insertText": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      await cdpSendCommand(tabId, "Input.insertText", { text: String(message.text || "") });
      return { ok: true };
    }
    case "key": {
      if (!cdpSessions.has(tabId)) return { ok: false, error: "cdp_not_attached" };
      if (!message.key) return { ok: false, error: "cdp_key_missing" };
      const base = {
        key: String(message.key),
        code: String(message.code || message.key),
        modifiers: Number(message.modifiers) || 0
      };
      // `text` makes printable keys actually produce characters in
      // fields that read it from the key event (native selects do).
      if (message.text) base.text = String(message.text);
      await cdpSendCommand(tabId, "Input.dispatchKeyEvent",
        Object.assign({ type: "keyDown" }, base));
      await cdpSendCommand(tabId, "Input.dispatchKeyEvent",
        Object.assign({ type: "keyUp" }, base));
      return { ok: true };
    }
    default:
      return { ok: false, error: "cdp_unknown_action" };
  }
}

chrome.debugger.onDetach.addListener(source => {
  if (source && source.tabId != null) cdpSessions.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  cdpSessions.delete(tabId);
});

// Failure-log writes are serialized through this chain (v3.1): the
// get-modify-write cycle is not atomic, and near-simultaneous callers
// (four field diags landing alongside the job failure) could read the
// same base log and overwrite each other's entries.
let failureLogChain = Promise.resolve();
function logFailure(queueId, reason, extra) {
  const run = failureLogChain.then(() => logFailureNow(queueId, reason, extra));
  failureLogChain = run.catch(() => {});
  return run;
}

async function logFailureNow(queueId, reason, extra) {
  const { autolaunch_failure_log: log = [] } = await chrome.storage.local.get(["autolaunch_failure_log"]);
  const entry = Object.assign(
    { queueId, reason, at: new Date().toISOString() },
    extra || {}
  );
  log.unshift(entry);
  await chrome.storage.local.set({
    autolaunch_failure_log: log.slice(0, 25),
    autolaunch_last_error: { queueId, reason, at: entry.at }
  });
}

// [PURE-DIAG-BEGIN] — extracted and unit-exercised by the test harness;
// keep free of chrome/fetch references.
// Compact the content script's per-field forensic records into the
// JSON string stored in the queue row's error_message (diag-to-DB,
// v3.1; form map v3.2; step notes v2.1.3): per field {field, tag,
// type, role, ariaLabel, outerHTML (≤160 chars), rungsAttempted,
// readBack, cdpError, note, detail (≤200 chars)}, plus the form_map
// entry whose formMap lists the failing step's visible controls
// {tag, type, role, ariaLabel, containerLabel (≤120 chars)}. The
// whole string is capped at 6000 chars — shed formMap entries first
// (halve, then drop), then outerHTML, then readBack + detail, then
// hard-truncate, so the field names + rungs + cdpError + notes
// survive.
function compactDiagError(diags) {
  if (!Array.isArray(diags) || !diags.length) return null;
  const fields = diags.map(d => {
    const el = (d && d.element) || {};
    return {
      field: (d && d.field) || null,
      tag: el.tag || null,
      type: el.type || null,
      role: el.role || null,
      ariaLabel: el.ariaLabel || null,
      outerHTML: el.outerHTML ? String(el.outerHTML).slice(0, 160) : null,
      rungsAttempted: (d && Array.isArray(d.rungsAttempted)) ? d.rungsAttempted.slice() : [],
      readBack: (d && d.readBack != null) ? String(d.readBack).slice(0, 120) : null,
      cdpError: (d && d.cdpError) || null,
      note: (d && d.note) || null,
      detail: (d && d.detail != null) ? String(d.detail).slice(0, 200) : null,
      formMap: (d && Array.isArray(d.formMap))
        ? d.formMap.slice(0, 12).map(m => ({
            tag: (m && m.tag) || null,
            type: (m && m.type) || null,
            role: (m && m.role) || null,
            ariaLabel: (m && m.ariaLabel) || null,
            containerLabel: (m && m.containerLabel != null)
              ? String(m.containerLabel).slice(0, 120) : null
          }))
        : null
    };
  });
  let out = JSON.stringify({ field_diag: fields });
  if (out.length > 6000) {
    fields.forEach(f => { if (Array.isArray(f.formMap)) f.formMap = f.formMap.slice(0, 6); });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.formMap = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.outerHTML = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) {
    fields.forEach(f => { f.readBack = null; f.detail = null; });
    out = JSON.stringify({ field_diag: fields });
  }
  if (out.length > 6000) out = out.slice(0, 6000);
  return out;
}
// [PURE-DIAG-END]

// The DB writes that end a job, split out so a finish that collides with
// a dead token can be stashed and replayed when a fresh token arrives
// (see autolaunch_pending_finish below) instead of being lost.
async function applyPosted(queueId, vin, userId) {
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`, { status: "posted" });
  await sbPatch(
    `scraped_inventory?vin=eq.${encodeURIComponent(vin)}&user_id=eq.${userId}`,
    { marketplace_posted_at: new Date().toISOString() }
  );
}

async function applyFailed(queueId, errorMessage) {
  if (errorMessage) {
    try {
      await sbPatch(`auto_posting_queue?id=eq.${queueId}`,
        { status: "failed", error_message: errorMessage });
      return;
    } catch (err) {
      // An auth failure would doom the retry too — rethrow so the
      // caller stashes the finish for the next token. Any other
      // rejection (e.g. the diagnostics write itself) must NOT cost
      // the failure state: fall through to the status-only write.
      if (err instanceof SbAuthError) throw err;
      console.warn("[AutoLaunch] error_message write rejected; failing the row without diagnostics.");
    }
  }
  await sbPatch(`auto_posting_queue?id=eq.${queueId}`, { status: "failed" });
}

async function flushPendingFinish() {
  const { autolaunch_pending_finish: pending } =
    await chrome.storage.local.get(["autolaunch_pending_finish"]);
  if (!pending) return;
  try {
    if (pending.outcome === "posted") {
      await applyPosted(pending.queueId, pending.vin, pending.userId);
    } else {
      await applyFailed(pending.queueId, pending.errorMessage || null);
    }
    await chrome.storage.local.remove(["autolaunch_pending_finish"]);
    console.log("[AutoLaunch] Replayed a job finish that was waiting on a fresh session token.");
  } catch (e) {
    // Still can't write — sbFetch already marked the session expired if
    // that's the cause. Leave the record; the next new token retries it.
  }
}

// The ONLY two ways a job ends. Called by the content script via message.
async function finishJobPosted(queueId, listingUrl) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  try {
    await applyPosted(queueId, job.car.vin, job.userId);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // The listing really is live; only the bookkeeping failed. Stash
      // the finish and replay it on the next token rather than losing
      // the confirmation (or wedging every future check behind a job
      // whose browser-side work is already done).
      await chrome.storage.local.set({
        autolaunch_pending_finish: {
          outcome: "posted", queueId,
          vin: job.car.vin, userId: job.userId,
          listingUrl: listingUrl || null
        }
      });
      await chrome.storage.local.remove(["current_posting_job"]);
      console.warn("[AutoLaunch] Posted confirmed on Facebook; the queue update is waiting on a fresh session token.");
      return;
    }
    throw err;
  }
  await chrome.storage.local.remove(["current_posting_job"]);
  console.log("[AutoLaunch] Posted confirmed for queue item", queueId, listingUrl || "");
}

async function finishJobFailed(queueId, reason, diags) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  // Diag-to-DB (v3.1): the content script's forensic records arrive in
  // this message; for a fields_unfilled failure they are compacted
  // into the row's error_message in the same write that fails it.
  const errorMessage =
    (typeof reason === "string" && reason.startsWith("fields_unfilled"))
      ? compactDiagError(diags)
      : null;
  try {
    await applyFailed(queueId, errorMessage);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // Same stash-and-replay as the posted path, so the row doesn't
      // sit in "processing" forever behind a dead token. The compacted
      // diagnostics ride the stash so the replay keeps them.
      await chrome.storage.local.set({
        autolaunch_pending_finish: { outcome: "failed", queueId, errorMessage }
      });
    } else {
      throw err; // the finally below still logs + clears, as before
    }
  } finally {
    await logFailure(queueId, reason || "unknown");
    await chrome.storage.local.remove(["current_posting_job"]);
    console.warn("[AutoLaunch] Job failed:", queueId, reason);
  }
}

// --- Wiring ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  checkQueue();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  checkQueue();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) checkQueue();
});

// Handshake path 1 (the real one): bridge.js on the AutoLaunch origin.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "AUTOLAUNCH_SET_USER_ID" && message.userId) {
    const fromApp = (sender.tab && sender.tab.url || "").startsWith("https://mdemoss-bdc.github.io/");
    if (!fromApp) return;
    (async () => {
      const updates = { autolaunch_user_id: message.userId };
      let freshToken = false;
      if (message.accessToken) {
        const { autolaunch_access_token: oldToken } =
          await chrome.storage.local.get(["autolaunch_access_token"]);
        if (message.accessToken !== oldToken) {
          // A NEW token revives an expired session: store it, clear the
          // expired stop, and (below) replay any stashed job finish
          // before resuming claims. The token value is never logged.
          updates.autolaunch_access_token = message.accessToken;
          updates.autolaunch_session_expired = false;
          freshToken = true;
        }
      }
      await chrome.storage.local.set(updates);
      sendResponse({ status: "connected" });
      if (freshToken) await flushPendingFinish();
      checkQueue();
    })();
    return true;
  }

  if (message.type === "AUTOLAUNCH_FETCH_PHOTO") {
    // Only the Facebook content script may use the relay (it is the one
    // CORS-blocked from dealer photo servers), and only real URLs — the
    // http(s) check lives in fetchPhotoForContent.
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    fetchPhotoForContent(message.url)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "photo_relay_failed" }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_CDP") {
    // Only the Facebook content script may drive trusted input, and only
    // on its own tab (sender.tab is authoritative — content scripts
    // cannot spoof another tab's id).
    const tabId = sender && sender.tab && sender.tab.id;
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (tabId == null || !senderUrl.startsWith("https://www.facebook.com/")) return;
    handleCdp(message, tabId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: "cdp_error: " + (err && err.message || "unknown") }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_FIELD_DIAG") {
    // A required field defeated every fill rung. Record the forensics
    // (element identity, rungs attempted, value read back) in the same
    // failure log the job reasons land in, so the NEXT failure is never
    // a guessing game. Reason strings + element metadata only.
    const senderUrl = (sender && sender.url) ||
      (sender && sender.tab && sender.tab.url) || "";
    if (!senderUrl.startsWith("https://www.facebook.com/")) return;
    const diag = message.diag || {};
    logFailure(message.queueId || null, "field_diag:" + (diag.field || "unknown"), {
      field: diag.field || null,
      element: diag.element || null,
      rungsAttempted: Array.isArray(diag.rungsAttempted) ? diag.rungsAttempted : [],
      readBack: diag.readBack != null ? String(diag.readBack) : null,
      expected: diag.expected != null ? String(diag.expected) : null,
      cdpError: diag.cdpError || null,
      note: diag.note || null,
      detail: diag.detail != null ? String(diag.detail) : null
    })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_POSTED") {
    finishJobPosted(message.queueId, message.listingUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_FAILED") {
    finishJobFailed(message.queueId, message.reason, message.diags)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Handshake path 2 (legacy, kept for compatibility): a page that knows the
// extension id can still set the user id externally. manifest.json limits
// this to the AutoLaunch origin via externally_connectable.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SET_USER_ID" && message.userId) {
    chrome.storage.local.set({ autolaunch_user_id: message.userId }, () => {
      sendResponse({ status: "connected" });
      checkQueue();
    });
    return true;
  }
});
