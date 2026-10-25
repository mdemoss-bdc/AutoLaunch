// AutoLaunch bridge — runs ONLY on the AutoLaunch web app origin.
//
// The app announces the signed-in session with:
//   window.postMessage(
//     { type: "AUTOLAUNCH_EXT_LOGIN", userId, accessToken }, "*")
// (see postExtLogin / initAppSession in index.html; re-posted whenever
// Supabase refreshes the token). Until now nothing received that
// message: the extension listened for chrome.runtime.onMessageExternal
// with a different type, and had no content script on this origin — so
// the user id never arrived and the queue poller always exited early.
//
// The access token has to travel with the id: the app's Supabase tables
// are RLS-locked to the `authenticated` role, so the worker's REST calls
// need Authorization: Bearer <accessToken>, not just the publishable key.
//
// This script is the missing half of the handshake. It listens for the
// app's window message and forwards user id + access token to the
// background service worker via chrome.runtime.sendMessage, and ignores
// everything else (including messages from other windows/frames).
//
// v2.1.10: it also carries the Extension setup page's LIVE STATUS ping.
// The page posts {type:"AUTOLAUNCH_EXT_PING"}; the bridge forwards it to
// the worker as {type:"AUTOLAUNCH_PING"} and posts the worker's reply
// back to the window as {type:"AUTOLAUNCH_EXT_PONG", hasToken, version}
// (version added v2.1.24 so the page can flag an out-of-date helper). If the
// worker cannot be reached at all, no pong is posted — the page's own
// ~1.5s timeout is what reports "not installed", so a dead bridge never
// masquerades as an installed-but-waiting helper.
(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data) return;

    if (data.type === "AUTOLAUNCH_EXT_PING") {
      try {
        chrome.runtime.sendMessage(
          { type: "AUTOLAUNCH_PING" },
          (response) => {
            // A lastError here means the worker did not answer; post
            // nothing and let the page's timeout speak for itself.
            if (chrome.runtime.lastError) return;
            try {
              window.postMessage(
                {
                  type: "AUTOLAUNCH_EXT_PONG",
                  hasToken: !!(response && response.hasToken),
                  version: (response && response.version) || null
                },
                window.location.origin
              );
            } catch (e) { /* page is gone — nothing to answer */ }
          }
        );
      } catch (e) {
        // Extension context invalidated (e.g. extension was reloaded).
        // No pong: the page reports the helper as not reachable.
      }
      return;
    }

    if (data.type === "AUTOLAUNCH_EXT_SYNC_REQUEST") {
      // App-driven inbound sync (v2.1.38): forward the Prospects
      // screen's "sync now" to the worker and post its confirmation
      // back as a PONG so the page can repaint with fresh data.
      try {
        chrome.runtime.sendMessage(
          { type: "AUTOLAUNCH_SYNC_REQUEST" },
          (response) => {
            if (chrome.runtime.lastError) return;
            try {
              window.postMessage(
                { type: "AUTOLAUNCH_EXT_SYNC_PONG", reqId: data.reqId || null, ok: !!(response && response.ok) },
                window.location.origin
              );
            } catch (e) { /* page is gone */ }
          }
        );
      } catch (e) { /* no pong — the page's fallback refresh covers it */ }
      return;
    }

    if (data.type === "AUTOLAUNCH_EXT_NUDGE_OUTBOUND") {
      // Realtime fast path (2026-10-25): the app just queued a reply —
      // tell the worker to claim it now instead of at its next 1-minute
      // poll. Fire-and-forget; the alarm remains the fallback.
      try {
        chrome.runtime.sendMessage(
          { type: "AUTOLAUNCH_NUDGE_OUTBOUND" },
          () => void chrome.runtime.lastError
        );
      } catch (e) { /* worker unreachable — alarm fallback covers it */ }
      return;
    }

    if (data.type !== "AUTOLAUNCH_EXT_LOGIN" || !data.userId) return;

    try {
      chrome.runtime.sendMessage(
        {
          type: "AUTOLAUNCH_SET_USER_ID",
          userId: String(data.userId),
          accessToken: data.accessToken ? String(data.accessToken) : null
        },
        () => void chrome.runtime.lastError // page may outlive a worker restart
      );
    } catch (e) {
      // Extension context invalidated (e.g. extension was reloaded).
      // The user gets the new bridge on their next page load.
    }
  });
})();
