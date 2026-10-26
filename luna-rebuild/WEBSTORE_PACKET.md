# Chrome Web Store Submission Packet — AutoLaunch Vehicle Assistant

**Extension version audited and packaged:** 2.1.44  
**Repository base for this refresh:** commit `150fced8`  
**Developer-account status:** Matthew has created the Chrome Web Store
developer account and paid Google's one-time $5 fee.  
**Store package:** `~/workspace/webstore/autolaunch-helper-2.1.44-store.zip`  
**Dashboard companion:** `~/workspace/webstore/CLICK_SHEET.md`

Submit this extension as an **UNLISTED** listing. Unlisted means it does
not appear in Web Store search or category browsing; it can be installed
only from its direct link. After approval, AutoLaunch will place that
link inside the app.

> **Submission blocker to clear first:** the dashboard texts in this
> packet have been refreshed for 2.1.44, but the published privacy
> policy still reflects the older posting-only extension. Update and
> republish `privacy.html` as described in §6 before pressing Submit.
> The dashboard answers must not promise practices that the linked
> policy contradicts or omits.

---

## 0. Fresh 2.1.44 code audit

This audit replaces the packet's old v2.1.10 audit. It was performed
against `luna-rebuild/extension/` at the version above.

### Manifest facts

- Manifest V3; name `AutoLaunch Vehicle Assistant`; version `2.1.44`.
- Service worker: `background.js`.
- Repository permissions: `storage`, `tabs`, `scripting`, `alarms`,
  and `debugger`.
- Host permissions: `https://*.supabase.co/*`,
  `https://*.facebook.com/*`, `https://mdemoss-bdc.github.io/*`, and
  `https://*/*`.
- The manifest has **no `icons` field and no `action` field**. A
  separate 128×128 store icon is supplied with the submission package;
  see §1.
- Content scripts:
  - `bridge.js` on the AutoLaunch app path at
    `mdemoss-bdc.github.io/AutoLaunch/*`;
  - `content.js` on Marketplace Create Vehicle, Selling, and Dashboard
    pages;
  - `chat_capture.js` on `facebook.com/messages/*`,
    `facebook.com/marketplace/inbox*`, and
    `facebook.com/marketplace/*` (the broader Marketplace match also
    covers the floating chat popup on Marketplace pages).
- `externally_connectable` is limited to
  `https://mdemoss-bdc.github.io/*`.

### API-use evidence

Counts below are literal `chrome.<api>` references in the four
JavaScript files:

| API | References | Audit result |
|---|---:|---|
| `chrome.scripting` | **0** | **Unused.** No `chrome.scripting`, `executeScript`, or programmatic CSS insertion exists in the extension JavaScript. |
| `chrome.debugger` | 6 | Used only through `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText`, for trusted input during Marketplace form filling and user-queued Messenger reply delivery. |
| `chrome.alarms` | 4 | One named one-minute alarm is created on install/startup and handled in the worker. |
| `chrome.tabs` | 13 | Used to create a job tab; query and coordinate the user's open Facebook tabs; navigate/reload a selected Facebook tab for a queued reply when necessary; and close only the tab the worker opened after a confirmed successful job. |
| `chrome.storage` | 62 | Used for the session handoff, current job, pending finish, failure metadata, and the temporary queued-reply delivery slot/claim. |

Other audit findings:

- **Store-build decision:** remove only `"scripting"` from the
  **store copy's** manifest. The repository/load-unpacked manifest is
  intentionally left unchanged by this packaging step.
- There is no `eval()`, `new Function`, `importScripts`, dynamic
  `import()`, analytics SDK, advertising SDK, or remote-code loader in
  the audited JavaScript.
- Network destinations in code are the AutoLaunch Supabase project
  (REST and its photo-proxy function), Facebook pages acted on in the
  user's session, the AutoLaunch GitHub Pages origin, and the specific
  dealer photo URLs contained in the user's own job. The photo fallback
  uses the photo-proxy on the same Supabase project; it is not a
  separate analytics or data recipient.
- The worker reads exactly these `user_settings` fields for a posting
  claim: `daily_post_limit`, `full_auto_enabled`,
  `post_delay_minutes`, `dealership_name`, `dealership_address`, and
  `include_stock`.

---

## 1. Listing copy (paste-ready)

### Name

Use the name supplied by the uploaded package:

```text
AutoLaunch Vehicle Assistant
```

