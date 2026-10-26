# AutoLaunch Plans (tiers) + Email Verification — rebuild notes

Built 2026-10-26. Tier gating and the email-confirmation flow came
first; the **trial + billing system followed the same day** (see
"Trial + Billing" below): a 5-day IP-locked trial, a purchase gate,
and Stripe checkout/portal/webhook plumbing. The plumbing is live but
dormant — it activates the moment the Stripe secrets are set.

---

## The three tiers

| Tier key | Name | What it includes |
|---|---|---|
| `post` | **Post** | The manual core: inventory workspace, post queue, manual Marketplace posting, listing-copy ✨ — manual only (no automation features), and capped at **5 queued posts per day** (see "Daily queue cap" below) |
| `automate` | **Post + Automate** | Everything in Post, plus: auto-post new arrivals, auto delete & repost, extra channels (TikTok / Instagram / Facebook Page), Luca + Prospects, Customer Wishlist, Trade Appraisals, intro videos |
| `group` | **Group** | Everything in Post + Automate, plus team features (accounts/organizations) — those don't exist yet, so today `group` behaves like `automate` plus the reserved `teams` feature flag |

The single source of truth in the app is the `TIER_FEATURES` object in
`index.html` (feature key → minimum tier). To move a feature between
tiers, change that one map — every gate reads from it. Ranks:
`post` = 1, `automate` = 2, `group` = 3.

### Where the gates are

- **Pages** (first line of the page function): Wishlist (`wishlist`),
  Prospects (`prospects`), Trade Appraisals (`trade`), Luca (`luca`).
- **Modals**: Auto-post settings (`autopost`), Auto delete & repost
  settings (`auto_repost`).
- **Switches** (gated on turning ON; turning anything OFF is always
  allowed, and a denied switch flips itself back): ribbon auto-post
  arrivals + master (`autopost`), ribbon auto-repost (`auto_repost`),
  full-auto (`autopost`), auto-delete-on-exit (`auto_repost`), channel
  toggles (`channels`), intro-video enable / upload / mode / active
  selection (`intro_videos`). Deleting an intro video is housekeeping
  and is deliberately not gated.
- Gated features stay **visible**. Opening one shows a plain notice
  modal ("Available on Post + Automate", etc.) — factual, no prices,
  no upsell machinery.
- Photo crop + branding is not in either approved tier list and is
  deliberately ungated.

### Tier resolution (from `user_settings.plan_tier`)

`resolveTier()` in `index.html`:

- `post` / `automate` / `group` → used as stored.
- **No settings row, or a null/empty value → `post`** (the new-signup
  default; onboarding's `finishSetup()` writes `plan_tier: 'post'`
  only when creating a first row — it never overwrites an existing
  tier value).
- **Any other stored value → `automate`.** Legacy values in the wild
  (`trial`, `free`, …) therefore keep everything they had today — no
  existing user loses a feature. Note the database column default is
  still `'trial'` (shared with the live app); a settings row created
  outside onboarding resolves through the same legacy rule.

### Daily queue cap (Post plan — added 2026-10-26)

Matthew's rule: **Post is manual-posting only, capped at 5 vehicles
queued per day.** Automate and Group have no tier cap. The single
source of truth is the `TIER_DAILY_POST_CAP` map in `index.html`
(`{ post: 5, automate: null, group: null }`), and the pure function
`effectiveDailyPostAllowance(tier, userLimit, billingStatus,
isOwner)` (in the PURE ACCESS LOGIC block) resolves what an account
may queue today:

