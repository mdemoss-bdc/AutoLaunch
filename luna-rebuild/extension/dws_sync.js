"use strict";
/* =====================================================================
   DealerCenter DWS — HELPER-SIDE INVENTORY SYNC (v2.1.80)
   =====================================================================
   Why this exists (2026-11-05): DealerCenter "DWS" dealer sites sit
   behind a Cloudflare rule that hard-blocks datacenter egress — our
   GitHub-runner scraper gets a 403 block page on every transport, so
   those accounts can never sync server-side (first account: Clear
   Choice Auto Sales of Ashland, Mike Thompson — its parser shipped
   in scraper.py the same day and proved 50/50 against the site's own
   bytes, but the runner cannot reach the site at all).

   The fix rides the helper: the dealer's own Chrome is a real
   browser on a residential connection, and Cloudflare serves it the
   site exactly as it serves the dealer. The sync below is a faithful
   JS port of the Python DWS path (crawl_dws_feed +
   parse_dws_listing_html + the _parse_dws_vdp branch of
   parse_vdp_details + enrich_cars_with_vdp's merge +
   push_batch_to_supabase's preservation/upsert + the stale pass's
   brake), driven by scrape_jobs rows instead of the runner.

   NO-INTERRUPTION GUARANTEE (Matthew's standing rule, restated for
   this feature 2026-11-05): the crawl is BACKGROUND FETCH ONLY.
   This file performs plain fetch() calls from the service worker —
   it never creates, navigates, activates, or focuses a tab or
   window (no chrome.tabs / chrome.windows calls exist in this
   file; the build harness greps for them). The dealer can be
   working in any window on any screen while a sync runs; if Chrome
   is closed entirely, the job simply waits for the next poll after
   it reopens.

   Job discipline:
   * Jobs come from scrape_jobs — a table the posting helpers have
     never claimed, so no older helper can mistake a sync job for a
     Marketplace post (the claim-shape hazard that fences
     auto_posting_queue does not exist here).
   * Only UNSCOPED, non-sync_vin jobs are eligible. Scoped and
     single-car jobs stay with the server, exactly as before.
   * The helper claims by flipping pending -> processing (a status
     the server's pending-only pickup then skips), and finishes the
     row exactly as the server would: completed + cars_synced +
     completed_at, or failed when the crawl dies before landing
     anything.
   * REPAIR PASS: the server may win the race to a job and complete
     it with 0 cars (its blocked crawl "succeeds" empty). When the
     newest such job is fresh (< 30 min) and this account's site
     fingerprints as DWS, the helper re-runs the crawl for it and
     corrects cars_synced. One attempt per job, ever.
   * The lease is honored exactly like posting claims: a foreign,
     unexpired lease means stand down.
   * This path QUEUES NOTHING: no auto-post pass, no price-update
     rows, no exit-delete rows (the server's stale pass queues those
     via _queue_exit_listing_removals; the helper only flips
     is_active on verified exits, under the same >50%-of->=20
     mass-exit brake). It also never writes sync_summaries — RLS
     denies owner inserts there (proven 2026-11-05), and the
     helper's sb layer reads any 403 as a dead session, so the
     attempt itself would do harm. The job row in scrape_jobs is
     the completion record, same as the app's status display reads.
   ===================================================================== */

// ---------------------------------------------------------------------
// Pure port — no chrome/DOM/fetch references below this line until the
// orchestration section. The Node harness loads this file directly.
// ---------------------------------------------------------------------

const DWS_VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const DWS_MAX_PHOTOS = 20;          // MAX_PHOTOS_PER_VEHICLE
const DWS_TEST_SYNC_LIMIT = 15;     // TEST_SYNC_LIMIT
const DWS_MAX_USED_FEEDS = 5;       // MAX_USED_FEEDS
const DWS_STALE_MAX_FRACTION = 0.5; // STALE_MAX_FRACTION

function dwsIsPlatform(html) {
  if (!html) return false;
  return html.includes('data-vehicle-id="vehicle-id-') &&
    html.toLowerCase().includes("dealercenter");
}

// Python int(float(str)) with $/, stripped; band 1000..350000.
function dwsMoneyInt(raw) {
  if (raw === null || raw === undefined) return null;
  const v = Math.trunc(parseFloat(String(raw).replace(/\$/g, "").replace(/,/g, "").trim()));
  if (!isFinite(v)) return null;
  return (v >= 1000 && v <= 350000) ? v : null;
}

// Python int(float(str)) with , stripped; band 0..2000000.
function dwsMileageInt(raw) {
  if (raw === null || raw === undefined) return null;
  const v = Math.trunc(parseFloat(String(raw).replace(/,/g, "").trim()));
  if (!isFinite(v)) return null;
  return (v >= 0 && v <= 2000000) ? v : null;
}

// Python str.title() for the ASCII dealer text these parsers see:
// lowercase everything, then uppercase a letter that follows a
// non-letter (or starts the string).
function dwsPyTitle(s) {
  return String(s).toLowerCase().replace(/(^|[^a-zA-ZÀ-ɏ])([a-zA-ZÀ-ɏ])/g,
    (m, p1, p2) => p1 + p2.toUpperCase());
}

function dwsReplaceAll(s, from, to) {
  return String(s).split(from).join(to);
}

