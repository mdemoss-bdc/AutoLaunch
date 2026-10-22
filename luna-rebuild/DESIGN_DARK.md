# AutoLaunch — Dark Command-Center Design System

Status: **template live on the Inventory screen only** (sidebar + inventory workspace).
Modals, auth, Get Started, and Wishlist still use the light theme until Matthew
approves the template and the rollout pass applies these same tokens there.

Direction (Matthew, 2026-10-22): "Dark command-center — navy + electric blue,
BDC Manager energy." Deep navy shell, dark slate surfaces, uppercase micro-labels,
glowing status accents — with AutoLaunch electric blue instead of BDC Manager's gold.

## How it's implemented

- `body.dark-shell` gates everything. All rules live in one delimited block at the
  end of the `<style>` in `index.html` ("DARK COMMAND-CENTER TEMPLATE").
- Rules are scoped to `:is(aside, main)` (shell + inventory) so body-level modals
  are untouched. JS-rendered rows/cards are covered because overrides key off the
  same Tailwind utility classes the renderers emit — no JS changes were needed.
- State classes swapped by JS (`setPillFilter`, `setViewMode`, peer-checked
  toggles) reuse those utilities, so states re-skin automatically. The active
  pill is targeted as `#pill*.bg-blue-600` (the class JS assigns when active).

## Tokens (CSS variables on `body.dark-shell`)

| Token | Value | Use |
|---|---|---|
| `--d-page` | `#070D1A` | App background / gradient bottom |
| `--d-page-top` | `#0B1424` | Gradient top of the main canvas |
| `--d-sidebar` | `#0A1220` | Sidebar (darker than content) |
| `--d-deep` | `#0C1730` | Sunken surfaces: table head, sidebar footer |
| `--d-card` | `#101B30` | Cards, ribbon, table wrap, grid cards |
| `--d-field` | `#0E1930` | Inputs, selects, inactive pills, toggle-off surfaces |
| `--d-track` | `#22345A` | Meter tracks, toggle-off track, scrollbar thumb |
| `--d-edge` | `rgba(59,130,246,.16)` | Card borders on dark |
| `--d-edge-strong` | `rgba(96,165,250,.45)` | Hover borders |
| `--d-field-edge` | `#2A3D5F` | Field borders |
| `--d-line` | `rgba(255,255,255,.055)` | Row dividers |
| page glow | `rgba(46,124,246,.13)` radial | Top-of-main radial glow |

## Text levels

| Level | Value | Maps from (light utilities) | Contrast on card |
|---|---|---|---|
| Heading | `#E9EFF8` | `text-slate-900/950` | 14.9:1 |
| Body | `#CBD5E1` | `text-slate-700/800` | 11.6:1 |
| Soft | `#9FB0C7` | `text-slate-600` | 7.8:1 |
| Micro-label | `#8698B5` | `text-slate-500` | 5.9:1 |
| Faint | `#7A90AC` | `text-slate-400` | ~5.2:1 |
| Link / price | `#58A6FF` | `text-blue-600` | 6.8:1 |

Status hues on dark (translucent tint bg + bright text + 35%-alpha border):
emerald `#34D399`, amber `#FBBF24`, rose `#FB7185`, indigo `#A5B4FF`, sky `#38BDF8`.

## Accent usage

- Primary buttons keep the brand gradient `linear-gradient(135deg,#2563EB,#1D4ED8)`
  (white on it is ≥5.2:1) with a deeper glow shadow on dark.
- Active nav item and active filter pill use the electric variant
  `linear-gradient(135deg,#2E7CF6,#1D4ED8)` + `0 4–6px 16–18px rgba(46,124,246,.45)` glow.
- Ribbon cards keep the blue→sky gradient hairline (`#2563EB → #38BDF8`) and get a
  stronger brand wash (`rgba(59,130,246,.10)` fading down).
- Focus rings: `--tw-ring-color: rgba(46,124,246,.55)` inside the dark shell.

## Rollout notes (for the next pass)

- `#getStartedPage` and `#wishlistPage` are temporarily pinned to the old light
  canvas (`background:#f0f4f8`) so their headings don't sit on navy before their
  content is re-skinned. Remove the pin when each view is rolled out.
- `#vehicleActionDropdown` (row "…" menu) is body-level and still light, like the
  modals — re-skin it with the modal pass.
- The auth/login overlay now sits over a navy body background (its own card and
  backdrop are unchanged); check it during the modal pass.
- Reuse the utility-mapping approach: dark values are keyed to the existing
  Tailwind classes, so most surfaces convert without markup changes.
