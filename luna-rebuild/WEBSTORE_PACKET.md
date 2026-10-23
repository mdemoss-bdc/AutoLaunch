# Chrome Web Store Submission Packet — AutoLaunch Vehicle Assistant

Everything needed to submit the AutoLaunch Chrome extension
(`luna-rebuild/extension/`, currently v2.1.10) to the Chrome Web Store
as an **UNLISTED** listing — except the one step only Matthew can do:
creating the Chrome Web Store developer account (one-time $5 fee, paid
to Google, under Matthew's own Google account).

Unlisted means: the listing does **not** appear in Web Store search or
categories. It is reachable only by its direct link, which AutoLaunch
will show inside the app (the in-app Extension page already has a
clearly-marked placeholder slot for it). That is the intended
distribution: AutoLaunch users install from the app, nobody else needs
to find it.

---

## 1. Listing copy (paste-ready)

### Name

```
AutoLaunch Vehicle Assistant
```

(This is the manifest `name` today — keep the listing name identical.)

### Short description (manifest `description`, ≤132 chars)

Current manifest text (124 characters):

```
Automated Facebook Marketplace helper for AutoLaunch users.
```

Suggested fuller short description for the listing's summary field
(verify the character count in the dashboard before submitting; trim
if the dashboard's limit differs):

```
Posts your AutoLaunch vehicle queue to Facebook Marketplace — fills the listing form, uploads photos, and can publish or wait for your click.
```

### Detailed description

```
AutoLaunch Vehicle Assistant is the posting helper for AutoLaunch, the
inventory syndication app for car dealerships and independent sales
reps. AutoLaunch itself has no way to create Facebook Marketplace
vehicle listings — Marketplace offers no listing API — so this
extension does that job inside your own Chrome, in your own signed-in
Facebook session.

WHAT IT DOES

• Watches your AutoLaunch post queue (only your own queue — the app
  hands the extension your signed-in AutoLaunch session).
• For each queued vehicle, opens Facebook Marketplace's Create Vehicle
  form and fills it in: year, make, model, price, mileage, condition,
  body style, colors, clean title, a generated description, and the
  vehicle's photos, in order.
• Confirm mode (the default): fills everything, then stops. You
  review and click Publish yourself.
• Full Auto mode (an AutoLaunch setting you choose): the extension
  clicks through and publishes, then verifies the listing actually
  appeared on your Selling page before marking it posted.
• Deletes listings when you ask: "Remove from Facebook" in AutoLaunch
  (or marking a posted car Sold) queues a removal; the extension finds
  the exact listing — matching year, make, model AND price — on your
  Selling page and deletes it, then verifies it is gone.
• Respects your AutoLaunch daily posting limit and uses human-paced
  delays. If Facebook shows a login wall, checkpoint or CAPTCHA, the
  job stops and reports honestly — it never tries to push through,
  and it never marks a vehicle posted unless the publish (or delete)
  was actually confirmed on Facebook.

WHAT IT NEEDS FROM YOU

• An AutoLaunch account, signed in to AutoLaunch in the same Chrome.
• Signed in to Facebook in Chrome, with Chrome left open while it
  works. Marketplace vehicle listings are posted from a personal
  Facebook account; that is how Marketplace works.
• You stay in control: Confirm mode is the default, and every result
  (posted, removed, or failed with a reason) is written back to your
  AutoLaunch queue.

PRIVACY

The extension handles only your own AutoLaunch queue data and the
Marketplace form data for your listings. It runs no analytics, sells
no data, and sends nothing anywhere except your AutoLaunch backend
(to read your queue and report results) and Facebook (the form you
asked it to fill). Full policy: see the Privacy Policy URL in this
listing.
```

### Category suggestion

**Productivity** (fallback: Business). The extension is a work tool
for dealership staff; it is not a shopping, social, or entertainment
extension. If the dashboard's category list has drifted since this
packet was written, pick the closest work/business category offered.

### Other listing assets to prepare

- Extension icon: the AutoLaunch shield/bolt mark (source art in
  `luna-rebuild/icons/` — export the sizes the dashboard asks for).
- At least one screenshot of the extension working (optional for
  unlisted, but helps review): the AutoLaunch Extension page showing
  "Helper ready ✓", and the on-form banner during a fill.
- Privacy Policy URL: the published URL of `privacy.html` (see
  FILINGS_PREP.md — GitHub Pages URL for `luna-rebuild/privacy.html`).

---

## 2. Permission justifications (verbatim-ready)

Paste each block into the corresponding justification field in the
Chrome Web Store developer dashboard (Privacy practices / permission
justifications). They are written to match what the code actually
does at v2.1.10.

### `storage`

```
The extension stores, in chrome.storage.local on the user's own
machine only: (1) the user's AutoLaunch session handoff — their
AutoLaunch user id and their Supabase session access token, sent by
the AutoLaunch web app the user is signed into — which the service
worker uses as the Authorization credential when reading and updating
that user's own post queue; (2) the currently claimed queue job and
its state, so a job survives the MV3 service worker's idle shutdown;
and (3) a short local failure log (job id, reason, timestamp, and
form-field diagnostic metadata — never the token) used to report
honest failure reasons back to the user. Nothing in storage is
transmitted anywhere except the token's use as the Authorization
header on requests to the user's own AutoLaunch backend (Supabase).
```

### `tabs`

```
The extension opens exactly one Facebook tab per queue job it claims:
the Marketplace Create Vehicle page for a post job, or the
Marketplace Selling page for a delete job. It records the id of the
tab it opened so that, after a confirmed successful post or delete,
it can close that same tab (about 4 seconds after the success banner,
so the user can read it); failed jobs never close their tab — it
stays open as the user's evidence. It never enumerates, reads, or
closes tabs it did not open for a job.
```

### `scripting` — READ THIS BEFORE PASTING ANYTHING

Honest status at v2.1.10 (code-audited for this packet): **no code in
the extension calls `chrome.scripting` today.** All injection is
static, via the manifest's declared content scripts (the bridge on
the AutoLaunch app origin, the form filler on Facebook Marketplace
pages). A justification claiming a runtime use that does not exist
would be untrue, so there is deliberately **no paste-ready scripting
justification in this packet**.

The clean submission move is to remove `"scripting"` from
`manifest.json`'s permissions for the Web Store build (a one-word
manifest change; the extension's behaviour is unchanged, because
nothing calls it). If a future build adds a real programmatic
injection path (e.g. re-injecting the filler into the Marketplace tab
the worker opens), write the justification then, describing that
actual path, and restore the permission in the same build.

