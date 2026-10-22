// AutoLaunch Vehicle Assistant — Marketplace form filler (v2)
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
    say("Stopped — " + bannerText + " This car was marked FAILED in your queue, not posted.", "#b91c1c");
    await report("AUTOLAUNCH_JOB_FAILED", { reason: storedReason || bannerText });
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

  function findField(keywords, selector) {
    const els = Array.from(document.querySelectorAll(selector || 'input, textarea'));
    return els.find(el => keywords.some(k => fieldLabel(el).includes(k))) || null;
  }

  function findAnyField(keywords) {
    return findField(keywords,
      'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]');
  }

  function fieldPresent(keywords) {
    return !!findAnyField(keywords);
  }

  function readField(keywords) {
    return extractValue(findAnyField(keywords));
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
    // Native <select> first
    const sels = Array.from(document.querySelectorAll("select"));
    const sel = sels.find(s => keywords.some(k => fieldLabel(s).includes(k)));
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
    // Matthew's target: up to 12 photos per listing.
    return [...new Set(urls)].slice(0, 12);
  }

  function photoPreviewCount() {
    return document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
  }

  async function attachPhotos(urls) {
    const input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
    if (!input) return { ok: false, reason: "photo_input_not_found" };
    const before = photoPreviewCount();
    const dt = new DataTransfer();
    let added = 0;
    // Sequential, one at a time: assign the cumulative file list after
    // each photo and watch the preview count, so one dead URL costs one
    // skip — not the whole upload — and progress is actually observed.
    for (const url of urls) {
      let blob;
      try {
        // Relay → photo-proxy (fetchPhotoBlob). A direct fetch of the
        // dealer URL from this page is CORS-blocked by design of the
        // photo servers — never add one back here.
        blob = await fetchPhotoBlob(url);
      } catch (e) { continue; } // this URL is dead both ways — next photo
      const name = (url.split("/").pop() || `photo-${added}.jpg`).split("?")[0];
      dt.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
      added++;
      const previewsBeforeAdd = photoPreviewCount();
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 4; i++) {
        await sleep(700);
        if (photoPreviewCount() > previewsBeforeAdd) break;
      }
    }
    if (!added) return { ok: false, reason: "photo_download_failed" };
    // Verify at least one preview actually appeared — the old code
    // checked this too; a listing with zero visible photos is a failure.
    for (let i = 0; i < 10; i++) {
      if (photoPreviewCount() > before) return { ok: true, count: added };
      await sleep(1000);
    }
    return { ok: false, reason: "photo_preview_never_appeared" };
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
    if (fieldPresent(["year"]) && car.year) {
      spec.push({
        name: "Year", kind: "year", expected: car.year,
        read: () => readField(["year"]),
        refill: async () => {
          await fillSelectOrListbox(["year"], [String(car.year)]) ||
            await fillCombobox(["year"], car.year);
          await sleep(600);
        }
      });
    }
    if (fieldPresent(["make"]) && car.make) {
      spec.push({
        name: "Make", kind: "text", expected: car.make,
        read: () => readField(["make"]),
        refill: async () => {
          await waitForEnabled(["make"]);
          await fillSelectOrListbox(["make"], [car.make]) ||
            await fillCombobox(["make"], car.make);
          await sleep(600);
        }
      });
    }
    if (fieldPresent(["model"]) && car.model) {
      spec.push({
        name: "Model", kind: "text", expected: car.model,
        read: () => readField(["model"]),
        refill: async () => {
          await waitForEnabled(["model"]);
          await fillSelectOrListbox(["model"], [car.model]) ||
            await fillCombobox(["model"], car.model);
          await sleep(600);
        }
      });
    }
    if (fieldPresent(["price"]) && car.price) {
      spec.push({
        name: "Price", kind: "price", expected: car.price,
        read: () => readField(["price"]),
        refill: async () => {
          const f = findField(["price"]);
          if (f) nativeSetValue(f, String(car.price));
          await sleep(400);
        }
      });
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
    if (!photoOk) missing.add("Photos");
    if (missing.size) {
      await failUnfilled([...missing]);
      return;
    }

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

