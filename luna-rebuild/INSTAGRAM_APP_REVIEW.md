# Instagram App Review — Submission Kit

**Purpose:** everything needed to submit the Meta App Review for the
AutoLaunch Instagram posting flow in one sitting, once Matthew gives
the go. The flow itself is built and deployed (2026-11-19, rebuild);
publishing stays dark until this review passes.

**App:** "Auto Launch Feed" — Meta app id `1442518901327928`
(the same app the business portfolio already uses).

**Permissions to request (Advanced Access):**

| Permission | Why |
|---|---|
| `instagram_content_publish` | Publish photos, carousels and Reels to the user's own Instagram business account (the core feature). |
| `instagram_basic` | Read the connected account's identity (username, display name) so the app can show who is connected. |
| `pages_show_list` | List the Pages the user manages so the app can resolve the Instagram account linked to their Page (publishing runs against that IG user id). |

These are the Facebook-Login / Graph API permission names. The
`instagram_business_*` names belong to the separate Instagram-Login
API product and are **not** used by this build.

---

## Before you submit (one-time setup, ~10 minutes)

1. **Function secrets** (Supabase dashboard → Phantom → Edge
   Functions → Secrets): set `META_APP_ID` = `1442518901327928` and
   `META_APP_SECRET` = the app secret from Meta App Dashboard →
   Settings → Basic. The secret never goes in code, chat, or this
   repo.
2. **Redirect URI** (Meta App Dashboard → Facebook Login → Settings →
   Valid OAuth Redirect URIs): add exactly
   `https://autolaunch.org/luna-rebuild/instagram-callback.html`
3. **App basics** (Settings → Basic): confirm the privacy policy URL
   points at `https://autolaunch.org/privacy.html`, the app icon is
   the AutoLaunch emblem, and the category is Business / Shopping.
4. **Reviewer test account:** App Review → provide the AutoLaunch
   **Luna test account** credentials (kept in the rebuild goal's
   hidden files — never in this repo) plus the instructions below.
   The reviewer also needs an Instagram business account linked to a
   Facebook Page they can connect — Meta's review environment
   provides test users for this; if Meta asks for ours, Matthew's own
   @autolaunchhq (linked to the AutoLaunch Page) is the fallback, and
   the connect step is done with Matthew present.
5. **Screencast:** record the demo script below (the TikTok review
   recording pattern). Upload it in the `instagram_content_publish`
   section of the submission.

## Instructions to paste into the review form ("how to test")

> 1. Open https://autolaunch.org/luna-rebuild/ and sign in with the
>    test account provided.
> 2. Open Settings (gear icon) → the **Instagram** tab.
> 3. Click **Connect Instagram**. You are taken to Facebook's own
>    login/consent screen. Approve the requested permissions
>    (instagram_basic, instagram_content_publish, pages_show_list).
> 4. Facebook returns you to AutoLaunch, which confirms "Instagram
>    connected as @…". AutoLaunch never sees or stores a Facebook or
>    Instagram password; the token is stored server-side only.
> 5. Go to the Dashboard (inventory list). Find any car and click the
>    **Instagram button** (camera icon) on its card, next to the
>    clapperboard (VIN Reel) button.
> 6. AutoLaunch posts that car's media to the connected Instagram
>    account: its VIN Reel video if one is ready, otherwise its
>    photos (a single photo, or a carousel when the car has several),
>    with a caption built from the car's year/make/model, price,
>    mileage and stock number.
> 7. Open the connected Instagram account: the post is there.
> 8. Back in Settings → Instagram you can click **Disconnect** at any
>    time, which deletes the stored token immediately.

## Permission justification (paste into the instagram_content_publish section)

> AutoLaunch is an inventory-automation tool for car dealerships and
> independent vehicle sellers. A signed-in user connects their own
> Instagram business account (linked to a Facebook Page they manage)
> and clicks "Post to Instagram" on one of their own vehicle
> listings. AutoLaunch then publishes that listing's own media — a
> photo, a photo carousel, or the listing's showcase video as a Reel —
> with a caption generated from the listing's own data (year, make,
> model, price, mileage, stock number), using the Content Publishing
> API (media container → status poll → media_publish). The permission
> is used only to publish content the user explicitly chooses, to the
> user's own account, at the moment they click. AutoLaunch never
> posts automatically without a user action, never posts to accounts
> the user does not own, and never reads messages, followers, or any
> other account data. Tokens are stored server-side only, are never
> shown to the browser, and are deleted immediately when the user
> disconnects.

For `instagram_basic`: "Used only to display which Instagram account
is connected (username and display name) on the Settings screen, so
the user can confirm the right account before posting."

For `pages_show_list`: "Publishing runs against the Instagram user id
linked to a Facebook Page the user manages. The app lists the user's
Pages once at connect time to resolve that linked Instagram account;
no Page content is read, posted to, or stored beyond the Page id."

## Demo script (screencast, ~60–90 seconds)

Record at desktop width, cursor visible, no cuts inside a step.

1. **(0:00)** AutoLaunch rebuild dashboard, signed in as the test
   user. Inventory list visible with real cars.
2. **(0:10)** Open Settings → Instagram tab. Status reads "Not
   connected yet." Click **Connect Instagram**.
3. **(0:20)** Facebook consent screen — show the three permissions
   listed — approve. (If a login is required, sign in with the
   reviewer-path account.)
4. **(0:35)** Callback page: "Instagram connected as @…". App returns
   to the dashboard with the confirmation toast.
5. **(0:45)** On a car card, click the **Instagram button**. Toast:
   "Posting this car to Instagram…".
6. **(0:55)** Switch to the connected Instagram account (phone or
   instagram.com) and open the profile: the new post is at the top of
   the grid. Open it — photo/carousel/Reel with the listing caption.
7. **(1:15)** Back in AutoLaunch: Settings → Instagram shows
   "Connected as @…". Click **Disconnect**; status returns to "Not
   connected yet." End recording.

Narration is optional; Meta accepts silent screencasts with the
written instructions above. Keep the connected Instagram account's
own posts in frame at step 6 — the platform itself is the proof,
same rule as everywhere else in AutoLaunch.

## After approval

1. Flip the app from Development to **Live** (App Dashboard header).
2. Matthew connects his own account in the rebuild (Settings →
   Instagram) and posts one car; verify the post on Instagram itself.
3. Only then: build the queue executor for `target_channel =
   'instagram'` rows and enable `channel_instagram_enabled`
   (INSTAGRAM.md step 8/10) — that graduation is a separate,
   Matthew-approved change, as is any move from rebuild to the live
   app.
