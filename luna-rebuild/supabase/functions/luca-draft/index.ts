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

  // ---- Voice learning (2026-10-25, Matthew's ask): Luca learns how
  // a rep talks from the replies they ALREADY send — no draft-editing
  // required. Auto-capture saves every rep reply (origin 'rep'), so
  // buyer -> rep pairs from the rep's OTHER threads become voice
  // examples in the prompt below. Effective from the first captured
  // conversation; sharper with every chat. Per-user by construction
  // (RLS + this user filter) — voices never mix between reps.
  type VRow = { prospect_id: string; direction: string; origin: string; body: string; status: string | null; created_at: string };
  const junkBody = (b: string) => !b || b.length < 3 || b.length > 400 || /\.(csv|txt|pdf|jpe?g|png|zip)$/i.test(b.trim());
  const { data: voiceRows } = await supabase
    .from("closer_messages")
    .select("prospect_id, direction, origin, body, created_at, status")
    .eq("user_id", user.id)
    .neq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(150);
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
  const voicePairs = allPairs.filter(p => {
    const k = p.rep.toLowerCase();
    if (seenRep.has(k)) return false;
    seenRep.add(k);
    return true;
  }).slice(0, 10);

  // Corrections (draft -> what the rep actually sent) remain the
  // strongest signal when they exist — the rep explicitly fixed Luca.
  const { data: corrRows } = await supabase
    .from("closer_corrections")
    .select("draft, final")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(8);
  const corrPairs = (corrRows || []).filter((c: any) => c.draft && c.final && c.draft !== c.final);

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
    "",
    "HARD RULES — never break these:",
    "- Never invent or guess a price, monthly payment, APR, financing term, discount, or trade-in value. The only price you may mention is one that appears in the listing label or the conversation.",
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

  const userPrompt = [
    "Listing the buyer is asking about: " + (prospect.vehicle_label || "(unknown)"),
    "Buyer name: " + (prospect.name || "(unknown)"),
    prospect.city || prospect.state ? "Buyer location: " + [prospect.city, prospect.state].filter(Boolean).join(", ") : "",
    "",
    "Conversation so far (oldest first):",
    transcript,
    ...voiceBlock,
    ...corrBlock,
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
  const draft = String(parsed?.draft || "").trim();
  if (!draft) return json({ ok: false, error: "Luca returned an empty draft" }, 502);
  const needsHuman = !!parsed?.needs_human;
  const reason = String(parsed?.reason || "");

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