### Summary (89 characters)

```text
Post queued Marketplace listings and sync your own buyer chats with AutoLaunch Prospects.
```

### Detailed description

```text
AutoLaunch Vehicle Assistant is the browser companion for AutoLaunch,
the inventory and buyer-conversation workspace for car dealerships and
independent sales representatives. It works inside your own Chrome
profile and your own signed-in Facebook session to carry out the
AutoLaunch work you direct there.

MARKETPLACE POSTING

• Watches your own AutoLaunch post queue.
• For each vehicle you queue, opens Facebook Marketplace's Create
  Vehicle form in a background tab and fills in the vehicle details,
  generated description, and photos from your AutoLaunch inventory.
• Confirm mode is the default: the helper fills the form and stops so
  you can review it and click Publish yourself.
• If you deliberately enable Full Auto in AutoLaunch, the helper
  completes the publish flow, checks that the listing appeared, and
  records the result.
• Carries out listing removals you queue in AutoLaunch and checks that
  the requested listing is gone before recording it as removed.
• Applies your AutoLaunch settings, including your daily post limit,
  posting delay, dealership name and address, and whether to include
  the stock number in the description.
• If Facebook presents a login wall, checkpoint, or CAPTCHA, the job
  stops and reports the problem. The helper does not mark a post or
  removal successful unless the result was confirmed on Facebook.

YOUR BUYER CHATS AND PROSPECTS

Facebook does not offer an API for these personal-account Marketplace
conversations, so the helper reads the Facebook pages already open in
your browser.

• When a Marketplace inbox or conversation is open, it can sync the
  visible conversation—including the buyer name, listing label, thread
  link, and visible messages—to that conversation's Prospect in your
  own AutoLaunch account.
• Automatic sync creates a new Prospect only when the visible thread
  has Marketplace evidence, such as a vehicle listing label. Unknown
  ordinary Messenger chats are not automatically turned into Prospects.
• A floating "Capture chat for Luca" button lets you deliberately add
  another open chat that you choose.
• For a conversation already in Prospects, the newest visible inbox
  preview line can be synced so the Prospect stays current.
• AutoLaunch may draft a suggested response with Luca, but Luca never
  sends a message by itself. You must review, edit if you wish, and
  choose to send the reply in AutoLaunch.
• When you queue a reply in AutoLaunch, the helper uses an open
  Facebook tab for that conversation, enters the exact text you typed
  or approved, sends it, verifies that it was accepted, and records
  whether delivery succeeded or failed. If no suitable Facebook tab is
  open, the reply stays queued.

WHAT YOU NEED

• An AutoLaunch account, signed in to AutoLaunch in the same Chrome
  profile.
• Facebook signed in in Chrome, with Chrome open while the helper is
  working.
• Marketplace vehicle listings and buyer chats are handled from a
  personal Facebook account because that is the Facebook surface on
  which they exist.

PRIVACY

The helper handles your own AutoLaunch queue, settings, vehicle and
photo data, and the Facebook conversations you sync to your own
Prospects. It contains no analytics or advertising, does not sell
personal data, and does not use the data for creditworthiness or
lending. Your Facebook password is never seen or collected by the
extension; Facebook sign-in remains between you and Facebook. See the
Privacy Policy URL in this listing for the complete policy.
```

### Category

**Productivity**

### Language

**English (United States)**

### Store icon

Upload the separate file supplied with this package:

```text
~/workspace/webstore/store-icon-128.png
```

It is 128×128 PNG. The extension manifest itself does not declare an
icon set, so do not skip the dashboard's store-icon upload.

### Screenshots Matthew must supply

Create the dashboard item and complete the text fields first. Before
final submission, add at least the first screenshot if the dashboard
requires image assets to submit:

1. **AutoLaunch Chrome Extension page showing the helper installed and
   ready.**
2. **A Marketplace Create Vehicle form while AutoLaunch is filling it
   or showing its review banner.**

Use screenshots without private buyer details where possible. The
second is helpful for review context; whether both are mandatory is
controlled by the dashboard's current validation.

### Website URL

```text
https://mdemoss-bdc.github.io/AutoLaunch/
```

### Privacy Policy URL

```text
https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/privacy.html
```

Use this URL only after the §6 privacy-policy corrections are live at
that address.

---

## 2. Single-purpose statement (paste-ready)

