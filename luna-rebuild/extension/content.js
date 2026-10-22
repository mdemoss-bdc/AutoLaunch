// AutoLaunch Vehicle Assistant — Marketplace form filler (v3)
//
// Phase 3 changes vs the original:
//  1. REACT-SAFE VALUES: the old code set element.value directly, which
//     React controlled inputs ignore. This version uses the native
//     prototype value setter + input/change events React actually tracks.
//  2. MORE FIELDS: year, make, model, trim (title), price, mileage,
//     condition, fuel, transmission, body style and description — matched
//     by label/aria text, with a combobox path for Facebook's dropdown
//     style fields. The old code filled price, mileage and one textarea.
//  3. PHOTOS ARE CHECKED: an upload that does not produce a preview is a
//     loud failure (banner + job marked failed), never a silent continue.
//  4. POSTED MEANS POSTED: the old code waited a fixed 2 seconds and then
//     wrote "completed" no matter what happened. This version NEVER marks
//     posted on a timer. It reports POSTED only after detecting a real
//     success state on Facebook (listing URL or "your listing is live"
//     style confirmation). Anything else — timeout, checkpoint, missing
//     Publish button — reports FAILED with a reason.
//  5. CONFIRM MODE (default ON): fill everything, then stop and let the
//     human review and click Publish. Detection keeps watching, so the
//     human click still produces a real posted confirmation. Turn it off
//     in chrome.storage (autolaunch_confirm_mode = false) for full-auto.
//     Confirm mode still advances "Next" steps itself — navigation is
//     not publishing; it stops only before the actual Publish button.
//  6. CHECKPOINTS STOP THE JOB: a Facebook login wall or identity
//     checkpoint fails the job immediately. Never type into one.
//  7. PHOTO FETCH GOES AROUND CORS: this script runs on facebook.com, so
//     a direct fetch of a dealer photo URL is cross-origin — and dealer
//     photo servers send no Access-Control-Allow-Origin, so the fetch
//     died and every job failed with photo_download_failed (proven in
//     the first live test). Photos are now fetched two ways, in order:
//     (a) relayed through the background worker (extension fetches are
//     not page-CORS-bound; bytes come back base64), then (b) the
//     photo-proxy Edge Function, which returns CORS *. Only if BOTH fail
//     does the job fail honestly — a photoless car is never posted.
//  8. VERIFY-OR-REPORT (second live test): photos, description, location
//     and transmission filled fine, but Year/Make/Model/Price were left
//     EMPTY while the banner claimed "Everything is filled in". Never
//     again: after filling, every required field is READ BACK from the
//     DOM and compared to the payload; a mismatch gets one re-fill and a
//     re-verify; anything still wrong fails the job with reason
//     fields_unfilled:<list> and a banner naming the fields. The banner
//     may only claim "everything is filled" when verification passed.
//  9. MULTI-STEP FORM + THE VIN TRAP: Facebook's vehicle flow is now
//     stepped (step 1: VIN, vehicle type, photos, year/make/model,
//     price, description; step 2: body style, colors, condition, fuel,
//     transmission, clean title, and a SECOND description box that
//     starts empty). The filler walks the steps itself. And entering a
//     VIN makes Facebook auto-populate from its decoder — observed live
//     rewriting a 2016 Hyundai Tucson as a "2020 Honda Accord" — so the
//     VIN goes in FIRST, the decoder is given time to settle, and every
//     other field is then set from the payload and verified against it.
// 10. ESCALATION LADDER + DIAGNOSTICS (third live test): verify-or-
//     report worked exactly as designed — the photos (12) and the rich
//     description landed, and the job FAILED honestly because Year,
//     Make, Model and Price STILL would not stick: Facebook commits
//     those four only through its suggestion-listbox selection /
//     trusted input pipeline, and React resets DOM-set values. Those
//     fields now climb a ladder until a read-back matches — rung 1: the
//     v2 native-setter / combobox logic; rung 2: synthetic keyboard
//     (select-all + Delete, execCommand insertText, then a per-character
//     keydown/keypress/beforeinput/input/keyup flurry, with comboboxes
//     committed by clicking the exact-match suggestion option); rung 3:
//     CDP trusted input driven by the background worker
//     (chrome.debugger: real mouse clicks, Input.insertText, real key
//     events). Verify-or-report remains the final arbiter after the
//     ladder. A field that defeats all three rungs leaves a forensic
//     record — element tag/type/role/aria-label + outerHTML head, the
//     rungs attempted, the value read back — in autolaunch_failure_log
//     (via AUTOLAUNCH_FIELD_DIAG), so a fourth failure can never be
//     blind. While rung 3 is attached, Chrome shows a "…is debugging
//     this browser" infobar; it disappears on detach, which happens
//     when the fill sequence ends or the job finishes/fails.
// 11. DIAG-TO-DB + SINGLE-SHOT PHOTOS (v3.1, fourth live test): run 4
//     proved the installed build really was 2.1.0 (extensions card) and
//     the honesty layer held — yet the field_diag records NEVER
//     surfaced in autolaunch_failure_log where Matthew went to read
//     them (two bare {at, queueId, reason} entries, no diag extras),
//     so the failure stayed blind. The records now also ride the
//     AUTOLAUNCH_JOB_FAILED message itself, and the worker writes them
//     into the queue row's error_message column — evidence readable
//     straight from the database, no console archaeology. Each record
//     is also printed as ONE JSON line to this page's console:
//     "[AutoLaunch] field_diag {...}".
// 12. FIELD LOCATION + NEVER-EMPTY DIAGNOSTICS (v3.2, fifth live test):
//     run 5 was the giveaway — error_message stayed NULL under a
//     working diag-to-DB, meaning jobDiags was EMPTY: the ladder and
//     its forensics never ran at all. Root cause: fieldLabel() only
//     read an element's OWN aria-label / placeholder / label[for], and
//     Facebook's current variant carries the labels ("Year", "Make",
//     "Model", "Price") as sibling text inside a container div — the
//     controls themselves are bare. findAnyField therefore returned
//     null for exactly those four fields: fieldPresent was false, the
//     fillers skipped them, requiredSpecForStep excluded them, and
//     the aggregation failed them honestly with nothing to report.
//     (The fields that always worked — Location, Description,
//     Transmission — are the ones locatable by own attributes or a
//     fallback.) Location now also scores CONTAINER label text: an
//     ancestor's leading text segment or label-ish child, matched
//     exactly or as a prefix, among VISIBLE candidates — tried only
//     AFTER the own-label match, so nothing that located before moves.
//     Clickable divs ([role="button"], [aria-haspopup]) join the
//     candidate set for the select-like fields (the Year control in
//     this variant is a chevron div). And the diagnostics can no
//     longer be empty: a required field that fails WITHOUT ever being
//     located gets a synthesized record (note "field_not_located")
//     plus ONE "form_map" record — the first ~12 visible controls on
//     the failing step with their computed container labels — so any
//     future Facebook label change is visible in the DB on the first
//     failed run, not the fifth.
//     And the photo step (also v3.1) had a multiplication bug:
//     Facebook MERGES every input.files assignment
//     into its uploader's internal list, and the old code assigned a
//     GROWING DataTransfer once per photo — 1+2+…+12 ≈ 70 photos —
//     compounded by dedupe treating the same image at width=500
//     (image_url) and width=1600 (photos[]) as two different photos.
//     Photos are now deduped by normalized URL (the width parameter is
//     ignored; the widest variant wins), all bytes are fetched first,
//     and the finished set is assigned EXACTLY ONCE. The preview count
//     is verified afterwards: more previews than intended is a banner
//     warning, not a failure; past Facebook's 20-photo ceiling the
//     filler removes extras via the tiles' remove buttons, or fails
//     honestly with photo_overflow.

