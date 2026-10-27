# AI Closer + Prospects — spec (Matthew's design, 2026-10-25)

Matthew's call after the Owini comparison: NO CRM. Two small things instead:

1. **Prospects** — a tiny tracker for people who reach out about a car.
2. **AI Closer** — an AI that answers buyer chats the way the *salesperson*
   wants: self-learning, and directed by the rep talking to it, not a fixed
   vendor script (that is the deliberate contrast with Owini's Closer).

## Name: Luca

The closer is named **Luca** (Matthew, 2026-10-25: "something that sounds
like you — like your son"). Luna → Luca; Luca means "light". Buyer-facing
copy introduces Luca only if the rep turns on the optional "I use an
assistant" note; otherwise Luca writes as the rep, per the rep's profile.

## The rep's profile (fields on the Luca screen — Matthew, 2026-10-25)

Stored in `closer_profiles.profile` (jsonb):

- **Your name** — who Luca is assisting / signing as.
- **Work schedule** — TWO layers (Matthew, 2026-10-25): **store hours**
  (`profile.store_schedule = {mon: {open, start, end}, ...}` — a day
  switched off is a CLOSED day; default Mon–Sat 9–20:00, Sun closed) and
  **personal hours** (`profile.schedule = {mon: {on, start, end}, ...}`
  — the rep's own days/hours; per-day because each weekday differs; the
  same week repeats all year — no date/season logic). `work_days` and
  `work_start/work_end` are kept as legacy mirrors of the personal
  layer. Luca's rules: never offer a store-closed day; on a store-open
  day the rep is off, offer the rep's next work day; book inside the
  rep's hours and quote real availability ("I'm in Saturday 9–7");
  off-hours get capture + draft or auto-reply per mode — never promise
  the rep is in when they're not.
- **Credit-app link** — the store's online credit application URL. When a
  prospect wants to apply, Luca sends this link. Sending the link is a
  hand-off, not a financing discussion: the no-APR / no-approval-promise
  floor still applies.
- **Tone** — starter voice (casual & short / friendly & detailed /
  professional), refined later by the corrections bank.
- **Standing instructions** — free text from the rep (see Talk to it).

## Invariants

- Prospects/Closer problems must NEVER affect posting (fail-open, same rule
  as intro videos).
- The closer never invents a price, a payment, an APR, or a financing
  promise. This floor is NOT user-configurable — it's the brand promise.
- Everything the closer does is visible to the rep (full transcript log).

## Prospects (not a CRM)

Fields (Matthew's list): **name, city, state, email, notes** — plus:

- **stage** — where they are in the buying process:
  New → Talking → Visit set → Came in → Sold · Not now
- **vehicle** — the car they asked about (link to inventory when known)
- **source** — Marketplace chat / manual / TikTok / Instagram

Capture paths:

- Manual add/edit (Phase 1 — same patterns as Customer Wishlist:
  Supabase table + localStorage fallback, local-first saves).
- Auto-create from a Marketplace chat when the extension sees a new buyer
  thread (Phase 2). Name + vehicle come from the thread; city/state/email
  are usually NOT in the chat — the closer asks for them naturally
  ("want me to send you the walk-around video? what's a good email?").
  No field is ever required to save a prospect.

UI: sidebar entry "Prospects" with a count badge for stage = New.
List grouped/filterable by stage; tap a prospect → detail with notes,
stage stepper, and (Phase 2+) the chat transcript.

## AI Closer

There is no official API into a personal account's Marketplace chats —
the closer runs through the extension in the rep's own logged-in session,
the same route posting already uses (and the same route Owini's uses).

Pipeline: extension observes buyer threads → new buyer message goes to a
Supabase Edge Function → the function builds the prompt from (a) the
vehicle's real listing data, (b) the thread history, (c) the rep's closer
memory → model replies → reply is drafted or sent per the active mode.

Modes (per rep, default = Draft):

1. **Draft** — closer writes the reply, rep taps send/edit/discard.
2. **Auto with limits** — sends on its own inside the rep's rules
   (hours, daily cap, pause-on-human-reply), hands back on triggers below.
3. **Off** — capture only (prospects still tracked).

Hand-back triggers (chat returns to the rep, closer goes quiet):
price haggling, financing numbers, trade-in value, upset buyer, buyer asks
for a real person, any topic on the rep's hand-back list.

### Self-learning (what it actually is)

Not model retraining — a per-rep memory the closer reads on every reply:

- **Profile**: tone, greeting style, qualifying questions (in the rep's
  order), hours/quiet times, "never say" list, hand-back topics.
- **Corrections bank**: every time the rep edits a draft or rewrites a
  sent reply, the before/after pair is stored and the best-matching
  examples ride along in future prompts. This is where "it answers like
  me" comes from.
- **Outcome signals**: replies that led to a booked visit / a stage move
  are marked; phrasing that works for this rep gets preferred.

### Talk to it (the rep directs it)

A chat box in AutoLaunch — "Your Closer" — two kinds of input:

- **Standing instructions** (persist into the profile):
  "Answer short and casual." "Always ask about a trade-in first."
  "Never message after 9 pm." "If they ask about the Sienna, mention the
  new tires."
- **Task commands** (one-off jobs, run through the extension):
  "Message everyone who asked about the blue F-150 — it dropped $500."
  "Follow up with anyone who went quiet 2+ days ago."
  Task commands always show a preview list + the exact message before
  anything sends (bulk actions never fire blind).

## Data model (draft — see supabase/ai_closer_migration_APPLIED_2026-10-25.sql)

- `prospects` (user_id, name, city, state, email, notes, stage,
  vehicle_id, vehicle_label, source, thread_ref, created_at, updated_at)
- `closer_profiles` (user_id, mode, profile jsonb — tone/rules/hours,
  updated_at)
- `closer_corrections` (user_id, thread_ref, draft, final, created_at)
- `closer_messages` (user_id, prospect_id, thread_ref, direction,
  body, origin [ai|rep|buyer], created_at)

All RLS owner-only, mirroring the wishlist/intro-video tables.

## Phases

- **P1 — Prospects tracker (manual)**: table + sidebar + list/detail UI.
  No extension changes, no AI. Ships on its own.
- **P2 — Capture + drafts**: extension reads Marketplace threads,
  auto-creates prospects, closer drafts replies in Draft mode.
- **P3 — Talk to it + memory**: closer profile editing by chat,
  corrections bank live, standing instructions honored.
- **P4 — Auto mode + tasks**: auto-send behind limits, hand-back
  triggers, task commands with preview-then-send.

## Open questions for Matthew

- Closer chat box lives where — its own sidebar page, or a panel on the
  Prospects page? (Spec assumes a panel on Prospects to keep the sidebar
  short.)
- Model choice for replies is Luna's pick (fast/cheap hosted model;
  grounded in listing data only) unless Matthew wants a say.

## Cost rule (Matthew, 2026-10-25): $0 until users

Matthew will not pay for AI before AutoLaunch has users and revenue.
Drafting therefore runs on **Google Gemini's free tier** (AI Studio key,
no credit card; Flash ≈1,500 requests/day — far above solo volume).
Accepted trade-off for now: free-tier content may be used by Google to
improve its models; flipping to a paid key (pennies per draft, out of
revenue) ends that. The drafting Edge Function is **provider-agnostic**
— provider + model + key are server config, so the flip is a settings
change, never a rebuild. If the product flops, total AI spend stays $0.

## Prospects inbox step 2 — reply from Prospects (built 2026-10-25)

The rep types a reply on the prospect's card; the app inserts a closer_messages row (direction out, origin rep, status "queued" — status column added 2026-10-25). The helper polls each minute: claims one row (status -> "sending", guarded), parks it in the luca_pending_delivery storage slot, and points a Facebook tab at the thread — opening it if needed. The tab's capture script types via the proven CDP path (insertText works in background tabs; execCommand is only a fallback), presses Enter, and VERIFIES the message appears as the rep's own bubble before the worker flips the status to "sent" (or "failed"). The card's pill is the receipt: queued / sending / sent / failed. Delivery happens only on the thread's own page — never via a floating popup (its conversation can't be matched to the pending thread with certainty). A delivery in flight >3 min is marked failed, never resent blind.

## Snippet sync — incoming messages without clicks (built 2026-10-25, ext 2.1.33)

Matthew's requirement: sync must catch NEW buyer messages in conversations he has not opened — he can't click every chat. Two tiers now: (1) the OPEN thread still gets the full-transcript capture; (2) the inbox LIST's per-row preview line (which Facebook updates live when a buyer writes) is forwarded by the content script — with a MutationObserver fast pickup (~5s debounce, 12s min gap) on top of the 45s pass — and the worker stores it as a message ONLY for threads already tied to a known prospect (personal chats are never pulled in). "You:" prefixes mark the rep's own line (direction out). Full captures delete the snippet rows they supersede (partial cleanup in handleCaptureChat). Honest limits: only conversations rendered in the list (top ~15) and only the newest line per conversation until it is opened.

## Commerce gate for stubs (ext 2.1.34, 2026-10-25)

First live run of snippet-era auto-sync hoovered Matthew's personal inbox: stubs appeared for a Meta AI chat, a 'Facebook user' personal chat, a business-page chat and a personal contact (4 junk prospects, deleted from the DB by Luna the same hour). Root cause: the stub pass stubbed EVERY /messages/t/ row. Fix: a row becomes a prospect stub only with Marketplace evidence — a priced listing label ($… - …), a year/make/model label, or residence on the /marketplace/inbox surface. Meta AI / Facebook user rows need a priced label to pass. Long fused first segments (>30 chars, name+snippet mergers like 'Eastgate Plaza WVYou: …') now fall back to the placeholder name instead of a wrong name self-heal would never fix.

## Reply delivery VERIFIED LIVE + conversation view (2026-10-25)

Third attempt (after a tab refresh) SUCCEEDED: status flipped to 'sent' in the DB and the message ('Certified Warranty adds 2yr 24k miles') is visible in the actual Messenger thread — reply-from-Prospects is proven end to end. Attempts 1-2 failed: (1) dead content script after an extension update ate the poke (fixed in 2.1.35 with ACK + tab-reload fallback); (2) failed fast on a stale build. 2.1.36 added delivery_error recording (column added) for stage-level diagnosis. Same day, Matthew asked for and got the CONVERSATION VIEW: a 'View conversation' expander on each prospect card renders all captured messages as bubbles (buyer left / rep right / Luca drafts tagged violet, outbound status tags on rep bubbles), every message individually copyable (Copy button + selectable text).

## Voice learning — SHIPPED 2026-10-25 (luca-draft v4)

Matthew's call: Luca must learn from how a rep writes on their own — not only from edited drafts. luca-draft now loads the rep's real captured replies (origin 'rep', status not failed) from their OTHER threads, builds buyer->rep pairs (up to 10, most recent first, deduped, junk-filtered), and puts them in the prompt as voice authority ("HOW THIS SALESPERSON ACTUALLY WRITES"). closer_corrections pairs (up to 8) ride along as a stronger signal when they exist. The current thread is excluded from examples (its own transcript already carries that voice). Per-user by RLS + user filter — voices never mix. No user effort: any rep with captured conversations gets voice-matched drafts automatically; each new chat sharpens the rest.

## Inventory grounding — SHIPPED 2026-10-25 (luca-draft v5)

Matthew's asks: (1) answer "any used Civics?" with real cars + stock # + listing link; (2) answer spec questions (miles, exterior/interior color, drivetrain, fuel, transmission) about the conversation's car. Built: label resolution finds the prospect's exact inventory row (year+model from vehicle_label, exact-price preferred; vehicle_id-as-VIN first when present); buyer-text keyword search (stopword-filtered, singularized — buyers type plurals, inventory is singular; condition + price-ceiling parsed from the text) returns up to 5 matches + 3 alternatives as a FACTS block. Specs come from the inventory row (miles, ext/int color, transmission, body) enriched by a FREE NHTSA vPIC VIN decode (drivetrain/fuel/engine — no key, fail-open, per-VIN cached). Reality: VW VINs report no drivetrain (Jetta decodes fuel/engine/transmission only) — trim-token fallback (AWD/4x4 in the trim), else Luca says he'll double-check; specs are NEVER guessed. Hard floor amended: prices/facts may be stated when they come from the listing label, the conversation, or these grounded blocks.

## Fuzzy buyer-language matching — SHIPPED 2026-10-25 (luca-draft v7)

Matthew's ask: buyers misspell and skip punctuation. Two live failures drove the redesign: v5/v6 searched inventory with the buyer's RAW words in sentence order, so filler flooded the query cap and stocked cars read as not-in-stock ("civics", then "colorados" — Matthew has 23 Colorados; Luca offered a Canyon instead). v7 is vocabulary-first: buyer words resolve against the lot's real make/model vocabulary (per-user, 10-min cached) — exact, alias (chevy->chevrolet, vw->volkswagen), singular, fused-word ("usedcivics"->civic), or edit-distance (<=1 for <=4 letters, <=2 above) — and only confirmed vehicle words are searched, spelled the inventory's way. 25/25 harness cases pass; live E2E with a typo-riddled buyer message ("jeta", "milage", "manuel", "colorodo") produced a fully grounded draft (real miles/gearbox + the Colorado with stock # and link).

## Auto-learn from sends — SHIPPED 2026-10-26 (app-side, luca-draft unchanged at v12)

Matthew's "make Luca smarter faster" lever #1: learn from the gap between Luca's draft and what the rep ACTUALLY sends — not just from edits made in the draft box (the copy-path capture has existed since 2026-10-25). App-side only, in luna-rebuild/index.html:

- **Retain**: when a draft is generated, the app retains it per prospect (in memory + localStorage per user, 7-day prune), keyed to the buyer turn it answers — the thread's latest inbound closer_messages id (DB-fresh at draft time, in-memory fallback).
- **Pair**: when the rep sends from the Prospects reply box, the sent text is compared: identical (modulo whitespace) → **acceptance**, tallied locally per user (`autolaunch_luca_accepts_<uid>`), deliberately NO corrections row (identical pairs teach nothing; v12 discards them) and no closer_messages write (status values there belong to the delivery machine). Different → exactly one `closer_corrections` row {user_id, thread_ref, draft, final} — precisely the shape luca-draft v12 already reads (≤8, draft≠final), so the very next draft call learns from it with NO function change. If a newer buyer message landed after the draft, the draft is **stale**: no pair, retained state dropped.
- **Dedupe**: the same (thread, draft, final) pair is never written twice — a session Set plus a DB existence check inside `recordLucaCorrection` (now shared by both writers: copy path and send path), so reloads and copy-then-send-same-text can't double-record one lesson.
- **Fail-open**: every step is fire-and-forget; a learning failure can never block or break a send. Draft-only invariant untouched: Luca still never sends — this only learns from sends the human makes.

Verified 2026-10-26: Node harness 25/25 (edited→one correction, unedited→acceptance/none, no draft→nothing, duplicate/reload attempts→still one, stale→none) + seeded E2E on the reviewer account running the REAL extracted app functions against the live DB — real v12 draft, simulated send, one correction row written (two duplicate attempts refused, incl. from a fresh session), v12's exact read query returns the pair as the prompt renders it, second real draft succeeded with the correction in its bank. Reviewer baseline restored (0 prospects/messages/corrections/profiles/settings, 15 inventory).

## luca-draft v13 — PREPARED 2026-10-26; **SHIPPED 2026-10-27 as platform v25, rebased onto v24 (see the v25 section at the end)**

Source: `supabase/functions/luca-draft-v13-prep/index.ts` (v12 source untouched; deployment is a shared-live change and waits for Matthew's promotion call). Three voice-learning fixes, harness-verified against the real imported voice bank: (1) the junkBody length cap rises 400 → 1,500 chars, so long-form rep messages (e.g. the ~1,400-char program-stacking walkthrough in the Corey Johnson import) can form voice pairs — v12 silently yields only ONE pair from that thread; pairs still slice to 300 chars in the prompt, so prompt size is unchanged. (2) The voice read window widens `.limit(150)` → `.limit(600)` prospect-linked messages; the imported bank (~176 rows) had outgrown the 150-row window, silently dropping older threads. Delivered pairs stay capped at 10. (3) The make/model vocabulary build is paginated with `.range()` — it read with `.limit(4000)`, which PostgREST silently caps at 1,000 rows, so models stocked only beyond that window never became searchable words.

## Grounding hardening — SHIPPED 2026-10-26 (luca-draft platform v24, on the v12 base)

Driven by a live miss the same evening: a buyer asked the miles on the thread's car (2026 Jetta, $26,159 listing, stock HA4220, actual 9,382 mi) and Luca drafted "It has 1,000 miles on it" — the 1,000-mi new-car placeholder from a DIFFERENT row, via the old resolver's first-row fallback. The rep sent it before anyone caught it. Matthew authorized this deploy directly ("make sure luca is always pulling the right info when questions are asked about the inventories of places, and not just make up an answer"). Three layers, all in `supabase/functions/luca-draft/index.ts` on top of the v12 source (verified token-identical to the deployed artifact before the build; the v13-prep voice changes are NOT included and v13-prep must be rebased onto this hardened source before any future deploy):

- **Placeholder scrub (factMileage)**: a mileage is a fact only when it's a real reading. Exactly 1,000 mi on a Used / Certified / Pre-Owned row — or on any row with a prior Marketplace listing (`marketplace_posted_at`) — is the scraper's new-car placeholder leaking, and is dropped before the prompt is built (the fact line simply carries no mileage). Null/zero are absent facts, never values.
- **Unique thread-car resolution (VERIFIED-CAR)**: the conversation's car resolves deterministically — a VIN or stock token anywhere in the thread data wins outright; otherwise the listing label is matched against live inventory and only an exact price + year/make/model match (or a single candidate) resolves. Ambiguity resolves to NOTHING: no VERIFIED-CAR block, a THREAD CAR — NOT VERIFIED block instead, and spec questions get the check-the-lot phrasing. Facts about "this car" may come only from the resolved row. General inventory answers likewise come only from rows actually retrieved for the draft (location claims from the rows' own location/group fields); anything else falls to the existing no-improvise / VERIFIED-NONE lines.
- **Post-draft deterministic guard**: every price/mileage figure in the generated draft is extracted and must trace to a verified value — the resolved car, a retrieved row shown in the prompt, the listing label, or a figure the buyer stated. A mismatch regenerates once with the violation named; a second mismatch strips the offending sentence(s), falling back to a double-check holding line if nothing clean remains. Interventions are console-logged with the prospect id.

Proof (behavioral, per the house standard): Node harness 38/38 on the real extracted helpers (placeholder matrix, claim extraction, violation detection, sentence strip, unique/ambiguous resolution, guard regenerate/strip/hold paths). Seeded E2E on the TikTok reviewer account against the deployed function with a Matthew-shaped fixture (two 2026 Jettas — $26,159 / 9,382 mi thread car + $23,220 / 8,818 mi — plus a new Sentra parked at the 1,000-mi placeholder): miles question → "It's got 9,382 miles…" (exact; no 1,000 anywhere); price question → "$26,159" only; ambiguous thread (label without price, two matches) → "Let me double-check the exact mileage on this one…" with zero spec claims; Toyota Tacoma ask (none in stock) → no-improvise reply, zero invented figures. 15/15 checks; reviewer baseline restored (0 prospects / messages / profiles, 15 inventory rows).

## luca-draft v25 — SHIPPED 2026-10-27 (v13 voice changes rebased onto v24; platform version 29)

Matthew's go (2026-10-27 00:56 EDT): "Work on Luca if you can. Try to make him as smart as you." The three prepared v13 voice changes were ported onto the deployed v24 source (blob d7629291, commit 506c7dbc) — nothing else. Merge proof: diff(v24 → v25) is exactly the header note plus the three changes (junkBody cap 400 → 1500 at the voice block; voice read .limit(150) → .limit(600); vocabulary build paginated with .range() pages of 1,000). Every v24 grounding behavior — pickThreadCar, factMileage placeholder scrub, VERIFIED-CAR / THREAD CAR — NOT VERIFIED blocks, VERIFIED-NONE / no-improvise lines, the post-draft deterministic guard — is byte-identical. Merged source blob 865e7b12; deployed via the Management API multipart pattern from those exact bytes. (The platform version counter reads 29, not 25: the verification cycle below redeployed v24 twice as a control, incrementing the counter each time. Content is what the counter can't show — the deployed bytes are blob 865e7b12.)

Proof (behavioral, per the house standard):
- Harnesses: grounding harness 38/38 on the merged source (and 38/38 on pristine v24 as control — identical). New voice harness 16/16: the REAL extracted junkBody now accepts 401 / 1,400 / 1,500-char rep messages and still rejects 1,501 chars, file-extension bodies, and empties (v24's extracted junkBody rejects the long ones — negative control); scoped checks confirm the 600 window and the paginated vocabulary build.
- Voice E2E (seeded, TikTok reviewer account): an old prospect thread whose rep answer is 1,060 chars (over the old cap) carrying distinctive content ("Purple Tiger route", walk-around video, cold start) was buried under 168 newer buyer-only messages, putting it at ranks 169–170 of the voice read — outside the old 150 window, inside the new 600 (proven deterministically at the query level: pair rows in-window = 0 at limit 150, 2 at limit 600). CONTROL on deployed v24 (run twice, before and after a marker-set amendment applied identically to both sides): 6/6 both times — zero pair content in any draft. VERIFY on deployed v25: 7/7 — all 3 drafts drew on the pair ("Good question, I get that a lot. I handle those long-distance deals by sending you a full walk-around video of the car first…"), 3/3 drafts carrying pair markers vs 0/2 on v24. Reviewer baseline restored after every run (0 prospects / messages / profiles, 15 inventory).
- Grounding E2E re-run (the v24 suite): the hard invariants held in every run on both versions — thread-car miles stated as 9,382 or safely omitted, never 1,000; price exactly $26,159; Tacoma ask produced no invented figures. One check is nondeterministic TONIGHT ON BOTH VERSIONS: the ambiguous-thread case (B) — v25 scored 14/15 three times and a v24 control run (rollback bytes, same night) also scored 14/15, each time presenting BOTH retrieved Jettas with real, traceable miles/prices (the 2026-10-26 v24 run produced the check-the-lot holding phrasing and 15/15). The B variance is the model's presentation choice among retrieved, guard-verified facts; it predates v25 and is not a regression. It IS a known prompt-adherence softness worth Matthew's awareness: on an ambiguous thread Luca may present both matching cars instead of asking which one.

Rollback: redeploy the v24 bytes (git commit 506c7dbc, blob d7629291) with the same multipart pattern — exercised twice during this verification, both deploys clean.