// (price, price_status) from ONE card's own price block. The fee
// anchor's data-total-price (vehicle price + dealer fees) is the
// advertised final figure; a "Sale Price" row outranks the
// struck-through "Price:" row, which never wins while any other row
// exists. No figure at all -> 'call' when the card says Call for
// Price, else 'none'.
function dwsCardPrice(segment) {
  if (segment.includes("dws-call-for-price") ||
      /call\s+for\s+price/i.test(segment)) {
    return [null, "call"];
  }
  const pi = segment.indexOf("vehicle-price-container");
  const zone = pi >= 0 ? segment.slice(pi, pi + 5000) : segment;
  const m = /data-total-price="(\d+)"/.exec(zone);
  if (m) {
    const v = dwsMoneyInt(m[1]);
    if (v) return [v, null];
  }
  const rows = [];
  const rowRe = /<div class="vehicle-price-col([^"]*)"[^>]*>\s*<span class="vehicle-price-label">([^<]+)<\/span>\s*<span class="vehicle-price-value[^"]*">\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/gs;
  let rm;
  while ((rm = rowRe.exec(zone)) !== null) {
    const v = dwsMoneyInt(rm[3]);
    if (v) rows.push([rm[2].trim().toLowerCase(), v, rm[1].includes("line-through")]);
  }
  if (rows.length) {
    for (const [label, v] of rows) {
      if (label.startsWith("sale")) return [v, null];
    }
    const plain = rows.filter(r => !r[2]).map(r => r[1]);
    if (plain.length) return [plain[plain.length - 1], null];
    return [rows[0][1], null];
  }
  return [null, "none"];
}

const DWS_TWO_WORD_MAKES = ["LAND ROVER", "ALFA ROMEO", "ASTON MARTIN"];
const DWS_TWO_WORD_MODELS = new Set([
  "GRAND CHEROKEE", "GRAND WAGONEER", "GRAND CARAVAN",
  "SANTA FE", "SANTA CRUZ", "LAND CRUISER",
]);