### `alarms`

```
An MV3 service worker cannot poll with setInterval (it is killed
when idle), so the extension uses a single chrome.alarms timer
(1-minute period) to check the user's AutoLaunch queue for pending
post/delete jobs. The alarm does nothing else; when no user is
signed in, when the stored session has expired, or when a job is
already running, the cycle exits immediately.
```

### `debugger`

```
Facebook's Marketplace vehicle form does not commit the Year, Make,
Model, and Price fields through ordinary DOM value-setting or
synthetic events — React-controlled inputs reset values set that way
(verified across multiple live runs of this extension: the fields
only stick when the value arrives through Facebook's own
suggestion-listbox selection or through trusted input). The
extension therefore uses the Chrome DevTools Protocol
(chrome.debugger), as a last-resort fill technique only, to send
real trusted keyboard and mouse input (Input.insertText,
Input.dispatchKeyEvent, Input.dispatchMouseEvent) to the Marketplace
form tab for those fields. It attaches only to the tab it opened for
the current job, only while filling, and detaches when the fill
sequence ends or the job finishes or fails. While attached, Chrome
shows its standard "…is debugging this browser" infobar, so the use
is visible to the user. The debugger is never attached to any other
tab, never used to read page content beyond the form interaction,
and never used while the extension is idle.
```

### Host permissions

Declared today: `https://*.supabase.co/*`, `https://*.facebook.com/*`,
`https://mdemoss-bdc.github.io/*`, `https://*/*`.

**facebook.com**

```
The extension's core function happens on Facebook Marketplace: the
content script fills the Create Vehicle form
(facebook.com/marketplace/create/vehicle) and performs requested
listing deletions on the user's Selling page
(facebook.com/marketplace/you/selling), inside the user's own
signed-in Facebook session. There is no official Marketplace listing
API; operating the form in the user's browser is the only way to
perform the user's requested posts and deletions.
```

**supabase.co**

```
AutoLaunch's backend is Supabase. The service worker reads the
signed-in user's own post queue, settings, and inventory rows from,
and writes job results back to, the AutoLaunch Supabase project
(REST API), authenticated with the user's own session token handed
over by the AutoLaunch web app. No other user's data is accessible:
the backend tables are row-level-security locked to the signed-in
user.
```

