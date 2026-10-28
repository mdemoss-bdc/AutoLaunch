// =====================================================================
// luca-draft — Luca (AI Closer) reply drafting, Phase 2.
//
// DEPLOYED 2026-10-25 (Management API multipart, verify_jwt=false; the
// caller's JWT is verified manually below, same pattern as tiktok-*).
// Secret: GEMINI_API_KEY (Google AI Studio, FREE tier — Matthew's cost
// rule: no paid AI until users/revenue). Provider-agnostic by config:
// PROVIDER/MODELS below are the only provider-specific lines.
//
// POST body: { prospect_id: uuid }
// Flow: verify caller JWT -> load the caller's prospect + its recent
// closer_messages + closer_profiles (all RLS owner-scoped) -> build a
// grounded prompt (rep profile: name/tone/schedules/credit link/
// standing instructions; hard floor below) -> Gemini -> save the draft
// as a closer_messages row (direction 'out', origin 'ai') so the
// corrections/outcome loop can learn from it later -> return
// { ok, draft, needs_human, reason }.
//
// HARD FLOOR (never configurable): the draft must not invent a price,
// payment, APR, or financing promise, nor state availability as fact
// beyond what the thread/listing shows. Haggling, financing specifics,
// trade-in value, or an upset buyer -> needs_human with a short, safe
// holding draft instead of an answer.
//
// GROUNDING HARDENING (2026-10-26, authorized by Matthew after a live
// miss stated a placeholder mileage as fact): three layers — (1)
// placeholder fields (the 1,000-mile new-car default on a used /
// certified / previously-listed row) are scrubbed before they can
// reach the prompt; (2) the thread car resolves deterministically
// and UNIQUELY or it contributes no facts at all (VERIFIED-CAR is the
// only basis for this car's specs); (3) a deterministic post-draft
// guard makes every stated price/mileage trace to a verified value
// (regenerate once, then strip-or-hold). Everything else is v12
// behavior.
//
// VOICE LEARNING v13 (2026-10-27, Matthew's go — "work on Luca, try
// to make him as smart as you"): the three prepared v13 voice
// changes, rebased onto the v24 grounding-hardened source:
//   1. junkBody length cap 400 -> 1500 chars, so a rep's long-form
//      messages (e.g. Matthew's ~1,400-char program-stacking
//      walkthrough) can form voice pairs. Pairs still slice to 300
//      chars in the prompt, so prompt size is unchanged; the
//      file-extension junk rejection is untouched.
//   2. Voice read window .limit(150) -> .limit(600) prospect-linked
//      messages. The imported voice bank (~176 rows by 2026-10-26)
//      outgrew the 150-row window, silently dropping older threads
//      from study. Delivered pairs stay capped at 10, unchanged.
//   3. Vocabulary build paginated with .range(): it read make/model
//      with .limit(4000), which PostgREST silently caps at 1,000
//      rows — for a 2,000+ car account the make/model vocabulary was
//      built from only the first 1,000 cars, so models stocked only
//      beyond that window never became searchable words.
// Grounding behavior (v24) is unchanged. This is platform v25.
//
// STRENGTHENING (2026-10-28, overnight mandate — battery-driven, free
// tier only; battery: 20 live scenarios on a test account, baseline
// 13/20 with one invented-availability claim and one missed
// hand-back):
//   4. Hyphenated model names resolve: the vocabulary also carries
//      the fused form ("CR-V" -> "crv") plus a fused->original map,
//      resolveTerm tries the dehyphenated token, and searchTerm
//      searches the original hyphenated spelling too. The thread-car
//      label match falls back to make+year when the model word finds
//      nothing. ("CR-Vs" previously resolved NOTHING — the stocked
//      car read as unsearchable and spec questions went unanswered.)
//   5. Category/ceiling browse fallback: an ask with a condition,
//      a price ceiling, or a vehicle-category word but NO matched
//      term now browses the lot by those filters instead of leaving
//      Luca to improvise; zero browse hits is a VERIFIED none for
//      that filter combination.
//   6. Availability-claim guard: an unavailability claim ("we don't
//      have any", "out of stock", "I checked the lot") with no
//      verified-none basis is regenerated once, then replaced with
//      a check-the-lot line. The claim is a fact; it needs a search.
//   7. Hand-back guard: the latest buyer message is classified
//      deterministically (payment / APR / trade value / haggle /
//      upset); if the model answered instead of handing back, one
//      corrective regeneration runs, then needs_human is forced
//      with a safe holding draft. Hard floor, enforced in code.
//   8. Voice pairs ranked for teaching quality (substantive replies
//      with a question, an invitation, times, or specifics outrank
//      recency alone) and normalized-deduped; top 8 delivered.
//   9. Trade-in link: when the account has a trade_token, trade
//      value asks hand back AND offer the intake link (never a
//      number). Transfer asks get the price-confirmation draft
//      instead of a manager punt.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = "gemini";
// Model reality (2026-10-25, learned live by probing this key):
// gemini-2.x/2.5 are retired for NEW API users ("no longer available to
// new users" 404s — the /models list still shows them, which fooled
// the first deploy). gemini-3.8-flash is the flagship but sat in a 503
// demand spike through every probe. gemini-3.5-flash answered with
// clean JSON, so it leads; 3.8 and a lite model follow as fallbacks.
const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.1-flash-lite"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function callGemini(apiKey: string, system: string, user: string) {
  const delays = [0, 2000]; // one retry per model for 429/503 spikes
  for (const model of MODELS) {
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
                // Thinking off + a roomy cap: the 3.x flash models are
                // reasoning models — with thinking on and a 400-token
                // cap, the JSON got truncated mid-string in probing.
                maxOutputTokens: 1200,
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
  throw new Error("Google's free AI is busy right now (demand spike) — give it a minute and try the draft again.");
}

// Levenshtein distance — small, dependency-free (vocab matching, v7).
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Per-user make/model vocabulary cache (10 min, warm instances): the
// lot's own words are the dictionary buyer text is matched against.
const vocabCache = new Map<string, { at: number; words: Set<string>; fused: Map<string, string[]> }>();
const TERM_ALIAS: Record<string, string> = { chevy: "chevrolet", vw: "volkswagen" };