// '2017 FORD F150 SUPERCREW CAB' -> [2017, 'Ford', 'F-150',
// 'Supercrew Cab']. DealerCenter titles are ALL CAPS; casing rules
// mirror the Python port's (badge models keep their form).
function dwsParseTitle(title) {
  let tokens = String(title || "").split(/\s+/).filter(Boolean);
  let year = 2026;
  if (tokens.length && /^(19|20)\d{2}$/.test(tokens[0])) {
    year = parseInt(tokens[0], 10);
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return [year, "Other", "Vehicle", ""];
  const upper = tokens.map(t => t.toUpperCase());
  let make = null;
  let used = 1;
  for (const cand of DWS_TWO_WORD_MAKES.concat(["MERCEDES-BENZ"])) {
    const parts = cand.split(" ");
    if (parts.every((p, i) => upper[i] === p)) {
      make = dwsPyTitle(cand);
      used = parts.length;
      break;
    }
  }
  if (make === null) {
    const raw = upper[0];
    make = (raw === "GMC" || raw === "BMW") ? raw : dwsPyTitle(tokens[0]);
  }
  let rest = tokens.slice(used);
  if (!rest.length) return [year, make, "Vehicle", ""];
  const mtok = rest[0].toUpperCase();
  const pair = mtok + " " + (rest.length > 1 ? rest[1].toUpperCase() : "");
  let model;
  if (DWS_TWO_WORD_MODELS.has(pair)) {
    model = dwsPyTitle(pair);
    rest = rest.slice(2);
  } else {
    const fm = /^F(\d{3})(SD)?$/.exec(mtok);
    const cxm = /^CX(\d+)$/.exec(mtok);
    if (fm) model = "F-" + fm[1];
    else if (cxm) model = "CX-" + cxm[1];
    else if (mtok === "RAV4") model = "RAV4";
    else if (mtok === "4RUNNER") model = "4Runner";
    else if (/\d/.test(mtok) || mtok.length <= 3) model = mtok;
    else model = dwsPyTitle(rest[0]);
    rest = rest.slice(1);
  }
  let trim = rest.map(t => (/\d/.test(t) ? t : dwsPyTitle(t))).join(" ");
  trim = trim.replace(/\b(SUV|Sedan|Truck|Coupe)\b/gi, "");
  trim = trim.split(/\s+/).filter(Boolean).join(" ");
  return [year, make, model, trim];
}

// The printed value of one vehicle-field-* detail row inside a card
// segment (odometer / transmission), or null.
function dwsFieldValue(segment, fieldClass) {
  const idx = segment.indexOf(fieldClass);
  if (idx < 0) return null;
  const m = /class="vehicle-info-value"[^>]*>([^<]+)</.exec(segment.slice(idx, idx + 500));
  return m ? m[1].trim() : null;
}

function dwsOrigin(baseUrl) {
  try {
    const u = new URL(baseUrl || "");
    return u.protocol + "//" + u.host;
  } catch (e) {
    return "";
  }
}

// Parse every DealerCenter DWS card in one listing page/fragment.
// Segments are sliced container-to-container so each car's fields
// come from its own card only. Dedupes by VIN, first card wins.
// Returns car records in the exact shape the Python parser produces.
function dwsParseListingHtml(html, baseUrl, defaultCondition, uid) {
  if (!html) return [];
  html = html.replace(/^\ufeff+/, "");
  const origin = dwsOrigin(baseUrl);
  const startRe = /<div class="vehicle-container[^"]*"[^>]*data-vehicle-id="vehicle-id-([A-HJ-NPR-Z0-9]{17})"/g;
  const starts = [];
  let sm;
  while ((sm = startRe.exec(html)) !== null) {
    starts.push([sm.index, sm[1].toUpperCase()]);
  }
  const cars = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const [start, vin] = starts[i];
    if (seen.has(vin) || !DWS_VIN_RE.test(vin)) continue;
    const seg = html.slice(start, i + 1 < starts.length ? starts[i + 1][0] : html.length);

    const tm = /<a class="vehicle-title" href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(seg);
    const title = tm ? tm[2].trim() : "";
    let href = tm ? tm[1] : null;
    if (!href) {
      const hm = /href="([^"]*(?:inventory|get-prequalified)\/[^"]*)"/.exec(seg);
      href = hm ? hm[1] : null;
    }
    let detailUrl = null;
    if (href) {
      href = dwsReplaceAll(href, "/get-prequalified/", "/inventory/");
      detailUrl = href.startsWith("http") ? href
        : (href.startsWith("/") ? origin + href : href);
    }

    const [year, make, model, trim] = dwsParseTitle(title);

    let stock = null;
    let stm = /data-sn="([^"]+)"/.exec(seg);
    if (stm && stm[1].trim()) stock = stm[1].trim();
    if (!stock) {
      stm = /data-stock-number="([^"]+)"/.exec(seg);
      if (stm && stm[1].trim()) stock = stm[1].trim().split("-").pop();
    }
    if (!stock) stock = vin.slice(-8);

    let mileage = null;
    const odo = dwsFieldValue(seg, "vehicle-field-odometer");
    if (odo) {
      const dm = /[0-9][0-9,]*/.exec(odo);
      if (dm) mileage = dwsMileageInt(dm[0]);
    }
    if (mileage === null && String(defaultCondition || "").toLowerCase().startsWith("new")) {
      mileage = 1000;
    }

    const trans = dwsFieldValue(seg, "vehicle-field-transmission");
    const transmission = trans ? dwsPyTitle(trans) : "Automatic";

    let photo = null;
    const im = /<img[^>]*class="vehicle-image"[^>]*>/.exec(seg);
    if (im) {
      const tag = im[0];
      const ss = /srcset="([^"]+)"/.exec(tag);
      if (ss) {
        let best = null, bestW = -1;
        for (const part of ss[1].split(",")) {
          const pm = /^\s*(\S+)\s+(\d+)w/.exec(part.trim());
          if (pm && parseInt(pm[2], 10) > bestW) {
            best = pm[1]; bestW = parseInt(pm[2], 10);
          }
        }
        photo = best;
      }
      if (!photo) {
        const sm2 = /src="([^"]+)"/.exec(tag);
        photo = sm2 ? sm2[1] : null;
      }
    }

    const [price, priceStatus] = dwsCardPrice(seg);

    let bodyType = "Other";
    if (/sport utility|\bsuv\b|crossover/i.test(title)) bodyType = "SUV";
    else if (/truck|pickup|crew cab|supercrew/i.test(title)) bodyType = "Truck";
    else if (/sedan/i.test(title)) bodyType = "Sedan";
    else if (/coupe/i.test(title)) bodyType = "Coupe";
    else if (/minivan|\bvan\b/i.test(title)) bodyType = "Van";

    seen.add(vin);
    cars.push({
      vin: vin,
      stock_number: stock,
      user_id: uid,
      year: year,
      make: make,
      model: model,
      trim: trim,
      price: price,
      price_status: priceStatus,
      mileage: mileage,
      location_name: "Dealership Lot",
      image_url: photo,
      photos: photo ? [photo] : [],
      interior_color: null,
      detail_url: detailUrl,
      color: "Standard",
      body_type: bodyType,
      transmission: transmission,
      status: "Available",
      condition: defaultCondition,
      is_active: true,
    });
  }
  return cars;
}

// {totalPages, ajaxUrl, totalVehicles} from a DWS listing page. The
// load-more container carries the page count; the AJAX endpoint
// rides in the page's ajaxObject (fallback: the standard WP path).
// totalVehicles is null unless the page publishes
// data-total-vehicles (Clear Choice's template does not).
function dwsListingMeta(html, baseUrl) {
  let total = 1;
  const m = /data-total-pages="(\d+)"/.exec(html || "");
  if (m) total = Math.max(1, parseInt(m[1], 10));
  let ajaxUrl = null;
  const am = /"ajaxUrl"\s*:\s*"([^"]+)"/.exec(html || "");
  if (am) ajaxUrl = dwsReplaceAll(am[1], "\\/", "/");
  if (!ajaxUrl) {
    const origin = dwsOrigin(baseUrl);
    if (origin) ajaxUrl = origin + "/wp-admin/admin-ajax.php";
  }
  let totalVehicles = null;
  const tv = /data-total-vehicles="(\d+)"/.exec(html || "");
  if (tv) totalVehicles = parseInt(tv[1], 10);
  return { totalPages: total, ajaxUrl: ajaxUrl, totalVehicles: totalVehicles };
}

// Remove a photo file that is the SOLE photo of 2+ cars in the batch
// (the platform's shared default image). Returns how many cars were
// stripped. Mirrors _strip_shared_placeholder_photos.
function dwsStripSharedPlaceholderPhotos(cars) {
  const sole = new Map();
  for (const c of cars) {
    const ph = c.photos || [];
    if (ph.length === 1) {
      if (!sole.has(ph[0])) sole.set(ph[0], []);
      sole.get(ph[0]).push(c);
    }
  }
  let stripped = 0;
  for (const owners of sole.values()) {
    if (owners.length >= 2) {
      for (const c of owners) {
        c.photos = [];
        c.image_url = null;
        stripped += 1;
      }
    }
  }
  return stripped;
}

