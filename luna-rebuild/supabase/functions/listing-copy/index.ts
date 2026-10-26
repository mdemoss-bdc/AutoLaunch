// =====================================================================
// listing-copy — AutoLaunch listing-copy engine (hackathon build,
// 2026-10-26). One car in -> channel-ready copy out:
//   marketplace : full Facebook Marketplace listing (title + description)
//   tiktok      : short caption + a 20-30s spoken reel script
//   page        : Facebook Page post text
//
// GROUNDING IS THE PRODUCT. The copy may use ONLY:
//   (a) the car's own scraped_inventory row (loaded owner-scoped via
//       the caller's JWT — the exact pattern luca-draft uses), and
//   (b) NHTSA vPIC VIN-decode specs, fail-open, never guessed
//       (mirrors luca-draft v5's vinSpecs/carSpecs).
// The model only phrases; a deterministic sanitizer (sanitizeCopy)
// strips anything ungrounded that slips through: wrong or unlisted
// prices, and any financing / payment / APR / lease language.
//
// PRICE RULE: the only price that may appear is the row's advertised
// price, exactly. price null / price_status 'call'|'none' -> the copy
// contains NO price figure at all (enforced in prompt AND sanitizer).
//
// COST RULE (Matthew): NO paid AI. Runs on Google Gemini FREE tier,
// same secret as luca-draft (GEMINI_API_KEY). PROVIDER-AGNOSTIC:
// AI_PROVIDER / AI_MODELS below are the ONLY provider-specific lines —
// flipping to Meta/Llama models later is a config-only change; the
// prompt, grounding, and guard code never mention a provider.
//
// POST body: { vin: string } or { car_id: string } (vin preferred;
// car_id falls back to a stock_number match). verify_jwt=false at the
// platform level; the caller's JWT is verified manually below, same
// pattern as luca-draft / tiktok-*.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ===== PROVIDER CONFIG — the only provider-specific lines =====
const AI_PROVIDER = "gemini"; // "gemini" today (free tier); "llama" later
const AI_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.1-flash-lite"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ==== PURE LOGIC BEGIN ====
// Everything between the PURE LOGIC markers is dependency-free
// (no Deno, no Supabase, no fetch) and is exercised verbatim by the
// Node harness: buildFacts -> buildPrompts -> (model) -> parseCopyJson
// -> sanitizeCopy. Keep it that way.

// The scraper sometimes glues the VIN onto the trim ("SR-3N1AB...") —
// same cleaner luca-draft uses.
function cleanTrim(t: unknown): string {
  return String(t || "")
    .replace(/^-+\s*/, "")
    .replace(/-?[A-HJ-NPR-Z0-9]{17}$/, "")
    .replace(/-+$/, "").trim();
}

