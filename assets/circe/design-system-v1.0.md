# Circe Design System v1.0

> **Use this as the source of truth for Circe UI, product screenshots, marketing surfaces, and generated mockups.**
> Circe should feel calm, capable, warm, focused, premium, operational, and device-agnostic.

---

## 1. Brand intent

Circe is a **quiet control plane for work across machines**.

It should feel:

- **Calm** — low visual noise, generous whitespace, restrained hierarchy.
- **Capable** — operational, trustworthy, precise.
- **Warm** — soft rose/copper warmth, never cold blue SaaS.
- **Focused** — every control must earn its place.
- **Everywhere** — consistent across desktop, mobile, voice, and control-center surfaces.

Primary lines:

- **Your work. Everywhere.**
- **Think. Do. Across your machines.**
- **A more capable you.**

Avoid: mystical language, cyberpunk styling, purple/blue AI gradients, glowing robots, sparkles, magic motifs, excessive glassmorphism, unnecessary decorative icons.

---

## 2. Logo usage

Use the approved Circe logo assets.

Preferred lockups:

- **Horizontal logo** — headers, desktop chrome, website navigation.
- **Mark only** — app icon, favicon, orb, avatar, compact surfaces.
- **Stacked lockup** — editorial / brand compositions only.

Rules:

- Never distort, rotate, stretch, bevel, outline, or recolor the logo arbitrarily.
- Preserve clear space around the mark equal to at least **0.5× the mark width**.
- On light surfaces: dark wordmark.
- On dark surfaces: white wordmark.
- The warm gradient mark remains consistent in both modes.

---

## 3. Brand palette

| Token        | Hex       | Use                           |
| ------------ | --------- | ----------------------------- |
| `ivory`      | `#FAF7F3` | Primary light background      |
| `midnight`   | `#0F1620` | Primary dark background       |
| `charcoal`   | `#2F2F33` | Secondary dark tone           |
| `rose`       | `#C9A79B` | Brand warmth                  |
| `stone`      | `#DCD3CD` | Borders / muted surfaces      |
| `copper`     | `#C97857` | Primary accent                |
| `peach`      | `#E8AE93` | Highlight / gradient endpoint |
| `deep-brown` | `#4A2D2A` | Logo depth                    |

### Brand gradient

```css
linear-gradient(
  135deg,
  #4A2D2A 0%,
  #9B6658 38%,
  #C97857 68%,
  #E8AE93 100%
)
```

Use the gradient for:

- Circe logo mark
- voice orb
- signature brand moments
- hero imagery

Do **not** use it as the default fill for buttons, cards, or navigation.

---

## 4. Semantic color tokens

### Light mode

| Token            | Value     |
| ---------------- | --------- |
| `bg`             | `#FAF7F3` |
| `surface-1`      | `#FFFDFC` |
| `surface-2`      | `#F5F0EC` |
| `surface-3`      | `#EEE7E2` |
| `text-primary`   | `#14171B` |
| `text-secondary` | `#64686F` |
| `text-muted`     | `#90959B` |
| `border`         | `#E3DDD8` |
| `border-strong`  | `#CFC6C0` |
| `accent`         | `#C97857` |
| `accent-hover`   | `#B96849` |
| `accent-soft`    | `#F2DFD6` |
| `success`        | `#49A878` |
| `warning`        | `#D89545` |
| `danger`         | `#D9515D` |
| `info`           | `#667C96` |

### Dark mode

| Token            | Value     |
| ---------------- | --------- |
| `bg`             | `#0F1620` |
| `surface-1`      | `#151B22` |
| `surface-2`      | `#1B222B` |
| `surface-3`      | `#232B35` |
| `text-primary`   | `#F6F2EF` |
| `text-secondary` | `#A9B0B8` |
| `text-muted`     | `#747C86` |
| `border`         | `#2D343E` |
| `border-strong`  | `#3B4551` |
| `accent`         | `#E08A66` |
| `accent-hover`   | `#ED9877` |
| `accent-soft`    | `#33231F` |
| `success`        | `#67C996` |
| `warning`        | `#E7AA5A` |
| `danger`         | `#EF6873` |
| `info`           | `#8FA4BD` |

