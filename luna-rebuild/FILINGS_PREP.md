# Filings Prep — Meta App Review (Instagram) + TikTok Direct Post Audit

One-sitting checklists for the two platform filings only Matthew can
submit. Facts are grounded in this repo's own `CHANNELS.md`; where a
dashboard's exact wording may have drifted since, the checklist says
what to look for rather than inventing a label. **No timelines or
approval guarantees are promised anywhere in this document** — review
durations and outcomes are the platforms' to decide, and neither
filing should be described to users as approved until it actually is.

Shared assets (prepare once, used by both filings):

- [ ] **Privacy policy URL:** publish `privacy.html` with the app
      (GitHub Pages) and use its URL:
      `https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/privacy.html`
      — and replace its `[CONTACT EMAIL]` placeholder with Matthew's
      business contact email first; reviewers require a working
      contact and will visit this page.
- [ ] **App icon:** the approved AutoLaunch shield/bolt mark
      (`luna-rebuild/icons/logo-mark-512.png`; export whatever size
      each dashboard asks for).
- [ ] **Screencast(s):** a screen recording of the real posting flow,
      end to end, in the real app — see each filing's specifics
      below. Record with a test account; never record real customer
      data.

---

## A. Meta App Review — Instagram content publishing

### Ground truth (from CHANNELS.md)

- Instagram posting in AutoLaunch is server-side via the Instagram
  Content Publishing API, from Matthew's Meta app: two-step publish
  (create a media container from a public HTTPS media URL, poll until
  processed, publish), photo carousels and/or Reels.
- **Meta App Review for the content-publish permission + Advanced
  Access is required before OTHER users' accounts can post** — not
  just Matthew's own test accounts. Until Advanced Access is granted,
  only accounts with a role in the Meta app (Matthew's own test
  accounts) can use it.
- The user's Instagram account must be a Professional
  (Business/Creator) account; onboarding checks this.
- API-published posts are capped per 24h per account (design ceiling
  ~50/day), no licensed music in API Reels, and posts can't be edited
  after publish — context for the "how does your app use this?"
  answers, not filing blockers.

### What to file

- [ ] In the Meta app: request the Instagram content publishing
      permission (the permission that lets the app publish to a
      user's Instagram account — look for the content publishing /
      `instagram_content_publish` permission in the app's permissions
      list) **with Advanced Access**.
- [ ] App Review submission for that permission, with the use-case
      description, screencast, and reviewer test instructions below.
- [ ] If the dashboard asks for business verification for Advanced
      Access, complete it (only Matthew can — see "Only Matthew").

### Where

- **Meta for Developers** (developers.facebook.com) → **My Apps** →
  the AutoLaunch Meta app → **App Review** → **Permissions and
  Features** (request the permission + Advanced Access there), and
  the app's **Settings → Basic** for app icon, privacy policy URL,
  and category.

### Assets needed

- [ ] Screencast: sign in to AutoLaunch with the test account →
      connect Instagram (Meta login + permission grant visible on
      screen) → queue a vehicle → the carousel/Reel actually
      publishing to the test Instagram account → show the published
      post on Instagram. Narrate or caption each step; reviewers
      must be able to see the permission being used, not just the
      result.
- [ ] Reviewer test credentials/instructions: a test AutoLaunch
      account + a test Instagram Professional account the reviewer
      can use, with step-by-step instructions to reproduce the flow
      in the screencast. Create these before submitting.
- [ ] Privacy policy URL (shared asset above).
- [ ] App icon (shared asset above).

### Questions they will ask (draft answers from the real product)

- *"How does your app use this permission?"* — AutoLaunch is an
  inventory syndication tool for car dealerships and independent
  sales reps. A user connects their own Instagram Professional
  account once; when their vehicles become eligible, AutoLaunch
  publishes a photo carousel (or Reel) of that vehicle to that user's
  own account, with a caption generated from the vehicle and the
  user's own posting preferences. Publishing happens only for the
  connected user's own account and inventory.
- *"Why does the app need to publish rather than only read?"* —
  Publishing is the product: dealers use AutoLaunch so a car entered
  once is posted to their sales channels. There is no other use of
  the permission.
- *"Walk through the user flow."* — the screencast + test
  instructions above; include where the user connects, where they
  can disconnect, and how a post can be deleted (delete/repost — API
  posts cannot be edited).
- Data-handling questions: answer from `privacy.html` (data handled:
  account email, dealership inventory, queue jobs; never sold; no
  third-party analytics).

### Only Matthew can do these

- [ ] Create/own the Meta app and accept Meta's developer terms.
- [ ] Identity and business verification, if Meta requires it for
      Advanced Access.
