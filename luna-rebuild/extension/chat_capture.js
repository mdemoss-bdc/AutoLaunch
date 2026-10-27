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
        if (nm && nm.length >= 2 && nm.length <= 60 && !isJunkName(nm)) return nm;
      }
    } catch (e) { /* fall through to the heading scan */ }
    // Thread header usually carries the buyer's name in a heading.
    var main = document.querySelector('[role="main"]');
    var scopes = [findChatPopup(), main, document].filter(Boolean);
    for (var i = 0; i < scopes.length; i++) {
      var heads = scopes[i].querySelectorAll("h1, h2");
      for (var j = 0; j < heads.length; j++) {
        var t = textOf(heads[j]);
        if (t && t.length >= 2 && t.length <= 60 && !isJunkName(t) && !/messenger|marketplace|chats|inbox/i.test(t)) return t;
      }
    }
    // Fallback: the document title on thread pages is often the name.
    var title = (document.title || "").replace(/\s*[|·•-]\s*Facebook.*$/i, "").replace(/^\(\d+\)\s*/, "").trim();
    if (title && !isJunkName(title) && !/messenger|facebook/i.test(title) && title.length <= 60) return title;
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

  // Chrome-label filter (v2.1.48): the thread page's info rail and
  // header render their labels as dir="auto" text too, and the
  // scrape stored them as if they were the rep's own messages —
  // "Mute", "Customize chat", "Chat members", the thread's own
  // title — polluting the Prospects view and Luca's voice data.
  // Two defenses: (1) an exact whole-text denylist of the known
  // Facebook chrome labels, plus the thread's own title text;
  // (2) a structural rule — a real message bubble is a plain text
  // block, never the whole content of a control (quick-reply chips
  // and rail rows are controls) and never inside a chrome region
  // (page header, nav, info rail, form). Whole-text only, always:
  // a real sentence that merely mentions a label is a message.
  var FB_CHROME_LABELS = {
    "Mute": 1, "Unmute": 1,
    "Customize chat": 1, "Chat members": 1,
    "Media, files and links": 1, "Privacy & support": 1,
    "Buyer details": 1, "Seller details": 1,
    "Send a quick response": 1,
    "View buyer": 1, "View seller": 1, "More options": 1,
    // v2.50 (sync repair): the generic participant placeholder and
    // composer/header furniture from half-rendered threads —
    // Matthew's live junk rows, 2026-10-27. Never a message body,
    // never a buyer name.
    "Facebook user": 1, "Compose": 1, "Conversation with Facebook user": 1
  };

  // v2.50: a scraped "name" that is really Facebook chrome is NOT
  // a resolved buyer — the worker's gate treats it as unresolved,
  // so it must never leave this script as a participant name.
  function isJunkName(n) {
    if (!n) return true;
    return !!FB_CHROME_LABELS[String(n).trim()];
  }

  function threadTitleTexts() {
    // The strings this thread's own header shows as its title —
    // "Name · Listing" from the aria-label, the header element's
    // visible text, and the name + listing pair rebuilt from the
    // scrapers. If the scrape meets one of these as a "message",
    // it is the header talking, not a person.
    var out = {};
    try {
      var titled = document.querySelector('[aria-label^="Conversation titled "]');
      if (titled) {
        var t = (titled.getAttribute("aria-label") || "").replace(/^Conversation titled\s*/, "").trim();
        if (t) out[t] = 1;
        var vis = textOf(titled);
        if (vis) out[vis] = 1;
      }
    } catch (e) { /* heuristic only */ }
    try {
      var name = findBuyerName();
      var lt = (findListing().vehicleText || "").replace(/^\$[\d,]+\s*-\s*/, "").trim();
      if (name && lt) out[name + " · " + lt] = 1;
    } catch (e) { /* heuristic only */ }
    return out;
  }

  function isChromeText(t, titles) {
    if (!t) return false;
    if (FB_CHROME_LABELS[t]) return true;
    if (titles && titles[t]) return true;
    return false;
  }

  function inChromeStructure(node, t) {
    // Structural containment: walk the node's ancestors. Chrome
    // regions (header / nav / complementary rail / search / form)
    // disqualify outright. A control (button / role=button) whose
    // ENTIRE text is this text also disqualifies — the node is the
    // control's label. A control holding more than this text (a
    // message row with hover actions) does not, and a link inside
    // a bubble (a pasted URL) never does.
    try {
      var el = node;
      for (var up = 0; up < 14 && el && el !== document.body; up++) {
        var role = el.getAttribute ? (el.getAttribute("role") || "") : "";
        var tag = el.tagName || "";
        if (role === "complementary" || role === "banner" || role === "navigation" ||
            role === "search" || tag === "HEADER" || tag === "NAV" || tag === "FORM") return true;
        if ((role === "button" || tag === "BUTTON") && textOf(el) === t) return true;
        el = el.parentElement;
      }
    } catch (e) { /* heuristic only — the text checks still apply */ }
    return false;
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
    var titles = threadTitleTexts();
    for (var i = 0; i < nodes.length; i++) {
      var t = textOf(nodes[i]);
      if (!t || t.length < 1 || t.length > 1000) continue;
      // Skip UI chrome that also uses dir="auto". The second pattern
      // set is Matthew's live thread (2026-10-25): header card labels,
      // group-system lines, and pane furniture that are NOT messages.
      if (/^(Seen|Delivered|Sent|Type a message|Aa|Search|Active now|You're friends on Facebook|You're both on Facebook)/.test(t)) continue;
      if (/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(t)) continue; // timestamp dividers ("1:57 PM") are not messages
      if (t === "Message sent" || t === "Message delivered") continue; // status furniture, not a message
      if (/^(View buyer|More options|Privacy & support|Messages|Send a quick response|Marketplace)$/.test(t)) continue;
      if (/^Conversation titled /.test(t)) continue;
      if (/^Conversation with /.test(t)) continue; // v2.50: half-rendered thread header
      if (/ created this group$/.test(t)) continue;
      if (/mutual friends/.test(t) || /badge on Marketplace/.test(t)) continue;
      // Info-panel guard (v2.1.39): the thread page's right rail
      // (Media, files and links) lives inside [role=main] too — its
      // attachment rows (filenames, sizes, dates) are not messages.
      // Seen live 2026-10-25 vacuuming a files list into a thread.
      if (nodes[i].closest && nodes[i].closest('[role="complementary"]')) continue;
      if (/\.(csv|txt|pdf|jpe?g|png|gif|mp3|wav|zip|docx?|xlsx?)$/i.test(t)) continue;
      if (/^\d+(\.\d+)?\s?(KB|MB|GB|B)$/.test(t)) continue;
      if (/Unread message:/.test(t)) continue;
      // Chrome-label filter (v2.1.48): the exact denylist + this
      // thread's title, and the structural containment rule.
      if (isChromeText(t, titles)) continue;
      if (inChromeStructure(nodes[i], t)) continue;
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

  // Seller-side evidence for the worker's auto-create gate
  // (v2.1.46): which surface this thread was read on, and whether
  // the thread pane carries the SELLER's controls. "View buyer"
  // renders only when the signed-in user is the listing's seller;
  // a buyer-side thread shows "View seller" instead.
  function threadSurface() {
    var p = window.location.pathname || "";
    return p.indexOf("/marketplace/inbox") === 0 ? "marketplace_inbox" : "";
  }

  function findSellerContext() {
    try {
      var scope = findChatPopup() || document.querySelector('[role="main"]') || document;
      var els = scope.querySelectorAll("a, button, [role='button'], span");
      for (var i = 0; i < els.length; i++) {
        if ((els[i].textContent || "").trim() === "View buyer") return true;
      }
    } catch (e) { /* heuristic only — never break the page */ }
    return false;
  }

  // Facebook identity (v2.1.47, worker header note 23): the gate's
  // self test compares IDENTITIES, never names — the rep tests from
  // a second account under the same display name, and real buyers
  // can share his name. Tokens are canonical: "id:<digits>" for
  // numeric profile ids, "vanity:<lowercased>" otherwise; an id
  // token never equals a vanity token (unproven = not self).
  var FB_RESERVED_SEGMENTS = {
    messages: 1, marketplace: 1, groups: 1, watch: 1, gaming: 1,
    friends: 1, notifications: 1, settings: 1, help: 1, events: 1,
    pages: 1, login: 1, sharer: 1, dialog: 1, plugins: 1, people: 1,
    search: 1, bookmarks: 1, me: 1, home: 1, "profile.php": 1,
    "photo.php": 1, "permalink.php": 1
  };

  function fbIdentityFromHref(href) {
    try {
      var u = new URL(href);
      if (!/(^|\.)facebook\.com$/.test(u.hostname)) return "";
      if (/\/profile\.php$/.test(u.pathname)) {
        var m = (u.search || "").match(/[?&]id=(\d+)/);
        return m ? "id:" + m[1] : "";
      }
      var seg = (u.pathname || "").split("/").filter(Boolean);
      if (seg.length === 1 && !FB_RESERVED_SEGMENTS[seg[0].toLowerCase()]) {
        return "vanity:" + seg[0].toLowerCase();
      }
    } catch (e) { /* not a profile link */ }
    return "";
  }

  function findSelfFbId() {
    // c_user is the signed-in account's numeric id, readable by the
    // page. Fallback: a profile.php link pointing at the account.
    try {
      var m = (document.cookie || "").match(/(?:^|;\s*)c_user=(\d+)/);
      if (m) return "id:" + m[1];
    } catch (e) { /* fall through */ }
    try {
      var links = document.querySelectorAll('a[href*="profile.php?id="]');
      for (var i = 0; i < links.length; i++) {
        var id = fbIdentityFromHref(links[i].href || "");
        if (id) return id;
      }
    } catch (e) { /* heuristic only */ }
    return "";
  }

  function findBuyerFbId(selfId) {
    // The counterparty's profile link lives on the thread pane —
    // the header / buyer card and the info rail, which on group-
    // flavored Marketplace threads is also where "Chat members"
    // links render. Take the pane's profile identities in order:
    // the buyer is the first that isn't provably the signed-in
    // user; if ALL of them are the signed-in user, the counterparty
    // IS the user (a true self thread). Tightest scope wins.
    try {
      var scopes = [findChatPopup(), document.querySelector('[role="main"]'), document].filter(Boolean);
      for (var s = 0; s < scopes.length; s++) {
        var seen = [];
        var links = scopes[s].querySelectorAll("a[href]");
        for (var i = 0; i < links.length; i++) {
          var id = fbIdentityFromHref(links[i].href || "");
          if (id && seen.indexOf(id) === -1) seen.push(id);
        }
        if (!seen.length) continue;
        for (var j = 0; j < seen.length; j++) {
          if (!selfId || seen[j] !== selfId) return seen[j];
        }
        return selfId;
      }
    } catch (e) { /* heuristic only */ }
    return "";
  }

  function scrape() {
    var listing = findListing();
    var selfId = findSelfFbId();
    return {
      buyerName: findBuyerName(),
      vehicleText: listing.vehicleText,
      itemUrl: listing.itemUrl,
      threadUrl: window.location.href,
      surface: threadSurface(),
      sellerContext: findSellerContext(),
      selfFbId: selfId,
      buyerFbId: findBuyerFbId(selfId),
      messages: findMessages()
    };
  }

  // Capture failure reasons (v2.1.47): a bare "Capture failed" told
  // the rep nothing. After a helper update, an already-open
  // Facebook tab runs an ORPHANED script whose sendMessage throws
  // (context invalidated) — the fix is reloading the tab, and the
  // label now says so. Worker-declined captures carry its code.
  function captureFailLabel(lastError, resp) {
    var msg = (lastError && lastError.message) || "";
    if (/context invalidated|receiving end does not exist|message port closed/i.test(msg)) {
      return "Capture failed — reload this Facebook tab";
    }
    if (resp && resp.error === "not_signed_in") return "Capture failed — open AutoLaunch & sign in";
    if (resp && resp.error === "no_buyer") return "Capture failed — no buyer found in this chat";
    if (resp && resp.error) return "Capture failed — try again in a moment";
    return "Capture failed — is AutoLaunch signed in?";
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
            setBtnLabel(btn, captureFailLabel(chrome.runtime.lastError, resp), false);
            return;
          }
          setBtnLabel(btn, "Captured ✓ " + (resp.added || 0) + " new · " + (resp.prospectName || "prospect"), true);
        });
      } catch (e) {
        setBtnLabel(btn, "Capture failed — reload this Facebook tab", false);
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
      if (isJunkName(nm)) nm = ""; // v2.50: a chrome placeholder is not a name
      var vm = rowText.match(/\$\d[\d,]*\s*-\s*[^·]{4,80}/);
      if (!vm) vm = rowText.match(/\b(19|20)\d{2}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z0-9]+/); // year/make/model label also proves Marketplace
      // Commerce gate (v2.1.34): the plain /messages list mixes in
      // personal chats, business-page chats and the Meta AI chat —
      // none of those are buyers. A row is only SENT with Marketplace
      // evidence: a priced listing label, a year/make/model label,
      // or the Marketplace inbox surface itself (which is commerce-
      // only by construction). Since v2.1.46 this pre-filter no
      // longer decides creation — the worker's autoCreateGate does,
      // and it fails closed where this pass cannot tell.
      var onMarketplaceInbox = (window.location.pathname || "").indexOf("/marketplace/inbox") === 0;
      var yearMake = /\b(19|20)\d{2}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+/.test(rowText);
      if (!onMarketplaceInbox && !vm && !yearMake) continue;
      if (/^(Meta AI|Facebook user)\b/i.test(nm) && !vm) continue;
      out.push({
        buyerName: nm,
        vehicleText: vm ? cleanListingLabel(vm[0]) : "",
        itemUrl: "",
        threadUrl: "https://www.facebook.com/messages/t/" + key,
        // v2.1.46: the worker's auto-create gate keys its surface
        // signal on this — a stub born on the Marketplace inbox is
        // commerce-surface evidence; a plain /messages row is not.
        surface: onMarketplaceInbox ? "marketplace_inbox" : "",
        sellerContext: false,
        selfFbId: findSelfFbId(),
        buyerFbId: "",
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
      if (isChromeText(snippet, null)) continue; // v2.1.48: a chrome label is not a snippet
      out.push({
        threadRef: "https://www.facebook.com/messages/t/" + key,
        snippet: snippet.slice(0, 140),
        direction: direction
      });
    }
    return out;
  }

  function sendCapture(capture) {
    // Every caller of this shared sender is an AUTO path (list pass,
    // observer, app-driven sync) — tag it so the worker can apply
    // the Marketplace-only auto rule. The manual Capture button has
    // its own send and stays untagged (a deliberate click is how a
    // rep adds a non-Marketplace thread).
    capture = Object.assign({}, capture, { auto: true });
    // Returns a promise that resolves when the worker has finished
    // (its handler responds only after the database write), so the
    // app-driven sync below can report TRUE completion.
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_CAPTURE_CHAT", capture: capture }, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Gate-skip retry (v2.50, background.js header note 24): the
  // worker's auto-create gate fails CLOSED on a half-rendered
  // page — unresolved_name before the header paints the buyer's
  // name, no_seller_signal before the seller controls / listing
  // link render. Those skips used to be FINAL: the open thread's
  // full capture is hash-deduped below, so a thread skipped
  // mid-render was never re-asked even after the page finished
  // painting. Track render-dependent skips per thread and re-ask
  // on later passes; terminal outcomes (created, self_thread,
  // deleted_by_user) clear the thread. Bounded per page session —
  // a thread that genuinely never resolves is retried a handful
  // of times, not forever.
  var GATE_RETRY_MAX = 10;
  var RENDER_SKIP_REASONS = { unresolved_name: 1, no_seller_signal: 1 };
  var gateSkipped = {}; // threadKey -> { capture, tries }

  function gateRetryKey(capture) {
    return threadKeyOf((capture && capture.threadUrl) || "") ||
      String((capture && capture.threadUrl) || "");
  }

  function noteCaptureResult(capture, resp) {
    var key = gateRetryKey(capture);
    if (!key) return;
    if (resp && resp.skipped) {
      if (RENDER_SKIP_REASONS[resp.skipped]) {
        var g = gateSkipped[key] || { tries: 0 };
        g.capture = capture;
        g.tries += 1;
        gateSkipped[key] = g;
      } else {
        delete gateSkipped[key]; // terminal skip (self / deleted)
      }
    } else if (resp && resp.ok) {
      delete gateSkipped[key];
    }
  }

  function sendCaptureTracked(capture) {
    var p = sendCapture(capture);
    // sendCapture resolves with the worker's response (or null on
    // a dead channel) — learning the outcome is the whole point.
    if (p && p.then) p.then(function (resp) {
      try { noteCaptureResult(capture, resp); } catch (e) { /* bookkeeping only */ }
    });
    return p;
  }

  function gateRetryDue(key) {
    var g = gateSkipped[key];
    return !!g && g.tries < GATE_RETRY_MAX;
  }

  var lastFullHash = "";
  function autoFullCapture() {
    if (!onChatSurface()) return null;
    var c = scrape();
    if (!c.messages.length && !c.buyerName) return null;
    var h = (c.threadUrl || "") + "|" + c.messages.map(function (m) { return m.direction + ":" + m.body; }).join("~");
    // A thread with a render-dependent skip on file bypasses the
    // hash dedupe while its retry budget lasts — the page may
    // have finished rendering around the very same messages.
    if (h === lastFullHash && !gateRetryDue(threadKeyOf(c.threadUrl || ""))) return null;
    lastFullHash = h;
    return sendCaptureTracked(c);
  }

  // App-driven sync (v2.1.38): the AutoLaunch page asks (through the
  // worker) for a capture RIGHT NOW and waits for the writes to land.
  // This exists because a BACKGROUND tab's own timers are throttled
  // by Chrome to ~1/minute — the exact lag Matthew measured — while a
  // runtime message wakes the script immediately.
  async function autoPassSync() {
    var jobs = [];
    try {
      if (onInboxListSurface()) {
        collectThreadStubs().forEach(function (c) { jobs.push(sendCaptureTracked(c)); });
        var snippets = collectThreadSnippets();
        if (snippets.length) {
          jobs.push(new Promise(function (resolve) {
            try {
              chrome.runtime.sendMessage({ type: "AUTOLAUNCH_CHAT_SNIPPETS", snippets: snippets }, function () {
                void chrome.runtime.lastError;
                resolve(null);
              });
            } catch (e) { resolve(null); }
          }));
        }
      }
      var full = autoFullCapture();
      if (full) jobs.push(full);
    } catch (e) { /* partial completion still counts */ }
    await Promise.all(jobs);
  }

  function autoPass() {
    try {
      if (onInboxListSurface()) {
        var stubKeys = {};
        collectThreadStubs().forEach(function (c) {
          stubKeys[gateRetryKey(c)] = 1;
          sendCaptureTracked(c);
        });
        // v2.50: re-ask for gate-skipped stub threads that have
        // scrolled out of the rendered list — their last capture
        // rides again while the retry budget lasts.
        Object.keys(gateSkipped).forEach(function (key) {
          if (stubKeys[key] || !gateRetryDue(key)) return;
          var g = gateSkipped[key];
          if (g.capture && g.capture.stub) sendCaptureTracked(g.capture);
        });
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
      if (!onInboxListSurface() && !onChatSurface()) return;
      if (observedTimer) return;
      observedTimer = setTimeout(function () {
        observedTimer = null;
        if (Date.now() - lastObservedPass < 6000) return;
        lastObservedPass = Date.now();
        autoPass();
      }, 2000);
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
      // Fallback (v2.1.36): label wording varies by surface — the
      // thread composer is the LAST visible contenteditable textbox
      // on the page (search boxes above it are plain inputs, never
      // contenteditable).
      var editables = [];
      for (var k = 0; k < boxes.length; k++) {
        if (boxes[k].getAttribute("contenteditable") === "true" && boxes[k].offsetParent !== null) editables.push(boxes[k]);
      }
      if (editables.length) return editables[editables.length - 1];
    }
    return null;
  }
  function normMsg(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }

  function findSendButton(composer) {
    // The composer's Send control (paper-plane arrow) is a real
    // clickable button near the textbox. Walk up from the composer,
    // searching each wider container; "send"-labeled only, and the
    // like button ("Send a like") is deliberately excluded.
    var node = composer;
    for (var depth = 0; depth < 7 && node; depth++) {
      node = node.parentElement;
      if (!node || !node.querySelectorAll) continue;
      var cands = node.querySelectorAll('[role="button"], button');
      for (var i = 0; i < cands.length; i++) {
        var lab = (cands[i].getAttribute("aria-label") || "").trim().toLowerCase();
        if (lab.indexOf("send") === 0 && lab.indexOf("like") === -1) {
          var r = cands[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return cands[i];
        }
      }
    }
    return null;
  }

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
      var attachedOk = !!(attached && attached.ok);
      if (attachedOk) {
        await replyCdp("key", { key: "Enter", code: "Enter" });
      } else {
        var evInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        composer.dispatchEvent(new KeyboardEvent("keydown", evInit));
        composer.dispatchEvent(new KeyboardEvent("keypress", evInit));
        composer.dispatchEvent(new KeyboardEvent("keyup", evInit));
      }
      await waitMs(700);
      // Send-button fallback (v2.1.41): when the CDP key path isn't
      // available, the synthetic Enter is ignored by Messenger's
      // current composer and the text sits in the box unsent (seen
      // live 2026-10-25: "i didnt say anything" typed but never
      // sent). The composer's own Send button is a real control —
      // click it whenever the text is still sitting there.
      if (normMsg(textOf(composer)).indexOf(normMsg(p.body).slice(0, 40)) !== -1) {
        var sendBtn = findSendButton(composer);
        if (sendBtn) { try { sendBtn.click(); } catch (e) { /* the verify below decides */ } }
      }
      var want = normMsg(p.body);
      var sendAt = Date.now();
      var hit = await waitForValue(function () {
        var inThread = findMessages().some(function (m) {
          return m.direction === "out" && (normMsg(m.body) === want || normMsg(m.body).indexOf(want.slice(0, 60)) === 0);
        });
        if (inThread) return true;
        // Composer emptied = Facebook accepted the send, even when
        // the bubble scrape lags in a background tab.
        if (Date.now() - sendAt > 1500 && normMsg(textOf(composer)) === "") return true;
        return null;
      }, 12000, 600);
      result.ok = !!hit;
      if (!hit) result.error = "not_verified_in_thread" + (attachedOk ? "" : "_nocdp");
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

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "AUTOLAUNCH_DELIVER_NOW") {
      // ACK first (v2.1.35): the worker treats no-ACK as a dead
      // script and reloads the tab, so answering is what proves this
      // script is alive. Delivery itself proceeds async.
      try { sendResponse({ accepted: true }); } catch (e) { /* channel quirks are non-fatal */ }
      maybeDeliverPending();
      return;
    }
    if (msg && msg.type === "AUTOLAUNCH_SYNC_NOW") {
      // App-driven sync (v2.1.38): run a pass and answer only when
      // the worker has confirmed the database writes, so the app can
      // repaint with the new messages already in place.
      autoPassSync().then(function () {
        try { sendResponse({ ok: true }); } catch (e) { /* page moved on */ }
      });
      return true;
    }
  });
  setTimeout(maybeDeliverPending, 2500);
  setInterval(maybeDeliverPending, 20000);
})();
