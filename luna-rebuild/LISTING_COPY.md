# Listing Copy Engine — one car in, every channel out

Built 2026-10-26 (the hackathon build), REBUILD ONLY — not yet in the
live app. Matthew green-lit starting early so the wow factor exists
before any selection email arrives.

## What it does

Pick any car in Inventory (the ✨ button on the row/card, or
**✨ Listing copy (AI)** in the ⋯ menu) and the engine writes three
channel-ready variants from that one car:

- **Marketplace** — listing title + full description
- **TikTok** — short caption + a 20–30s spoken reel script (65–85
  words: hook → walkaround facts → invitation to the lot)
- **Page** — a Facebook Page post

Each variant has its own Copy button in the panel. The rep reviews,
copies, pastes — same human-in-the-loop posture as Luca.

## Grounding is the product

The copy may use ONLY:

1. The car's own `scraped_inventory` row — year/make/model/trim,
   advertised price, miles, colors, stock #, location (shown through
   the rep's location groups), condition, transmission, photo count,
   listing link.
2. NHTSA vPIC VIN-decode specs (drivetrain, fuel, engine,
   transmission) — fetched fail-open, exactly like luca-draft v5.
   If the VIN record doesn't carry a spec, the copy omits it.
   Specs are never guessed.

**Never invented:** price, features, financing, payments, APR,
warranty, availability promises.

**Price rule:** the only dollar figure allowed is the row's
advertised price, exactly. If `price` is null or `price_status` is
`call`/`none`, the copy contains **no price figure at all** — the
stale value in the row is treated as absent.

Enforcement is two-layer:

- The **prompt** states the rules and hands the model a FACTS block
  (and an explicit "PRICE: NOT LISTED" instruction when applicable).
- A **deterministic sanitizer** (`sanitizeCopy` in the function)
  re-checks the model's output: sentences with financing/payment/APR/
  lease language are dropped, any dollar amount that isn't exactly
  the advertised price is removed, and the Marketplace description
  is guaranteed to carry the real price/miles/stock # (appended as a
  facts footer only when the model left them out). Model formatting
  quirks (spaced-out URLs, split decimals like "2. 0L") are repaired,
  with the listing link restored to the exact URL from the row.

If the rep has a Luca profile (`closer_profiles`), the copy matches
its tone.

## Plumbing

- Edge Function: `supabase/functions/listing-copy/index.ts`
  (deployed to Phantom, verify_jwt=false + manual JWT verification,
  anon client + caller JWT — the luca-draft pattern; RLS makes the
  inventory read owner-scoped, so a rep only ever gets copy for
  their own cars).
- POST body: `{ "vin": "..." }` (or `{ "car_id": "..." }` — VIN
  match first, then stock #).
- Response: `{ ok, vin, car, variants: { marketplace: {title,
  description}, tiktok: {caption, script}, page: {text} },
  grounded: { price_used, vin_specs_used, photo_count }, provider }`.

## Cost & provider rule

NO paid AI (Matthew's rule). Drafting runs on Google Gemini's FREE
tier via the same `GEMINI_API_KEY` secret as luca-draft. The
provider is behind one config block at the top of the function
(`AI_PROVIDER` / `AI_MODELS`) — flipping to Meta/Llama models for
the hackathon is a config-only change; prompts, grounding, and
guards are provider-agnostic.

## Verification (2026-10-26)

- **Node harness** (30 checks): the function's pure logic
  (buildFacts → buildPrompts → parseCopyJson → sanitizeCopy) was
  extracted verbatim and run against stubbed model outputs —
  compliant, forgetful, wrong-price, financing-laced, and
  price-injecting. A grounded car yields copy with its real
  price/miles/stock #; a price-less car yields ZERO dollar figures
  anywhere; financing language never survives; "please" does.
- **Seeded E2E** (reviewer test account, real JWT, real deployed
  function): 2023 Nissan Sentra SR, stock TTP1891A — returned all
  three variants carrying the real $11,222 / 142,277 miles / VIN
  specs (2.0L 4-cylinder, CVT, 4x2) / real listing link, no
  financing language.

## Demo flow (the one-car-to-everywhere story)

1. Open Inventory in the rebuild app.
2. Tap ✨ on a car — the panel fills with Marketplace, TikTok
   (caption + read-aloud reel script), and Page copy in seconds.
3. Copy each variant into its channel. One car, written once,
   posted everywhere — with every fact traceable to the car's own
   row and its VIN record.