- **trialing → 1** (the trial rule — strictest, wins outright; the
  trial's own gate and counting are unchanged).
- **owner (not previewing) → their own `daily_post_limit`**,
  untouched, per the hard rule below. The caller passes the
  exemption flag OFF while any owner preview (tier or billing) is
  active, so previewing Post shows the cap exactly as a Post
  customer gets it.
- **Post → `min(daily_post_limit, 5)`**; an unlimited own limit
  (999/unset) collapses to 5.
- **Automate / Group → their own `daily_post_limit`** as before
  (999 stays unlimited).

Enforcement sits at the two post-queue insert paths, in the same
place as the trial cap: single-car `enqueueMarketplaceCar` and the
bulk queue both run `trialQueueGate` → **`postPlanQueueGate`** →
`checkDailyLimit` (the user's own safety limit) → insert. The plan
gate counts with the shared cap counter
(`getTrialQueueUsedToday` — distinct VINs across today's non-failed,
non-delete queue rows UNION today's posted cars; see the counting
paragraph under "Trial mode in the app") and is
all-or-nothing like the trial gate: a bulk selection that would pass
the cap queues nothing and shows the notice. The gate fires **only
when the plan cap is the binding limit** — a Post user whose own
safety limit is at or below 5 is governed by that limit, and
`checkDailyLimit`'s "raise your limit" message is the truthful one
for them; when the plan binds, the notice (the `planGateModal`,
same plain style as the other plan notices, no prices) says:
"You've reached the Post plan's limit of 5 queued posts per day.
The Automate plan lifts this cap — your own daily posting limit
still applies there. You can queue more cars tomorrow, or switch
plans in Settings."

The **safety counter shows the effective allowance** as its
denominator everywhere (`refreshSafetyCounter` and `checkDailyLimit`
both render `currentDailyPostAllowance()`): a Post user with a
personal limit of 10 sees "N of 5 today"; with a personal limit of
3, "N of 3 today"; during the trial the counter reads against 1.
The ribbon label, the Safety modal counter, and the mobile header
summary (which mirrors the ribbon label) all agree.

Scope note: this caps **queueing from the app**, which is the only
posting a Post account can do — auto-posting is an Automate feature
the tier gates already deny, so there is no scraper-side hole for
this rule. (Server-side enforcement in general remains the phase-2
item listed at the bottom.)

### What each plan includes — PLAN_DETAILS (added 2026-10-26)

Matthew's rule: when someone is picking between the free trial, the
1st tier and the 2nd tier, they must know **exactly** what each one
gives them — no vague card copy. So plan descriptions now live in
ONE config in `index.html`: **`PLAN_DETAILS`** (next to
`TIER_FEATURES`), with an entry per plan (`trial` / `post` /
`automate` / `group`) holding its display name, price label, one-line
tagline, and a 13-row feature list of `{ label, included }` entries
(the daily-cap row carries a `value` instead of a check):

| Row | Trial | Post | Automate | Group |
|---|---|---|---|---|
| Inventory sync & workspace | ✓ | ✓ | ✓ | ✓ |
| Manual Marketplace posting | ✓ | ✓ | ✓ | ✓ |
| Queued posts per day | **1 per day** | **5 per day** | No plan cap — your own safety limit | No plan cap — your own safety limit |
| AI listing copy | — | ✓ | ✓ | ✓ |
| Auto-post new arrivals | — | — | ✓ | ✓ |
| Auto delete & repost | — | — | ✓ | ✓ |
| TikTok, Instagram & Facebook Page posting | — | — | ✓ | ✓ |
| Luca AI Assistant + Prospects | — | — | ✓ | ✓ |
| Customer Wishlist | — | — | ✓ | ✓ |
| Trade Appraisals | — | — | ✓ | ✓ |
| Intro videos | — | — | ✓ | ✓ |
| AutoLaunch Pay | — | — | — (add-on available) | ✓ |
| Teams & multiple users | — | — | — | ✓ |

The matrix mirrors the enforcement truth, it doesn't restate it: the
included flags follow `TIER_FEATURES` (a capability is included
exactly when the plan's tier meets its minimum tier; the trial's
column follows `TRIAL_ALLOWED_FEATURES`), and the cap values follow
`TIER_DAILY_POST_CAP` (Post 5; Automate/Group none) plus the trial's
1-per-day rule. The trial entry also carries the note line: "No card
needed. When the trial ends, pick a plan to keep posting."

Every surface renders from this config through the one shared
renderer, `planFeaturesHtml(planKey)` (emerald ✓ / muted — / the cap
value in bold):

- **Signup choice gate** — the trial card (`renderSignupTrialCard`)
  and both buy cards (`renderPurchaseCards`): tagline + full
  checklist, so a brand-new user compares all three options row by
  row before choosing.
- **Purchase gate** — the same buy cards.
- **Settings → Plans tab** — the same buy cards in the billing block, and
  the tier list (`renderPlanPanel`) now renders each plan's card
  from `PLAN_DETAILS` with the same checklist HTML; during the trial
  the trial card leads the list marked "Your plan".

Retired into `PLAN_DETAILS` (they were separate hand-written copies
of the same truth and could drift): `TIER_INFO`, `BILLING_PLAN_COPY`,
and `BILLING_PRICES`. Plan names in the gate notices
(`requireTier`) and the account modal read `PLAN_DETAILS` too.
Automate has a `PLAN_DETAILS` entry for the Plan panel only — the
gates still sell **Post and Group only** (Matthew's spec), so
Automate carries no price and renders no Buy card anywhere.

### Owner exemption (hard rule)

Matthew's account (`40a95557-504a-460f-a891-462bb2b4f25c`) and
Jourdan's account (`9cdba37e-ac31-464d-92b9-0745772fbf00`) are in the
`OWNER_USER_IDS` constant and **always pass every gate**, regardless of
their stored `plan_tier`. The Settings → Plans tab shows owners an extra
"preview the app as" select so they can test the gates; the preview is
a **per-device localStorage override only** (`autolaunch_owner_test_tier`)
— it never writes to the database, so the exemption itself can never be
lost by testing.

### Enforcement level (honest note)

This is UI-level gating: the buttons, pages and switches are locked.
The data layer is not yet tier-aware (RLS doesn't know about tiers, and
the nightly scraper's auto-post pass reads its own settings columns).
That's fine for bones and for testing how the plans feel; real
enforcement belongs to the paywall build (below).

One scraper consequence to know: a `post`-tier user who somehow has
auto-delete-on-exit already on file keeps that scraper behavior (the
app only gates enabling changes from the UI). No current user is in
that state.

---

## Email verification

### Supabase Auth config change (project Phantom, shared with live)

Applied via the Management API, `PATCH /v1/projects/{ref}/config/auth`,
on 2026-10-26:

| Field | Before | After |
|---|---|---|
| `mailer_autoconfirm` | `true` (no verification) | **`false` — "Confirm email" ON** |
| `site_url` | `http://localhost:3000` (leftover default) | `https://mdemoss-bdc.github.io/AutoLaunch/` |
| `uri_allow_list` | empty | live app URL, live `index.html`, rebuild URL, rebuild `index.html`, `https://mdemoss-bdc.github.io/AutoLaunch/**`, and `http://localhost:3000` (kept from the old site_url so nothing implicit was removed) |

Safe to enable because all 5 existing auth users were already
email-confirmed — nobody was locked out, and all 5 were re-verified
intact after the E2E below.

### App flow (rebuild)

- Sign-up passes `emailRedirectTo` = the app page the user signed up
  from. If sign-up returns no session, the auth card shows a persistent
  **"Check your email"** panel (address + a **Resend confirmation
  email** button calling `supabase.auth.resend`) instead of a dead end.
- Signing in with an unconfirmed account is intercepted
  (`email_not_confirmed`) and shows the same panel with resend — never
  the raw error.
- The confirmation link lands back on the app; the Supabase client is
  initialized with no options object, so `detectSessionInUrl` stays at
  its default **true** and the returned session is picked up by the
  existing `onAuthStateChange` → `startAppForUser` path.

### E2E evidence (2026-10-26, disposable user, deleted after)

Using `matthewdemoss+verifytest@gmail.com` through the real Auth API
with the rebuild's redirect:

1. Sign-up → 200, user created, **session: null** (confirmation is on).
2. Sign-in before confirming → **400 "Email not confirmed"** (the exact
   condition the app maps to the friendly panel).
3. Confirmation link followed (retrieved via the Admin API
   `generate_link` — this agent had no inbox access; the Gmail
   connector token isn't available to subagents) → 303 redirect
   carrying `access_token`/`refresh_token`; the token authenticated
   `GET /auth/v1/user` (200, correct account, `email_confirmed_at`
   set); SQL confirmed the same and the token consumed.
4. Password sign-in after confirming → **200, session issued**.
5. Cleanup: user deleted via Admin API; zero settings rows existed for
   it; final check — exactly the 5 original accounts, all confirmed.

Two findings from the E2E:

- **Resend works but Supabase's built-in mailer is very tight.** The
  resend endpoint answered 429 `over_email_send_rate_limit` — first the
  per-address ~60-second cooldown, then the project quota after only a
  couple of test emails. Two signup emails did reach Matthew's inbox
  (one per E2E attempt). A resend success (200) could not be captured
  inside the quota window; the endpoint, request shape, and app wiring
  are verified — delivery throttling is the built-in sender, exactly
  the known limitation. **Custom SMTP is required before real public
  signups.**
- **`generate_link` test links always redirect to `site_url`** in this
  GoTrue version (proved with three different allow-listed redirect
  targets, including a different host) — so generated links land on
  the live app root, which has identical session-landing behavior. The
  emailed links use the redirect captured at sign-up (passed by the
  app via supabase-js), which is a different code path; it could not be
  observed without inbox access.

---

## Trial + Billing (built 2026-10-26, rebuild only)

Matthew's spec: new accounts get a **5-day free trial**, **IP-locked**
to one trial per IP; during the trial they may **pull inventory and
queue a post for 1 car per day**; after that they **must buy** — the
purchase screen offers the lowest tier (**Post, $75/mo**) or the
highest tier (**Group, $100/mo**), each described in plain language.
Billing requirements: the monthly charge recurs on the **same day of
the month** the subscription starts, and users can **cancel in-app**.

### State machine (user_settings.billing_status)

| Value | Meaning | App behavior |
|---|---|---|
| `NULL` | Not yet decided (new signup) — or a row predating billing | Pre-cutoff account: app calls `trial-start` once on load, resolved server-side. Post-cutoff signup: the **signup choice gate** (below) — nothing is called or written until the user picks trial or plan |
| `trialing` | In the 5-day trial (`trial_ends_at` is the clock) | Trial mode (below) until the window passes, then the purchase gate |
| `trial_blocked` | This network's trial was already used by another account | Purchase gate immediately, no trial |
| `active` | Paid subscription — or a grandfathered account | Normal tier behavior (`plan_tier` decides features) |
| `expired` | Trial ended unused, or a subscription ended (webhook) | Purchase gate |

Grandfathering is absolute: every settings row that existed when the
system shipped was backfilled to `active` (2 rows — Matthew + Jourdan),
and `trial-start` maps any account created before 2026-10-26 to
`active` as well. Owners are exempt regardless, as always.

### The trial (trial-start Edge Function)

Called by the app on sign-in when `billing_status` is NULL —
automatically for pre-cutoff accounts; for post-cutoff signups only
when they pick the trial on the signup choice gate (below).
Idempotent — a decided account gets its status back unchanged.

1. Account created before 2026-10-26 → `active` (grandfathered).
2. Otherwise the client IP (`x-forwarded-for` first entry, fallback
   `cf-connecting-ip`) is hashed as SHA-256(salt : IP) with the
   `TRIAL_IP_SALT` function secret. The raw IP is never stored or
   logged; only the salted hash lands in `trial_ip_claims` (RLS on,
   **no policies** — service-role access only).
3. Hash already claimed by a **different** account →
   `trial_blocked`. Otherwise the claim is recorded and the account
   gets `trialing` with a 5-day window.
4. **Fail-open:** no IP header (or no salt configured) → the trial is
   granted *without* a claim. A missing header must never lock out a
   legitimate user.

**Shared-IP caveat (known, accepted):** a dealership's staff share one
public IP behind the store's NAT, so an IP lock means the *second*
person signing up from the same store network gets "a trial was
already used from this network" instead of a trial. That's the
anti-abuse tradeoff Matthew chose; the gate copy says it plainly.

Two legacy wrinkles. The first is harmless because the state
machine reads `billing_status` only: the DB still defaults
`plan_tier` to `'trial'` on fresh rows (resolves to `automate`, but
a trialing/blocked account never reaches tier features, and a
purchase writes the real tier explicitly via the webhook). The
second was a trap and was fixed the same day (choice gate, below):
`trial_ends_at` carried a legacy default of `now() + 30 days`, so a
fresh row *displayed* a 30-day window until `trial-start` overwrote
it with the real one. Its default is now `now() + '5 days'`
(record: `supabase/migrations_draft/trial_default_5day_APPLIED_2026-10-26.sql`),
so even an undecided row shows the true 5-day shape; `trial-start`
still writes the authoritative window when it decides. Note the
Supabase gateway decides which IP the function
sees — from Luna's sandbox that's a rotating egress pool, which is
why the E2E's block case arrived via a shared egress IP rather than a
spoofed header; for a real browser the first `x-forwarded-for` entry
is the user's public IP, which is what the lock is designed around.

### Signup choice gate (added 2026-10-26)

Matthew's follow-up call: a new signup should **choose** — start the
5-day free trial, or pick a membership level right away — instead of
the trial starting silently on first load.

- **Who sees it:** a signed-in, non-owner account created on/after
  2026-10-26T00:00:00Z whose `billing_status` is still NULL (the pure
  `needsSignupChoice` decision in the app). Pre-cutoff NULL accounts
  never see it — they keep the automatic `trial-start` call, which
  grandfathers them to `active`. Owners never see it.
- **What it is:** a non-dismissible full-screen overlay
  (`#signupChoiceOverlay`, in `MODAL_CLOSE_DENY`, same styling as the
  purchase gate, sign-out link included). Path one: **Start my 5-day
  free trial** — plain copy (pull inventory, queue 1 car per day, no
  card needed; when the trial ends you pick a plan) — runs the same
  `trial-start` call the automatic flow used to make, then
  re-resolves: `trialing` closes the gate into trial mode (banner +
  days left); `trial_blocked` hands over to the purchase gate's
  blocked explanation with only the plan cards; `active` closes the
  gate. A failed call leaves the status NULL and the gate up, with a
  retry note. Path two: **Choose a plan now** — the same Post $75 /
  Group $100 cards and `startCheckout` behavior as the purchase gate
  (until Stripe keys land, Buy shows the honest "Checkout opens as
  soon as billing is switched on" interim message).
- **Nothing is written until a choice is made.** Refreshing or
  closing leaves `billing_status` NULL, and the gate returns on the
  next load. Behind the gate the app resolves exactly as before
  (NULL reads as full under the tier rules) but is unreachable — the
  overlay covers it — which is the intended behavior.
- Trial mode after choosing the trial is unchanged (banner, 1/day
  cap on both insert paths, feature notices).

### Trial mode in the app

- Inventory + Sync work normally. Every post-queue insert path
  (single Post button and bulk queue) first runs `trialQueueGate()`:
  posts used today must be **< 1**, and a bulk selection of more
  than one car is refused with the trial notice. "Used today" is
  counted by `getTrialQueueUsedToday()` (UTC day) as **distinct
  VINs in the union of today's non-failed, non-delete queue rows
  and today's posted cars** (`scraped_inventory.marketplace_posted_at`
  at or after UTC midnight). The posted-cars half is load-bearing:
  the helper deletes a queue row when its job completes, so a
  queue-rows-only count resets the allowance the moment a car posts
  — the leak Matthew caught live on 2026-10-26, fixed the same day.
  A car queued and posted the same day counts once (same VIN in
  both sets during the overlap); a failed post (row 'failed', no
  posted_at) consumes nothing. The Post plan gate counts with this
  same function — there is still exactly one cap-counting method.
  *Delete* rows
  (sold/exited removals) don't consume the trial post and aren't
  gated — a trial user can always clean up their one live listing.
- All `TIER_FEATURES` features **and listing copy** answer with the
  trial notice modal ("Not in the free trial", with a View plans
  button) instead of the plan notice. `tierAllows()` itself is
  billing-aware, so every existing gate call site behaves.
- A banner over the inventory ribbon shows days left + the end date.

### Purchase gate

Expired or blocked accounts get a **non-dismissible full-screen
overlay** (it's in `MODAL_CLOSE_DENY`: Escape and backdrop taps can't
close it): the reason line, the two plan cards — **Post $75/mo**
("For one salesperson posting by hand: inventory workspace, post
queue, manual Marketplace posting, listing copy.") and **Group
$100/mo** ("Everything in Post, plus all the automation: auto-post
new arrivals, auto delete & repost, TikTok / Instagram / Facebook
Page channels, Luca AI Assistant + Prospects, Customer Wishlist,
Trade Appraisals, intro videos.") — "Renews monthly on the day you
subscribe. Cancel anytime in Settings.", and a sign-out link. The
same two cards render in the Settings → Plans tab (the "View plans" target),
which also shows the billing status, trial end date, current period
end, and — for accounts with a Stripe customer on file — the
**Manage or cancel subscription** button with the copy "Cancelling
keeps your access until the end of the paid month."

Owners get two extra preview states in the Settings → Plans tab (`trial`,
`expired`), stored in localStorage (`autolaunch_owner_billing_preview`)
exactly like the tier preview — never written to the account.

### Stripe plumbing (functions, all deployed ACTIVE)

- `billing-checkout` (JWT): `{plan}` → Stripe Checkout Session
  (mode=subscription; user id + plan in session **and** subscription
  metadata; `client_reference_id` = user id). **No
  `billing_cycle_anchor` is ever set** — Stripe's default anchors the
  monthly renewal to the subscription's start day, which is exactly
  the same-day-of-month rule. Prices come from the
  `STRIPE_PRICE_POST` / `STRIPE_PRICE_GROUP` secrets, never the app.
- `billing-portal` (JWT): Billing Portal session for the account's
  stored `stripe_customer_id` — the cancel path. Portal cancellation
  takes effect at period end; access continues until then.
- `billing-webhook` (Stripe signature verified against
  `STRIPE_WEBHOOK_SECRET`): `checkout.session.completed` → `active` +
  plan + Stripe ids + period end; `customer.subscription.updated` →
  status sync (past_due keeps access — Stripe is retrying the card;
  canceled → `expired`); `customer.subscription.deleted` → `expired`
  (this fires when a portal cancellation reaches the period end, so
  cancelling never cuts access early). If the webhook secret isn't
  set, the endpoint returns 503 and processes **nothing** — there is
  deliberately no accept-and-log mode.
- Until the Stripe secrets exist, checkout/portal return
  `503 billing_not_configured` and the app says so honestly
  ("Checkout opens as soon as billing is switched on — check back
  shortly."). No fake checkout anywhere.

**Scraper note (phase 2):** trial enforcement is app-side. The nightly
scraper's auto-post pass requires `auto_post_enabled is True`, whose
DB default is `false` and which a trial account can't switch on (the
UI gate blocks it) — so there's no auto-post hole today. One scraper
behavior *does* apply during a trial by pre-existing design:
auto-delete-on-exit defaults ON (it removes sold/exited listings,
including a trial user's one posted car if it sells). Server-side
(trial-aware RLS/scraper) enforcement remains a phase-2 item.

### Verification (2026-10-26)

- Node harness over the extracted pure access logic: **69/69** —
  owner / owner previews / active post / active group / trial day 1 /
  trial day 5 / expired (status + by date) / blocked / grandfathered
  NULL × inventory, queue, cap-at-1, gate, days-left, plus the trial
  feature set and paid-tier behavior.
- Seeded E2E against the deployed functions with disposable users
  (deleted after; the 5 real accounts verified intact, reviewer
  baseline restored): user A → `trialing` with an exact 5-day window
  + IP claim; user C (different IP) → `trialing`; user B re-tested
  after a reset landed on a shared egress IP already claimed by
  another account → **`trial_blocked`**, no claim written; repeat
  calls are idempotent; a pre-cutoff account (the TikTok reviewer)
  → `active` via the grandfather branch. Checkout → 503
  `billing_not_configured` (both plans), bogus plan → 400, portal →
  503, webhook unconfigured → 503, no-JWT calls → 401.

### Verification — choice gate + 5-day default (2026-10-26)

- DB: `information_schema` shows the `trial_ends_at` default as
  `(now() + '5 days'::interval)`; a disposable user with a bare
  `finishSetup`-shaped row read back an exact 5-day window and was
  deleted after; the 5 real accounts and both `active` settings
  rows verified untouched, and the mosescars test row still NULL
  (its trial was not started for it).
- Node harness over the edited app: **127/127** — the original
  11-state billing matrix, trial feature set, and paid-tier behavior
  unchanged (the three pre-existing pure functions are byte-identical
  to the pre-change file); a 13-case decision matrix for
  `needsSignupChoice`; and DOM-stub flows over the real extracted
  gate code: post-cutoff NULL shows the gate with both plan cards
  and invokes nothing; trial pick → `trialing` closes the gate with
  the banner at 5 days left; trial pick → `trial_blocked` hands over
  to the purchase gate with only the cards; a failed `trial-start`
  call leaves the status NULL and the gate up with a retry note;
  pre-cutoff NULL and owners never see the gate; Buy Post/Group
  invoke `billing-checkout` with the right plan and a 503 shows the
  interim message.

### Verification — Post daily cap (2026-10-26)

- Node harness over the edited app: **76/76** — the full
  `effectiveDailyPostAllowance` matrix (owner × every tier → own
  limit; trialing → 1; Post × limits 3/5/10/999/0/null → min with 5;
  Automate/Group → own limit, 999 stays 999; owner-preview-Post →
  5); the three pre-existing pure functions plus
  `getTrialQueueUsedToday`, `trialQueueGate`, `showTrialNotice`,
  `getDailyPostUsage`, and `updateSafetyCounterUI` byte-identical to
  the pre-change file (`checkDailyLimit` identical except its
  counter-display line); DOM/Supabase-stub flows over the real
  extracted gates: Post at 4 used queues the 5th, at 5 used the 6th
  is stopped with the plan notice (no prices in the copy); bulk
  stops at the allowance (3+2 in, 3+3 out); failed and delete rows
  don't consume the cap; a Post user with a personal limit of 3 gets
  silence from the plan gate (their own limit speaks); the trial
  path is untouched (plan gate steps aside, trial gate still blocks
  at 1, trial counter allowance = 1); owners are uncapped until
  they preview Post, which caps them at 5; call-site wiring asserts
  trial → plan → own-limit → insert order at both insert paths with
  exactly two plan-gate call sites; and a full-file parse of the
  inline script.

### Verification — plan details consolidation (2026-10-26)

- Node harness (`~/workspace/plandetails-work/harness.mjs`):
  **201/201** — Parts 1–3 are the choice-gate regression suite
  (billing state matrix byte-compared pure functions,
  `needsSignupChoice` matrix, DOM-stub gate flows incl. Buy →
  `billing-checkout` with the right plan and the 503 interim
  message) with only its extraction set updated for the retired
  constants; Part 4 asserts the plan truth: identical 13-row label
  sets in identical order across trial/post/automate/group; every
  `TIER_FEATURES` capability included exactly when the plan's tier
  meets its minimum (trial column matches `trialFeatureAllowed`);
  cap rows read exactly "1 per day" / "5 per day" (=
  `TIER_DAILY_POST_CAP.post`) / the no-plan-cap text; Pay excluded
  on Post, add-on-noted on Automate, included on Group; prices
  $75/$100 in config; and rendering sameness — the Settings → Plans tab
  HTML embeds `planFeaturesHtml(plan)` byte-for-byte for the same
  plan the gates render, in both the active and trialing states,
  with the trial card leading during the trial.
- Regression: the billing harness (**69/69**) and the Post-cap
  harness (**76/76**) pass unchanged against the edited file.
  Full-file inline-script parse clean.

### Verification — cap counting leak fix (2026-10-26)

- The leak: `getTrialQueueUsedToday` counted live queue rows only,
  and the helper deletes a queue row when its job completes — so the
  trial's 1/day and Post's 5/day both reset the moment a car posted
  (proven live: Matthew's posted trial Sentra row existed at 17:37
  EDT with status 'posted', was gone by 17:49, and a refresh let a
  second car queue). Fixed by counting distinct VINs across today's
  queue rows UNION today's posted cars (`marketplace_posted_at`),
  the same durable source `getDailyPostUsage` already used for the
  safety counter — which is why the counter honestly read "1 of 1"
  while the gate leaked. `checkDailyLimit` / `getDailyPostUsage`
  needed no change: their usage count was already the posted-aware
  union (only their day boundary differs — local midnight vs the
  gates' UTC day — which predates this fix and is unchanged).
- Node harness (`~/workspace/capfix-work/harness.mjs`): sequence
  tests over the real extracted counter and both real gates —
  queue car A (count 1) → A posts, its posted_at lands and its
  queue row is deleted (count still 1) → the trial gate blocks
  car B, and the Post gate counts A toward the 5 (four more queue,
  the sixth is refused with the plan notice); a failed post
  consumes nothing and the next queue is allowed; delete rows are
  ignored; N distinct cars count N; the same VIN queued twice —
  including once per channel — counts once; yesterday's post does
  not count; a car queued yesterday and posted today does. Every
  neighboring function (`trialQueueGate`, `postPlanQueueGate`,
  `currentDailyPostAllowance`, `checkDailyLimit`,
  `getDailyPostUsage`, `showTrialNotice`, the pure access block)
  is byte-identical to the parent build — the counter is the only
  change. Regression: plan-details harness **201/201**, billing
  harness **69/69**; the Post-cap harness passes 75/76, the single
  non-pass being its byte-identity assertion on
  `getTrialQueueUsedToday` itself — the function this fix rewrites —
  whose behavior the sequence harness re-verifies directly.
  Full-file inline-script parse clean.

### What remains to take real money

1. ~~Connect Stripe~~ — done 2026-10-26 (account activated; products
   created: AutoLaunch Post `price_1UUtXgA3zjwds4H07Z7dfuJr` $75/mo,
   AutoLaunch Group `price_1UUtXlA3zjwds4H0QRlUpA9f` $100/mo).
2. Set the Phantom function secrets: `STRIPE_SECRET_KEY`,
   `STRIPE_PRICE_POST`, `STRIPE_PRICE_GROUP`, `STRIPE_WEBHOOK_SECRET`
   (the secret key comes from Matthew via the Secure Vault flow).
3. Register the webhook endpoint in the Stripe dashboard
   (`https://tdsipiltwajwhzgjsupx.supabase.co/functions/v1/billing-webhook`)
   for `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`; its signing secret is the
   `STRIPE_WEBHOOK_SECRET` above. Also confirm the Billing Portal is
   enabled in Stripe settings (the cancel button depends on it).
4. Test one real checkout end-to-end (trial user → pay → webhook
   flips to `active` → portal cancel → `expired` at period end).

## What remains for the real paywall

- Custom SMTP so confirmation/resend email isn't throttled.
- Server-side enforcement phase 2: tier/trial-aware RLS and/or scraper
  checks, plus changing the `plan_tier` column default away from
  `'trial'`.
- Team features for `group` (the `teams` feature key is reserved in
  `TIER_FEATURES`).
- Promoting any of this from the rebuild to the live app — a separate,
  explicitly approved step.