// Models occasionally wrap or pad the JSON despite responseMimeType;
// parse strictly first, then extract the first {...} block, then fall
// back to treating plain prose as the draft (Gemini drafts are prose —
// a usable reply beats an error).
function parseDraftText(raw: string) {
  try { return JSON.parse(raw); } catch { /* try extraction */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return { draft: raw.trim(), needs_human: false, reason: "" };
}

// ---- Grounding hardening — pure helpers (the Node harness extracts
// and exercises these verbatim; keep them free of Deno/Supabase refs).

const PLACEHOLDER_NEW_CAR_MILES = 1000;

// A stored mileage is a FACT only when it is a real reading. The
// scraper parks new cars at exactly 1,000 mi when no reading exists;
// that value on a used / certified / pre-owned car — or on any car
// that has already been listed to Marketplace — is the placeholder
// leaking through, never a fact. Null / zero / missing likewise mean
// "no fact", not a value.
function factMileage(c: any): number | null {
  const m = c?.mileage;
  if (m === null || m === undefined || !(Number(m) > 0)) return null;
  const n = Number(m);
  if (n === PLACEHOLDER_NEW_CAR_MILES) {
    const cond = String(c?.condition || "").toLowerCase();
    const usedish = cond.includes("used") || cond.includes("certified") || cond.includes("pre-owned") || cond.includes("preowned");
    if (usedish || c?.marketplace_posted_at) return null;
  }
  return n;
}

function factPrice(c: any): number | null {
  const p = c?.price;
  if (p === null || p === undefined || !(Number(p) > 0)) return null;
  return Number(p);
}

// Deterministic pick of THE thread car from candidate inventory rows.
// An exact listing-price match is the only multi-candidate win (with
// a make-word tiebreak); a unique candidate wins; anything else is
// ambiguity and returns null — an unresolved car contributes NO
// facts, never the first row that happened to come back.
function pickThreadCar(labelInfo: { price: number | null; makeWord: string | null }, rows: any[]): any | null {
  if (!rows || !rows.length) return null;
  let pool = rows;
  if (labelInfo.price !== null && labelInfo.price !== undefined) {
    const exact = pool.filter((r: any) => Number(r.price) === labelInfo.price);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) pool = exact;
    else return null; // the listing price matches nothing on the lot — not uniquely resolvable
  }
  if (pool.length === 1) return pool[0];
  if (labelInfo.makeWord) {
    const mk = pool.filter((r: any) => String(r.make || "").toLowerCase().split(/[^a-z0-9]+/).includes(labelInfo.makeWord!));
    if (mk.length === 1) return mk[0];
  }
  return null;
}

// Every price / mileage figure a draft states, normalized to plain
// numbers ("9,382 miles" -> 9382, "9.4k miles" -> 9400, "$26,159" ->
// 26159, "$30k" -> 30000). This is the claim set the guard checks.
function extractFactClaims(text: string): { miles: number[]; prices: number[] } {
  const miles: number[] = [];
  const prices: number[] = [];
  const t = String(text || "");
  let m: RegExpExecArray | null;
  const mileRe = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:miles|mi)\b/gi;
  while ((m = mileRe.exec(t))) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2]) v *= 1000;
    if (v > 0) miles.push(Math.round(v));
  }
  const mileRe2 = /\b(?:mileage|odometer|odo)\b[^0-9]{0,16}(\d[\d,]*)/gi;
  while ((m = mileRe2.exec(t))) {
    const v = parseInt(m[1].replace(/,/g, ""), 10);
    if (v > 0) miles.push(v);
  }
  const priceRe = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?/gi;
  while ((m = priceRe.exec(t))) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2]) v *= 1000;
    if (v > 0) prices.push(Math.round(v));
  }
  return { miles, prices };
}

// Claims in the draft that trace to NO allowed value — the invented
// facts. Returned as display strings ("1,000 miles", "$25,500").
function factViolations(draft: string, allowedMiles: Set<number>, allowedPrices: Set<number>): string[] {
  const claims = extractFactClaims(draft);
  const out: string[] = [];
  for (const v of claims.miles) if (!allowedMiles.has(v)) out.push(v.toLocaleString("en-US") + " miles");
  for (const v of claims.prices) if (!allowedPrices.has(v)) out.push("$" + v.toLocaleString("en-US"));
  return Array.from(new Set(out));
}

// Drop only the sentences that carry an unverified claim; the rest
// of the model's reply (its voice, its next step) survives.
function stripFactSentences(draft: string, allowedMiles: Set<number>, allowedPrices: Set<number>): string {
  const parts = String(draft || "").split(/(?<=[.!?])\s+/);
  const kept = parts.filter(s => !factViolations(s, allowedMiles, allowedPrices).length);
  return kept.join(" ").trim();
}

// Post-draft guard flow: clean draft passes untouched; a violating
// draft regenerates ONCE with the violation named; if the rewrite
// still violates, the offending sentences are stripped — and if
// nothing clean remains, a double-check holding line stands in.
// Every intervention is logged with the prospect id.
async function enforceFactGuard(
  draft: string,
  allowedMiles: Set<number>,
  allowedPrices: Set<number>,
  regen: (violations: string[]) => Promise<string>,
  prospectId: string,
): Promise<string> {
  let violations = factViolations(draft, allowedMiles, allowedPrices);
  if (!violations.length) return draft;
  console.log("[luca-draft] fact guard: unverified " + violations.join(", ") + " in draft (prospect " + prospectId + ") — regenerating once");
  try {
    const second = await regen(violations);
    if (second) {
      const v2 = factViolations(second, allowedMiles, allowedPrices);
      if (!v2.length) return second;
      violations = v2;
      draft = second;
    }
  } catch (e) {
    console.log("[luca-draft] fact guard: regeneration failed (prospect " + prospectId + "): " + (e as Error).message);
  }
  const stripped = stripFactSentences(draft, allowedMiles, allowedPrices);
  console.log("[luca-draft] fact guard: fallback after regeneration (prospect " + prospectId + "); stripped unverified " + violations.join(", "));
  return stripped || "Let me double-check that for you and get right back to you.";
}

// ---- Strengthening helpers (2026-10-28) — pure, harness-tested.

