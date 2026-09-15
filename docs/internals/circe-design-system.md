# Circe Design System v1

Circe is a quiet control plane for work across machines. The interface should
feel quiet, precise, premium, warm, restrained, technical, and editorial.

The identity is not "black and orange." It is a warm editorial surface, an
extremely disciplined technical UI, and one luminous copper object. The product
UI should mostly disappear; the orb, copper accent, typography, and occasional
glow are where Circe has a personality.

Visual balance per screen:

- 80–85% neutral
- 10–15% typography, borders, elevation
- 3–5% brand copper
- under 1% strong glow or status color

Do not spread copper across every icon, border, button, and heading. If
everything is orange the aesthetic collapses.

## Where the tokens live

`apps/web/src/index.css` is the single source of truth for the palette,
geometry, motion, and the `circe-*` utilities. `apps/web/src/themePalette.ts`
holds the same values as the flagship theme palette so the Appearance picker,
the persisted theme, and the first paint agree. `apps/web/index.html` carries a
small pre-React copy for the splash; `themeBoot.test.ts` enforces that copy
against the real palette, so change both together.

`docs/internals` avoids duplicating hex values. Read the CSS.

## Character rules

- Dark surfaces are warm near-black, layered by tone: canvas, sidebar, card,
  raised, hover. Never pure black, never blue-charcoal.
- Light surfaces are warm ivory, never sterile white. The product stays warm
  even where copper is absent.
- Borders are 1px and low-opacity (alpha, not a solid grey). They carry most of
  the separation; the desktop UI is nearly shadowless.
- Radius is restrained. Inputs 8–10px, dashboard cards 10–12px, large panels
  16–18px, pills only when semantically appropriate. Do not put a 20px+ radius
  on every card.
- Selected navigation is a copper-tinted gradient plus a thin accent rule
  (`circe-nav-selected`), never a filled orange pill.

## Typography

Three voices:

- **Product UI** — Inter, self-hosted. Weights 400/500/600. Avoid 700+.
- **Editorial** — Instrument Serif, self-hosted, via `circe-display`. Hero and
  brand moments only; never dense product UI.
- **Identity / micro-label** — uppercase, tracked, weight 500. `circe-brand-label`
  at 0.30em for brand and eyebrows; `circe-section-label` at 0.08em for table
  headers and structure.

Table headers are 11px uppercase at 0.08em; row text 12–13px; row height 34–40px.
Use status dots and text, not badges, for state.

## Copper, glow, and the orb

Copper fills (primary buttons) take dark ink labels so the accent stays
luminous and the label clears contrast. Copper _text and icons_ on light
surfaces use the deeper `--accent-ink`; the luminous accent is for fills.

Glow is reserved for the orb, a focused voice state, and small active brand
indicators. Never glow buttons, cards, sidebar rows, or arbitrary selected
states. `circe-glow-sm|md|lg` exist for those rare placements.

`CirceOrb` is the brand device: a dark sphere with a thin incandescent rim, an
uneven warm edge, a specular flare, and a restrained halo. It must not read as
Siri, a generic AI blob, a gradient ball, or a plasma globe. Use it at identity
points only, not scattered through the product.

Icons are monoline (Lucide), stroke 1.5–1.75, and are functional. Do not place
an icon next to a label merely because an icon exists.

## Accessibility constraint

The palette follows the reference, with one deliberate correction: placeholder
and tertiary text are darkened until they clear the 4.5:1 body-text floor
(light `--placeholder`, dark `--placeholder`). Copper button labels use dark ink
for the same reason. Keep that floor when adjusting the palette.

## Guardrails

Never:

- bright orange, generic AI purple/blue gradients, or blue as the product accent
- pure black plus pure white everywhere
- a shadow or a 20px+ radius on every card
- gradients on normal product controls
- an orange-filled selected state, or a badge for every status
- icons added purely to decorate labels
- heavy glassmorphism, sparkles, stars, or magic motifs
- the glowing orb treatment on arbitrary UI
- bold 700/800 typography throughout
- an orb that resembles a phone-call, Siri, or ChatGPT voice surface

Prefer:

- warm-black layered surfaces and warm ivory light surfaces
- 1px low-opacity borders and subtle tonal elevation
- restrained copper, quiet status dots, small tracked uppercase labels
- editorial serif only for expressive brand moments
- one dominant visual hierarchy per screen

## Motion

Hover 120–160ms, panel 180–220ms, modal 220–260ms, easing
`cubic-bezier(.22,.8,.3,1)`. The orb idles at ±4–6% glow over 3.5–5s and must be
reduced-motion safe. No springy navigation animations.

## Marketing versus application UI

Onboarding and marketing may use the serif, a large orb, ambient copper light,
and generous spacing. The application UI stays mostly sans, mostly neutral,
dense, and nearly monochromatic. Do not build the dashboard as though it were
the landing page.
