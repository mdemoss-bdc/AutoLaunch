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

## Color themes (Settings → Appearance)

Users can recolor the shell: 8 curated presets plus a fully custom
base + accent pair, saved per user on `user_settings` (`theme_preset` =
preset id or `"custom"`, `theme_custom` = `{base, accent}`). Matthew's ask:
"whatever color combination their little heart desires."

**How it works**

- The shell CSS consumes ~27 tokens. Every accent-tinted rule derives from
  four RGB-triplet tokens (`--accent-rgb`, `--accent-strong-rgb`,
  `--glow-rgb`, `--btn-rgb`) via `rgba(var(--accent-rgb), α)` — no
  hard-coded blue literals remain in accent-derived rules (semantic
  status hues — emerald/amber/rose/indigo/sky/purple — intentionally stay
  fixed so meaning never changes with the colorway).
- A theme is `{ base, accent, mode }`. `deriveThemeTokens()` expands the
  two colors into the full token set in HSL space: surfaces are the base
  hue at stepped lightnesses (dark: card = base L + .06, field + .055,
  deep + .052, sidebar + .018, page-top + .028; light mirrors downward),
  the text scale is the base hue at fixed lightness rungs (dark: heading
  .93 → fainter .40; light: heading .10 → fainter .74), link/electric/
  strong/button fills come from the accent hue.
- `applyTheme()` writes the tokens inline on `<body>`, overriding the
  stylesheet defaults; it also sets the `<html>` backdrop directly (html
  can't inherit body's custom properties). No saved theme → nothing is
  written and the stylesheet defaults render — that IS Midnight Blue.
- **Readability is enforced, not hoped for:** after derivation, heading,
  body, and link colors are stepped in lightness until they clear WCAG
  4.5:1 against the worst surface they sit on (card and page canvas);
  if the heading pins at its extreme, the surface steps away instead.
  The primary-button fill is stepped to ≥3:1 under its white label.
  Custom mode is chosen by base luminance: ≤0.20 relative luminance →
  dark mode (light text scale); above that → light mode (dark text).
- UI: Settings → **Appearance** tab. Preset swatches apply instantly on
  click; the two custom color inputs live-preview on `input`, and
  **Use custom colors** commits the pair as the active selection.
  Everything persists through the modal's normal Save Settings
  (`saveAllSettings` upserts `theme_preset`/`theme_custom`), and
  `loadUserStoreSettings` restores + applies on sign-in. Opening Settings
  re-syncs the picker to the committed selection.

**Presets**

| ID | Name | Base | Accent | Mode |
|---|---|---|---|---|
| `midnight` | Midnight Blue | `#070D1A` | `#3B82F6` | dark |
| `carbon` | Carbon Black / Blue | `#08090C` | `#3B82F6` | dark |
| `blackred` | Black / Red | `#0A0809` | `#EF4444` | dark |
| `deepsea` | Deep Sea | `#06222B` | `#22C55E` | dark |
| `emerald` | Emerald Night | `#071A10` | `#10B981` | dark |
| `violet` | Royal Violet | `#120A26` | `#8B5CF6` | dark |
| `arctic` | Arctic | `#EFF4FA` | `#2563EB` | light |
| `paperred` | Paper Red | `#FAF5F2` | `#DC2626` | light |

Midnight Blue additionally carries a literal token map (`MIDNIGHT_TOKENS`
in the theme engine) equal to the original template values — verified
token-for-token against the stylesheet defaults — so the default render
is unchanged. The other presets run through the standard derivation.

Verified by unit test (Node, engine extracted from the page): all 8
presets + 8 hostile custom pairs (white+yellow, black+black, mid-gray,
pure red, lime+magenta, white+white…) produce valid colors with
heading/body/link ≥ 4.5:1 against card and page.

Scope note: themes recolor the shell + Inventory (the surfaces the dark
template covers). Modals stay light and Get Started / Wishlist stay
pinned until the rollout pass; they will consume the same tokens then.

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