---

## 5. Typography

### Product UI

Primary: **Inter**

Fallback:

```css
font-family:
  Inter,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

Weights:

- 400 — body
- 500 — labels / controls
- 600 — headings
- 700 — rare, major emphasis only

### Brand / editorial

Preferred: **Satoshi**, fallback to Inter.

For marketing/editorial compositions, a restrained serif may be used for large display headings only. Do not use serif typography inside dense product UI.

### Type scale

| Role       |    Size | Weight | Line height |
| ---------- | ------: | -----: | ----------: |
| Display XL | 48–64px |    500 |        1.05 |
| Display L  | 40–48px |    500 |        1.10 |
| H1         |    32px |    600 |        1.15 |
| H2         |    24px |    600 |        1.20 |
| H3         |    18px |    600 |        1.25 |
| Body L     |    16px |    400 |        1.55 |
| Body       |    14px |    400 |        1.50 |
| Small      |    12px |    400 |        1.45 |
| Label      | 11–12px |    600 |        1.20 |
| Micro      | 10–11px |    600 |        1.20 |

UI controls use **sentence case**. Micro labels may use uppercase + letter spacing.

---

## 6. Spacing

Use a **4px base grid**.

Allowed spacing:

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80`

Typical usage:

- Dense table row: 40–44px
- Standard control: 40–44px
- Mobile touch target: minimum 44px
- Card padding: 16–24px
- Section separation: 32–48px

Avoid arbitrary spacing unless technically necessary.

---

## 7. Radius

Circe should feel soft, not bubbly.

| Token         | Value |
| ------------- | ----: |
| `radius-xs`   |   6px |
| `radius-sm`   |   8px |
| `radius-md`   |  12px |
| `radius-lg`   |  16px |
| `radius-xl`   |  22px |
| `radius-pill` | 999px |

Defaults:

- Buttons / inputs: **10–12px**
- Cards: **14–16px**
- Floating surfaces: **20–24px**
- Pills only when semantically appropriate.

---

## 8. Borders and shadows

Prefer borders over heavy shadows.

### Light

```css
border: 1px solid #e3ddd8;
box-shadow: 0 8px 28px rgba(24, 20, 18, 0.08);
```

### Dark

```css
border: 1px solid #2d343e;
box-shadow: 0 12px 36px rgba(0, 0, 0, 0.32);
```

Glow is reserved for:

- Circe orb
- listening state
- small active brand indicators

Never glow entire cards or tables.

---

## 9. Icons

Use one icon family consistently.

Recommended: **Lucide**

Rules:

- Default size: 16–18px
- Large standalone controls: 20–24px
- Stroke: 1.5–1.75px
- Icons are functional, not decorative.
- Avoid unnecessary icons beside already-clear text.
- Avoid generic AI sparkle icons.
- Use the Circe mark only when representing Circe itself.

---

## 10. Buttons

### Primary

- Background: `accent`
- Text: near-white
- Height: 40–44px
- Radius: 12px
- One dominant primary action per local context

### Secondary

- Neutral surface
- 1px border
- Primary text

### Ghost

- Transparent
- Borderless until hover where appropriate

### Destructive

Use `danger`, never brand orange.

---

## 11. Inputs and command surfaces

Inputs should be quiet and structural.

- Height: 42–46px
- Subtle border
- Slight surface contrast
- Placeholder uses muted text
- Focus: accent border + restrained focus ring

Command bars can be slightly pill-like, but must not look like generic chat bubbles.

---

## 12. Cards and panels

Cards exist for grouping, not decoration.

Preferred hierarchy:

1. Background
2. Primary surface
3. Nested surface only when needed

Default card:

- Radius: 14–16px
- 1px border
- little or no shadow

Avoid endless card-within-card nesting.

---

## 13. Navigation