**AutoLaunch origin (mdemoss-bdc.github.io)**

```
The bridge content script runs only on the AutoLaunch web app
origin. It receives the signed-in session handoff the app posts to
its own window (user id + session token) and forwards it to the
service worker, and it carries the setup page's install-status ping
so the app can show the user whether the helper is installed and
ready.
```

**https://\*/\* (all URLs)**

```
Vehicle listing photos are hosted on the dealership's own photo CDN,
which is a different arbitrary host for every dealership (the
extension's users are many different dealers). The Facebook page
context cannot fetch those photos: dealer photo servers send no
Access-Control-Allow-Origin header, so a page fetch is CORS-blocked
(verified against real dealer CDNs). The service worker therefore
fetches the photo bytes itself — extension fetches with host
permission are not page-CORS-bound — and hands them to the content
script, which attaches them to the Marketplace form. The worker
fetches a URL only when the Facebook content script asks for one
photo from the user's own queue job, only for http(s) URLs, and the
bytes go only into that form's photo upload. Because the photo host
cannot be enumerated in advance, host access must cover arbitrary
https hosts. The extension does not browse, scrape, or read content
from these hosts — it downloads listing photos the user queued.
```

---

## 3. Single-purpose statement (paste-ready)

```
This extension has a single purpose: to carry out the signed-in
AutoLaunch user's own Facebook Marketplace vehicle posting queue —
filling (and, in the user's chosen mode, publishing) Marketplace
vehicle listings from that queue, and deleting those listings when
the user requests removal. Every permission, content script, and
network call in the extension serves that one purpose.
```

---

## 4. Data-use disclosures (for the dashboard's privacy form)

Answer the data-use questions with these facts:

- **What the extension touches:**
  - The user's own AutoLaunch queue rows (vehicle year/make/model,
    price, mileage, VIN, stock number, photo URLs, job status) and
    their AutoLaunch settings (daily post limit, Full Auto choice).
  - The user's AutoLaunch user id and Supabase session access token
    (stored locally in the extension, used only as the Authorization
    header to the user's own backend; never logged, never sold,
    never sent anywhere else).
  - Facebook Marketplace form data: the fields the extension fills on
    the Create Vehicle form and the listing cards it matches on the
    Selling page (year/make/model and price) to perform a requested
    deletion.
  - Vehicle listing photos, fetched from dealer photo CDNs and
    attached to the user's own listing.
- **What it does NOT do:** no analytics or telemetry of any kind; no
  advertising; no sale, rental, or sharing of user data with third
  parties for their own purposes; no browsing-history collection; no
  data collection from sites other than the AutoLaunch app origin,
  Facebook Marketplace pages, the AutoLaunch backend, and the photo
  URLs in the user's own queue.
- **Data certification answers:** data is used only to provide the
  extension's single purpose; it is not sold; it is not used or
  transferred for unrelated purposes; it is not used to determine
  creditworthiness or for lending purposes.
- **Remote code:** none. All code ships inside the extension package;
  nothing is fetched and executed at runtime.

## 5. Privacy policy

The listing's Privacy Policy URL points at `privacy.html` (in
`luna-rebuild/`, published with the app on GitHub Pages). That page is
the policy referenced by every statement above; keep the two in sync
if either changes.

## 6. Submission checklist

- [ ] Matthew: create the Chrome Web Store developer account
      (one-time $5 fee — only Matthew can do this).
- [ ] Decide the `scripting` permission (see its section above):
      recommended — remove it from the Web Store build's manifest,
      since no code calls it at v2.1.10.
- [ ] Package the extension: zip the **contents** of
      `luna-rebuild/extension/` (manifest.json at the zip root).
- [ ] Dashboard: create the item, upload the zip, set visibility to
      **Unlisted**.
- [ ] Paste: name, short + detailed description, category
      (Productivity), icon, screenshots.
- [ ] Paste: single-purpose statement, each permission justification,
      host-permission justifications, data-use disclosures.
- [ ] Privacy Policy URL → the published `privacy.html` URL.
- [ ] Submit for review. On approval, copy the listing's direct link
      into the in-app Extension page's "Coming soon" placeholder slot
      (that last step is a code change to `index.html`).
