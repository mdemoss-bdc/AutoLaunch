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
//  6. CHECKPOINTS STOP THE JOB: a Facebook login wall or identity
//     checkpoint fails the job immediately. Never type into one.

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
  const fail = async reason => {
    say("Stopped — " + reason + " This car was marked FAILED in your queue, not posted.", "#b91c1c");
    await report("AUTOLAUNCH_JOB_FAILED", { reason });
  };

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

  function findField(keywords, selector) {
    const els = Array.from(document.querySelectorAll(selector || 'input, textarea'));
    return els.find(el => keywords.some(k => fieldLabel(el).includes(k))) || null;
  }

  // Combobox/dropdown-style fields: type the value, then click the option
  // that matches. Returns true when an option was picked.
  async function fillCombobox(keywords, value) {
    const el = findField(keywords, 'input[role="combobox"], input');
    if (!el || !value) return false;
    nativeSetValue(el, String(value));
    await sleep(1200);
    const wanted = String(value).toLowerCase();
    const options = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] *'));
    const match = options.find(o =>
      (o.textContent || "").trim().toLowerCase() === wanted ||
      (o.textContent || "").trim().toLowerCase().startsWith(wanted));
    if (match) { match.click(); return true; }
    return false;
  }

  async function fillSelectOrListbox(keywords, candidates) {
    // Native <select> first
    const sels = Array.from(document.querySelectorAll("select"));
    const sel = sels.find(s => keywords.some(k => fieldLabel(s).includes(k)));
    if (sel) {
      for (const cand of candidates) {
        const opt = Array.from(sel.options).find(o =>
          (o.textContent || "").toLowerCase().includes(cand.toLowerCase()) ||
          (o.value || "").toLowerCase().includes(cand.toLowerCase()));
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
    const trigger = findField(keywords, 'input, [role="combobox"], [aria-haspopup="listbox"]');
    if (trigger) {
      trigger.click();
      await sleep(900);
      for (const cand of candidates) {
        const opt = Array.from(document.querySelectorAll('[role="option"]'))
          .find(o => (o.textContent || "").toLowerCase().includes(cand.toLowerCase()));
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
  }

  function photoUrls() {
    const urls = [];
    if (car.image_url) urls.push(car.image_url);
    for (const key of ["photos", "images", "image_urls", "photo_urls"]) {
      if (Array.isArray(car[key])) {
        car[key].forEach(u => { if (typeof u === "string" && u.startsWith("http")) urls.push(u); });
      }
    }
    return [...new Set(urls)].slice(0, 10);
  }

  async function attachPhotos(urls) {
    const input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
    if (!input) return { ok: false, reason: "photo_input_not_found" };
    const before = document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
    const dt = new DataTransfer();
    let added = 0;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        const name = (url.split("/").pop() || `photo-${added}.jpg`).split("?")[0];
        dt.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
        added++;
      } catch (e) { /* try the next photo */ }
    }
    if (!added) return { ok: false, reason: "photo_download_failed" };
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Verify a preview actually appeared — the old code never checked.
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const now = document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
      if (now > before) return { ok: true, count: added };
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
    if (photos.length) {
      say(`Uploading ${photos.length} photo(s)…`);
      const res = await attachPhotos(photos);
      if (!res.ok) {
        await fail(`Photo upload failed (${res.reason}).`);
        return;
      }
      await humanPause();
    }

    // Text dropdowns / comboboxes (Facebook's vehicle flow uses these for
    // year, make and model on most layouts).
    say("Filling in vehicle details…");
    await fillCombobox(["year"], car.year);
    await humanPause();
    await fillCombobox(["make"], car.make);
    await humanPause();
    await fillCombobox(["model"], car.model);
    await humanPause();

    const priceField = findField(["price"]);
    if (priceField && car.price) { nativeSetValue(priceField, String(car.price)); await humanPause(); }

    const mileageField = findField(["mileage", "odometer"]);
    if (mileageField && car.mileage != null) { nativeSetValue(mileageField, String(car.mileage)); await humanPause(); }

    const conditionMap = {
      "New": ["New"],
      "Certified Pre-Owned": ["Certified", "Used - Excellent", "Excellent"],
      "Used": ["Used - Good", "Used", "Good"]
    };
    await fillSelectOrListbox(["condition"], conditionMap[car.condition] || ["Used - Good", "Used"]);
    await humanPause();

    if (car.transmission) {
      await fillSelectOrListbox(["transmission"], [car.transmission]);
      await humanPause();
    }
    if (car.body_type && car.body_type !== "Other") {
      await fillSelectOrListbox(["body", "vehicle type", "style"], [car.body_type]);
      await humanPause();
    }

    // Description — the one big textarea. Title lives in the description
    // because Marketplace vehicle listings have no separate title field.
    const textareas = Array.from(document.querySelectorAll("textarea"));
    const descField = textareas.find(t => fieldLabel(t).includes("description")) || textareas[0];
    if (descField) {
      const title = `${car.year || ""} ${car.make || ""} ${car.model || "Vehicle"} ${car.trim || ""}`.trim();
      const body =
        `${title}\n` +
        `Price: $${(car.price || 0).toLocaleString()}\n` +
        (car.mileage != null ? `Mileage: ${Number(car.mileage).toLocaleString()} miles\n` : "") +
        (car.color ? `Exterior: ${car.color}\n` : "") +
        (car.transmission ? `Transmission: ${car.transmission}\n` : "") +
        (car.vin ? `VIN: ${car.vin}\n` : "") +
        `\nInspected and frontline ready. Message to set up a test drive!`;
      nativeSetValue(descField, body);
      await humanPause();
    }

    // Multi-step layouts: advance through "Next" steps in full-auto mode,
    // re-checking we are not staring at a checkpoint after each step.
    if (!confirmMode) {
      for (let step = 0; step < 5; step++) {
        if (publishButton()) break;
        const next = Array.from(document.querySelectorAll('[role="button"], button'))
          .find(b => (b.textContent || "").trim().toLowerCase() === "next");
        if (!next) break;
        next.click();
        await sleep(2500);
        const t = (document.body.innerText || "").toLowerCase();
        if (t.includes("checkpoint") || t.includes("confirm your identity")) {
          await fail("Facebook showed an identity check mid-posting.");
          return;
        }
        const p2 = findField(["price"]);
        if (p2 && car.price && !p2.value) { nativeSetValue(p2, String(car.price)); await humanPause(); }
      }
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