(async function () {
  const stored = await chrome.storage.local.get([
    "current_posting_job", "autolaunch_confirm_mode"
  ]);
  const job = stored.current_posting_job;
  if (!job || !job.car) return;

  const { queueId, car } = job;
  const confirmMode = stored.autolaunch_confirm_mode !== false; // default ON

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const humanPause = () => sleep(900 + Math.random() * 1600);

  // ---- visible status banner -------------------------------------------
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1d4ed8;" +
    "color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;" +
    "padding:10px 16px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.3)";
  document.documentElement.appendChild(banner);
  const say = (text, color) => {
    banner.textContent = "AutoLaunch: " + text;
    if (color) banner.style.background = color;
  };

  const report = (type, payload) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type, queueId }, payload || {}), () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) { resolve(); }
  });
  // fail(bannerText) or fail(bannerText, storedReason) — the stored
  // reason defaults to the banner text, but machine-readable reasons
  // (fields_unfilled:…) can differ from the human wording.
  const fail = async (bannerText, storedReason) => {
    await cdpDetach(); // a trusted-input session never outlives its job
    say("Stopped — " + bannerText + " This car was marked FAILED in your queue, not posted.", "#b91c1c");
    // The per-field forensic records ride THIS message (v3.1): the
    // worker writes them into the queue row's error_message, where
    // they can be read from the database. jobDiags is declared with
    // the ladder state below and filled by recordFieldDiagnostic —
    // fail() only ever runs after those declarations execute.
    await report("AUTOLAUNCH_JOB_FAILED", {
      reason: storedReason || bannerText,
      diags: jobDiags.slice()
    });
  };
  const failUnfilled = async names => {
    await fail(
      "could not fill: " + names.join(", ") + ".",
      "fields_unfilled:" + names.join(",")
    );
  };

  // ---- pure verification helpers ---------------------------------------
  // [PURE-VERIFY-BEGIN] — extracted and unit-exercised by the test
  // harness; keep these free of DOM/chrome references (element-likes in,
  // values out).
  function normText(v) {
    return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
  }
  function extractValue(el) {
    if (!el) return "";
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      const opts = el.options || [];
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].selected) return String(opts[i].text || opts[i].value || "");
      }
      return String(el.value || "");
    }
    if (typeof el.value === "string") return el.value;
    if (typeof el.value === "number") return String(el.value);
    return String(el.textContent || "");
  }
  function moneyNumber(v) {
    const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? null : n;
  }
  function valueMatches(actual, expected, kind) {
    if (expected == null || expected === "") return true; // nothing to prove
    if (kind === "year") {
      const a = String(actual || "").replace(/\D/g, "");
      const e = String(expected).replace(/\D/g, "");
      return a !== "" && a === e;
    }
    if (kind === "price" || kind === "number") {
      const a = moneyNumber(actual), e = moneyNumber(expected);
      return a !== null && e !== null && a === e;
    }
    if (kind === "contains") {
      return normText(actual).includes(normText(expected));
    }
    const a = normText(actual), e = normText(expected);
    if (!a || !e) return false;
    return a === e || a.includes(e) || e.includes(a);
  }
  // spec: [{ name, kind, expected, read(), refill() }] — read every field;
  // the mismatches get ONE refill each, then a re-read. Resolves to the
  // names still missing/wrong. This is the verify-or-report core.
  async function verifyFieldsWithRefill(spec) {
    const first = {};
    for (const f of spec) {
      try { first[f.name] = f.read(); } catch (e) { first[f.name] = ""; }
    }
    const bad = spec.filter(f => !valueMatches(first[f.name], f.expected, f.kind));
    for (const f of bad) {
      try { await f.refill(); } catch (e) { /* re-read decides */ }
    }
    const missing = [];
    for (const f of bad) {
      let now = "";
      try { now = f.read(); } catch (e) { now = ""; }
      if (!valueMatches(now, f.expected, f.kind)) missing.push(f.name);
    }
    return missing;
  }
  function vehicleTypeCandidates(carLike) {
    const hay = normText(
      (carLike.body_type || carLike.body_style || "") + " " +
      (carLike.make || "") + " " + (carLike.model || ""));
    if (hay.includes("motorcycle")) return ["Motorcycle"];
    if (hay.includes("rv") || hay.includes("camper")) return ["RV/Camper", "RV", "Camper"];
    if (hay.includes("trailer")) return ["Trailer"];
    if (hay.includes("boat")) return ["Boat"];
    // Cars, SUVs and pickups all live under Facebook's Car/Truck type.
    return ["Car/Truck", "Car", "Truck"];
  }
  function bodyStyleCandidates(carLike) {
    const raw = normText(carLike.body_style || carLike.body_type || "");
    const model = normText(carLike.model || "");
    const has = s => raw.includes(s) || model.includes(s);
    if (has("pickup") || has("truck")) return ["Pickup truck", "Truck", "Pickup"];
    if (has("suv") || has("crossover")) return ["SUV", "Crossover"];
    if (has("sedan")) return ["Sedan"];
    if (has("coupe")) return ["Coupe"];
    if (has("hatchback")) return ["Hatchback"];
    if (has("convertible")) return ["Convertible"];
    if (has("minivan")) return ["Minivan", "Van"];
    if (has("van")) return ["Van"];
    if (has("wagon")) return ["Wagon"];
    return raw ? [String(carLike.body_style || carLike.body_type)] : [];
  }
  function cleanTitleWanted(jobLike, carLike) {
    const settings = (jobLike && jobLike.settings) || {};
    if (settings.include_clean_title !== undefined) return !!settings.include_clean_title;
    if (carLike.include_clean_title !== undefined) return !!carLike.include_clean_title;
    if (carLike.clean_title === true) return true;
    if (typeof carLike.title_status === "string" &&
        normText(carLike.title_status).includes("clean")) return true;
    return false;
  }
  // [PURE-VERIFY-END]

  // [PURE-LADDER-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of DOM/chrome
  // references (element-likes and plain values in, plain values out).
  function keyEventInitForChar(ch) {
    let code = "";
    if (/[a-zA-Z]/.test(ch)) code = "Key" + ch.toUpperCase();
    else if (/[0-9]/.test(ch)) code = "Digit" + ch;
    else if (ch === " ") code = "Space";
    return { key: ch, code };
  }
  // The per-character event flurry of rung 2, as data: for each char —
  // keydown, keypress, beforeinput, input, keyup (the order a real
  // keystroke produces, and the one per-keystroke validators expect).
  function typingEventPlan(text) {
    const plan = [];
    for (const ch of String(text)) {
      const init = keyEventInitForChar(ch);
      plan.push({ type: "keydown", key: init.key, code: init.code });
      plan.push({ type: "keypress", key: init.key, code: init.code });
      plan.push({ type: "beforeinput", inputType: "insertText", data: ch });
      plan.push({ type: "input", inputType: "insertText", data: ch });
      plan.push({ type: "keyup", key: init.key, code: init.code });
    }
    return plan;
  }
  // Forensic snapshot of a field element for the failure log.
  function describeElement(el) {
    if (!el) return { tag: null, type: null, role: null, ariaLabel: null, outerHTML: null };
    const get = n => (typeof el.getAttribute === "function" ? el.getAttribute(n) : null);
    return {
      tag: String(el.tagName || "").toLowerCase() || null,
      type: get("type"),
      role: get("role"),
      ariaLabel: get("aria-label"),
      outerHTML: String(el.outerHTML || "").slice(0, 200) || null
    };
  }
  // The CDP wire protocol with the background worker, as data.
  function buildCdpAttach() { return { action: "attach" }; }
  function buildCdpDetach() { return { action: "detach" }; }
  function buildCdpClick(x, y) { return { action: "click", x, y }; }
  function buildCdpInsertText(text) { return { action: "insertText", text: String(text) }; }
  function buildCdpKey(key, code, opts) {
    const cmd = { action: "key", key: String(key), code: String(code || key) };
    if (opts && opts.text) cmd.text = String(opts.text);
    if (opts && opts.modifiers) cmd.modifiers = Number(opts.modifiers) || 0;
    return cmd;
  }
  // [PURE-LADDER-END]

  // [PURE-LOCATE-BEGIN] — extracted and unit-exercised by the test
  // harness alongside the verify helpers; keep these free of
  // chrome/fetch references (element-likes in, plain values out —
  // parentElement / childNodes / nodeType / tagName / getAttribute /
  // textContent are the only surface used). See header note 12: on
  // Facebook's current variant the label of Year/Make/Model/Price is
  // SIBLING TEXT inside a container div, not an attribute of the
  // control, so location must be able to read the container.
  // Does a subtree contain a form control? (Manual walk, node-capped,
  // so a label-ish child can be recognised by having none.)
  function subtreeHasFormControl(root, cap) {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen++ > (cap || 250)) continue;
      const tag = String(n.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (typeof n.getAttribute === "function") {
        const role = n.getAttribute("role");
        if (role === "combobox" || role === "textbox" || role === "listbox") return true;
      }
      const kids = n.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return false;
  }
  // The label-ish child of a container: its first element child whose
  // subtree holds NO form control and whose text is short (1..40
  // chars) — Facebook renders field labels as exactly such an
  // element. A control-bearing first element child is decisive: the
  // label is not here (""), never a deeper sibling's text.
  function labelishChildText(container) {
    const kids = (container && container.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (!n || n.nodeType !== 1) continue;
      if (subtreeHasFormControl(n)) return "";
      const t = String(n.textContent || "").trim();
      return t.length >= 1 && t.length <= 40 ? t : "";
    }
    return "";
  }
  // A container's leading text: its first non-empty text node, else
  // its label-ish child. Deliberately NOT the container's whole
  // textContent — that would make every ancestor "labelled" with
  // whatever field happens to be listed first inside it.
  function containerLeadingText(container) {
    if (!container) return "";
    const kids = container.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (!n) continue;
      if (n.nodeType === 3) {
        const t = String(n.nodeValue || "").trim();
        if (t) return t.slice(0, 60);
        continue;
      }
      if (n.nodeType === 1) break; // element children: helper below
    }
    return labelishChildText(container);
  }
  // The label a container gives its field: climb up to 5 ancestors
  // and take the first non-empty leading text. The field's own
  // wrapper is met first, so a shared form-group higher up only
  // labels a field when no closer container does.
  function containerLabel(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const t = containerLeadingText(node);
      if (t) return t;
    }
    return "";
  }
  // A container text labels a field when it EQUALS a keyword or
  // STARTS with it at a word boundary ("Price" ✓, "Price in USD" ✓,
  // "Priceless" ✗). Case-insensitive via normText.
  function labelTextMatches(text, keywords) {
    const lt = normText(text);
    if (!lt) return false;
    return (keywords || []).some(k => {
      const nk = normText(k);
      if (!nk) return false;
      if (lt === nk) return true;
      return lt.startsWith(nk) &&
        " :·•-/".includes(lt.charAt(nk.length));
    });
  }
  // [PURE-LOCATE-END]

  // ---- React-safe value setting -----------------------------------------
  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fieldLabel(el) {
    const aria = el.getAttribute("aria-label") || "";
    const ph = el.getAttribute("placeholder") || "";
    let lab = "";
    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`);
      if (l) lab = l.textContent || "";
    }
    return (aria + " " + ph + " " + lab).toLowerCase();
  }

  // Wider label context for elements whose label lives in an ancestor
  // (Facebook wraps fields in labelled containers; checkboxes especially).
  function nearbyText(el) {
    let text = fieldLabel(el);
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (node) text += " " + (node.textContent || "").slice(0, 160);
    }
    return text.toLowerCase();
  }

  // Candidate controls for field location (v3.2). The select-like
  // fields add clickable divs — [role="button"] / [aria-haspopup] —
  // because the Year control in Facebook's current variant is a
  // chevron div, not an input or a native select.
  const FIELD_SELECTOR =
    'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], ' +
    '[role="button"], [aria-haspopup]';

  function isVisibleEl(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    if (typeof el.getClientRects === "function" && el.getClientRects().length) return true;
    return false;
  }

  // Locate a field in three tries, in an order that cannot move a
  // field that already located (header note 12):
  //   (a) the element's OWN label — aria-label / placeholder /
  //       label[for] — the v2 behaviour, unchanged winners;
  //   (b) CONTAINER label text among VISIBLE candidates — the v3.2
  //       fix for labels that live as sibling text in a wrapper div;
  //   (c) the wider nearby-text context, as a last resort.
  function findAnyField(keywords, selector) {
    const all = Array.from(document.querySelectorAll(selector || FIELD_SELECTOR));
    const own = all.find(el => keywords.some(k => fieldLabel(el).includes(k)));
    if (own) return own;
    const byContainer = all.filter(isVisibleEl)
      .find(el => labelTextMatches(containerLabel(el), keywords));
    if (byContainer) return byContainer;
    return all.find(el => keywords.some(k => nearbyText(el).includes(k))) || null;
  }

  function findField(keywords, selector) {
    return findAnyField(keywords, selector || 'input, textarea, select');
  }

  function fieldPresent(keywords) {
    return !!findAnyField(keywords);
  }

  function readField(keywords) {
    return extractValue(findAnyField(keywords));
  }

  // ---- fill escalation ladder (v3, see header note 10) ------------------
  // State is per-job: which rungs each stubborn field has climbed, and
  // whether the forensic record for it has already been written.
  const fieldAttempts = {};   // name -> { rungs: [...], cdpError: null }
  const diagRecorded = new Set();
  const jobDiags = [];        // forensic records, sent with JOB_FAILED (v3.1)
  let formMapRecorded = false; // the form_map record is one per job (v3.2)
  let cdpAttached = false;

  function attemptsFor(name) {
    return (fieldAttempts[name] = fieldAttempts[name] || { rungs: [], cdpError: null });
  }
  function noteRung(name, rung) {
    const att = attemptsFor(name);
    if (!att.rungs.includes(rung)) att.rungs.push(rung);
  }

  function dispatchKeyboard(el, type, init) {
    el.dispatchEvent(new KeyboardEvent(type, Object.assign(
      { bubbles: true, cancelable: true, composed: true }, init || {})));
  }

  // A bare .click() is easy for React wrappers to shrug off; walk the
  // full pointer/mouse sequence a real press produces.
  function realisticClick(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2)
    };
    try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", init));
    try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  }

  // The suggestion option Facebook would commit: exact text first,
  // then prefix, then containment.
  function findOptionExact(value) {
    const wanted = normText(value);
    if (!wanted) return null;
    const opts = Array.from(document.querySelectorAll('[role="option"]'));
    return opts.find(o => normText(o.textContent) === wanted) ||
      opts.find(o => normText(o.textContent).startsWith(wanted)) ||
      opts.find(o => normText(o.textContent).includes(wanted)) || null;
  }

  // Rung 2's typing engine: follow typingEventPlan literally, committing
  // each character with the native setter between beforeinput and input
  // (synthetic key events alone never mutate a value — but the flurry
  // around the mutation is what per-keystroke validators listen to).
  async function rung2TypeText(el, text) {
    let acc = "";
    try { acc = extractValue(el); } catch (e) { acc = ""; }
    for (const stepEv of typingEventPlan(text)) {
      if (stepEv.type === "keydown" || stepEv.type === "keypress" || stepEv.type === "keyup") {
        dispatchKeyboard(el, stepEv.type, { key: stepEv.key, code: stepEv.code });
      } else {
        if (stepEv.type === "input") {
          acc += stepEv.data;
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, acc);
        }
        el.dispatchEvent(new InputEvent(stepEv.type, {
          inputType: stepEv.inputType, data: stepEv.data,
          bubbles: true, cancelable: true, composed: true
        }));
      }
      if (stepEv.type === "keyup") await sleep(30);
    }
  }

  async function rung2Fill(field) {
    const el = findAnyField(field.keywords);
    if (!el) return false;
    const value = String(field.expected);
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      // Type-ahead by trusted-looking key flurry; best-effort (the CDP
      // rung is the one with real keys) — read-back decides.
      el.focus();
      for (const ch of value) {
        const init = keyEventInitForChar(ch);
        dispatchKeyboard(el, "keydown", init);
        dispatchKeyboard(el, "keyup", init);
        await sleep(40);
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(400);
      return true;
    }
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      // Listbox trigger (a div/button that opens options): open it and
      // pick the exact option — the click is the commit.
      realisticClick(el);
      await sleep(900);
      const opt = findOptionExact(value);
      if (opt) { realisticClick(opt); await sleep(500); }
      return true;
    }
    el.focus();
    // Clear first: select-all + Delete through the keyboard pipeline,
    // with execCommand doing the actual edit where it can.
    dispatchKeyboard(el, "keydown", { key: "a", code: "KeyA", ctrlKey: true });
    try { document.execCommand("selectAll"); } catch (e) {}
    dispatchKeyboard(el, "keyup", { key: "a", code: "KeyA", ctrlKey: true });
    dispatchKeyboard(el, "keydown", { key: "Delete", code: "Delete" });
    try { document.execCommand("delete"); } catch (e) {}
    dispatchKeyboard(el, "keyup", { key: "Delete", code: "Delete" });
    // execCommand insertText performs a REAL edit in Chrome (proper
    // beforeinput/input with inputType=insertText) — try it before the
    // manual per-character climb.
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, value); } catch (e) {}
    if (!inserted || !valueMatches(extractValue(el), field.expected, field.kind)) {
      if (extractValue(el)) { try { nativeSetValue(el, ""); } catch (e) {} }
      await rung2TypeText(el, field.kind === "price" ? value.replace(/\D/g, "") : value);
    }
    await sleep(300);
    // Combobox commit: if a suggestion listbox is open, clicking the
    // exact-match option is what Facebook actually records.
    const opt = findOptionExact(value);
    if (opt) { realisticClick(opt); await sleep(500); }
    return true;
  }

  // ---- rung 3: CDP trusted input via the background worker --------------
  function cdpRequest(payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: "AUTOLAUNCH_CDP" }, payload),
          resp => {
            void chrome.runtime.lastError;
            resolve(resp && typeof resp === "object" ? resp
              : { ok: false, error: "cdp_no_response" });
          });
      } catch (e) { resolve({ ok: false, error: "cdp_send_failed" }); }
    });
  }

  async function cdpEnsure(fieldName) {
    if (cdpAttached) return true;
    const res = await cdpRequest(buildCdpAttach());
    if (res && res.ok) { cdpAttached = true; return true; }
    // Remember WHY rung 3 could not run — it lands in the diagnostics.
    attemptsFor(fieldName).cdpError = (res && res.error) || "cdp_attach_failed";
    return false;
  }

  async function cdpDetach() {
    if (!cdpAttached) return;
    cdpAttached = false;
    await cdpRequest(buildCdpDetach());
  }

  async function cdpClickEl(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(150);
    const r = el.getBoundingClientRect();
    return cdpRequest(buildCdpClick(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2)));
  }

  async function rung3Fill(field) {
    const el = findAnyField(field.keywords);
    if (!el) return false;
    if (!(await cdpEnsure(field.name))) return false;
    const value = String(field.expected);
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      // Trusted keys: click to focus/open, type-ahead the digits, Enter.
      await cdpClickEl(el);
      await sleep(300);
      for (const ch of value.replace(/\D/g, "")) {
        await cdpRequest(buildCdpKey(ch, "Digit" + ch, { text: ch }));
        await sleep(60);
      }
      await cdpRequest(buildCdpKey("Enter", "Enter"));
      await sleep(400);
      return true;
    }
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      // Listbox trigger: trusted click opens it, trusted click commits.
      await cdpClickEl(el);
      await sleep(900);
      const opt = findOptionExact(value);
      if (opt) { await cdpClickEl(opt); await sleep(500); }
      return true;
    }
    // Text/combobox input: trusted click focuses, select-all + delete,
    // then Input.insertText injects the text through the trusted
    // pipeline React actually listens to.
    await cdpClickEl(el);
    await sleep(250);
    await cdpRequest(buildCdpKey("a", "KeyA", { modifiers: 2 })); // Ctrl+A
    await cdpRequest(buildCdpKey("Backspace", "Backspace"));
    await cdpRequest(buildCdpInsertText(
      field.kind === "price" ? value.replace(/\D/g, "") : value));
    await sleep(900); // let a suggestion listbox render, if this field has one
    const opt = findOptionExact(value);
    if (opt) { await cdpClickEl(opt); await sleep(500); }
    else if (el.getAttribute("role") === "combobox") {
      // No clickable option materialised — keyboard commit instead.
      await cdpRequest(buildCdpKey("ArrowDown", "ArrowDown"));
      await cdpRequest(buildCdpKey("Enter", "Enter"));
      await sleep(400);
    }
    return true;
  }

  // ---- ladder driver + diagnostics ---------------------------------------
  function recordFieldDiagnostic(field, readBack, note) {
    if (diagRecorded.has(field.name)) return;
    diagRecorded.add(field.name);
    const att = attemptsFor(field.name);
    // The element snapshot: via the field's keywords when it has
    // them; the Description spec carries none — it locates through
    // findDescriptionField instead. A field that was never located
    // snapshots null (describeElement(null) → all-null descriptor),
    // which is exactly the evidence its "field_not_located" note
    // (v3.2) needs next to it.
    let el = null;
    try {
      el = field.keywords ? findAnyField(field.keywords)
        : (field.name === "Description" ? findDescriptionField() : null);
    } catch (e) { el = null; }
    const entry = {
      field: field.name,
      element: describeElement(el),
      rungsAttempted: att.rungs.slice(),
      readBack: String(readBack == null ? "" : readBack).slice(0, 200),
      expected: field.expected == null ? null : String(field.expected),
      cdpError: att.cdpError || null,
      note: note || null
    };
    // Three records of the same evidence (v3.1): (1) ONE JSON line on
    // this page's console, greppable as "field_diag"; (2) the job-level
    // array that rides the AUTOLAUNCH_JOB_FAILED message into the
    // queue row's error_message in the database — the channel that
    // cannot be lost; (3) the storage-log message, kept as before.
    console.log("[AutoLaunch] field_diag " + JSON.stringify(entry));
    jobDiags.push(entry);
    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_FIELD_DIAG", queueId, diag: entry },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* the console + job-payload records above still stand */ }
  }

  // ---- form map (v3.2): the never-empty-diagnostics companion -------
  // When a required field fails without ever being located, a bare
  // "not found" teaches nothing. The form map snapshots the first ~12
  // VISIBLE controls on the failing step — tag / type / role /
  // aria-label plus the container label location computed for each —
  // so the NEXT Facebook label change is legible from the database
  // row of the first failed run. It rides the same three channels as
  // a field diagnostic (console line, JOB_FAILED payload, storage).
  const FORM_MAP_SELECTOR =
    'input, textarea, select, [role="combobox"], [role="button"], ' +
    '[aria-haspopup], [contenteditable="true"]';
  function formMapEntries(limit) {
    return Array.from(document.querySelectorAll(FORM_MAP_SELECTOR))
      .filter(isVisibleEl)
      .slice(0, limit || 12)
      .map(el => {
        const d = describeElement(el);
        return {
          tag: d.tag, type: d.type, role: d.role, ariaLabel: d.ariaLabel,
          containerLabel: String(containerLabel(el) || "").slice(0, 120)
        };
      });
  }
  function recordFormMap() {
    if (formMapRecorded) return;
    formMapRecorded = true;
    const entry = {
      field: "__form_map__",
      element: null,
      rungsAttempted: [],
      readBack: "",
      expected: null,
      cdpError: null,
      note: "form_map",
      formMap: formMapEntries(12)
    };
    console.log("[AutoLaunch] field_diag " + JSON.stringify(entry));
    jobDiags.push(entry);
    try {
      chrome.runtime.sendMessage(
        { type: "AUTOLAUNCH_FIELD_DIAG", queueId, diag: entry },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* the console + job-payload records above still stand */ }
  }

  // Climb the ladder for one stubborn field; true only when a READ-BACK
  // matches the payload (verify-or-report stays the arbiter). On total
  // exhaustion the forensic record is written here, once per field.
  async function escalatedRefill(field) {
    const readNow = () => { try { return field.read(); } catch (e) { return ""; } };
    const settled = () => valueMatches(readNow(), field.expected, field.kind);

    noteRung(field.name, "rung1");
    try { await field.rung1(); } catch (e) {}
    if (settled()) return true;

    noteRung(field.name, "rung2");
    try { await rung2Fill(field); } catch (e) {}
    if (settled()) return true;

    noteRung(field.name, "rung3");
    try { await rung3Fill(field); } catch (e) {}
    if (settled()) return true;

    recordFieldDiagnostic(field, readNow());
    return false;
  }

  // Combobox/dropdown-style fields: open, type the value, then click the
  // option that matches. Returns true when an option was picked or the
  // input itself holds the value afterwards.
  async function fillCombobox(keywords, value) {
    const el = findField(keywords, 'input[role="combobox"], input');
    if (!el || !value) return false;
    el.focus();
    el.click();
    nativeSetValue(el, String(value));
    await sleep(1200);
    const wanted = String(value).toLowerCase();
    const options = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] *'));
    const match = options.find(o =>
      (o.textContent || "").trim().toLowerCase() === wanted ||
      (o.textContent || "").trim().toLowerCase().startsWith(wanted));
    if (match) { match.click(); await sleep(500); return true; }
    return normText(el.value) === wanted;
  }

  async function fillSelectOrListbox(keywords, candidates) {
    // Native <select> first — located by its own label, or (v3.2) by
    // container text when the select itself is bare.
    const sels = Array.from(document.querySelectorAll("select"));
    const sel = sels.find(s => keywords.some(k => fieldLabel(s).includes(k))) ||
      sels.find(s => labelTextMatches(containerLabel(s), keywords));
    if (sel) {
      for (const cand of candidates) {
        if (!cand) continue;
        const opt = Array.from(sel.options).find(o =>
          (o.textContent || "").toLowerCase().includes(String(cand).toLowerCase()) ||
          (o.value || "").toLowerCase().includes(String(cand).toLowerCase()));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }
    }
    // Listbox-style (Facebook custom dropdowns): open, then click option
    const trigger = findAnyField(keywords);
    if (trigger) {
      trigger.click();
      await sleep(900);
      for (const cand of candidates) {
        if (!cand) continue;
        const opt = Array.from(document.querySelectorAll('[role="option"]'))
          .find(o => (o.textContent || "").toLowerCase().includes(String(cand).toLowerCase()));
        if (opt) { opt.click(); await sleep(400); return true; }
      }
    }
    return false;
  }

  // Year/Make/Model are cascading on Facebook: Make options only enable
  // once Year is set, Model once Make is. Poll briefly for the next
  // field to become usable before filling it.
  async function waitForEnabled(keywords, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      const el = findAnyField(keywords);
      if (el && !el.disabled && el.getAttribute("aria-disabled") !== "true") return el;
      await sleep(500);
    }
    return findAnyField(keywords);
  }

  async function fillYearMakeModel() {
    if (fieldPresent(["year"]) && car.year) {
      await fillSelectOrListbox(["year"], [String(car.year)]) ||
        await fillCombobox(["year"], car.year);
      await sleep(700);
    }
    if (fieldPresent(["make"]) && car.make) {
      await waitForEnabled(["make"]);
      await fillSelectOrListbox(["make"], [car.make]) ||
        await fillCombobox(["make"], car.make);
      await sleep(700);
    }
    if (fieldPresent(["model"]) && car.model) {
      await waitForEnabled(["model"]);
      await fillSelectOrListbox(["model"], [car.model]) ||
        await fillCombobox(["model"], car.model);
      await sleep(700);
    }
  }

  // ---- photo fetching (see note 7 in the header) -----------------------
  // Same project URL + publishable key the background worker uses; the
  // photo-proxy is an Edge Function on that project that streams dealer
  // photos back with CORS * (built for the web app, reused here).
  const PHOTO_PROXY_URL = "https://tdsipiltwajwhzgjsupx.supabase.co/functions/v1/photo-proxy";
  const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";

  function base64ToBlob(base64, contentType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType || "image/jpeg" });
  }

  function relayPhoto(url) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "AUTOLAUNCH_FETCH_PHOTO", url }, resp => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // One photo, two stages: background relay first (no CORS wall), then
  // the photo-proxy. Throws only when both stages failed, so the caller
  // can skip to the next photo exactly like the old direct fetch did.
  async function fetchPhotoBlob(url) {
    const relayed = await relayPhoto(url);
    if (relayed && relayed.ok && relayed.base64) {
      return base64ToBlob(relayed.base64, relayed.contentType);
    }
    const res = await fetch(PHOTO_PROXY_URL + "?url=" + encodeURIComponent(url), {
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    if (!res.ok) throw new Error("photo_proxy_" + res.status);
    return res.blob();
  }

  // [PURE-PHOTOS-BEGIN] — extracted and unit-exercised by the test
  // harness; keep these free of DOM/chrome references.
  // The same dealer photo arrives at several sizes (image_url is the
  // width=500 variant, photos[] entries are width=1600). The dedupe key
  // therefore ignores the width parameter entirely: origin + pathname
  // (+ any remaining query) identifies the photo; among variants of
  // one photo the WIDEST wins (no width parameter = original = widest).
  function photoUrlKey(u) {
    try {
      const url = new URL(u);
      url.searchParams.delete("width");
      const rest = url.searchParams.toString();
      return url.origin + url.pathname + (rest ? "?" + rest : "");
    } catch (e) {
      return String(u).replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/, "");
    }
  }
  function photoUrlWidth(u) {
    try {
      const w = new URL(u).searchParams.get("width");
      return w == null ? Infinity : (parseInt(w, 10) || 0);
    } catch (e) {
      const m = /[?&]width=(\d+)/.exec(String(u));
      return m ? parseInt(m[1], 10) : Infinity;
    }
  }
  function dedupePhotoUrls(urls, cap) {
    const byKey = new Map(); // key -> best URL, in first-seen order
    for (const u of urls) {
      if (typeof u !== "string" || !u.startsWith("http")) continue;
      const key = photoUrlKey(u);
      const prev = byKey.get(key);
      if (prev === undefined || photoUrlWidth(u) > photoUrlWidth(prev)) {
        byKey.set(key, u);
      }
    }
    return [...byKey.values()].slice(0, cap || 12);
  }
  // [PURE-PHOTOS-END]

  function photoUrls() {
    const urls = [];
    if (car.image_url) urls.push(car.image_url);
    for (const key of ["photos", "images", "image_urls", "photo_urls"]) {
      if (Array.isArray(car[key])) {
        car[key].forEach(u => { if (typeof u === "string" && u.startsWith("http")) urls.push(u); });
      }
    }
    if (Array.isArray(car.custom_photo_urls)) {
      car.custom_photo_urls.forEach(u => { if (typeof u === "string" && u.startsWith("http")) urls.push(u); });
    }
    // Matthew's target: up to 12 photos per listing — counted AFTER
    // normalization dedupe, so a photo at two sizes counts once (v3.1).
    return dedupePhotoUrls(urls, 12);
  }

  // Preview tiles = the distinct photo previews Facebook rendered.
  // The same object URL is reused across a tile and the big preview,
  // so count distinct srcs, not <img> elements.
  function photoPreviewCount() {
    const srcs = new Set();
    document.querySelectorAll('img[src^="blob:"], img[src^="data:"]')
      .forEach(im => { if (im.src) srcs.add(im.src); });
    return srcs.size;
  }

  // The remove (×) button of the LAST photo tile: a "remove"-labelled
  // button sitting in a container that also holds a blob preview img.
  function lastPhotoRemoveButton() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
      const lab = (b.getAttribute("aria-label") || "").toLowerCase();
      if (!lab.includes("remove")) return false;
      let node = b;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (node && node.querySelector && node.querySelector('img[src^="blob:"]')) return true;
      }
      return false;
    });
    return btns[btns.length - 1] || null;
  }

  // Facebook caps vehicle listings at 20 photos. If its uploader merged
  // in leftovers (a prior attempt in the same tab), trim back to the cap
  // with the tiles' own remove buttons. False = could not get under it.
  async function trimPhotoPreviews(max) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (photoPreviewCount() <= max) return true;
      const btn = lastPhotoRemoveButton();
      if (!btn) return false;
      realisticClick(btn);
      await sleep(700);
    }
    return photoPreviewCount() <= max;
  }

  async function attachPhotos(urls) {
    const input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
    if (!input) return { ok: false, reason: "photo_input_not_found" };
    const before = photoPreviewCount();
    // Fetch EVERY photo first (relay → photo-proxy per URL; a URL dead
    // both ways costs one skip, exactly as before). A direct fetch of
    // the dealer URL from this page is CORS-blocked by design of the
    // photo servers — never add one back here.
    const files = [];
    for (const url of urls) {
      let blob;
      try { blob = await fetchPhotoBlob(url); } catch (e) { continue; }
      const name = (url.split("/").pop() || `photo-${files.length}.jpg`).split("?")[0];
      files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
    }
    if (!files.length) return { ok: false, reason: "photo_download_failed" };
    // Assign the finished set EXACTLY ONCE (v3.1): Facebook MERGES
    // every input.files assignment into its uploader's internal list,
    // so the old per-photo cumulative assignment re-added earlier
    // photos on every pass (1+2+…+12 ≈ 70 attachments in run 4).
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Verify via preview tiles: wait for the count to show up and
    // settle (two equal reads in a row), capped at ~16s.
    let count = before, stableReads = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(800);
      const now = photoPreviewCount();
      if (now === count && now > before) { stableReads++; if (stableReads >= 2) break; }
      else stableReads = 0;
      count = now;
      if (count - before >= files.length && i >= 2) break;
    }
    const attached = count - before;
    if (attached <= 0) return { ok: false, reason: "photo_preview_never_appeared" };
    if (count > 20) {
      // Over Facebook's hard ceiling — trim, or fail honestly.
      const trimmed = await trimPhotoPreviews(20);
      count = photoPreviewCount();
      if (!trimmed || count > 20) return { ok: false, reason: "photo_overflow" };
    }
    const result = { ok: true, count: Math.max(attached, 0) };
    if (attached > files.length) {
      // Facebook kept extras (merge leftovers) but we are within its
      // limits — a warning for the banner, not a failure.
      result.warning = "photo_overshoot:" + attached + "_of_" + files.length;
      result.shownCount = count;
    }
    return result;
  }

  function publishButton() {
    const btns = Array.from(document.querySelectorAll('[role="button"], button'));
    return btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t === "publish" || t === "post" || t.startsWith("publish");
    }) || null;
  }

  function nextButton() {
    const btns = Array.from(document.querySelectorAll('[role="button"], button'));
    return btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t !== "next") return false;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      return true;
    }) || null;
  }

  function detectPublished() {
    const url = window.location.href;
    if (/facebook\.com\/marketplace\/item\//.test(url)) return url;
    if (/marketplace\/you\/selling|commerce\/listing/.test(url)) return url;
    const text = (document.body.innerText || "").toLowerCase();
    if (text.includes("your listing is now live") ||
        text.includes("your listing has been published") ||
        text.includes("listed on marketplace")) {
      return url;
    }
    return null;
  }

  async function watchForPublish(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = detectPublished();
      if (hit) return hit;
      await sleep(3000);
    }
    return null;
  }

  function checkpointShowing() {
    const t = (document.body.innerText || "").toLowerCase();
    return t.includes("checkpoint") || t.includes("confirm your identity");
  }

  // ---- description ------------------------------------------------------
  function buildDescription() {
    const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"} ${car.trim || ""}`.trim();
    return (
      `${title}\n` +
      `Price: $${(car.price || 0).toLocaleString()}\n` +
      (car.mileage != null ? `Mileage: ${Number(car.mileage).toLocaleString()} miles\n` : "") +
      (car.color && normText(car.color) !== "standard" ? `Exterior: ${car.color}\n` : "") +
      (car.transmission ? `Transmission: ${car.transmission}\n` : "") +
      (car.vin ? `VIN: ${car.vin}\n` : "") +
      `\nInspected and frontline ready. Message to set up a test drive!`
    );
  }

  function findDescriptionField() {
    const textareas = Array.from(document.querySelectorAll("textarea"));
    const byLabel = textareas.find(t => fieldLabel(t).includes("description"));
    if (byLabel) return byLabel;
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const ed = editables.find(t => fieldLabel(t).includes("description") || nearbyText(t).includes("description"));
    if (ed) return ed;
    return textareas[0] || null;
  }

  function descriptionExpectedSnippet() {
    const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"}`.trim();
    return title;
  }

  async function fillDescription() {
    const field = findDescriptionField();
    if (!field) return;
    const want = buildDescription();
    if (normText(extractValue(field)).includes(normText(descriptionExpectedSnippet()))) return;
    if (field.tagName === "TEXTAREA" || field.tagName === "INPUT") {
      nativeSetValue(field, want);
    } else {
      field.focus();
      field.textContent = want;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await humanPause();
  }

  // ---- step field filling ------------------------------------------------
  // Everything here is presence-guarded: Facebook serves layout variants
  // and steps, so each filler only acts when its field is on this step.
  async function fillCurrentStepFields(isFirstStep) {
    // VIN FIRST on step 1, before anything it can corrupt: Facebook's
    // VIN decoder auto-populates (badly, observed live), so give it time
    // to fire and settle, THEN overwrite with payload truth below.
    if (isFirstStep && car.vin && fieldPresent(["vin"])) {
      const vinField = findAnyField(["vin"]);
      if (vinField && !valueMatches(extractValue(vinField), car.vin, "text")) {
        if (vinField.tagName === "INPUT" || vinField.tagName === "TEXTAREA") {
          nativeSetValue(vinField, String(car.vin));
        }
        say("VIN entered — waiting for Facebook's auto-fill to settle, then setting the real details…");
        await sleep(3000); // decoder settles inside this window
      }
    }

    // Vehicle type (step 1): Car/Truck for cars/SUVs/pickups.
    if (fieldPresent(["vehicle type"])) {
      await fillSelectOrListbox(["vehicle type"], vehicleTypeCandidates(car));
      await humanPause();
    }

    // Year → Make → Model cascade (payload values overwrite anything
    // the VIN decoder guessed).
    if (fieldPresent(["year"]) || fieldPresent(["make"]) || fieldPresent(["model"])) {
      say("Filling in vehicle details…");
      await fillYearMakeModel();
      await humanPause();
    }

    const priceField = findField(["price"]);
    if (priceField && car.price) { nativeSetValue(priceField, String(car.price)); await humanPause(); }

    const mileageField = findField(["mileage", "odometer"]);
    if (mileageField && car.mileage != null) { nativeSetValue(mileageField, String(car.mileage)); await humanPause(); }

    // Step-2 fields — best-effort, never job-fatal (see verify set).
    const bodyCands = bodyStyleCandidates(car);
    if (bodyCands.length && fieldPresent(["body style", "body type"])) {
      await fillSelectOrListbox(["body style", "body type"], bodyCands);
      await humanPause();
    }
    // "Standard" in the data means "we don't know" — never type it.
    if (car.color && normText(car.color) !== "standard" && fieldPresent(["exterior color", "exterior"])) {
      await fillSelectOrListbox(["exterior color", "exterior"], [car.color]) ||
        await fillCombobox(["exterior color", "exterior"], car.color);
      await humanPause();
    }
    if (car.interior_color && fieldPresent(["interior color", "interior"])) {
      await fillSelectOrListbox(["interior color", "interior"], [car.interior_color]) ||
        await fillCombobox(["interior color", "interior"], car.interior_color);
      await humanPause();
    }

    const conditionMap = {
      "New": ["New"],
      "Certified Pre-Owned": ["Certified pre-owned", "Certified", "Used - Excellent", "Excellent"],
      "Certified": ["Certified pre-owned", "Certified", "Used - Excellent", "Excellent"],
      "Used": ["Used - Good", "Used", "Good"]
    };
    if (fieldPresent(["condition"])) {
      await fillSelectOrListbox(["condition"], conditionMap[car.condition] || ["Used - Good", "Used"]);
      await humanPause();
    }
    if (car.fuel_type && fieldPresent(["fuel"])) {
      await fillSelectOrListbox(["fuel"], [car.fuel_type]);
      await humanPause();
    }
    if (car.transmission && fieldPresent(["transmission"])) {
      await fillSelectOrListbox(["transmission"], [car.transmission]);
      await humanPause();
    }
    if (car.body_type && car.body_type !== "Other" &&
        !fieldPresent(["body style"]) && fieldPresent(["style"])) {
      await fillSelectOrListbox(["style"], bodyStyleCandidates(car));
      await humanPause();
    }

    // Clean title: only when the user's preference or the payload says
    // the title is clean; when in doubt, leave it unchecked. Optional —
    // never part of the required verification set.
    if (cleanTitleWanted(job, car)) {
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
      const box = boxes.find(b => nearbyText(b).includes("clean title") || fieldLabel(b).includes("clean"));
      if (box) {
        const checked = box.checked === true || box.getAttribute("aria-checked") === "true";
        if (!checked) { box.click(); await sleep(400); }
      }
    }

    // Description: present on step 1 AND again (empty) on step 2 — fill
    // whichever instance this step shows; verification re-checks it at
    // the final step.
    if (findDescriptionField()) {
      await fillDescription();
    }
  }

  // ---- required-field verification ---------------------------------------
  // Required set (verify-or-report): Photos ≥1, Year, Make, Model,
  // Price, Description. Everything else is best-effort.
  function requiredSpecForStep() {
    const spec = [];
    // The four stubborn fields (Year/Make/Model/Price) refill via the
    // escalation ladder; their `refill` only reports success when a
    // read-back matches, and verifyFieldsWithRefill re-checks anyway.
    if (fieldPresent(["year"]) && car.year) {
      const f = {
        name: "Year", kind: "year", expected: car.year, keywords: ["year"],
        read: () => readField(["year"]),
        rung1: async () => {
          await fillSelectOrListbox(["year"], [String(car.year)]) ||
            await fillCombobox(["year"], car.year);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["make"]) && car.make) {
      const f = {
        name: "Make", kind: "text", expected: car.make, keywords: ["make"],
        read: () => readField(["make"]),
        rung1: async () => {
          await waitForEnabled(["make"]);
          await fillSelectOrListbox(["make"], [car.make]) ||
            await fillCombobox(["make"], car.make);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["model"]) && car.model) {
      const f = {
        name: "Model", kind: "text", expected: car.model, keywords: ["model"],
        read: () => readField(["model"]),
        rung1: async () => {
          await waitForEnabled(["model"]);
          await fillSelectOrListbox(["model"], [car.model]) ||
            await fillCombobox(["model"], car.model);
          await sleep(600);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (fieldPresent(["price"]) && car.price) {
      const f = {
        name: "Price", kind: "price", expected: car.price, keywords: ["price"],
        read: () => readField(["price"]),
        rung1: async () => {
          const pf = findField(["price"]);
          if (pf) nativeSetValue(pf, String(car.price));
          await sleep(400);
        }
      };
      f.refill = () => escalatedRefill(f);
      spec.push(f);
    }
    if (findDescriptionField()) {
      spec.push({
        name: "Description", kind: "contains", expected: descriptionExpectedSnippet(),
        read: () => extractValue(findDescriptionField()),
        refill: async () => {
          const f = findDescriptionField();
          if (f) {
            if (f.tagName === "TEXTAREA" || f.tagName === "INPUT") nativeSetValue(f, buildDescription());
            else { f.focus(); f.textContent = buildDescription(); f.dispatchEvent(new Event("input", { bubbles: true })); }
          }
          await sleep(400);
        }
      });
    }
    return spec;
  }

  // For the never-empty diagnostics (v3.2): the location keywords and
  // the payload value per required-field name, so a field that failed
  // WITHOUT ever entering a spec can still get a synthesized record.
  const REQUIRED_FIELD_KEYWORDS = {
    Year: ["year"], Make: ["make"], Model: ["model"], Price: ["price"]
  };
  function expectedForFieldName(name) {
    switch (name) {
      case "Year": return car.year;
      case "Make": return car.make;
      case "Model": return car.model;
      case "Price": return car.price;
      case "Description": return descriptionExpectedSnippet();
      default: return null;
    }
  }
  function locateRequiredField(name) {
    if (name === "Description") return findDescriptionField();
    const kw = REQUIRED_FIELD_KEYWORDS[name];
    return kw ? findAnyField(kw) : null;
  }

  // ---- main flow ----------------------------------------------------------
  try {
    say("Preparing your listing…");
    await sleep(3500); // let Facebook render the form

    const pageText = (document.body.innerText || "").toLowerCase();
    if (window.location.href.includes("/login") ||
        pageText.includes("checkpoint") ||
        pageText.includes("confirm your identity") ||
        pageText.includes("log in to facebook")) {
      await fail("Facebook is asking for login or an identity check. Sign in normally in this browser, then re-queue the car.");
      return;
    }

    // Photos first: a listing without photos is not worth posting, and a
    // failed upload must stop the job — not silently continue.
    const photos = photoUrls();
    let photoOk = false;
    if (photos.length) {
      say(`Uploading ${photos.length} photo(s)…`);
      const res = await attachPhotos(photos);
      if (!res.ok) {
        await fail(`Photo upload failed (${res.reason}).`);
        return;
      }
      photoOk = true;
      if (res.warning) {
        // Soft warning only (v3.1): Facebook is showing more previews
        // than we sent (its uploader merged leftovers), still within
        // its 20-photo limit — say so, then carry on.
        say(`Photos attached — Facebook is showing ${res.shownCount || res.count} (some duplicates from its uploader). Continuing…`);
        await sleep(2000);
      }
      await humanPause();
    }

    // Walk the steps: fill + verify each step, then click Next (in BOTH
    // modes — advancing a step is navigation, not publishing; confirm
    // mode stops only at the Publish button, when the form is complete).
    const verifiedEver = new Set();
    let lastStepMissing = [];
    let isFirstStep = true;
    for (let step = 0; step < 6; step++) {
      await fillCurrentStepFields(isFirstStep);
      isFirstStep = false;

      const spec = requiredSpecForStep();
      lastStepMissing = await verifyFieldsWithRefill(spec);
      for (const f of spec) {
        if (!lastStepMissing.includes(f.name)) verifiedEver.add(f.name);
      }
      if (spec.length) {
        say(lastStepMissing.length
          ? `Checking details… still missing: ${lastStepMissing.join(", ")}`
          : "Checking details… this step verified ✓");
      }

      if (publishButton()) break; // final step reached — Publish is here
      const next = nextButton();
      if (!next) break;
      next.click();
      await sleep(2800);
      if (checkpointShowing()) {
        await fail("Facebook showed an identity check mid-posting.");
        return;
      }
    }

    // Final verification pass — the LAST thing before confirm-watch, so
    // a mid-fill React re-render (photo attach, step change, VIN decode)
    // that wiped a field is caught here and repaired by the refill.
    await sleep(800);
    const finalSpec = requiredSpecForStep();
    const finalMissing = await verifyFieldsWithRefill(finalSpec);
    const missing = new Set(finalMissing);
    for (const f of finalSpec) {
      if (!finalMissing.includes(f.name)) verifiedEver.add(f.name);
    }
    // A required field that is not on the final step only passes if it
    // verified on the step where it lived.
    for (const name of ["Year", "Make", "Model", "Price", "Description"]) {
      const presentNow = finalSpec.some(f => f.name === name);
      if (!presentNow && !verifiedEver.has(name)) {
        const hadExpected =
          (name === "Year" && car.year) || (name === "Make" && car.make) ||
          (name === "Model" && car.model) || (name === "Price" && car.price) ||
          name === "Description";
        if (hadExpected) missing.add(name);
      }
    }
    // Never-empty diagnostics (v3.2): EVERY failed required field
    // leaves a forensic record. Fields the ladder exhausted already
    // have one (diagRecorded). The rest split in two: located but
    // never laddered (e.g. Description) — snapshot the real element;
    // and NEVER LOCATED — no spec ever included them because
    // fieldPresent was false all along (the run-5 failure mode) —
    // synthesize a "field_not_located" record, and map the form ONCE
    // so the shapes Facebook actually served are on the record too.
    for (const name of missing) {
      if (name === "Photos" || diagRecorded.has(name)) continue;
      const specEntry = finalSpec.find(f => f.name === name);
      const kw = REQUIRED_FIELD_KEYWORDS[name];
      if (specEntry) {
        let rb = "";
        try { rb = specEntry.read(); } catch (e) { rb = ""; }
        recordFieldDiagnostic(
          specEntry.keywords ? specEntry
            : Object.assign({}, specEntry, { keywords: kw }),
          rb);
      } else if (!locateRequiredField(name)) {
        recordFieldDiagnostic(
          { name, expected: expectedForFieldName(name), keywords: kw },
          "", "field_not_located");
        recordFormMap();
      } else {
        recordFieldDiagnostic(
          { name, expected: expectedForFieldName(name), keywords: kw }, "");
      }
    }
    if (!photoOk) missing.add("Photos");
    if (missing.size) {
      await failUnfilled([...missing]);
      return;
    }

    // The fill sequence is over and everything verified — end the
    // trusted-input session (Chrome's debugging infobar goes with it)
    // before the confirm watch / publish step.
    await cdpDetach();

    const already = detectPublished();
    if (already) {
      say("Listing confirmed live ✓", "#15803d");
      await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: already });
      return;
    }

    if (confirmMode) {
      say("Everything is filled in. Review it, then click Publish — AutoLaunch will confirm the post for you.", "#b45309");
      const hit = await watchForPublish(10 * 60 * 1000);
      if (hit) {
        say("Listing confirmed live ✓", "#15803d");
        await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: hit });
      } else {
        await fail("Publish was not confirmed within 10 minutes (never clicked, or Facebook did not show a success state).");
      }
      return;
    }

    // Full-auto mode.
    const btn = publishButton();
    if (!btn) {
      await fail("Could not find Facebook's Publish button — the form layout may have changed.");
      return;
    }
    say("Publishing…");
    await humanPause();
    btn.click();
    const hit = await watchForPublish(2 * 60 * 1000);
    if (hit) {
      say("Listing confirmed live ✓", "#15803d");
      await report("AUTOLAUNCH_JOB_POSTED", { listingUrl: hit });
    } else {
      await fail("Clicked Publish but Facebook never showed a success state within 2 minutes — NOT marked posted. Check Marketplace drafts.");
    }
  } catch (err) {
    console.error("[AutoLaunch] content error:", err);
    await fail("Unexpected error: " + (err && err.message ? err.message : "unknown"));
  }
})();

