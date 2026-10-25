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

  // Facebook is a SPA: the button must survive route changes.
  setInterval(injectButton, 1500);
  injectButton();
})();
