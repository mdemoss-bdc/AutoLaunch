// AutoLaunch Vehicle Assistant — Luca chat capture (Phase 2, v1).
//
// Marketplace buyer chats are Messenger threads on facebook.com. There
// is no official API into a personal account's chats, so Luca reads
// them the same way the poster works: in the rep's own signed-in
// Chrome. This script runs on Messenger / Marketplace inbox pages and
// adds one floating button — "Capture chat for Luca". On click it
// scrapes the OPEN thread (buyer name, the listing it belongs to, the
// visible messages with a left/right direction guess) and hands it to
// the worker, which stores it in Supabase as a Prospect + messages.
//
// v1 is deliberately manual (one click per chat, only what's on
// screen): deterministic for the two-account smoke test, and nothing
// is captured that the rep didn't choose to capture. Selectors are
// best-effort heuristics with fallbacks — if Facebook reshuffles its
// DOM, the failure mode is "captured little", never a broken page.
(function () {
  "use strict";

  var BTN_ID = "autolaunch-luca-capture-btn";

  // The floating chat popup (v2.1.28): sellers often read Marketplace
  // chats in the docked mini-window on a listing page, not the full
  // Messenger view — Matthew hit exactly that on 2026-10-25 and there
  // was no Capture button. The popup lives in a fixed-position
  // container holding a message box; the full Messenger thread is in
  // normal flow, so this returns null there and behavior is unchanged.
  function findChatPopup() {
    try {
      var inputs = document.querySelectorAll('[role="textbox"][aria-label], [contenteditable="true"][aria-label]');
      for (var i = 0; i < inputs.length; i++) {
        var lab = (inputs[i].getAttribute("aria-label") || "").toLowerCase();
        if (lab.indexOf("message") === -1 && lab !== "aa") continue;
        var node = inputs[i];
        for (var up = 0; up < 10 && node && node !== document.body; up++) {
          node = node.parentElement;
          if (!node) break;
          var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
          if (cs && cs.position === "fixed" && node.querySelectorAll('[dir="auto"]').length) return node;
        }
      }
    } catch (e) { /* heuristic only — never break the page */ }
    return null;
  }

  function onChatSurface() {
    var p = window.location.pathname || "";
    return p.indexOf("/messages/") === 0 || p.indexOf("/marketplace/inbox") === 0 || !!findChatPopup();
  }

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || "").trim().replace(/\s+/g, " ");
  }

  function findBuyerName() {
    // Best hook (v2.1.29, from Matthew's live capture): Facebook labels
    // the thread container "Conversation titled <Name> · <Listing>" —
    // the name is the part before the first "·".
    try {
      var titled = document.querySelector('[aria-label^="Conversation titled "]');
      if (titled) {
        var t = (titled.getAttribute("aria-label") || "").replace(/^Conversation titled\s*/, "");
        var nm = t.split("·")[0].trim();
        if (nm && nm.length >= 2 && nm.length <= 60) return nm;
      }
    } catch (e) { /* fall through to the heading scan */ }
    // Thread header usually carries the buyer's name in a heading.
    var main = document.querySelector('[role="main"]');
    var scopes = [findChatPopup(), main, document].filter(Boolean);
    for (var i = 0; i < scopes.length; i++) {
      var heads = scopes[i].querySelectorAll("h1, h2");
      for (var j = 0; j < heads.length; j++) {
        var t = textOf(heads[j]);
        if (t && t.length >= 2 && t.length <= 60 && !/messenger|marketplace|chats|inbox/i.test(t)) return t;
      }
    }
    // Fallback: the document title on thread pages is often the name.
    var title = (document.title || "").replace(/\s*[|·•-]\s*Facebook.*$/i, "").replace(/^\(\d+\)\s*/, "").trim();
    if (title && !/messenger|facebook/i.test(title) && title.length <= 60) return title;
    return "";
  }

  // The thread-header listing link's subtree includes its action
  // buttons, so the raw text arrives as "$23,220 - 2026 Volkswagen
  // Jetta View buyer More options" (Matthew's live capture, 2026-10-25).
  // Cut at the first chrome token and drop a leading "Marketplace".
  function cleanListingLabel(label) {
    var s = String(label || "").trim();
    s = s.split(/\s+(?:View buyer|More options)\b/)[0];
    s = s.replace(/^Marketplace\s+(?=\$)/, "");
    return s.trim();
  }

  function findListing() {
    // Marketplace threads link the listing; the first item link in the
    // thread pane is the car this chat is about.
    var links = document.querySelectorAll('a[href*="/marketplace/item/"]');
    for (var i = 0; i < links.length; i++) {
      var label = cleanListingLabel(textOf(links[i]) || (links[i].getAttribute("aria-label") || "").trim());
      var href = links[i].href || "";
      if (label && label.length >= 4) return { vehicleText: label.slice(0, 140), itemUrl: href };
      if (href) return { vehicleText: "", itemUrl: href };
    }
    return { vehicleText: "", itemUrl: "" };
  }

  function findMessages() {
    // Popup first: when the chat is the floating mini-window, scope to
    // it — its own midpoint is what separates buyer (left) from rep
    // (right); measured against the whole page the popup sits right of
    // center and every bubble would read as the rep's.
    var main = findChatPopup() || document.querySelector('[role="main"]') || document.body;
    // Message text lives in dir="auto" blocks; a bubble is the closest
    // reasonably-sized container around one.
    var nodes = main.querySelectorAll('[dir="auto"]');
    var pane = main.getBoundingClientRect();
    var paneMid = pane.left + pane.width / 2;
    var out = [];
    var seen = {};
    for (var i = 0; i < nodes.length; i++) {
      var t = textOf(nodes[i]);
      if (!t || t.length < 1 || t.length > 1000) continue;
      // Skip UI chrome that also uses dir="auto". The second pattern
      // set is Matthew's live thread (2026-10-25): header card labels,
      // group-system lines, and pane furniture that are NOT messages.
      if (/^(Seen|Delivered|Sent|Type a message|Aa|Search|Active now|You're friends on Facebook|You're both on Facebook)/.test(t)) continue;
      if (/^(View buyer|More options|Privacy & support|Messages|Send a quick response|Marketplace)$/.test(t)) continue;
      if (/^Conversation titled /.test(t)) continue;
      if (/ created this group$/.test(t)) continue;
      if (/mutual friends/.test(t) || /badge on Marketplace/.test(t)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var key = t + "|" + (r.left > paneMid ? "R" : "L");
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ direction: r.left + r.width / 2 > paneMid ? "out" : "in", body: t });
    }
    // DOM order is chronological; keep the most recent 30.
    return out.slice(-30);
  }

  function scrape() {
    var listing = findListing();
    return {
      buyerName: findBuyerName(),
      vehicleText: listing.vehicleText,
      itemUrl: listing.itemUrl,
      threadUrl: window.location.href,
      messages: findMessages()
    };
  }

  function setBtnLabel(btn, label, ok) {
    btn.textContent = label;
    btn.style.background = ok === true ? "#059669" : ok === false ? "#e11d48" : "#2563eb";
    setTimeout(function () {
      btn.textContent = "🌙 Capture chat for Luca";
      btn.style.background = "#2563eb";
    }, 4000);
  }

  function injectButton() {
    if (!onChatSurface() || document.getElementById(BTN_ID)) return;
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "🌙 Capture chat for Luca";
    btn.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
      "background:#2563eb", "color:#fff", "border:none", "border-radius:999px",
      "padding:10px 16px", "font:600 13px system-ui, sans-serif",
      "box-shadow:0 4px 14px rgba(0,0,0,.35)", "cursor:pointer"
    ].join(";");
    btn.addEventListener("click", function () {
      var capture = scrape();
      if (!capture.messages.length && !capture.buyerName && onInboxListSurface()) {
        autoPass();
        setBtnLabel(btn, "Synced ✓", true);
        return;
      }
      if (!capture.messages.length && !capture.buyerName) {
        setBtnLabel(btn, "Nothing found — open a chat first", false);
        return;
      }
      btn.textContent = "Capturing…";
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_CAPTURE_CHAT", capture: capture }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            setBtnLabel(btn, "Capture failed — is AutoLaunch signed in?", false);
            return;
          }
          setBtnLabel(btn, "Captured ✓ " + (resp.added || 0) + " new · " + (resp.prospectName || "prospect"), true);
        });
      } catch (e) {
        setBtnLabel(btn, "Capture failed", false);
      }
    });
    document.body.appendChild(btn);
  }

  // ---- AUTO-CAPTURE v1 (v2.1.31, Matthew's ask): no more clicking
  // Capture per chat. While an inbox surface is open in Chrome:
  //  - every visible thread-list row becomes a STUB capture (the
  //    prospect exists in AutoLaunch with its thread link; the worker
  //    matches by thread, so rows never duplicate a real prospect);
  //  - the OPEN thread (full view or floating popup) is fully captured
  //    whenever its content changes (new message = new hash).
  // The helper never clicks or navigates anything — it only reads
  // what is already on screen, on a slow timer.
  function onInboxListSurface() {
    var p = window.location.pathname || "";
    return p.indexOf("/messages") === 0 || p.indexOf("/marketplace/inbox") === 0;
  }

  function threadKeyOf(url) {
    var m = String(url || "").match(/\/t\/(\d+)/);
    return m ? m[1] : "";
  }

  function collectThreadStubs() {
    var out = [];
    var seen = {};
    var links = document.querySelectorAll('a[href*="/messages/t/"]');
    for (var i = 0; i < links.length && out.length < 15; i++) {
      var key = threadKeyOf(links[i].href || "");
      if (!key || seen[key]) continue;
      var rowText = textOf(links[i]);
      if (!rowText || rowText.length < 3) continue;
      seen[key] = true;
      // Rows lead with the buyer name, then separators/snippets. The
      // worker self-heals names from later full captures, so a rough
      // name here is acceptable — a wrong THREAD never is, and the
      // thread key comes from the href, not the text.
      var nm = rowText.split(" · ")[0].trim();
      var youAt = nm.indexOf("You:");
      if (youAt > 0) nm = nm.slice(0, youAt).trim();
      // A long first segment means the name fused with the snippet —
      // a placeholder (which full captures self-heal) beats a wrong
      // name that never gets corrected.
      if (nm.length > 30) nm = "";
      if (!nm || /\$/.test(nm) || /^(Chats|Marketplace|New message)/i.test(nm)) nm = "";
      var vm = rowText.match(/\$\d[\d,]*\s*-\s*[^·]{4,80}/);
      // Commerce gate (v2.1.34): the plain /messages list mixes in
      // personal chats, business-page chats and the Meta AI chat —
      // none of those are buyers. A row becomes a prospect ONLY with
      // Marketplace evidence: a priced listing label, a year/make/
      // model label, or the Marketplace inbox surface itself (which
      // is commerce-only by construction).
      var onMarketplaceInbox = (window.location.pathname || "").indexOf("/marketplace/inbox") === 0;
      var yearMake = /\b(19|20)\d{2}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+/.test(rowText);
      if (!onMarketplaceInbox && !vm && !yearMake) continue;
      if (/^(Meta AI|Facebook user)\b/i.test(nm) && !vm) continue;
      out.push({
        buyerName: nm,
        vehicleText: vm ? cleanListingLabel(vm[0]) : "",
        itemUrl: "",
        threadUrl: "https://www.facebook.com/messages/t/" + key,
        messages: [],
        stub: true
      });
    }
    return out;
  }

  // Snippet sync (v2.1.33): each list row also carries the conversation's
  // NEWEST line as a preview — and that preview updates live when a
  // buyer writes, no click needed. We forward those lines for every
  // visible row; the worker stores them only for threads that already
  // belong to a prospect (personal chats are never pulled in). "You:"
  // prefixes mark the rep's own latest line.
  function collectThreadSnippets() {
    var out = [];
    var seen = {};
    var timeLike = /^(\d{1,2}:\d{2}\s?(AM|PM)?|\d+\s?[mhdw]|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan \d+|Feb \d+|Mar \d+|Apr \d+|May \d+|Jun \d+|Jul \d+|Aug \d+|Sep \d+|Oct \d+|Nov \d+|Dec \d+|Just now|Yesterday)$/i;
    var links = document.querySelectorAll('a[href*="/messages/t/"]');
    for (var i = 0; i < links.length && out.length < 15; i++) {
      var key = threadKeyOf(links[i].href || "");
      if (!key || seen[key]) continue;
      var rowText = textOf(links[i]);
      if (!rowText || rowText.length < 3) continue;
      seen[key] = true;
      var segs = rowText.split(" · ").map(function (s) { return s.trim(); }).filter(Boolean);
      if (segs.length < 2) continue;
      var rest = segs.slice(1).filter(function (s) {
        return !timeLike.test(s) && !/^\$[\d,]+\s*-/.test(s) && s.length > 1;
      });
      if (!rest.length) continue;
      var snippet = rest.reduce(function (a, b) { return b.length > a.length ? b : a; }, "");
      var direction = "in";
      if (/^You[:\s]/i.test(snippet)) {
        direction = "out";
        snippet = snippet.replace(/^You[:\s]+/i, "").trim();
      }
      if (snippet.length < 2) continue;
      out.push({
        threadRef: "https://www.facebook.com/messages/t/" + key,
        snippet: snippet.slice(0, 140),
        direction: direction
      });
    }
    return out;
  }

  function sendCapture(capture) {
    try {
      chrome.runtime.sendMessage({ type: "AUTOLAUNCH_CAPTURE_CHAT", capture: capture }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* next pass retries */ }
  }

  var lastFullHash = "";
  function autoFullCapture() {
    if (!onChatSurface()) return;
    var c = scrape();
    if (!c.messages.length && !c.buyerName) return;
    var h = (c.threadUrl || "") + "|" + c.messages.map(function (m) { return m.direction + ":" + m.body; }).join("~");
    if (h === lastFullHash) return;
    lastFullHash = h;
    sendCapture(c);
  }

  function autoPass() {
    try {
      if (onInboxListSurface()) {
        collectThreadStubs().forEach(sendCapture);
        var snippets = collectThreadSnippets();
        if (snippets.length) {
          try {
            chrome.runtime.sendMessage({ type: "AUTOLAUNCH_CHAT_SNIPPETS", snippets: snippets }, function () {
              void chrome.runtime.lastError;
            });
          } catch (e) { /* next pass retries */ }
        }
      }
      autoFullCapture();
      var btn = document.getElementById(BTN_ID);
      if (btn && onInboxListSurface()) btn.textContent = "🌙 Luca auto-sync on · Capture now";
    } catch (e) { /* heuristics must never break the page */ }
  }

  // Fast pickup (v2.1.33): a new buyer message rewrites its list row
  // within seconds. Watch the list for changes and run a pass shortly
  // after (debounced, at most ~4x a minute) instead of waiting out the
  // 45-second timer. The worker dedupes anything unchanged.
  var lastObservedPass = 0;
  var observedTimer = null;
  try {
    var listObserver = new MutationObserver(function () {
      if (!onInboxListSurface()) return;
      if (observedTimer) return;
      observedTimer = setTimeout(function () {
        observedTimer = null;
        if (Date.now() - lastObservedPass < 12000) return;
        lastObservedPass = Date.now();
        autoPass();
      }, 5000);
    });
    listObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* the 45s timer still covers it */ }

  // Facebook is a SPA: the button must survive route changes.
  setInterval(injectButton, 1500);
  injectButton();
  setTimeout(autoPass, 3500);
  setInterval(autoPass, 45000);

  // ---- OUTBOUND DELIVERY (v2.1.32): the worker claims a queued reply
  // in the database, parks it in the luca_pending_delivery storage
  // slot, and points a Facebook tab at the thread. This script does
  // the typing HERE: CDP insertText (works in background tabs, where
  // execCommand silently no-ops), Enter to send, then VERIFY the
  // message actually appears as our bubble before reporting success.
  // Delivery only ever happens on the thread's own page — never
  // through a floating popup, whose conversation can't be matched to
  // the pending thread with certainty (wrong-person risk).
  var delivering = false;
  function waitMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitForValue(fn, timeoutMs, stepMs) {
    var end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      var v = fn();
      if (v) return v;
      await waitMs(stepMs || 400);
    }
    return null;
  }
  function replyCdpRequest(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: "AUTOLAUNCH_CDP" }, payload),
          function (resp) {
            void chrome.runtime.lastError;
            resolve(resp && typeof resp === "object" ? resp : { ok: false, error: "cdp_no_response" });
          });
      } catch (e) { resolve({ ok: false, error: "cdp_send_failed" }); }
    });
  }
  var replyCdpAttached = false;
  async function replyCdp(action, extra) {
    var res = await replyCdpRequest(Object.assign({ action: action }, extra || {}));
    if (action === "attach" && res && res.ok) replyCdpAttached = true;
    if (action === "detach") replyCdpAttached = false;
    return res;
  }
  function findComposer() {
    var scopes = [document.querySelector('[role="main"]'), document].filter(Boolean);
    for (var i = 0; i < scopes.length; i++) {
      var boxes = scopes[i].querySelectorAll('[role="textbox"]');
      for (var j = 0; j < boxes.length; j++) {
        var lab = (boxes[j].getAttribute("aria-label") || "").toLowerCase();
        if (lab.indexOf("message") !== -1 || lab === "aa") return boxes[j];
      }
    }
    return null;
  }
  function normMsg(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }

  async function deliverPending(p) {
    var result = { ok: false, error: null };
    try {
      var composer = await waitForValue(findComposer, 20000, 500);
      if (!composer) { result.error = "composer_not_found"; return result; }
      try { composer.focus(); } catch (e) { /* DOM focus is best effort */ }
      try { composer.click(); } catch (e) { /* same */ }
      await waitMs(300);
      var attached = await replyCdp("attach");
      var inserted = false;
      if (attached && attached.ok) {
        var ins = await replyCdp("insertText", { text: p.body });
        inserted = !!(ins && ins.ok);
      }
      if (!inserted) {
        try { inserted = document.execCommand("insertText", false, p.body); } catch (e) { /* ladder continues */ }
      }
      await waitMs(400);
      var inComposer = normMsg(textOf(composer)).indexOf(normMsg(p.body).slice(0, 40)) !== -1;
      if (!inComposer && !inserted) { result.error = "insert_failed"; return result; }
      if (replyCdpAttached) {
        await replyCdp("key", { key: "Enter", code: "Enter" });
      } else {
        var evInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        composer.dispatchEvent(new KeyboardEvent("keydown", evInit));
        composer.dispatchEvent(new KeyboardEvent("keypress", evInit));
        composer.dispatchEvent(new KeyboardEvent("keyup", evInit));
      }
      var want = normMsg(p.body);
      var hit = await waitForValue(function () {
        return findMessages().some(function (m) {
          return m.direction === "out" && (normMsg(m.body) === want || normMsg(m.body).indexOf(want.slice(0, 60)) === 0);
        }) ? true : null;
      }, 12000, 600);
      result.ok = !!hit;
      if (!hit) result.error = "not_verified_in_thread";
      return result;
    } finally {
      if (replyCdpAttached) {
        try { await replyCdp("detach"); } catch (e) { /* session hygiene best effort */ }
      }
    }
  }

  async function maybeDeliverPending() {
    if (delivering) return;
    var store = await chrome.storage.local.get(["luca_pending_delivery", "luca_delivery_claim"]);
    var p = store && store.luca_pending_delivery;
    if (!p || !p.messageId || !p.threadRef) return;
    if (threadKeyOf(window.location.href) !== threadKeyOf(p.threadRef)) return;
    // Cross-tab claim: another Facebook tab on the same thread must
    // not deliver twice. Storage claims aren't atomic, but a 30s
    // claim window makes a double-send a genuine rarity.
    var claim = store.luca_delivery_claim;
    if (claim && claim.messageId === p.messageId && Date.now() - (claim.at || 0) < 30000) return;
    await chrome.storage.local.set({ luca_delivery_claim: { messageId: p.messageId, at: Date.now() } });
    delivering = true;
    try {
      var res = await deliverPending(p);
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_REPLY_RESULT", messageId: p.messageId, ok: res.ok, error: res.error || null },
        function () { void chrome.runtime.lastError; });
    } catch (e) {
      try {
        chrome.runtime.sendMessage(
          { type: "AUTOLAUNCH_REPLY_RESULT", messageId: p.messageId, ok: false, error: "exception" },
          function () { void chrome.runtime.lastError; });
      } catch (e2) { /* worker will time the pending slot out */ }
    } finally {
      delivering = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "AUTOLAUNCH_DELIVER_NOW") maybeDeliverPending();
  });
  setTimeout(maybeDeliverPending, 2500);
  setInterval(maybeDeliverPending, 20000);
})();