// The DWS branch of parse_vdp_details: gallery slider photos, the
// advertised final price from the price field, and the spec-row
// colors / odometer / trim. Returns the standard details dict;
// non-DWS pages get the empty default (their merge result is the
// same: no photos, no price, nothing filled).
function dwsParseVdpDetails(html, vin, pageUrl) {
  const out = {
    photos: [], price: null, price_status: null, price_is_final: false,
    color: null, interior_color: null, body_type: null, mileage: null,
  };
  if (!html || !vin) return out;
  if (!html.includes("dws-field-vehicleprice") && !html.includes("dws-label__")) {
    return out;
  }

  // PHOTOS: the car's own gallery slider only — img tags carrying an
  // imagescf file AND the slider's popup class or "- Image N" alt.
  const photos = [];
  const seenFiles = new Set();
  const imgRe = /<img[^>]+>/g;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    const tag = im[0];
    if (!tag.includes("imagescf.dealercenter.net")) continue;
    if (!tag.includes("dws-img-with-popup") && !tag.includes("- Image")) continue;
    let src = null;
    for (const attr of ["data-lazy", "src"]) {
      const am = new RegExp(attr + '="([^"]+)"').exec(tag);
      if (am) { src = dwsReplaceAll(am[1], "&amp;", "&"); break; }
    }
    if (!src) continue;
    const fname = src.split("/").pop();
    if (seenFiles.has(fname)) continue;
    seenFiles.add(fname);
    photos.push(src);
    if (photos.length >= DWS_MAX_PHOTOS) break;
  }
  out.photos = photos;

  // PRICE: the VDP price field's data-total-price is the advertised
  // final figure; the call-for-price class is the dealer's own
  // no-price state.
  const idx = html.indexOf("dws-field-vehicleprice");
  if (idx >= 0) {
    const block = html.slice(idx, idx + 2000);
    if (block.includes("dws-call-for-price")) {
      out.price_status = "call";
    } else {
      const m = /data-total-price="(\d+)"/.exec(block);
      let v = m ? dwsMoneyInt(m[1]) : null;
      if (v === null) {
        const m2 = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/.exec(block);
        v = m2 ? dwsMoneyInt(m2[1]) : null;
      }
      if (v) {
        out.price = v;
        out.price_is_final = true;
        out.price_status = null;
      } else {
        out.price_status = "none";
      }
    }
  } else {
    out.price_status = html.includes("dws-call-for-price") ? "call" : "none";
  }

  // SPEC ROWS: dws-label__<field> + .vehicle-value pairs. A "-"
  // value means the dealer publishes nothing — it stays missing,
  // never the literal string.
  const pairs = {};
  const pairRe = /dws-label__([a-z0-9_]+)"[^>]*>[^<]*<\/span>\s*<span class="vehicle-value">([^<]*)<\/span>/g;
  let pm;
  while ((pm = pairRe.exec(html)) !== null) {
    if (!(pm[1] in pairs)) pairs[pm[1]] = pm[2].trim();
  }
  const ext = pairs["exteriorcolor"];
  if (ext && ext !== "-") out.color = ext;
  const intc = pairs["interiorcolor"];
  if (intc && intc !== "-") out.interior_color = intc;
  const odo = pairs["odometer"];
  if (odo) {
    const dm = /[0-9][0-9,]*/.exec(odo);
    if (dm) {
      const mv = dwsMileageInt(dm[0]);
      if (mv !== null) out.mileage = mv;
    }
  }
  const trimU = (pairs["trim"] || "").toUpperCase();
  if (/SPORT UTILITY|\bSUV\b|CROSSOVER/.test(trimU)) out.body_type = "SUV";
  else if (/PICKUP|CREW CAB/.test(trimU)) out.body_type = "Truck";
  else if (trimU.includes("SEDAN")) out.body_type = "Sedan";
  else if (trimU.includes("COUPE")) out.body_type = "Coupe";
  else if (trimU.includes("MINIVAN")) out.body_type = "Van";
  else if (trimU.includes("CONVERTIBLE")) out.body_type = "Convertible";
  else if (trimU.includes("HATCHBACK")) out.body_type = "Hatchback";
  return out;
}

// Count REAL photos the way the app and the Python counter do:
// usable http(s) URLs across image_url + photos + custom_photo_urls,
// deduped by query-stripped path, skipping /static/ paths and the
// no-photo fallback asset.
function dwsUsablePhotoCount(car) {
  const urls = new Set();
  const add = (u) => {
    if (typeof u !== "string") return;
    u = u.trim();
    if (!u) return;
    if (u.startsWith("//")) u = "https:" + u;
    if (!u.startsWith("http://") && !u.startsWith("https://")) return;
    if (u.includes("/static/")) return;
    const path = u.split("?")[0].split("#")[0];
    if (path.endsWith("assets/no-photo.png")) return;
    urls.add(path);
  };
  add(car.image_url);
  for (const key of ["photos", "custom_photo_urls"]) {
    const v = car[key];
    if (Array.isArray(v)) for (const u of v) add(u);
  }
  return urls.size;
}