```text
This extension has a single purpose: to operate the signed-in
AutoLaunch user's own Facebook selling workflow in their own Chrome
session. It carries out the user's AutoLaunch Marketplace listing
queue and keeps that user's buyer conversations synchronized with
AutoLaunch Prospects, including delivering only replies the user typed
or approved in AutoLaunch. Every permission, content script, and
network request serves that purpose.
```

---

## 3. Permission justifications (paste-ready)

### `storage`

```text
The extension uses chrome.storage.local on the user's own machine to
operate between MV3 service-worker restarts and coordinate its own
content scripts. It stores: (1) the signed-in user's AutoLaunch user
ID and Supabase session access token, handed off by the AutoLaunch
app and used only as the Authorization credential for that user's own
AutoLaunch backend requests; (2) the currently claimed posting job
and its vehicle data and state; (3) a pending job-finish record if a
confirmed Facebook result occurs while the session token is expired;
(4) a short local failure log and latest-error metadata, limited to
job IDs, reasons, timestamps, and form-field diagnostics—not the
access token; and (5) a temporary outbound-reply delivery slot and
cross-tab claim containing the queued message ID, Facebook thread
reference, exact reply text the user queued in AutoLaunch, tab ID,
and timestamp. The reply slot is removed after delivery succeeds,
fails, or times out. Stored data is not used for analytics or
advertising.
```

### `tabs`

```text
The extension uses chrome.tabs for the user's own AutoLaunch work in
Facebook. For a posting or removal job, it creates one background
Facebook tab (Marketplace Create Vehicle or Selling), marks that tab
as not auto-discardable while the job runs, records its ID, and closes
only that worker-created tab after a confirmed successful result;
failed jobs leave their tab open for the user to inspect. For chat
synchronization requested from AutoLaunch and for replies the user
queues in AutoLaunch, it queries only open tabs matching
https://www.facebook.com/*, uses their IDs and URLs to select a
suitable tab, and sends that tab a message asking its already-loaded
AutoLaunch content script to run a capture or delivery. If the exact
reply thread is already open, it coordinates with that tab; otherwise
it may navigate a selected existing Facebook tab to the queued reply's
thread. If that tab does not acknowledge a delivery because its
content script is stale, the extension may reload that same tab so
the current script can complete the user-requested delivery. It does
not close user-created tabs.
```

### `alarms`

```text
An MV3 service worker cannot rely on setInterval because Chrome stops
it when idle. The extension therefore creates one chrome.alarms timer
with a one-minute period. The alarm wakes the worker to check for the
signed-in user's pending Marketplace post/removal jobs and for replies
the user has queued in AutoLaunch. If no user is signed in, the stored
session is expired, or work is already in progress, the relevant check
exits without taking action.
```

### `debugger`

```text
The extension uses chrome.debugger only to send trusted input through
the Chrome DevTools Protocol's Input domain. This is necessary in two
user-directed flows. First, Facebook's React-controlled Marketplace
vehicle form does not reliably commit some fields—such as year, make,
model, and price—when values are supplied only through ordinary DOM
value changes or synthetic events; trusted keyboard and mouse input
lets the form's own controls accept and retain the values. Second,
Messenger's composer can ignore synthetic text insertion and Enter
events, particularly in a background tab; trusted Input.insertText
and Input.dispatchKeyEvent are used to enter and send only the exact
reply the user typed or approved in AutoLaunch. The debugger attaches
only to the Facebook tab being used for the current form fill or reply
delivery, only for that interaction, and detaches when the interaction
ends or fails. While attached, Chrome displays its standard debugging
notice. The extension does not use the debugger to evaluate page
JavaScript, inspect network traffic, capture screenshots, read
unrelated page content, or operate while idle.
```

### `scripting` — not requested in the store build

Do **not** paste a justification for `scripting`. The fresh 2.1.44
audit found zero uses of the API. The supplied store ZIP's manifest
omits `scripting`; the repository manifest remains unchanged for the
existing load-unpacked development workflow.

---

## 4. Host-permission justifications (paste-ready)

If the dashboard provides one combined field, paste the four labeled
sections in order. If it provides separate fields, paste each section
under its matching host pattern.

### `https://*.facebook.com/*`

