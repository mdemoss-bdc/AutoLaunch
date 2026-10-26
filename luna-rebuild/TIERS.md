# AutoLaunch Plans (tiers) + Email Verification — rebuild notes

Built 2026-10-26. **Bones only:** tier gating and the email-confirmation
flow exist; there are no prices, no checkout, and no payment code
anywhere yet.

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

## What remains for the real paywall

- Prices + a decision on trials (none exist yet).
- Stripe (or equivalent) checkout + webhooks writing `plan_tier`.
- Custom SMTP so confirmation/resend email isn't throttled.
- Server-side enforcement: tier-aware RLS and/or scraper checks, plus
  changing the `plan_tier` column default away from `'trial'`.
- Team features for `group` (the `teams` feature key is reserved in
  `TIER_FEATURES`).
- Promoting any of this from the rebuild to the live app — a separate,
  explicitly approved step.
