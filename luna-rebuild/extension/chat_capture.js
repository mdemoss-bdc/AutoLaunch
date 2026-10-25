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

  function onChatSurface() {
    var p = window.location.pathname || "";
    return p.indexOf("/messages/") === 0 || p.indexOf("/marketplace/inbox") === 0;
  }

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || "").trim().replace(/\s+/g, " ");
  }

  function findBuyerName() {
    // Thread header usually carries the buyer's name in a heading.
    var main = document.querySelector('[role="main"]');
    var scopes = [main, document].filter(Boolean);
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

  function findListing() {
    // Marketplace threads link the listing; the first item link in the
    // thread pane is the car this chat is about.
    var links = document.querySelectorAll('a[href*="/marketplace/item/"]');
    for (var i = 0; i < links.length; i++) {
      var label = textOf(links[i]) || (links[i].getAttribute("aria-label") || "").trim();
      var href = links[i].href || "";
      if (label && label.length >= 4) return { vehicleText: label.slice(0, 140), itemUrl: href };
      if (href) return { vehicleText: "", itemUrl: href };
    }
    return { vehicleText: "", itemUrl: "" };
  }

  function findMessages() {
    var main = document.querySelector('[role="main"]') || document.body;
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
      // Skip UI chrome that also uses dir="auto".
      if (/^(Seen|Delivered|Sent|Type a message|Aa|Search|Active now|You're friends on Facebook|You're both on Facebook)/.test(t)) continue;
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