```text
Facebook host access is required for the extension's core purpose.
Declared content scripts operate on the user's own signed-in Facebook
surfaces: Marketplace Create Vehicle for posting, Marketplace Selling
and Dashboard for verification and requested removals, Messenger and
Marketplace inbox/thread pages for buyer-chat synchronization, and
Marketplace pages that contain a floating chat window. On those pages
the extension fills the requested listing form, checks the requested
post/removal result, reads visible conversation text and listing
labels for synchronization to the user's own AutoLaunch Prospects,
and enters a reply only when the user has queued that exact text in
AutoLaunch. The service worker also queries open Facebook tabs and
coordinates with those declared content scripts. Facebook provides no
API for these personal-account Marketplace listing and conversation
workflows, so performing the user's requested actions in their own
browser session is necessary.
```

### `https://*.supabase.co/*`

```text
Supabase is AutoLaunch's own backend. Using the signed-in user's own
session token, the extension reads and updates only that user's rows:
Marketplace post/removal queue entries, inventory records,
posting-related user settings, Prospects, and synchronized buyer
messages. It writes job outcomes and honest failure reasons, stores
captured conversations and inbox preview lines for Prospects, claims
one user-queued reply at a time, and records that reply's delivery
status. The same Supabase project also provides a photo-proxy
function used as a fallback for listing photos. Backend row-level
security restricts the authenticated session to the user's own data.
```

### `https://mdemoss-bdc.github.io/*`

```text
This is the AutoLaunch web application's origin. A bridge content
script on the AutoLaunch app receives the signed-in user's session
handoff (user ID and access token) from the app window and forwards
it to the extension worker. The bridge also carries the app's helper
status ping, a user-initiated Prospects synchronization request, and
a notification that the user has queued a reply, so the worker can
respond without waiting for its next alarm. The worker checks that
these requests come from a tab on this origin. This host is not used
to collect browsing history or operate on unrelated GitHub Pages
content.
```

### `https://*/*`

```text
Broad HTTPS host access is needed only to retrieve vehicle listing
photos for the user's own queued Marketplace jobs. AutoLaunch serves
dealers whose listing photos are hosted on many different dealership
and inventory-provider CDNs, so the photo hosts cannot be enumerated
in advance. The Facebook page cannot fetch many of those photos
because the photo servers do not send CORS headers that permit the
page fetch. At the Facebook content script's request for a photo in
the current job, the service worker fetches that specific HTTP(S)
URL, verifies that the response is an image and is no larger than
15 MB, and returns the bytes so the content script can attach the
photo to the user's listing. If this relay fails, the content script
may send the same photo URL to AutoLaunch's Supabase photo-proxy
function. The extension does not use broad host access to browse,
scrape, or read arbitrary websites; it retrieves only photo URLs
already contained in the user's own queue job.
```

---

## 5. Data-use disclosures

### Dashboard data categories to select

Select these categories if the dashboard presents them:

- **Personally identifiable information** — the user's AutoLaunch
  user ID; dealership name and address read from the user's settings;
  buyer names shown in Facebook conversations synchronized to the
  user's Prospects.
- **Authentication information** — the user's AutoLaunch/Supabase
  session access token, stored locally in the extension and sent only
  as the Authorization credential to the AutoLaunch backend.
- **Personal communications** — visible Facebook chat message text,
  inbox preview lines, thread references, and the exact reply text the
  user queues in AutoLaunch, together with delivery status.
- **Website content** — visible Facebook Marketplace and Messenger
  page content used for the requested function, including listing and
  conversation labels, listing/thread URLs, form values, listing
  verification content, and vehicle photos supplied for a listing.

Do **not** select health information, financial or payment
information, precise user location, general web history, or user
activity. The extension does not collect a list of pages the user
visits generally; it uses only the specific Facebook listing/thread
URLs involved in a queue job or a Prospect conversation. It does not
record clicks, scrolling, or keystrokes as activity data; trusted
input is sent functionally to complete a form fill or a user-queued
reply and is not collected as an activity history.

### Data inventory (paste-ready if the dashboard requests details)