function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
function fmtMiles(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Usable photo URLs: http(s), deduped, skipping placeholders — mirrors
// the scraper's _usable_photo_count convention.
function usablePhotoUrls(car: any): string[] {
  const seen = new Set<string>();
  const push = (u: unknown) => {
    if (typeof u !== "string") return;
    const s = u.trim();
    if (!/^https?:\/\//i.test(s)) return;
    if (s.includes("/static/") || s.includes("assets/no-photo.png")) return;
    seen.add(s);
  };
  if (car) {
    push(car.image_url);
    if (Array.isArray(car.photos)) car.photos.forEach(push);
    if (Array.isArray(car.custom_photo_urls)) car.custom_photo_urls.forEach(push);
  }
  return Array.from(seen);
}

// A color of "Standard" is the scraper's filler, not a color (the
// posting-gaps convention) — treat it as missing.
function realColor(c: unknown): string | null {
  const s = String(c || "").trim();
  if (!s || s.toLowerCase() === "standard") return null;
  return s;
}

// buildFacts: the ONLY facts the copy may state. Anything absent here
// must be absent from the copy — the prompt says so and the sanitizer
// enforces the money/financing part deterministically.
function buildFacts(car: any, vinSpecText: string, locationLabel: string) {
  const priceStatus = String(car.price_status || "").toLowerCase();
  const rawPrice = car.price != null ? Number(car.price) : NaN;
  const hasPrice = Number.isFinite(rawPrice) && rawPrice > 0 &&
    priceStatus !== "call" && priceStatus !== "none";
  const rawMiles = car.mileage != null ? Number(car.mileage) : NaN;
  const facts = {
    vin: String(car.vin || ""),
    year: car.year != null ? Number(car.year) : null,
    make: String(car.make || "").trim() || null,
    model: String(car.model || "").trim() || null,
    trim: cleanTrim(car.trim) || null,
    condition: String(car.condition || "").trim() || null,
    price: hasPrice ? rawPrice : null,
    priceText: hasPrice ? fmtMoney(rawPrice) : null,
    miles: Number.isFinite(rawMiles) && rawMiles > 0 ? rawMiles : null,
    milesText: Number.isFinite(rawMiles) && rawMiles > 0 ? fmtMiles(rawMiles) : null,
    exteriorColor: realColor(car.color),
    interiorColor: realColor(car.interior_color),
    transmission: String(car.transmission || "").trim() || null,
    bodyType: String(car.body_type || "").trim() || null,
    stockNumber: String(car.stock_number || car.stock_num || "").trim() || null,
    location: (locationLabel || String(car.location_name || "")).trim() || null,
    detailUrl: String(car.detail_url || car.listing_url || "").trim() || null,
    photoCount: usablePhotoUrls(car).length,
    vinSpecs: String(vinSpecText || "").trim() || null,
  };
  const nameParts = [facts.year, facts.make, facts.model].filter(Boolean).join(" ");
  (facts as any).name = nameParts || "Vehicle";
  const lines = [
    "Vehicle: " + (facts as any).name,
    facts.trim ? "Trim: " + facts.trim : "",
    facts.condition ? "Condition: " + facts.condition : "",
    facts.priceText ? "Advertised price: " + facts.priceText : "Price: NOT LISTED — this vehicle has no advertised price. Do not state any price, dollar amount, or price hint anywhere in the copy.",
    facts.milesText ? "Mileage: " + facts.milesText + " miles" : "",
    facts.exteriorColor ? "Exterior color: " + facts.exteriorColor : "",
    facts.interiorColor ? "Interior color: " + facts.interiorColor : "",
    facts.transmission ? "Transmission: " + facts.transmission : "",
    facts.bodyType ? "Body style: " + facts.bodyType : "",
    facts.vinSpecs ? "Specs (from the VIN record): " + facts.vinSpecs : "",
    facts.stockNumber ? "Stock #: " + facts.stockNumber : "",
    facts.location ? "Located at: " + facts.location : "",
    facts.photoCount ? "Photos available: " + facts.photoCount : "",
    facts.detailUrl ? "Listing link: " + facts.detailUrl : "",
  ].filter(Boolean);
  (facts as any).factsText = lines.join("\n");
  return facts as typeof facts & { name: string; factsText: string };
}

// buildPrompts: system + user text. Provider-agnostic — this is the
// grounding contract, reused unchanged when the provider flips.
function buildPrompts(facts: any, profile: any) {
  const tone = String((profile && profile.tone) || "").trim();
  const repName = String((profile && (profile.rep_name || profile.name)) || "").trim();
  const system = [
    "You write vehicle listing copy for a car salesperson. You are given a FACTS block — the vehicle's real data from the dealership's own inventory system, plus specs decoded from its VIN. The facts are the ONLY things you may state about the vehicle.",
    "",
    "HARD RULES — never break these:",
    "- Use ONLY facts from the FACTS block. If a fact is not in the block (a feature, an option, a spec, a previous-owner story), do not mention it — not even vaguely ('loaded', 'tons of features' with invented examples is still inventing).",
    "- The only price you may state is the Advertised price from the FACTS block, exactly as written. If the block says the price is NOT LISTED, state no price and no dollar amount anywhere.",
    "- NEVER mention financing, monthly payments, APR, interest rates, loans, leases, credit approval, or down payments — in any channel, in any wording.",
    "- Never promise availability ('it will go fast', 'won't last', 'still available guaranteed'). You may invite the reader to come see it or message for details.",
    "- Never invent warranty, certification beyond the stated Condition, accident history, or service history.",
    "- Write like a real salesperson, not a brochure: plain, confident, specific. Specifics come from the facts (trim, colors, mileage, specs) — never from imagination.",
    tone ? "- Match this tone: " + tone + "." : "- Tone: friendly and straightforward.",
    repName ? "- The salesperson's name is " + repName + "; sign off in first person only where natural (Page post)." : "",
    "",
    'Reply with ONLY a JSON object: {"marketplace":{"title": string, "description": string}, "tiktok":{"caption": string, "script": string}, "page":{"text": string}}',
  ].filter(Boolean).join("\n");

  const user = [
    "FACTS:",
    facts.factsText,
    "",
    "Write three variants of listing copy for this one vehicle:",
    "",
    "1) marketplace.title — a Facebook Marketplace listing title: year, make, model, trim if present. Plain text, under 140 characters, no price unless the FACTS block lists one.",
    "2) marketplace.description — the full Marketplace listing description (3-6 short paragraphs or lines). Lead with what the vehicle is, weave in the real facts (condition, mileage, colors, transmission, VIN specs when present), include the stock # and the location, and end with an invitation to message or come see it. If a listing link is in the facts, end with it.",
    "3) tiktok.caption — a short TikTok/Reels caption: 1-2 sentences from the facts plus 3-5 generic hashtags (e.g. #carsforsale). No invented claims.",
    "4) tiktok.script — a spoken script the salesperson reads on camera for a 20-30 second walkaround reel: about 65-85 words. Hook line first, then the real facts in walkaround order (outside, inside, the numbers), close by inviting viewers to the location in the facts. Write it to be spoken aloud, conversational.",
    "5) page.text — a Facebook Page post: 2-4 short lines, a touch more polished than the caption, facts only, include the listing link if the facts have one.",
  ].join("\n");
  return { system, user };
}

// Lenient JSON parse (same approach as luca-draft): strict first,
// then first {...} block, then plain-text fallback into the
// marketplace description so a usable result beats an error.
function parseCopyJson(raw: string) {
  const empty = { marketplace: { title: "", description: "" }, tiktok: { caption: "", script: "" }, page: { text: "" } };
  const norm = (o: any) => ({
    marketplace: {
      title: String(o?.marketplace?.title || ""),
      description: String(o?.marketplace?.description || ""),
    },
    tiktok: {
      caption: String(o?.tiktok?.caption || ""),
      script: String(o?.tiktok?.script || ""),
    },
    page: { text: String(o?.page?.text || o?.page || "") },
  });
  try { return norm(JSON.parse(raw)); } catch { /* try extraction */ }
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (m) { try { return norm(JSON.parse(m[0])); } catch { /* fall through */ } }
  const out = norm(empty);
  out.marketplace.description = String(raw || "").trim();
  return out;
}

// Financing/payment language is banned outright. Sentence-level drop:
// a sentence that trips the filter disappears; the rest of the copy
// survives untouched.
const FINANCE_RE = /financ|apr\b|interest rate|monthly payment|per month|\/\s?mo\b|\blease[sd]?\b|loan\b|credit approval|down payment|\$\s?0\s+down|payments?\s+(as low|starting|from)\b/i;

function stripFinanceSentences(text: string): string {
  if (!text) return text;
  // Line-by-line so paragraph breaks survive; within a line, drop
  // only the offending sentences. (\blease\b above is deliberate —
  // a bare "lease" substring would eat every "please".)
  const lines = text.split("\n").map((line) => {
    const sentences = line.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [line];
    return sentences.filter(s => !FINANCE_RE.test(s)).join(" ").replace(/[ \t]{2,}/g, " ").trim();
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MONEY_RE = /\$\s?\d[\d,]*(\.\d{1,2})?/g;

// Deterministic price guard: any dollar amount that is not exactly
// the advertised price is removed; when there is no advertised
// price, EVERY dollar amount is removed.
function enforcePrice(text: string, facts: any): string {
  if (!text) return text;
  return text.replace(MONEY_RE, (m) => {
    const val = parseFloat(m.replace(/[$,\s]/g, ""));
    if (facts.price != null && Math.round(val) === Math.round(facts.price)) {
      return facts.priceText;
    }
    return "";
  }).replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

// Small model-formatting repairs (typography, not facts): flash
// models sometimes split decimals ("2. 0L") and break long URLs with
// spaces ("https://www. mosescars. com/..."). If the copy contains a
// spaced-out version of THIS car's own listing link, swap in the
// exact link from the facts — the one URL that is ground truth.
function repairFormatting(text: string, facts: any): string {
  if (!text) return text;
  let out = text.replace(/(\d)\.\s+(\d)/g, "$1.$2");
  if (facts.detailUrl && !out.includes(facts.detailUrl)) {
    const host = String(facts.detailUrl).replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (host) {
      out = out.replace(/https?:\/\/[^\n]*?(?=\n{2,}|\n|$)/g, (m: string) => {
        const squashed = m.replace(/\s+/g, "");
        return squashed.includes(host) ? facts.detailUrl : m;
      });
    }
  }
  return out;
}

// sanitizeCopy: the deterministic backstop behind the prompt rules.
// Order matters — strip finance language first, then police prices,
// then guarantee the marketplace description carries the car's real
// stock #, miles, and price (facts only) when the model left them out.
function sanitizeCopy(variants: any, facts: any) {
  const v = {
    marketplace: {
      title: String(variants?.marketplace?.title || "").trim(),
      description: String(variants?.marketplace?.description || "").trim(),
    },
    tiktok: {
      caption: String(variants?.tiktok?.caption || "").trim(),
      script: String(variants?.tiktok?.script || "").trim(),
    },
    page: { text: String(variants?.page?.text || "").trim() },
  };
  for (const k of ["title", "description"] as const) v.marketplace[k] = repairFormatting(enforcePrice(stripFinanceSentences(v.marketplace[k]), facts), facts);
  for (const k of ["caption", "script"] as const) v.tiktok[k] = repairFormatting(enforcePrice(stripFinanceSentences(v.tiktok[k]), facts), facts);
  v.page.text = repairFormatting(enforcePrice(stripFinanceSentences(v.page.text), facts), facts);

  // Marketplace footer guarantee: a buyer (and the rep) must be able
  // to match the copy to the exact car — stock #, miles, price are
  // facts from the row, appended only when missing.
  const desc = v.marketplace.description;
  const missing: string[] = [];
  if (facts.priceText && !desc.includes(facts.priceText)) missing.push(facts.priceText);
  if (facts.milesText && !desc.replace(/,/g, "").includes(String(Math.round(facts.miles)))) missing.push(facts.milesText + " miles");
  if (facts.stockNumber && !desc.includes(facts.stockNumber)) missing.push("Stock #: " + facts.stockNumber);
  if (missing.length && desc) {
    v.marketplace.description = desc + "\n\n" + missing.join(" · ");
  }
  return v;
}
// ==== PURE LOGIC END ====

async function callGemini(apiKey: string, system: string, user: string) {
  const delays = [0, 2000]; // one retry per model for 429/503 spikes
  for (const model of AI_MODELS) {
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
      let res: Response;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            signal: AbortSignal.timeout(45000),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              generationConfig: {
                temperature: 0.7,
                // Thinking off + a roomy cap (same lesson as luca-draft):
                // three channel variants need more room than one draft.
                maxOutputTokens: 2000,
                thinkingConfig: { thinkingBudget: 0 },
                responseMimeType: "application/json",
              },
            }),
          },
        );
      } catch (e) {
        continue; // network/timeout — try the next attempt/model
      }
      if (res.status === 429 || res.status === 503) continue; // busy — back off and retry
      if (res.status === 404) break; // model gone — fall to the next one
      if (!res.ok) {
        const t = await res.text();
        throw new Error("Gemini HTTP " + res.status + ": " + t.slice(0, 200));
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
      if (!text) continue;
      return text;
    }
  }
  throw new Error("Google's free AI is busy right now (demand spike) — give it a minute and try again.");
}

// VIN decode (NHTSA vPIC — free, no key), copied from luca-draft v5:
// the inventory table has no drivetrain/fuel/engine columns, but every
// row's VIN decodes to them authoritatively. Fail-open: any error
// just skips the specs — the copy simply omits them.
const vinCache = new Map<string, string>();
async function vinSpecs(vin: string): Promise<string> {
  if (!vin || vin.length < 11) return "";
  if (vinCache.has(vin)) return vinCache.get(vin)!;
  let specs = "";
  try {
    const res = await fetch(
      "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/" + encodeURIComponent(vin) + "?format=json",
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const r = (await res.json())?.Results?.[0] || {};
      const engine = [r.DisplacementL ? String(r.DisplacementL) + "L" : "", r.EngineCylinders ? String(r.EngineCylinders) + "-cylinder" : ""].filter(Boolean).join(" ");
      specs = [
        r.DriveType ? "Drivetrain: " + r.DriveType : "",
        r.FuelTypePrimary ? "Fuel: " + r.FuelTypePrimary : "",
        engine ? "Engine: " + engine : "",
        r.TransmissionStyle ? "Transmission (VIN record): " + r.TransmissionStyle + (r.TransmissionSpeeds ? " " + r.TransmissionSpeeds + "-speed" : "") : "",
      ].filter(Boolean).join(" · ");
    }
  } catch { /* fail-open */ }
  vinCache.set(vin, specs);
  return specs;
}

async function carSpecs(car: any): Promise<string> {
  let s = await vinSpecs(String(car.vin || ""));
  if (!/Drivetrain:/.test(s)) {
    const dm = String((car.trim || "") + " " + (car.model || "")).match(/\b(AWD|FWD|4WD|RWD|4x4)\b/i);
    if (dm) s = (s ? s + " · " : "") + "Drivetrain: " + dm[1].toUpperCase().replace("4X4", "4WD") + " (from the trim)";
  }
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (!apiKey) return json({ ok: false, error: "GEMINI_API_KEY secret is not set" }, 500);

  const auth = req.headers.get("Authorization") || "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: "Not signed in" }, 401);
  const user = userData.user;

  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const vin = String(body?.vin || "").trim();
  const carId = String(body?.car_id || body?.id || "").trim();
  if (!vin && !carId) return json({ ok: false, error: "vin (or car_id) is required" }, 400);

  // Owner-scoped by RLS: the caller only ever sees their own cars.
  let car: any = null;
  if (vin) {
    const { data } = await supabase.from("scraped_inventory").select("*").eq("vin", vin).limit(1);
    if (data && data.length) car = data[0];
  }
  if (!car && carId) {
    const byVin = await supabase.from("scraped_inventory").select("*").eq("vin", carId).limit(1);
    if (byVin.data && byVin.data.length) car = byVin.data[0];
    else {
      const byStock = await supabase.from("scraped_inventory").select("*").eq("stock_number", carId).limit(1);
      if (byStock.data && byStock.data.length) car = byStock.data[0];
    }
  }
  if (!car) return json({ ok: false, error: "Vehicle not found in your inventory" }, 404);

  // Tone: if the rep has a Luca (closer_profiles) profile, the copy
  // speaks in the same voice. Fail-open — no profile, neutral tone.
  let profile: any = {};
  try {
    const { data: profileRow } = await supabase
      .from("closer_profiles").select("profile").eq("user_id", user.id).maybeSingle();
    if (profileRow && (profileRow as any).profile) profile = (profileRow as any).profile;
  } catch { /* fail-open */ }

  // Location display names through the rep's location groups (same
  // layer luca-draft uses), fail-open to the raw rooftop name.
  let locationLabel = String(car.location_name || "");
  try {
    const { data: settingsRow } = await supabase
      .from("user_settings").select("location_groups").eq("user_id", user.id).maybeSingle();
    const groups = (settingsRow as any)?.location_groups;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g && Array.isArray(g.members) && g.members.includes(locationLabel)) {
          locationLabel = String(g.name || locationLabel);
          break;
        }
      }
    }
  } catch { /* fail-open */ }

  const specText = await carSpecs(car);
  const facts = buildFacts(car, specText, locationLabel);
  const prompts = buildPrompts(facts, profile);

  let variants: any = null;
  try {
    const raw = await callGemini(apiKey, prompts.system, prompts.user);
    variants = sanitizeCopy(parseCopyJson(raw), facts);
  } catch (e) {
    return json({ ok: false, error: "Copy generation failed: " + (e as Error).message }, 502);
  }
  if (!variants.marketplace.description && !variants.page.text) {
    return json({ ok: false, error: "The copy engine returned an empty result — try again." }, 502);
  }

  return json({
    ok: true,
    vin: facts.vin,
    car: {
      name: facts.name,
      price: facts.price,
      mileage: facts.miles,
      stock_number: facts.stockNumber,
      location: facts.location,
    },
    variants,
    grounded: {
      price_used: facts.price,
      vin_specs_used: !!facts.vinSpecs,
      photo_count: facts.photoCount,
    },
    provider: AI_PROVIDER,
  });
});