### Desktop

- Quiet left rail or top navigation
- Active item: restrained warm tint + thin accent indicator
- Avoid large filled buttons for every nav item

### Mobile

- 3–5 primary destinations max
- Do not force device/project selection before user intent
- Primary flow should feel like: **tell Circe what you want**

---

## 14. Status colors

| State       | Color           |
| ----------- | --------------- |
| Running     | Accent / copper |
| Completed   | Success         |
| Queued      | Neutral gray    |
| Failed      | Danger          |
| Needs input | Warning         |
| Offline     | Muted gray      |

Always combine color with text/iconography.

Progress bars:

- 4–6px height
- neutral track
- accent fill
- no animated rainbow gradients

---

## 15. Voice / listening state

This is a signature Circe moment.

Use:

- immersive dark surface
- warm orb/ring
- subtle waveform or flowing line
- restrained bloom
- direct state text: `Listening…`, `Thinking…`, `Working…`, `Done`

It should feel attentive and deterministic, not mystical.

Do not make it resemble a phone call UI.

---

## 16. Motion

Timing:

- Micro interaction: 120–180ms
- Panel transition: 180–240ms
- Modal / large surface: 220–300ms

Easing:

```css
cubic-bezier(0.2, 0.8, 0.2, 1)
```

Prefer:

- opacity
- subtle scale: `0.98 → 1`
- short translations: `4–8px`

Avoid:

- bouncy springs
- exaggerated parallax
- perpetual decorative motion
- spinning gradients

---

## 17. Light mode

Light mode is warm ivory, never sterile white.

Use:

- Page background: `#FAF7F3`
- Main surfaces: `#FFFDFC`
- Warm gray borders
- Copper accent
- Charcoal typography

Do not flood the interface with pure white.

---

## 18. Dark mode

Dark mode is deep blue-charcoal, not black.

Use:

- Background: `#0F1620`
- Main surfaces: `#151B22`
- Elevated surfaces: `#1B222B`

Avoid large fields of `#000000`.

---

## 19. Marketing imagery

Visual language:

- warm ivory
- deep midnight
- copper / rose illumination
- soft celestial or architectural curves
- editorial composition
- generous negative space

When showing product UI:

- UI remains the hero
- background imagery supports rather than competes
- use the logo sparingly
- avoid robots, brains, circuit-board clichés, holograms, stars, wands, and generic AI motifs

---

## 20. Accessibility

Minimum:

- Body text contrast ≥ 4.5:1
- Large text contrast ≥ 3:1
- Visible focus states
- 44px minimum mobile touch target
- State must never rely on color alone
- Support reduced motion
- Avoid faint warm-gray body text on ivory

---

## 21. Circe-specific product principles

Circe is **one assistant across many machines**, not a device manager first.

Therefore:

- Do not require manual device selection in the normal path.
- Do not lead with provider/model selection.
- Hide infrastructure until relevant.
- User intent comes first.
- Circe resolves routing.
- Device/provider/execution detail appears progressively.
- Prefer operational language:
  - `Running`
  - `Queued`
  - `Completed`
  - `Needs input`
- Avoid:
  - `Working magic`
  - `Casting`
  - `Summoning`
  - other mystical language

---

## 22. Anti-patterns

Do not default to:

- purple-to-blue AI gradients
- neon cyan
- orange everywhere
- glassmorphism everywhere
- huge rounded pills
- icons in every button
- unnecessary badges
- sparkle icons as filler
- gradient text in dense UI
- oversized shadows
- random illustrations
- duplicated icon + text semantics
- forcing project/device selection before action
- phone-call-like voice screens

---

## 23. Agent implementation rule

When generating a new Circe screen:

1. Pick light or dark semantic tokens.
2. Use only defined spacing/radius tokens.
3. Use accent only for action, focus, or meaningful state.
4. Keep hierarchy quiet.
5. Remove decorative elements that do not improve comprehension.
6. If the result looks like a generic SaaS dashboard, simplify it.