// Mirror of the Python hi_res_photo_url(url) with add_width=False:
// rewrite a numeric width/w query param below 1600 up to 1600. Raw
// query pairs are preserved verbatim unless a rewrite actually
// happens, so untouched URLs come back byte-identical.
function dwsHiResPhotoUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const q = url.indexOf("?");
    if (q < 0) return url;
    const base = url.slice(0, q);
    let query = url.slice(q + 1);
    let frag = "";
    const h = query.indexOf("#");
    if (h >= 0) { frag = query.slice(h); query = query.slice(0, h); }
    const pairs = query.split("&").filter(s => s.length);
    let changed = false;
    const out = pairs.map(p => {
      const eq = p.indexOf("=");
      const k = eq >= 0 ? p.slice(0, eq) : p;
      const v = eq >= 0 ? p.slice(eq + 1) : "";
      const kl = k.toLowerCase();
      if ((kl === "width" || kl === "w") && /^\d+$/.test(v) && parseInt(v, 10) < 1600) {
        changed = true;
        return k + "=1600";
      }
      return p;
    });
    if (!changed) return url;
    return base + "?" + out.join("&") + frag;
  } catch (e) {
    return url;
  }
}

// The merge half of enrich_cars_with_vdp's per-car step (fetch and
// CARFAX capture excluded — the extractor finds no in-scope badge
// on DWS VDPs, verified on the platform's own pages, so the server
// sets no carfax_url for this platform either).
function dwsEnrichMerge(car, d, vdpFetched) {
  const fallback = car.image_url ? [dwsHiResPhotoUrl(car.image_url)] : [];
  if (!car.detail_url || !vdpFetched) {
    if (fallback.length) car.photos = fallback;
    return car;
  }
  if (d.photos.length) {
    car.photos = d.photos;
    car.image_url = d.photos[0];
  } else if (fallback.length) {
    car.photos = fallback;
  }
  // Final price wins; a non-final VDP price only fills a gap.
  if (d.price && (d.price_is_final || !car.price)) {
    car.price = d.price;
  }
  // A NEW car can never cost under $5,000 — extractor artifact guard.
  if (String(car.condition || "").toLowerCase().startsWith("new") &&
      car.price && car.price < 5000) {
    car.price = null;
  }
  // A VDP that publishes NO price is authoritative over the card.
  if (!d.price && (d.price_status === "call" || d.price_status === "none")) {
    car.price = null;
    car.price_status = d.price_status;
  } else if (car.price) {
    car.price_status = null;
  } else if (d.price_status) {
    car.price_status = d.price_status;
  }
  if (d.color) car.color = d.color;
  if (d.interior_color) car.interior_color = d.interior_color;
  if (d.body_type && (!car.body_type || car.body_type === "Other")) {
    car.body_type = d.body_type;
  }
  if (d.mileage !== null && d.mileage !== undefined &&
      (car.mileage === null || car.mileage === undefined)) {
    car.mileage = d.mileage;
  }
  return car;
}

