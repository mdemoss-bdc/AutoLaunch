// AutoLaunch bridge — runs ONLY on the AutoLaunch web app origin.
//
// The app announces the signed-in user with:
//   window.postMessage({ type: "AUTOLAUNCH_EXT_LOGIN", userId }, "*")
// (see initAppSession in index.html). Until now nothing received that
// message: the extension listened for chrome.runtime.onMessageExternal
// with a different type, and had no content script on this origin — so
// the user id never arrived and the queue poller always exited early.
//
// This script is the missing half of the handshake. It listens for the
// app's window message and forwards the user id to the background
// service worker via chrome.runtime.sendMessage, and ignores everything
// else (including messages from other windows/frames).
(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "AUTOLAUNCH_EXT_LOGIN" || !data.userId) return;

    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_SET_USER_ID", userId: String(data.userId) },
        () => void chrome.runtime.lastError // page may outlive a worker restart
      );
    } catch (e) {
      // Extension context invalidated (e.g. extension was reloaded).
      // The user gets the new bridge on their next page load.
    }
  });
})();