// Voice-pair quality: a pair teaches voice when the rep's reply has
// substance — length in the working range, a question or invitation,
// real times, or concrete specifics. Trivial replies ("Ok", "Yes
// sir") score below zero so recency alone can't crowd out the best
// teaching material with the newest filler.
function normVoiceKey(rep: string): string {
  return String(rep || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function voicePairScore(p: { rep: string }): number {
  const rep = String(p.rep || "");
  const L = rep.length;
  let s = 0;
  if (L < 12) s -= 50;
  else if (L < 25) s -= 10;
  else s += Math.min(20, Math.floor(L / 12));
  if (/\?/.test(rep)) s += 6;
  if (/\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|today|tomorrow|morning|afternoon|evening|\d{1,2}(:\d{2})?\s?(am|pm))\b/i.test(rep)) s += 4;
  if (/\b(come|swing by|stop by|test drive|drive it|take a look|check it out|bring it)\b/i.test(rep)) s += 4;
  if (/\$\s?\d|\d{3,}|\bstock\b/i.test(rep)) s += 3;
  return s;
}
function rankVoicePairs<T extends { rep: string; at: string }>(pairs: T[]): T[] {
  return pairs.slice().sort((a, b) => {
    const d = voicePairScore(b) - voicePairScore(a);
    if (d) return d;
    return a.at < b.at ? 1 : -1; // recency breaks ties
  });
}

// Unavailability claims are FACTS and need a verified-none basis (a
// completed search that came back empty). Patterns for a draft
// asserting them — including the fabricated "I checked the lot".
const UNAVAILABILITY_RES: RegExp[] = [
  /\bdon'?t have\b/i,
  /\bdo not have\b/i,
  /\bnot in stock\b/i,
  /\bout of stock\b/i,
  /\bnone in stock\b/i,
  /\bsold out\b/i,
  /\bcurrently out of\b/i,
  /\bwe have no\b/i,
  /\bi checked (the lot|our inventory|on that)\b/i,
  /\bchecked (the lot|our inventory)\b/i,
];
function unavailabilityClaim(draft: string): boolean {
  const t = String(draft || "");
  return UNAVAILABILITY_RES.some((re) => re.test(t));
}

// Hand-back classification of the buyer's LATEST message. The hard
// floor categories, matched conservatively so process questions
// ("do you take trades?") don't fire — only value/specifics asks do.
function baitCategory(latest: string): { cat: string; label: string; reason: string } | null {
  const t = String(latest || "").toLowerCase();
  if (/\bapr\b|interest rate|finance rate|what rate/.test(t))
    return { cat: "apr", label: "APR / interest-rate specifics", reason: "buyer asked about APR/rates — financing specifics for the salesperson" };
  if (/monthly payment|payment (would|will|might) be|payments? on (this|it|that car)|how much[^.?!]*\b(a month|per month|monthly)\b|\bper month\b/.test(t))
    return { cat: "payment", label: "monthly-payment specifics", reason: "buyer asked for a monthly payment — financing specifics for the salesperson" };
  if (/what[^.?!]*(worth|give|get|offer)[^.?!]*(trade|my (car|truck|suv|van|vehicle))|trade[- ]?in value|give me for my|how much[^.?!]*for my (car|truck|suv|van|vehicle)/.test(t))
    return { cat: "trade", label: "a trade-in value", reason: "buyer asked for a trade-in value — never quoted by Luca" };
  if (/take it or leave it|best price|lowest (price|you('ll| will) go)|come down (on|in) (the )?price|\$\s?[\d,]+\s*(cash|firm|out the door)|offer you \$/.test(t))
    return { cat: "haggle", label: "price haggling", reason: "buyer is haggling on price — the salesperson's call" };
  if (/\bcrook|\bscam|rip ?off|lawsuit|attorney|better business bureau|report you/.test(t))
    return { cat: "upset", label: "an upset buyer", reason: "buyer is upset/threatening — the salesperson should take over" };
  return null;
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

  let prospectId = "";
  try { prospectId = (await req.json())?.prospect_id || ""; } catch { /* handled below */ }
  if (!prospectId) return json({ ok: false, error: "prospect_id is required" }, 400);

  const { data: prospect, error: pErr } = await supabase
    .from("prospects").select("*").eq("id", prospectId).single();
  if (pErr || !prospect) return json({ ok: false, error: "Prospect not found" }, 404);

  const { data: msgs } = await supabase
    .from("closer_messages")
    .select("direction, origin, body, created_at")
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(20);
  const thread = (msgs || []).slice().reverse();
  if (!thread.length) {
    return json({ ok: false, error: "No captured conversation yet — capture the chat first, then ask Luca for a draft." }, 422);
  }

  const { data: profileRow } = await supabase
    .from("closer_profiles").select("*").eq("user_id", user.id).maybeSingle();
  const profile = (profileRow && (profileRow as any).profile) || {};

  // Location groups (v10): the app lets a rep COMBINE rooftops into
  // one display location (user_settings.location_groups, Settings ->
  // Location Groups — the same labels the Inventory filter shows).
  // Luca must see locations through that exact layer: every rooftop
  // inside the rep's home group is "here"; anything else is a sister
  // lot. Read with the caller's client (owner RLS), fail-open to no
  // groups. The saved home value may be a group's display name OR a
  // raw rooftop inside it — normalize it through the same mapping.
  let locGroups: any[] = [];
  let tradeTokenVal = "";
  try {
    const { data: settingsRow } = await supabase
      .from("user_settings").select("location_groups, trade_token").eq("user_id", user.id).maybeSingle();
    if (settingsRow && Array.isArray((settingsRow as any).location_groups)) locGroups = (settingsRow as any).location_groups;
    if (settingsRow) tradeTokenVal = String((settingsRow as any).trade_token || "").trim();
  } catch (_) { /* no settings row -> raw names, no groups */ }
  const displayLoc = (raw: string | null | undefined): string => {
    if (!raw) return "";
    for (const g of locGroups) {
      if (g && Array.isArray(g.members) && g.members.includes(raw)) return String(g.name || raw);
    }
    return String(raw);
  };
  const tradeUrl = tradeTokenVal ? "https://autolaunch.org/trade.html?t=" + encodeURIComponent(tradeTokenVal) : "";
  const homeRaw = String((profile as any).home_location || "").trim();
  const homeLabel = homeRaw ? displayLoc(homeRaw) : "";

  // ---- Voice learning (2026-10-25, Matthew's ask): Luca learns how
  // a rep talks from the replies they ALREADY send — no draft-editing
  // required. Auto-capture saves every rep reply (origin 'rep'), so
  // buyer -> rep pairs from the rep's OTHER threads become voice
  // examples in the prompt below. Effective from the first captured
  // conversation; sharper with every chat. Per-user by construction
  // (RLS + this user filter) — voices never mix between reps.
  type VRow = { prospect_id: string; direction: string; origin: string; body: string; status: string | null; created_at: string };
  const junkBody = (b: string) => !b || b.length < 3 || b.length > 1500 || /\.(csv|txt|pdf|jpe?g|png|zip)$/i.test(b.trim()); // v13: cap 400 -> 1500 (see header)
  const { data: voiceRows } = await supabase
    .from("closer_messages")
    .select("prospect_id, direction, origin, body, created_at, status")
    .eq("user_id", user.id)
    .neq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(600); // v13: window 150 -> 600 (see header)
  const byProspect = new Map<string, VRow[]>();
  for (const r of (voiceRows || []) as VRow[]) {
    if (!r.prospect_id) continue;
    if (!byProspect.has(r.prospect_id)) byProspect.set(r.prospect_id, []);
    byProspect.get(r.prospect_id)!.push(r);
  }
  const allPairs: { buyer: string; rep: string; at: string }[] = [];
  for (const rows of byProspect.values()) {
    const chrono = rows.slice().reverse(); // oldest first within the thread
    for (let i = 0; i < chrono.length; i++) {
      if (chrono[i].direction !== "in" || junkBody(String(chrono[i].body))) continue;
      for (let j = i + 1; j < chrono.length; j++) {
        if (chrono[j].direction === "in") break;
        const r = chrono[j];
        if (r.direction === "out" && r.origin === "rep" && r.status !== "failed" && !junkBody(String(r.body))) {
          allPairs.push({ buyer: String(chrono[i].body).slice(0, 300), rep: String(r.body).slice(0, 300), at: String(r.created_at || "") });
          break;
        }
      }
    }
  }
  allPairs.sort((a, b) => (a.at < b.at ? 1 : -1)); // most recent first
  const seenRep = new Set<string>();
  const dedupedPairs = allPairs.filter(p => {
    // Normalized dedupe (2026-10-28): case/punctuation variants of
    // the same reply are one lesson, not three.
    const k = normVoiceKey(p.rep);
    if (!k || seenRep.has(k)) return false;
    seenRep.add(k);
    return true;
  });
  // Quality-ranked (2026-10-28): the best teaching material must
  // not be crowded out by the newest filler — score substance first,
  // recency breaks ties. Top 8 (was 10 by recency alone).
  const voicePairs = rankVoicePairs(dedupedPairs).slice(0, 8);

  // Corrections (draft -> what the rep actually sent) remain the
  // strongest signal when they exist — the rep explicitly fixed Luca.
  const { data: corrRows } = await supabase
    .from("closer_corrections")
    .select("draft, final")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(8);
  const corrPairs = (corrRows || []).filter((c: any) => c.draft && c.final && c.draft !== c.final);

  // ---- Inventory grounding (v5, Matthew's ask): when the buyer asks
  // about vehicles ("any used Civics?"), search the rep's OWN live
  // inventory (RLS owner-scoped, same client) and hand Luca real
  // matches — year/trim/price/miles/stock #/listing link — as FACTS
  // he may state. Retrieval is deterministic (keyword ILIKE on
  // make/model from the buyer's own words + condition and price-
  // ceiling filters parsed from the text); the model only presents.
  // No keyword hits in inventory -> no block at all (the buyer likely
  // wasn't asking about a car, e.g. a warranty question).
  const cleanTrim = (t: string | null) => String(t || "")
    .replace(/^-+\s*/, "")
    .replace(/-?[A-HJ-NPR-Z0-9]{17}$/, "") // the scraper sometimes glues the VIN onto the trim
    .replace(/-+$/, "").trim();
  const fmtCar = (c: any) => [
    [c.year, c.make, c.model].filter(Boolean).join(" "),
    cleanTrim(c.trim) || null,
    c.condition || null,
    c.price ? "$" + Number(c.price).toLocaleString("en-US") : "price: call / not listed",
    // Sanitized: a placeholder mileage (see factMileage) is an
    // absent fact — the line simply carries no mileage at all.
    factMileage(c) ? Number(factMileage(c)).toLocaleString("en-US") + " miles" : null,
    c.color ? "Exterior: " + c.color : null,
    c.interior_color ? "Interior: " + c.interior_color : null,
    c.transmission || null,
    c._vinSpecs || null,
    c.location_name ? "at " + displayLoc(c.location_name) + (homeLabel ? (displayLoc(c.location_name) === homeLabel ? " (the salesperson's own lot)" : " (a sister lot)") : "") : null,
    c.stock_number ? "Stock #" + c.stock_number : null,
    c.detail_url || null,
  ].filter(Boolean).join(" · ");

  // VIN decode (NHTSA vPIC — free, no key): the inventory table has
  // no drivetrain/fuel/engine columns, but every row's VIN decodes to
  // them authoritatively. Fail-open: any error just skips the specs.
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

  async function carSpecs(c: any): Promise<string> {
    let s = await vinSpecs(String(c.vin || ""));
    // Some makers (VW among them) don't report drivetrain in the VIN
    // record at all. If the trim/model itself carries it ("AWD",
    // "4x4"), use that; otherwise the spec stays unstated and Luca
    // tells the buyer he'll double-check — never a guess.
    if (!/Drivetrain:/.test(s)) {
      const dm = String((c.trim || "") + " " + (c.model || "")).match(/\b(AWD|FWD|4WD|RWD|4x4)\b/i);
      if (dm) s = (s ? s + " · " : "") + "Drivetrain: " + dm[1].toUpperCase().replace("4X4", "4WD") + " (from the trim)";
    }
    return s;
  }

  // Resolve THE vehicle this conversation is about, so spec questions
  // (miles? color? interior? AWD? diesel? manual?) get real answers.
  // DETERMINISTIC + UNIQUE-ONLY (grounding hardening): a VIN or stock
  // token anywhere in the thread data wins outright; otherwise the
  // listing label ("$26,159 - 2026 Volkswagen Jetta") is matched
  // against live inventory and pickThreadCar decides — an exact
  // price + year/make/model match, or a single candidate. Ambiguity
  // resolves to NOTHING: no car, no facts (the old code took the
  // first row back, which is how a placeholder mileage from a
  // different car got stated as this car's miles).
  let currentCar: any = null;
  {
    const label = String(prospect.vehicle_label || "");
    const threadText = [
      String(prospect.vehicle_id || ""),
      label,
      ...thread.map((m: any) => String(m.body || "")),
    ].join(" \n ");
    const vinM = threadText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
    if (vinM) {
      const { data } = await supabase.from("scraped_inventory").select("*")
        .ilike("vin", vinM[0]).eq("is_active", true).limit(1);
      if (data && data.length) currentCar = data[0];
    }
    if (!currentCar) {
      const stockM = threadText.match(/stock\s*#?\s*[:\-]?\s*([A-Za-z0-9]{4,12})/i);
      if (stockM) {
        const { data } = await supabase.from("scraped_inventory").select("*")
          .eq("stock_number", stockM[1]).eq("is_active", true).limit(2);
        if (data && data.length === 1) currentCar = data[0];
      }
    }
    if (!currentCar) {
      const yearM = label.match(/\b(?:19|20)\d{2}\b/);
      const priceM = label.match(/\$\s*([\d,]+)/);
      const words = label.replace(/\$\s*[\d,]+/, " ").replace(/\b(?:19|20)\d{2}\b/, " ")
        .replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length >= 3);
      if (yearM && words.length) {
        const modelWord = words[words.length - 1].toLowerCase();
        const { data } = await supabase.from("scraped_inventory").select("*")
          .eq("is_active", true).eq("year", parseInt(yearM[0], 10))
          .ilike("model", "%" + modelWord + "%").limit(25);
        let rows = data || [];
        if (!rows.length) {
          // Hyphenated/short-token models ("CR-V" tokenizes to "cr"
          // + "v", neither long enough to survive the word filter,
          // so the "model word" degenerates to the make) — fall
          // back to make+year candidates; pickThreadCar still
          // requires a unique pick (exact price) before any fact
          // is used.
          for (const w of words.slice(0, -1)) {
            const { data: byMake } = await supabase.from("scraped_inventory").select("*")
              .eq("is_active", true).eq("year", parseInt(yearM[0], 10))
              .ilike("make", "%" + w.toLowerCase() + "%").limit(25);
            if (byMake && byMake.length) { rows = byMake; break; }
          }
        }
        // The make word: a label word (other than the model word)
        // that some candidate's make actually carries — used only
        // as a tiebreak inside pickThreadCar.
        let makeWord: string | null = null;
        for (const w of words.slice(0, -1)) {
          const lw = w.toLowerCase();
          if (rows.some((r: any) => String(r.make || "").toLowerCase().split(/[^a-z0-9]+/).includes(lw))) { makeWord = lw; break; }
        }
        currentCar = pickThreadCar(
          { price: priceM ? parseInt(priceM[1].replace(/,/g, ""), 10) : null, makeWord },
          rows,
        );
      }
    }
    if (currentCar) currentCar._vinSpecs = await carSpecs(currentCar);
  }
  const STOP = new Set("the,you,have,any,car,cars,vehicle,vehicles,price,much,what,when,with,that,this,for,are,got,get,one,ones,looking,look,need,want,know,about,there,them,they,from,will,would,come,still,available,lot,your,just,like,show,see,send,info,more,details,please,thanks,thank,hey,hello,interested,anything,something,how,many,does,and,also,can,could,should,than,then,was,were,has,had,did,been,its".split(","));
  // FOCUS-FIRST (v12): the buyer's LATEST message is the question
  // being answered, so its vehicle words are resolved and searched
  // FIRST and can never be crowded out. Caught live 2026-10-25: the
  // old oldest-first order + a shared 40-row accumulation cap let
  // "colorados" (23 rows) and "expeditons" (18) exhaust the search
  // before "beetle" was ever queried — a Beetle sat ACTIVE at the
  // rep's own lot while Luca said "I don't have any Beetles."
  const buyerMsgs = thread.filter((m: any) => m.direction === "in").slice(-3)
    .map((m: any) => String(m.body || ""));
  const latestBuyer = buyerMsgs.length ? buyerMsgs[buyerMsgs.length - 1] : "";
  const buyerText = buyerMsgs.join(" ").toLowerCase();
  const tokensOf = (text: string) => (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)?/g) || [])
    .filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));

  // ---- Vocabulary-first matching (v7, Matthew's ask): buyers
  // misspell and skip punctuation ("colorodo", "usedcivics", "jeat",
  // no apostrophes). Searching with the buyer's RAW words failed
  // twice in testing — filler words flooded the query cap and the
  // vehicle word never got searched ("civics" in v5, "colorados" in
  // v6), so stocked cars read as not-in-stock. Now the buyer's words
  // are matched against the lot's REAL make/model vocabulary first
  // (exact / alias / singular / fused-word / edit-distance), and the
  // inventory is searched ONLY with confirmed vehicle words, spelled
  // the inventory's way. Filler can never flood anything again.
  let vocab = new Set<string>();
  let fusedMap = new Map<string, string[]>();
  try {
    const cached = vocabCache.get(user.id);
    if (cached && Date.now() - cached.at < 600000) {
      vocab = cached.words;
      fusedMap = cached.fused;
    } else {
      // v13: paginate — .limit(4000) silently capped at 1,000 rows.
      const vrows: any[] = [];
      for (let vfrom = 0; ; vfrom += 1000) {
        const { data: vpage } = await supabase
          .from("scraped_inventory").select("make, model").eq("is_active", true).range(vfrom, vfrom + 999);
        vrows.push(...(vpage || []));
        if (!vpage || vpage.length < 1000) break;
      }
      for (const r of vrows || []) {
        for (const s of [String((r as any).make || ""), String((r as any).model || "")]) {
          const parts = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
          for (const w of parts) if (w.length >= 3) vocab.add(w);
          // Fused form (2026-10-28): buyers write "CRV"/"CR-Vs";
          // the split parts ("cr","v") are too short to match.
          // Carry the joined form in the vocabulary and remember
          // which original spellings it stands for, so searchTerm
          // can query the hyphenated inventory spelling too.
          if (parts.length > 1) {
            const f = parts.join("");
            if (f.length >= 3) {
              vocab.add(f);
              if (!fusedMap.has(f)) fusedMap.set(f, []);
              const orig = s.trim();
              if (orig && !fusedMap.get(f)!.includes(orig)) fusedMap.get(f)!.push(orig);
            }
          }
        }
      }
      if (vocab.size) vocabCache.set(user.id, { at: Date.now(), words: vocab, fused: fusedMap });
    }
  } catch { /* fail-open: resolveTerm falls back to the raw word */ }
  const resolveTerm = (t: string): string | null => {
    if (!vocab.size) return t; // no vocabulary available — old behavior
    if (vocab.has(t)) return t;
    // Dehyphenated twin (2026-10-28): "cr-vs" never equals the
    // vocabulary word "crv" until the hyphen (and plural) come off.
    const dehyph = t.replace(/-/g, "");
    if (dehyph !== t && vocab.has(dehyph)) return dehyph;
    const alias = TERM_ALIAS[t];
    if (alias && vocab.has(alias)) return alias;
    const forms = dehyph !== t ? [t, dehyph] : [t];
    for (const f of forms) {
      if (f.endsWith("es") && vocab.has(f.slice(0, -2))) return f.slice(0, -2);
      if (f.endsWith("s") && vocab.has(f.slice(0, -1))) return f.slice(0, -1);
    }
    for (const f of forms) for (const w of vocab) if (w.length >= 4 && f.length > w.length && f.includes(w)) return w; // fused: "usedcivics" -> "civic"
    // Fused AND misspelled (v8): "anyexpeditons" contains no exact
    // vocab word and is too long for the plain fuzzy pass — slide
    // windows of the vocab word's length across the token and take
    // a near-enough window. Caught live 2026-10-25: 18 Expeditions
    // in stock read as "don't have any" on exactly this input.
    const fuzzyPass = (x: string): string | null => {
      for (const w of vocab) {
        if (w.length < 5 || x.length <= w.length + 1) continue;
        const maxDw = w.length >= 8 ? 2 : 1;
        for (let s = 0; s + w.length - 1 <= x.length; s++) {
          for (const L of [w.length - 1, w.length, w.length + 1]) {
            if (s + L > x.length) continue;
            if (lev(x.slice(s, s + L), w) <= maxDw) return w;
          }
        }
      }
      let best: string | null = null;
      let bestD = 99;
      const maxD = x.length <= 4 ? 1 : 2;
      for (const w of vocab) {
        if (Math.abs(w.length - x.length) > maxD) continue;
        const d = lev(x, w);
        if (d < bestD) { bestD = d; best = w; }
      }
      return bestD <= maxD ? best : null;
    };
    return fuzzyPass(t) || (dehyph !== t ? fuzzyPass(dehyph) : null);
  };
  const resolveAll = (text: string) => Array.from(new Set(
    tokensOf(text).map(resolveTerm).filter((x): x is string => !!x),
  ));
  const focusTerms = resolveAll(latestBuyer).slice(0, 4);
  const extraTerms = resolveAll(buyerMsgs.slice(0, -1).join(" "))
    .filter(t => !focusTerms.includes(t)).slice(0, Math.max(0, 6 - focusTerms.length));
  const focusCounts = new Map<string, number>();
  let invMatches: any[] = [];
  {
    const seenKey = new Set<string>();
    const searchTerm = async (t: string, focus: boolean) => {
      // A fused vocabulary word ("crv") must also search the
      // original inventory spelling ("CR-V") — ILIKE on "crv"
      // alone would never substring-match the hyphenated model.
      const pats = Array.from(new Set([t, ...((fusedMap.get(t) || []))]))
        .map(p => String(p).replace(/[,()%]/g, "").trim()).filter(Boolean);
      const orExpr = pats.map(p => `model.ilike.%${p}%,make.ilike.%${p}%`).join(",");
      const { data: rows } = await supabase
        .from("scraped_inventory")
        .select("year, make, model, trim, price, mileage, condition, stock_number, detail_url, color, interior_color, transmission, vin, location_name, marketplace_posted_at")
        .eq("is_active", true)
        .or(orExpr)
        .limit(25);
      if (focus) focusCounts.set(t, (rows || []).length);
      for (const r of rows || []) {
        const k = String((r as any).vin || (r as any).stock_number || JSON.stringify(r));
        if (!seenKey.has(k)) { seenKey.add(k); (r as any)._focus = focus; invMatches.push(r); }
      }
    };
    // Focus terms ALWAYS run to completion — no shared cap can
    // starve the question actually being answered.
    for (const t of focusTerms) await searchTerm(t, true);
    for (const t of extraTerms) {
      if (invMatches.length >= 40) break;
      await searchTerm(t, false);
    }
  }
  // A focus term that was searched and matched NOTHING is a verified
  // fact, not a gap: the prompt gets an explicit VERIFIED line, which
  // is the only basis on which Luca may ever say "we don't have any."
  const verifiedNone = focusTerms.filter(t => (focusCounts.get(t) || 0) === 0);
  const wantsUsed = /\bused\b|\bpre-owned\b|\bpreowned\b/.test(buyerText);
  const wantsNew = !wantsUsed && /\bnew\b/.test(buyerText);
  const ceilMatch = buyerText.match(/(?:under|below|less than|max|around|about)\s*\$?\s*([\d,]+)\s*(k)?/);
  const ceiling = ceilMatch ? parseInt(ceilMatch[1].replace(/,/g, ""), 10) * (ceilMatch[2] ? 1000 : 1) : null;
  const condOk = (c: any) => {
    const cd = String(c.condition || "").toLowerCase();
    return wantsUsed ? (cd.includes("used") || cd.includes("certified")) : wantsNew ? cd.includes("new") : true;
  };
  const byPrice = (a: any, b: any) => (a.price || 1e12) - (b.price || 1e12);
  // Category/ceiling browse fallback (2026-10-28): a buyer asking
  // "any used SUVs under $15k" names no make/model word, so the
  // term search above never runs and the model used to improvise
  // ("currently out of SUVs under $15k" — while a $13,995 RAV4 sat
  // in stock). When the ask carries a condition, a price ceiling,
  // or a vehicle-category word but no term matched anything, browse
  // the lot by those filters instead: hits become the grounded
  // results, and zero hits is a VERIFIED none for that exact filter
  // combination (it is the only basis for a "nothing matches" claim).
  let filterNone = false;
  if (!invMatches.length && (wantsUsed || wantsNew || ceiling ||
      /\b(suv|suvs|truck|trucks|sedan|sedans|van|vans|coupe|coupes|hatchback|car|cars|vehicle|vehicles)\b/.test(buyerText))) {
    const { data: browsed } = await supabase
      .from("scraped_inventory")
      .select("year, make, model, trim, price, mileage, condition, stock_number, detail_url, color, interior_color, transmission, vin, location_name, marketplace_posted_at")
      .eq("is_active", true).not("price", "is", null)
      .order("price", { ascending: true }).limit(60);
    const hits = (browsed || []).filter((c: any) => condOk(c) && (!ceiling || (c.price && c.price <= ceiling)));
    if (hits.length) {
      for (const r of hits) { (r as any)._focus = true; invMatches.push(r); }
    } else filterNone = true;
  }
  const focusMatches = invMatches.filter(c => (c as any)._focus);
  const primaryPool = focusMatches.length ? focusMatches : invMatches;
  const invPrimary = primaryPool.filter(c => condOk(c) && (!ceiling || (c.price && c.price <= ceiling))).sort(byPrice).slice(0, 5);
  const invAlt = invMatches.filter(c => !invPrimary.includes(c)).sort(byPrice).slice(0, 3);
  // Drivetrain/fuel/engine for the matches too (parallel VIN decodes),
  // so "is that one AWD?" about a recommended car also has an answer.
  await Promise.all(invPrimary.map(async (c: any) => { c._vinSpecs = await carSpecs(c); }));

  const now = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", hour: "numeric", minute: "2-digit",
    month: "long", day: "numeric",
  }).format(new Date());

  const system = [
    "You are Luca, an AI assistant who drafts Facebook Marketplace replies FOR a car salesperson. The salesperson reviews and sends every draft personally — write exactly what they would send, in first person as the salesperson.",
    "",
    "SALESPERSON PROFILE (JSON): " + JSON.stringify(profile),
    "",
    "It is currently: " + now + " (salesperson's local time).",
    "Availability rules: only suggest coming in on days the STORE is open AND the salesperson works (profile.store_schedule / profile.schedule). Suggest the salesperson's own hours, never store hours they are not there for.",
    "If the buyer wants to apply for financing or asks for the credit application, include the credit-app link from the profile — that hand-off is allowed and encouraged. Do not discuss rates, approvals, or terms.",
    ...(tradeUrl ? [
      "If the buyer asks what their current vehicle is worth in trade: never give a number or range (hard rule). Set needs_human to true, and make the draft warmly offer the salesperson's trade-in link so the team can work a real value from the buyer's answers and photos: " + tradeUrl,
    ] : []),
    ...(homeLabel ? [
      "",
      "LOCATION & TRANSFERS — the salesperson works at " + homeLabel + ". Each vehicle fact line ends with where that vehicle sits: '(the salesperson's own lot)' or '(a sister lot)'. Combined rooftops the salesperson grouped together all count as their own lot:",
      "- A vehicle at the salesperson's own lot is HERE — talk about it normally.",
      "- A vehicle at a SISTER lot is not here, but the group can bring it to the salesperson's lot for the buyer. Present it warmly and be upfront: it's at a sister location, and we can have it brought over for them.",
      "- Moving a vehicle is a commitment, so BEFORE promising any transfer, get the buyer comfortable with the PRICE as it stands: the move makes sense once they agree the price works for them, assuming they like how it drives and it checks out when it's here. Ask for that confirmation naturally. Never promise the transfer itself, an arrival day/time, or any transfer fee — those are the salesperson's call.",
      "- If the buyer asks for a sister-lot car to be brought over (or demands it by a day/time), do NOT punt to a manager and do NOT promise the move or a time: use the price-confirmation reply above — it's at a sister lot, and if the price works for them as it stands, you'll ask to have it brought over.",
    ] : []),
    "",
    "HARD RULES — never break these:",
    "- Never invent or guess a price, monthly payment, APR, financing term, discount, or trade-in value. The only prices you may mention are ones that appear in the listing label, the conversation, or the INVENTORY RESULTS block.",
    "- Vehicle facts (stock number, mileage, colors, transmission, drivetrain, fuel, engine, listing link) may ONLY come from the VERIFIED-CAR or INVENTORY RESULTS blocks, stated exactly as written. When you recommend a vehicle from the results, include its stock # and its link. If a spec the buyer asks about is not in the blocks, say you'll double-check rather than guessing it.",
    "- THIS conversation's car: the VERIFIED-CAR block is the ONLY basis for its facts. When there is no VERIFIED-CAR block, the exact car could not be matched in live inventory and you do NOT know its mileage, colors, or specs — never borrow numbers from a similar car or from a search result. For those questions, say you'll double-check and get right back to them.",
    "- If the buyer asks whether you have a particular vehicle and NO block in this request covers it, you do not know either way: never claim to have it OR not have it, and never name a specific alternative vehicle. Say you'll check the lot and get right back to them. The ONE exception: a VERIFIED — NONE IN STOCK line is a completed inventory search — for the vehicles it names, you may say plainly that you don't have one on the lot right now.",
    "- Never promise the vehicle is available as a fact beyond what the conversation shows; phrase it as the salesperson checking/confirming ('Yes, it's still here as of today' is fine when the thread implies a live listing).",
    "- If the buyer is haggling on price, asking financing specifics, asking trade-in value, threatening, or upset: set needs_human to true, give a one-line reason, and make the draft a short polite holding reply that says the salesperson will check and get right back to them.",
    "- Keep drafts SHORT and natural for Messenger: 1–3 sentences, no corporate fluff, no emoji unless the profile tone asks for it. End with a question or a concrete next step when it fits (ideally a visit).",
    "- Follow the salesperson's standing instructions in the profile above everything except these hard rules.",
    "- When the request includes the salesperson's real past replies or corrections, they are the authority on voice: copy their greetings, sentence length, wording habits, and how they offer times and close. Their real phrasing beats generic sales-speak.",
    "",
    'Reply with ONLY a JSON object: {"draft": string, "needs_human": boolean, "reason": string}',
  ].join("\n");

  const transcript = thread
    .map((m: any) => (m.direction === "in" ? "BUYER: " : m.origin === "ai" ? "REP (Luca draft): " : "REP: ") + m.body)
    .join("\n");
  const voiceBlock = voicePairs.length ? [
    "",
    "HOW THIS SALESPERSON ACTUALLY WRITES — real exchanges from their own chats (other buyers). Draft in this voice:",
    ...voicePairs.map(p => "BUYER: " + p.buyer + "\nSALESPERSON SENT: " + p.rep),
  ] : [];
  const corrBlock = corrPairs.length ? [
    "",
    "CORRECTIONS — Luca's earlier drafts vs what this salesperson actually sent. Their version wins; do not repeat phrasing they removed:",
    ...corrPairs.map((c: any) => "LUCA WROTE: " + String(c.draft).slice(0, 300) + "\nSALESPERSON SENT: " + String(c.final).slice(0, 300)),
  ] : [];

  const noneBlock = verifiedNone.length ? [
    "",
    "VERIFIED — NONE IN STOCK: an inventory search just confirmed there are currently NO vehicles matching: " + verifiedNone.join(", ") + ". For these you MAY tell the buyer plainly that you don't have one on the lot right now (and offer to keep an eye out).",
  ] : [];

  const filterNoneBlock = filterNone ? [
    "",
    "VERIFIED — NONE MATCHING THE ASK: a live inventory search just confirmed the lot currently has NO vehicles matching the condition/price the buyer asked for. You may say plainly that you don't have one matching that right now (and offer to keep an eye out). Do not name a specific alternative vehicle that is not in a block above.",
  ] : [];

  const invBlock = invMatches.length ? [
    "",
    invPrimary.length
      ? "INVENTORY RESULTS — live from the salesperson's lot, matched to what the buyer asked. These are FACTS (prices, miles, stock numbers, links exactly as written). Mention at most 2-3 vehicles; for each one you name, include the stock # and the link:"
      : "INVENTORY RESULTS — the salesperson's lot has vehicles matching the buyer's words, but NONE in the exact condition/price they asked for. Be honest about that, then offer the closest alternative below (labeled as the alternative it is) or offer to keep an eye out:",
    ...invPrimary.map((c: any) => "- " + fmtCar(c)),
    ...(invAlt.length ? ["Closest alternatives:", ...invAlt.map((c: any) => "- " + fmtCar(c))] : []),
  ] : [];

  const currentBlock = currentCar ? [
    "",
    "VERIFIED-CAR — the exact car this conversation is about, matched live and uniquely to this listing in the salesperson's inventory. These are FACTS; answer spec questions (miles, colors, transmission, drivetrain, fuel, engine) straight from this line, exactly as written:",
    "- " + fmtCar(currentCar),
  ] : [];

  // No unique match -> the car contributes NO facts. The block tells
  // Luca plainly that this car's specs are unknown, so spec questions
  // get the check-the-lot phrasing instead of a borrowed number.
  const unresolvedBlock = (!currentCar && String(prospect.vehicle_label || "").trim()) ? [
    "",
    "THREAD CAR — NOT VERIFIED: this conversation's exact car could not be uniquely matched in live inventory, so its mileage, colors, and specs are UNKNOWN. If the buyer asks about them, say you'll double-check and get right back — never borrow numbers from another car.",
  ] : [];

  const userPrompt = [
    "Listing the buyer is asking about: " + (prospect.vehicle_label || "(unknown)"),
    "Buyer name: " + (prospect.name || "(unknown)"),
    prospect.city || prospect.state ? "Buyer location: " + [prospect.city, prospect.state].filter(Boolean).join(", ") : "",
    "",
    "Conversation so far (oldest first):",
    transcript,
    ...currentBlock,
    ...unresolvedBlock,
    ...voiceBlock,
    ...corrBlock,
    ...invBlock,
    ...noneBlock,
    ...filterNoneBlock,
    "",
    "Write the salesperson's next reply.",
  ].filter(Boolean).join("\n");

  let parsed: any = null;
  try {
    const raw = await callGemini(apiKey, system, userPrompt);
    parsed = parseDraftText(raw);
  } catch (e) {
    return json({ ok: false, error: "Drafting failed: " + (e as Error).message }, 502);
  }
  let draft = String(parsed?.draft || "").trim();
  if (!draft) return json({ ok: false, error: "Luca returned an empty draft" }, 502);
  let needsHuman = !!parsed?.needs_human;
  let reason = String(parsed?.reason || "");

  // ---- Post-draft fact guard (grounding hardening): every price /
  // mileage figure in the draft must trace to a verified source —
  // the resolved thread car, a retrieved row actually shown in the
  // prompt, the listing label itself, or a figure the buyer stated.
  // Anything else is treated as invented and never reaches the rep.
  const allowedMiles = new Set<number>();
  const allowedPrices = new Set<number>();
  {
    const allowCar = (c: any) => {
      if (!c) return;
      const fm = factMileage(c);
      if (fm) allowedMiles.add(fm);
      const fp = factPrice(c);
      if (fp) allowedPrices.add(fp);
    };
    allowCar(currentCar);
    for (const c of invPrimary) allowCar(c);
    for (const c of invAlt) allowCar(c);
    const labelPriceM = String(prospect.vehicle_label || "").match(/\$\s*([\d,]+)/);
    if (labelPriceM) allowedPrices.add(parseInt(labelPriceM[1].replace(/,/g, ""), 10));
    for (const m of thread) {
      if ((m as any).direction !== "in") continue;
      const bc = extractFactClaims(String((m as any).body || ""));
      for (const v of bc.miles) allowedMiles.add(v);
      for (const v of bc.prices) allowedPrices.add(v);
    }
    draft = await enforceFactGuard(draft, allowedMiles, allowedPrices, async (violations: string[]) => {
      const raw2 = await callGemini(apiKey, system, userPrompt +
        "\n\nCORRECTION — your previous draft stated " + violations.join(", ") +
        ", which is NOT among the verified facts in the blocks above. Rewrite the reply using only figures that appear in the VERIFIED-CAR or INVENTORY RESULTS blocks (or the listing label itself). If the figure the buyer asked about isn't in those blocks, leave the number out entirely and say you'll double-check.");
      return String(parseDraftText(raw2)?.draft || "").trim();
    }, prospectId);
    if (!draft) return json({ ok: false, error: "Luca returned an empty draft" }, 502);
  }

  // ---- Post-draft availability-claim guard (2026-10-28): an
  // unavailability claim is a FACT, and its only basis is a
  // completed search that came back empty — verifiedNone (asked
  // term) or filterNone (asked filter). Without that basis the
  // claim is invented (caught live in the battery: "I checked the
  // lot and we don't have any Beetles" with no search ever run).
  // Regenerate once with the rule named; if the rewrite still
  // claims, a check-the-lot line stands in. Runs only when the
  // draft would otherwise be sent as a normal answer.
  if (!needsHuman && draft && !verifiedNone.length && !filterNone && unavailabilityClaim(draft)) {
    console.log("[luca-draft] claim guard: unverified unavailability claim (prospect " + prospectId + ") — regenerating once");
    let fixed = "";
    try {
      const rawC = await callGemini(apiKey, system, userPrompt +
        "\n\nCORRECTION — your previous draft claimed a vehicle is unavailable, or that you checked the lot, but NO completed inventory search in this request backs that claim. Rewrite honestly: if no block above covers the vehicle the buyer asked about, say you'll check the lot and get right back to them. Never claim to have checked, and never say you have or don't have a vehicle the blocks above don't cover.");
      fixed = String(parseDraftText(rawC)?.draft || "").trim();
    } catch { /* fall through to the replacement */ }
    if (fixed && !unavailabilityClaim(fixed) && !factViolations(fixed, allowedMiles, allowedPrices).length) {
      draft = fixed;
    } else {
      console.log("[luca-draft] claim guard: fallback replacement (prospect " + prospectId + ")");
      draft = "Let me check the lot on that one and get right back to you.";
    }
  }

  // ---- Post-draft hand-back guard (2026-10-28): the hard floor
  // says haggling / financing specifics / trade value / an upset
  // buyer go to the salesperson — but the model sometimes answers
  // anyway (battery: a monthly-payment question got a sales reply).
  // The buyer's latest message is classified deterministically; if
  // it is a hand-back category and the model did not hand back, one
  // corrective regeneration runs; if that still answers, force
  // needs_human with a safe holding draft (trade asks offer the
  // intake link when the account has one — never a number).
  {
    const bait = baitCategory(latestBuyer);
    if (bait && !needsHuman && draft) {
      console.log("[luca-draft] hand-back guard: " + bait.cat + " ask not handed back (prospect " + prospectId + ") — regenerating once");
      let recovered = false;
      try {
        const rawB = await callGemini(apiKey, system, userPrompt +
          "\n\nCORRECTION — the buyer's latest message is about " + bait.label + ", which the HARD RULES hand to the salesperson. Set needs_human to true and make the draft a short, polite holding reply" +
          (bait.cat === "trade" && tradeUrl ? " that offers the trade-in link given in the system instructions" : "") +
          ". Do not answer the question yourself, and do not state any number.");
        const pB: any = parseDraftText(rawB);
        const dB = String(pB?.draft || "").trim();
        if (pB?.needs_human && dB && !factViolations(dB, allowedMiles, allowedPrices).length && !unavailabilityClaim(dB)) {
          draft = dB;
          needsHuman = true;
          reason = String(pB?.reason || bait.reason);
          recovered = true;
        }
      } catch { /* force below */ }
      if (!recovered) {
        console.log("[luca-draft] hand-back guard: forcing needs_human (prospect " + prospectId + ")");
        needsHuman = true;
        reason = bait.reason;
        draft = bait.cat === "trade" && tradeUrl
          ? "I can't put a number on a trade sight unseen — but start here and we'll work a real value from your answers and photos: " + tradeUrl
          : "Let me check on that for you and get right back to you.";
      }
    }
  }

  // Save the draft so the corrections/outcome loop can learn from it.
  await supabase.from("closer_messages").insert({
    user_id: user.id,
    prospect_id: prospect.id,
    thread_ref: prospect.thread_ref || null,
    direction: "out",
    origin: "ai",
    body: draft,
  });

  return json({ ok: true, draft, needs_human: needsHuman, reason, provider: PROVIDER });
});
