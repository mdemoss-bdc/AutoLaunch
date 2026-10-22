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

async function logFailure(queueId, reason) {
  const { autolaunch_failure_log: log = [] } = await chrome.storage.local.get(["autolaunch_failure_log"]);
  log.unshift({ queueId, reason, at: new Date().toISOString() });
  await chrome.storage.local.set({
    autolaunch_failure_log: log.slice(0, 25),
    autolaunch_last_error: { queueId, reason, at: new Date().toISOString() }
  });
}

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

async function applyFailed(queueId) {
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
      await applyFailed(pending.queueId);
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

async function finishJobFailed(queueId, reason) {
  const { current_posting_job: job } = await chrome.storage.local.get(["current_posting_job"]);
  if (!job || job.queueId !== queueId) return;
  try {
    await applyFailed(queueId);
  } catch (err) {
    if (err instanceof SbAuthError) {
      // Same stash-and-replay as the posted path, so the row doesn't
      // sit in "processing" forever behind a dead token.
      await chrome.storage.local.set({
        autolaunch_pending_finish: { outcome: "failed", queueId }
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

  if (message.type === "AUTOLAUNCH_JOB_POSTED") {
    finishJobPosted(message.queueId, message.listingUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "AUTOLAUNCH_JOB_FAILED") {
    finishJobFailed(message.queueId, message.reason)
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
