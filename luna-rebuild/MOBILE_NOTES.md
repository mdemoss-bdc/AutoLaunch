# Mobile Compatibility Pass (iOS + Android) — 2026-10-22

Test copy only. Live/root files untouched.

## What was wrong

- The app was effectively desktop-only: the fixed 240px sidebar stayed on screen at all widths, leaving a phone (~390px) about 150px of usable content width.
- Login inputs were 14px, so iOS Safari auto-zoomed on focus, and the email/password fields had no autocomplete or keyboard hints, so phone browsers could autocapitalize/autocorrect into the fields.
- Tall modals could run past the visible screen on phones with no way to scroll the card.

## What changed in index.html

- Viewport now uses `viewport-fit=cover`, plus theme-color and web-app meta tags for Android Chrome and iOS home-screen launches.
- A mobile-only CSS block (applies under 768px, desktop untouched):
  - Sidebar becomes an off-canvas drawer, opened from a new menu button in the Inventory header and closed by picking a destination or the sidebar toggle.
  - Main column takes full width, uses `100dvh`, and respects safe-area insets (notch / home bar).
  - All form fields render at 16px on phones so iOS does not auto-zoom on focus.
  - Modal cards are capped at the visible height and scroll internally.
  - Wide 12-column inner grids stack to one column, tables keep momentum touch scrolling, touch targets are at least 40px in the main column.
- Login fields: email gets `autocomplete="email"` + email keyboard; password gets `autocomplete="current-password"`; both get autocapitalize/autocorrect/spellcheck off so phones stop "helpfully" changing what's typed.

## Test on a phone

1. Open the test URL on iPhone or Android, sign in, confirm no zoom jump on the login fields and that autofill offers the right saved password.
2. Confirm the sidebar is hidden until the menu button (top left of Inventory) is tapped, and that content uses the full width.
3. Open Settings and a vehicle details modal, confirm they fit and scroll.
4. On desktop, confirm nothing looks different.
