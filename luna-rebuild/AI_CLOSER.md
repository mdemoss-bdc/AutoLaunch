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
