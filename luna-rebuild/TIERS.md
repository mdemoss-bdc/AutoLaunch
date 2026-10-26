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
| `post` | **Post** | The manual core: inventory workspace, post queue, manual Marketplace posting, listing-copy ✨ |
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

### Owner exemption (hard rule)

Matthew's account (`40a95557-504a-460f-a891-462bb2b4f25c`) and
Jourdan's account (`9cdba37e-ac31-464d-92b9-0745772fbf00`) are in the
`OWNER_USER_IDS` constant and **always pass every gate**, regardless of
their stored `plan_tier`. Settings → Plan shows owners an extra
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
| `NULL` | Not yet decided (new signup) — or a row predating billing | App calls `trial-start` once on load; resolved server-side |
| `trialing` | In the 5-day trial (`trial_ends_at` is the clock) | Trial mode (below) until the window passes, then the purchase gate |
| `trial_blocked` | This network's trial was already used by another account | Purchase gate immediately, no trial |
| `active` | Paid subscription — or a grandfathered account | Normal tier behavior (`plan_tier` decides features) |
| `expired` | Trial ended unused, or a subscription ended (webhook) | Purchase gate |

Grandfathering is absolute: every settings row that existed when the
system shipped was backfilled to `active` (2 rows — Matthew + Jourdan),
and `trial-start` maps any account created before 2026-10-26 to
`active` as well. Owners are exempt regardless, as always.

### The trial (trial-start Edge Function)

Called by the app on sign-in when `billing_status` is NULL.
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

Two legacy wrinkles, both harmless because the state machine reads
`billing_status` only: the DB still defaults `plan_tier` to `'trial'`
on fresh rows (resolves to `automate`, but a trialing/blocked account
never reaches tier features), and `trial_started_at` /
`trial_ends_at` carry legacy defaults (`now()` / `now() + 30 days`)
that a fresh row shows until `trial-start` writes the real 5-day
window. Note the Supabase gateway decides which IP the function
sees — from Luna's sandbox that's a rotating egress pool, which is
why the E2E's block case arrived via a shared egress IP rather than a
spoofed header; for a real browser the first `x-forwarded-for` entry
is the user's public IP, which is what the lock is designed around.

### Trial mode in the app

- Inventory + Sync work normally. Every post-queue insert path
  (single Post button and bulk queue) first runs `trialQueueGate()`:
  posts queued today (UTC day, non-failed — the `getDailyPostUsage`
  counting semantics) must be **< 1**, and a bulk selection of more
  than one car is refused with the trial notice. *Delete* rows
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
same two cards render in Settings → Plan (the "View plans" target),
which also shows the billing status, trial end date, current period
end, and — for accounts with a Stripe customer on file — the
**Manage or cancel subscription** button with the copy "Cancelling
keeps your access until the end of the paid month."

Owners get two extra preview states in Settings → Plan (`trial`,
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