```text
The extension handles the signed-in user's own AutoLaunch data:
user ID and session access token; Marketplace queue entries; vehicle
year, make, model, trim, price, mileage, VIN, stock number, colors,
condition, listing description data, and photo URLs or photo bytes;
and the user's daily post limit, Full Auto choice, posting delay,
dealership name, dealership address, and stock-number-description
preference.

It also handles Facebook content needed for the user's own Prospects:
buyer names, listing labels, thread and listing URLs, visible chat
message text, inbox preview lines, message direction, and timestamps
created for synchronized records. For an outbound reply, it handles
the exact text the user typed or approved in AutoLaunch and the
resulting sent/failed status and any delivery error.

A full open-thread capture reads no more than the most recent 30
visible messages, and the worker stores each captured message body at
no more than 2,000 characters. An inbox preview line is stored at no
more than 500 characters. Automatic creation of a new Prospect is
limited to a visible thread with Marketplace evidence; a user may
manually capture another open chat with the Capture button.
Conversation snippets are stored only for a thread already associated
with one of the user's Prospects.

The user's Facebook password is not handled. No analytics,
advertising, or telemetry data is collected.
```

### Certifications / use answers

Use these answers:

- Data is used **only** to provide or improve the extension's single
  purpose described above.
- Personal data is **not sold**.
- Personal data is **not used or transferred for purposes unrelated**
  to the extension's single purpose.
- Personal data is **not used or transferred to determine
  creditworthiness or for lending purposes**.
- Data sent to Supabase is sent to AutoLaunch's own backend/service
  provider so it can store and return the user's own queue, settings,
  Prospects, and messages. It is not transferred for a third party's
  own marketing or independent use.
- Data entered on Facebook is entered at the user's direction to post
  or remove the user's listing or deliver the user's queued reply.
- **Remote code:** No. All executable code is included in the
  extension package. The extension does not fetch and execute remote
  JavaScript or WebAssembly. Data and vehicle photos fetched over the
  network are not executed as code.

---

## 6. Privacy policy — required correction before submission

**Published URL to use after correction:**

```text
https://mdemoss-bdc.github.io/AutoLaunch/luna-rebuild/privacy.html
```

The page currently published at that URL is dated October 22, 2026
and is stale for 2.1.44. In particular, it describes Facebook
interaction as local Marketplace form work and says the extension does
not read pages outside the AutoLaunch app, Facebook Marketplace, and
photo locations. That omits—and in context contradicts—the current
Messenger/Marketplace chat synchronization.

Before submission, update and republish the policy so it accurately
states all of the following:

1. The extension reads the AutoLaunch app, Facebook Marketplace
   surfaces, Facebook Messenger/Marketplace inbox and thread surfaces,
   floating Marketplace chat windows, and the specific photo URLs in
   the user's queue.
2. Visible chat text, buyer names, listing labels, thread/listing
   URLs, message direction, and inbox preview lines may be synchronized
   to the user's own AutoLaunch backend and shown in Prospects.
3. Automatic new-Prospect creation is limited to Marketplace-evidenced
   threads; other chats are captured only when the user clicks the
   Capture button. Preview-line storage is limited to threads already
   associated with the user's Prospects.
4. The session token is used for the user's own queue, settings,
   inventory, Prospects, and synchronized messages—not only the queue.
5. A reply is delivered only when the user types it or approves it in
   AutoLaunch; Luca drafts but does not send by itself. The policy
   should describe the queued text and delivery-status handling.
6. Listing photos may be retrieved directly by the extension or
   through AutoLaunch's Supabase photo-proxy fallback.
7. The existing no-sale, no-analytics, no-advertising, and
   no-Facebook-password statements remain accurate.

Do not change the dashboard disclosures to match the old policy.
Change the policy to match the actual 2.1.44 behavior and this packet.

---

## 7. Final submission checklist

- [x] Matthew created the Chrome Web Store developer account and paid
      the one-time $5 fee.
- [ ] Clear the §6 privacy-policy blocker and confirm the corrected
      policy is visible at the published URL.
- [ ] Upload only the supplied store ZIP—not the repository extension
      folder and not a ZIP containing the extension folder as an extra
      top-level directory.
- [ ] Confirm the dashboard parsed **AutoLaunch Vehicle Assistant**
      and version **2.1.44**.
- [ ] Store listing: summary, detailed description, Productivity
      category, English (United States), website URL, store icon, and
      required screenshot(s).
- [ ] Privacy practices: single-purpose statement; justifications for
      `storage`, `tabs`, `alarms`, and `debugger`; host-permission
      justifications; data categories and certifications; remote code
      = No; Privacy Policy URL.
- [ ] Confirm there is **no `scripting` justification** and that the
      uploaded manifest does not request `scripting`.
- [ ] Distribution/visibility: **Unlisted**.
- [ ] Submit for review.
- [ ] After approval, record the listing's direct link for the later
      in-app Extension-page update. That app change is outside this
      submission package.