- [ ] Provide the reviewer test accounts (his own test Instagram
      Professional account).
- [ ] Final submit of the App Review request, and responding to any
      reviewer follow-up.

### Until it passes

Ship Instagram as available to Matthew's own test accounts only
(standard access scope); do not promise other users Instagram posting
until Advanced Access is granted — that gate is exactly what
CHANNELS.md records.

---

## B. TikTok audit — Content Posting API, Direct Post

### Ground truth (from CHANNELS.md)

- TikTok posting in AutoLaunch is server-side via the TikTok Content
  Posting API, **Direct Post**, `video.publish` scope: AutoLaunch
  generates the vehicle's 9:16 video first, queries `creator_info`
  before EVERY post for that account's allowed privacy levels (never
  hardcoding PUBLIC), and posts with an allowed level.
- **THE GATE: until TikTok audits and approves Matthew's API client,
  posts are forced private (`SELF_ONLY` visibility) and the client
  is limited to a handful of creators/day.** Public auto-posting
  unlocks only after audit approval.
- Tokens: access token ~24h, refresh token ~365 days; the backend
  refreshes automatically.
- CHANNELS.md's instruction stands: **file the audit EARLY (it is the
  long pole); build and test everything in private mode meanwhile;
  do not promise users public TikTok posting before the audit
  passes.**

### What to file

- [ ] TikTok developer app/client registered for the Content Posting
      API with the Direct Post capability and the `video.publish`
      scope.
- [ ] The audit (app review) application for that client, requesting
      approval for Direct Post with public visibility — including
      the use-case description, the demo/screencast, and the privacy
      policy URL.
- [ ] A working demo of the unaudited flow first: a real Direct Post
      landing as `SELF_ONLY` on a test creator account. The audit
      expects a demonstrable integration, not a mock-up.

### Where

- **TikTok for Developers** (developers.tiktok.com) → **Manage
  apps** → the AutoLaunch app → the Content Posting API / Direct
  Post configuration (scopes and posting settings live there), and
  that dashboard's **app review / audit submission** flow for the
  client. If the dashboard's navigation labels differ from the above,
  follow the dashboard's own "submit for review/audit" path for the
  Content Posting API product — the deliverables below are what it
  will ask for regardless of label.

### Assets needed

- [ ] Screencast/demo video: sign in to AutoLaunch → connect TikTok
      (`video.publish` authorization visible) → queue a vehicle →
      AutoLaunch generates the vehicle video → Direct Post runs →
      the post appears on the test TikTok account (as `SELF_ONLY`
      pre-audit — show the privacy level honestly; that limitation is
      the known pre-audit state, not something to hide) → show the
      `creator_info` privacy-level check in the flow if the UI
      surfaces it.
- [ ] Privacy policy URL (shared asset above — the same published
      `privacy.html`).
- [ ] App icon (shared asset above) + the app name/description as
      they will appear to users on the TikTok authorization screen.
- [ ] The domain story for pull-from-URL, if that method is used:
      media must come from a domain Matthew owns/verifies in the
      TikTok dashboard. If the integration uploads the file directly
      instead, say so in the application and skip this.

### Questions they will ask (draft answers from the real product)

- *"What does your app post, and on whose behalf?"* — Short vehicle
  videos generated from a dealership's own inventory photos (year/
  make/model, price, mileage, dealership name, call to action), posted
  only to the TikTok account the user themselves connected, only for
  vehicles in that user's own AutoLaunch queue.
- *"How do you choose the privacy level?"* — Before every post the
  backend queries `creator_info` for that account and posts with a
  level the account is allowed; PUBLIC is never hardcoded. Pre-audit,
  posts are `SELF_ONLY` as TikTok requires.
- *"How does a user authorize and revoke?"* — One connect click +
  TikTok login (`video.publish`); revocation by the user in TikTok
  or by disconnecting in AutoLaunch, after which the stored tokens
  are no longer used/refreshed.
- *"Content disclosures?"* — The Direct Post call sets the
  disclosure/branded-content flags the API requires for dealership
  (commercial) content; describe the actual settings the
  implementation sends, and update this answer if they change.
- Data-handling questions: answer from `privacy.html`.

### Only Matthew can do these

- [ ] Create/own the TikTok developer account and app, and accept
      TikTok's developer terms.
- [ ] Identity/business verification, if TikTok requires it.
- [ ] Provide the test TikTok creator account used in the demo.
- [ ] Final submit of the audit application, and responding to any
      auditor follow-up.

### Until it passes

TikTok stays in private mode: posts are `SELF_ONLY`, creator volume
is limited, and user-facing copy must say exactly that. The switch
to public posting happens only when the audit approval is actually
in hand.