// _clean_url_list + used_feed_urls + enumerate_feeds, mirrored: the
// account's crawl lots in crawl order — every USED link (primary
// first), then Certified, then New. Each feed is {url, condition,
// key}.
function dwsCleanUrlList(values) {
  const out = [];
  for (const v of values || []) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function dwsBuildFeeds(settings) {
  const cfg = settings || {};
  const usedRaw = [];
  if (typeof cfg.used_url === "string" && cfg.used_url.trim()) {
    usedRaw.push(cfg.used_url.trim());
  }
  let extras = cfg.extra_used_urls;
  if (typeof extras === "string") {
    try { extras = JSON.parse(extras); } catch (e) { extras = []; }
  }
  if (Array.isArray(extras)) usedRaw.push(...dwsCleanUrlList(extras));
  const used = dwsCleanUrlList(usedRaw).slice(0, DWS_MAX_USED_FEEDS);
  const feeds = [];
  used.forEach((url, i) => {
    feeds.push({
      url: url, condition: "Used",
      key: i === 0 ? "used_url" : "used_url_" + (i + 1),
    });
  });
  if (typeof cfg.certified_url === "string" && cfg.certified_url.trim()) {
    feeds.push({ url: cfg.certified_url.trim(), condition: "Certified Pre-Owned", key: "certified_url" });
  }
  if (typeof cfg.new_url === "string" && cfg.new_url.trim()) {
    feeds.push({ url: cfg.new_url.trim(), condition: "New", key: "new_url" });
  }
  return feeds;
}

// ---------------------------------------------------------------------
// Orchestration. Every network read of a dealer site goes through
// deps.fetchText — a plain service-worker fetch(). No tab, window,
// or navigation API is referenced anywhere in this file.
// ---------------------------------------------------------------------

// Enumerate one DWS feed over the platform's own data path (page 1
// server-rendered + admin-ajax fragments), mirroring
// crawl_dws_feed's request transport. Returns null when the feed
// does not fingerprint as DWS (not ours — the server keeps it),
// else {cars, complete}. `limit` is a soft stop like the Python
// one: no further listing pages once enough cars are in hand.
// firstHtml, when given, is the already-fetched page 1 (the probe
// fetch doubles as the crawl's first page).
async function dwsCrawlFeed(fetchText, feed, uid, limit, firstHtml) {
  let html1 = firstHtml;
  if (html1 === null || html1 === undefined) {
    let r = null;
    try { r = await fetchText(feed.url); } catch (e) { /* not ours */ }
    if (!r || r.status !== 200 || !dwsIsPlatform(r.text)) return null;
    html1 = r.text;
  }
  const meta = dwsListingMeta(html1, feed.url);
  let cars = dwsParseListingHtml(html1, feed.url, feed.condition, uid);
  const seen = new Set(cars.map(c => c.vin));
  let complete = true;
  for (let pno = 2; pno <= meta.totalPages; pno++) {
    if (limit && cars.length >= limit) break;
    const form = {
      action: "dws_inventory_vehicles",
      page_no: String(pno),
      template_id: "",
      dg_dcid: "",
      advance_filter_id: "",
      make: "",
      model: "",
      get_params: "",
    };
    let frag = null;
    try {
      const fr = await fetchText(meta.ajaxUrl, { method: "POST", form: form });
      if (fr && fr.status === 200) frag = fr.text;
    } catch (e) { /* incomplete below */ }
    if (!frag) { complete = false; break; }
    for (const c of dwsParseListingHtml(frag, feed.url, feed.condition, uid)) {
      if (!seen.has(c.vin)) { seen.add(c.vin); cars.push(c); }
    }
  }
  // When the page publishes a total, an assembled count that
  // disagrees means the enumeration is not verified-complete.
  if (meta.totalVehicles && cars.length !== meta.totalVehicles) {
    complete = false;
  }
  return { cars: cars, complete: complete };
}

// Fetch each car's VDP (5 at a time, like the Python pass) and
// merge the details in. Any failure leaves the card values in
// place (photos fall back to the single card photo, hi-res).
async function dwsFetchAllVdp(fetchText, cars) {
  let idx = 0;
  async function worker() {
    while (idx < cars.length) {
      const car = cars[idx++];
      if (!car.detail_url) { dwsEnrichMerge(car, null, false); continue; }
      let html = null;
      try {
        const r = await fetchText(car.detail_url);
        if (r && r.status === 200) html = r.text;
      } catch (e) { /* fallback below */ }
      if (!html) { dwsEnrichMerge(car, null, false); continue; }
      const d = dwsParseVdpDetails(html, car.vin, car.detail_url);
      dwsEnrichMerge(car, d, true);
    }
  }
  const n = Math.max(1, Math.min(5, cars.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

async function dwsSelectIn(deps, userId, cols, vins) {
  const map = new Map();
  for (let i = 0; i < vins.length; i += 200) {
    const chunk = vins.slice(i, i + 200);
    const rows = await deps.sbGet(
      `scraped_inventory?user_id=eq.${userId}&select=${cols}&vin=in.(${chunk.join(",")})`);
    for (const r of rows || []) map.set(r.vin, r);
  }
  return map;
}

// push_batch_to_supabase, mirrored: dedupe by VIN, preserve a
// stored price where this scrape found none, retire user-added
// photos where this scrape found real dealer photos, then upsert
// on (vin, user_id). The preservation reads are fail-open exactly
// like the Python blocks — a read failure never blocks the push.
async function dwsPushBatch(deps, userId, records) {
  if (!records.length) return 0;
  const unique = new Map();
  for (const r of records) if (r && r.vin) unique.set(r.vin, r);
  const recs = Array.from(unique.values());
  try {
    const missVins = recs.filter(r => !r.price).map(r => r.vin);
    if (missVins.length) {
      const stored = await dwsSelectIn(deps, userId, "vin,price", missVins);
      for (const r of recs) {
        if (!r.price && stored.has(r.vin) && stored.get(r.vin).price) {
          r.price = stored.get(r.vin).price;
        }
      }
    }
  } catch (e) {
    deps.log("[AutoLaunch] DWS price-preservation warning:", e && e.message || e);
  }
  try {
    const usableVins = recs.filter(r =>
      dwsUsablePhotoCount({ image_url: r.image_url, photos: r.photos, custom_photo_urls: [] }) > 0
    ).map(r => r.vin);
    if (usableVins.length) {
      const stored = await dwsSelectIn(deps, userId, "vin,custom_photo_urls", usableVins);
      for (const r of recs) {
        const s = stored.get(r.vin);
        if (s && Array.isArray(s.custom_photo_urls) && s.custom_photo_urls.length) {
          r.custom_photo_urls = [];
        }
      }
    }
  } catch (e) {
    deps.log("[AutoLaunch] DWS custom-photo retirement warning:", e && e.message || e);
  }
  const res = await deps.sbUpsert("scraped_inventory?on_conflict=vin,user_id", recs);
  return Array.isArray(res) ? res.length : 0;
}

// The stale pass, narrowed to what the helper may do: flip
// is_active on verified exits ONLY — never queue exit-delete jobs
// (that machinery, with its per-run cap and dedupe, stays
// server-side; for a first-sync DWS account there are no posted
// exits to remove anyway). Same mass-exit brake as the server:
// past >50% of >=20 active unseen, mark NOTHING. scopeKeys fences
// the pass to the crawled feeds' source keys when the account also
// has non-DWS feeds the helper never saw; null = the whole account
// (every feed was DWS). Errors are swallowed like the Python pass.
async function dwsMarkStale(deps, userId, seenVins, scopeKeys) {
  if (!seenVins.size) return 0;
  try {
    const rows = [];
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const chunk = await deps.sbGet(
        `scraped_inventory?user_id=eq.${userId}&is_active=eq.true` +
        `&select=vin,source_key&order=vin.asc&limit=${pageSize}&offset=${offset}`);
      const list = chunk || [];
      for (const r of list) if (r.vin) rows.push(r);
      if (list.length < pageSize) break;
      offset += pageSize;
    }
    const scoped = scopeKeys
      ? rows.filter(r => scopeKeys.includes(r.source_key))
      : rows;
    const stale = scoped.map(r => r.vin).filter(v => !seenVins.has(v));
    if (!stale.length) return 0;
    if (scoped.length >= 20 && stale.length > DWS_STALE_MAX_FRACTION * scoped.length) {
      deps.log(`[AutoLaunch] DWS stale pass skipped: ${stale.length} of ${scoped.length} active units unseen (>50%).`);
      return 0;
    }
    for (let i = 0; i < stale.length; i += 200) {
      const chunk = stale.slice(i, i + 200);
      await deps.sbPatch(
        `scraped_inventory?user_id=eq.${userId}&vin=in.(${chunk.join(",")})`,
        { is_active: false });
    }
    return stale.length;
  } catch (e) {
    deps.log("[AutoLaunch] DWS stale pass warning:", e && e.message || e);
    return 0;
  }
}

async function dwsMarkAttempted(deps, attempted, jobId) {
  try {
    await deps.storageSet({
      dws_attempted_jobs: attempted.concat([jobId]).slice(-50),
    });
  } catch (e) { /* bookkeeping only */ }
}

let _dwsSyncRunning = false;

// One poll cycle of the DWS sync path. Called from the same alarm
// as the posting poll; cheap no-ops when there is nothing to do.
async function checkDwsSync(deps) {
  if (_dwsSyncRunning) return { skipped: "running" };
  _dwsSyncRunning = true;
  try {
    return await dwsSyncMain(deps);
  } catch (e) {
    deps.log("[AutoLaunch] DWS sync error:", e && e.message || e);
    return { error: String(e && e.message || e) };
  } finally {
    _dwsSyncRunning = false;
  }
}

async function dwsSyncMain(deps) {
  const store = await deps.storageGet([
    "autolaunch_user_id", "autolaunch_access_token",
    "autolaunch_session_expired", "current_posting_job",
    "dws_attempted_jobs",
  ]);
  const userId = store.autolaunch_user_id;
  if (!userId) return { skipped: "no_user" };
  if (store.autolaunch_session_expired) return { skipped: "session_expired" };
  if (!store.autolaunch_access_token) return { skipped: "no_token" };
  // Posting work owns the cycle while a job is in flight — the
  // sync waits for a later poll, untouched.
  if (store.current_posting_job) return { skipped: "posting_active" };
  const attempted = Array.isArray(store.dws_attempted_jobs)
    ? store.dws_attempted_jobs : [];

  const base = `scrape_jobs?user_id=eq.${userId}&sync_vin=is.null&sync_scope=is.null`;
  let job = null;
  let mode = null;
  // 1) A pending job — newest first, the server's adoption order.
  let jobs = await deps.sbGet(
    `${base}&status=eq.pending&order=started_at.desc&limit=5`);
  if (jobs && jobs.length) { job = jobs[0]; mode = "claim"; }
  // 2) Our own orphaned claim (worker died mid-crawl): a processing
  // row older than 20 minutes is ours to finish.
  if (!job) {
    const cutoff = new Date(deps.now() - 20 * 60 * 1000).toISOString();
    jobs = await deps.sbGet(
      `${base}&status=eq.processing&started_at=lt.${encodeURIComponent(cutoff)}` +
      `&order=started_at.desc&limit=5`);
    if (jobs && jobs.length) { job = jobs[0]; mode = "reclaim"; }
  }
  // 3) Repair: the server completed a fresh job with 0 cars (its
  // blocked crawl "succeeds" empty on DWS sites). One attempt each.
  if (!job) {
    const since = new Date(deps.now() - 30 * 60 * 1000).toISOString();
    jobs = await deps.sbGet(
      `${base}&status=eq.completed&cars_synced=eq.0` +
      `&completed_at=gte.${encodeURIComponent(since)}` +
      `&order=completed_at.desc&limit=5`);
    if (jobs) job = jobs.find(j => !attempted.includes(j.id)) || null;
    if (job) mode = "repair";
  }
  if (!job) return { skipped: "no_job" };

  const srows = await deps.sbGet(
    `user_settings?user_id=eq.${userId}` +
    `&select=used_url,extra_used_urls,certified_url,new_url,helper_lease_id,helper_lease_expires_at`);
  const settings = srows && srows.length ? srows[0] : null;
  if (!settings) {
    if (mode === "repair") await dwsMarkAttempted(deps, attempted, job.id);
    return { skipped: "no_settings" };
  }
  // The lease gates sync claims exactly like posting claims.
  const myId = await deps.getInstanceId();
  if (deps.leaseDecision(
        settings.helper_lease_id, settings.helper_lease_expires_at,
        myId, deps.now()) === "foreign") {
    deps.log("[AutoLaunch] DWS sync: another computer holds the helper lease — standing by.");
    return { skipped: "lease_foreign" };
  }
  await deps.sbPatch(`user_settings?user_id=eq.${userId}`, {
    helper_lease_id: myId,
    helper_lease_expires_at: new Date(deps.now() + deps.leaseTtlMs).toISOString(),
  });

  const feeds = dwsBuildFeeds(settings);
  if (!feeds.length) {
    if (mode === "repair") await dwsMarkAttempted(deps, attempted, job.id);
    return { skipped: "no_feeds" };
  }

  // Probe every feed once (background fetch): the DWS ones are
  // ours; their page-1 HTML doubles as the crawl's first page.
  const dwsFeeds = [];
  for (const feed of feeds) {
    let html = null;
    try {
      const r = await deps.fetchText(feed.url);
      if (r && r.status === 200) html = r.text;
    } catch (e) { /* not ours */ }
    if (html && dwsIsPlatform(html)) dwsFeeds.push({ feed: feed, html1: html });
  }
  if (!dwsFeeds.length) {
    if (mode === "repair") await dwsMarkAttempted(deps, attempted, job.id);
    return { skipped: "not_dws" };
  }

  // Claim: flip pending -> processing so the server's pending-only
  // pickup walks past this job. Losing the race is a clean no-op.
  if (mode === "claim") {
    const claimed = await deps.sbPatch(
      `scrape_jobs?id=eq.${job.id}&status=eq.pending`, { status: "processing" });
    if (!claimed || !claimed.length) return { skipped: "claim_lost" };
  }

  const isTest = job.sync_mode === "test";
  let limitLeft = isTest ? DWS_TEST_SYNC_LIMIT : 0;
  const seenVins = new Set();
  let totalSaved = 0;
  let anyComplete = true;
  let anyCars = false;
  try {
    for (const entry of dwsFeeds) {
      const res = await dwsCrawlFeed(
        deps.fetchText, entry.feed, userId, limitLeft, entry.html1);
      if (!res) { anyComplete = false; continue; }
      if (!res.complete) anyComplete = false;
      let cars = res.cars;
      if (limitLeft && cars.length > limitLeft) cars = cars.slice(0, limitLeft);
      await dwsFetchAllVdp(deps.fetchText, cars);
      dwsStripSharedPlaceholderPhotos(cars);
      for (const c of cars) {
        c.source_key = entry.feed.key;
        seenVins.add(c.vin);
      }
      if (cars.length) {
        anyCars = true;
        const saved = await dwsPushBatch(deps, userId, cars);
        totalSaved += saved;
        if (limitLeft) limitLeft -= saved;
      }
    }
  } catch (e) {
    if (mode === "repair") {
      await dwsMarkAttempted(deps, attempted, job.id);
    } else {
      try {
        await deps.sbPatch(`scrape_jobs?id=eq.${job.id}`, { status: "failed" });
      } catch (e2) { /* row state is the least of it */ }
    }
    throw e;
  }

  // Stale pass: only a full-mode, verified-complete crawl that
  // actually saw cars may deactivate anything — the server's rule.
  if (!isTest && anyComplete && seenVins.size) {
    const allDws = dwsFeeds.length === feeds.length;
    const scope = allDws ? null : dwsFeeds.map(x => x.feed.key);
    await dwsMarkStale(deps, userId, seenVins, scope);
  }

  if (mode === "repair") {
    await dwsMarkAttempted(deps, attempted, job.id);
    if (totalSaved > 0) {
      await deps.sbPatch(`scrape_jobs?id=eq.${job.id}`, { cars_synced: totalSaved });
    }
    deps.log(`[AutoLaunch] DWS sync repair for job ${job.id}: landed ${totalSaved} car(s).`);
    return { repaired: job.id, saved: totalSaved };
  }
  if (!anyCars) {
    // Claimed a DWS job but the crawl landed nothing (the site
    // died mid-run): an honest failure, never a fake success.
    await deps.sbPatch(`scrape_jobs?id=eq.${job.id}`, { status: "failed" });
    return { failed: job.id };
  }
  await deps.sbPatch(`scrape_jobs?id=eq.${job.id}`, {
    status: "completed",
    completed_at: new Date(deps.now()).toISOString(),
    cars_synced: totalSaved,
  });
  deps.log(`[AutoLaunch] DWS sync completed job ${job.id}: ${totalSaved} car(s).`);
  return { completed: job.id, saved: totalSaved };
}

const AutoLaunchDwsSync = {
  dwsIsPlatform: dwsIsPlatform,
  dwsMoneyInt: dwsMoneyInt,
  dwsMileageInt: dwsMileageInt,
  dwsPyTitle: dwsPyTitle,
  dwsCardPrice: dwsCardPrice,
  dwsParseTitle: dwsParseTitle,
  dwsFieldValue: dwsFieldValue,
  dwsParseListingHtml: dwsParseListingHtml,
  dwsListingMeta: dwsListingMeta,
  dwsStripSharedPlaceholderPhotos: dwsStripSharedPlaceholderPhotos,
  dwsParseVdpDetails: dwsParseVdpDetails,
  dwsUsablePhotoCount: dwsUsablePhotoCount,
  dwsHiResPhotoUrl: dwsHiResPhotoUrl,
  dwsEnrichMerge: dwsEnrichMerge,
  dwsBuildFeeds: dwsBuildFeeds,
  dwsCrawlFeed: dwsCrawlFeed,
  dwsFetchAllVdp: dwsFetchAllVdp,
  dwsPushBatch: dwsPushBatch,
  dwsMarkStale: dwsMarkStale,
  checkDwsSync: checkDwsSync,
};
if (typeof module !== "undefined" && module.exports) {
  module.exports = AutoLaunchDwsSync;
}
if (typeof self !== "undefined") {
  self.AutoLaunchDwsSync = AutoLaunchDwsSync;
}
