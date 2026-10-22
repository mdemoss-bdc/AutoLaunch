# Branding — the AutoLaunch emblem

Approved by Matthew, 2026-10-22. The emblem: a blue shield shaped like a
car front (windshield, headlights, mirrors) with a white lightning bolt.

## What replaced what

- The old in-app logo tile — a blue rounded square with a Font Awesome
  lightning bolt — is gone. The emblem image (`icons/logo-mark-512.png`)
  now sits in its place in the two logo lockups:
  - the sign-in / register screen, next to the AutoLaunch wordmark
  - the sidebar header, next to the AutoLaunch wordmark
- The tagline under the wordmark on the sign-in screen now reads
  **"Intelligence Suite"** — the word "Dealer" was removed at Matthew's
  request. (The browser tab title and ordinary copy about dealerships
  were deliberately left alone; this was a brand-tagline change only.)

## Where the logo is used

| Place | File |
|---|---|
| Sign-in screen + sidebar lockups | `icons/logo-mark-512.png` |
| Browser tab favicon | `icons/favicon.ico`, `icons/favicon-48.png` |
| iOS home screen (Add to Home Screen) | `icons/icon-180.png` (apple-touch-icon) |
| Android / PWA install icon | `icons/icon-192.png`, `icons/icon-512.png` |
| Android maskable (adaptive) icon | `icons/icon-maskable-512.png` |
| Web app manifest | `manifest.webmanifest` (name AutoLaunch, standalone display, theme #2563eb) |

## Home-screen / install behaviour

When a user adds the AutoLaunch site to their phone's home screen
(iPhone: Share → Add to Home Screen; Android Chrome: Install app / Add
to Home screen), the icon they get is the emblem — not a screenshot of
the page — and the app opens full-screen (standalone) with the blue
theme colour, like a native app. This is wired in the test copy's
index.html head: manifest link, apple-touch-icon, favicons, theme-color.

Source artwork lives outside the rebuild in ~/workspace/autolaunch-icons/
(Matthew's upload, prepared sizes) — the copies in `icons/` here are the
ones the site serves.
