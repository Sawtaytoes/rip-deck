# First paint follows the OS scheme, and a header switcher owns the choice

- **Status:** Accepted
- **Date:** 2026-08-03
- **Type:** web / theming
- **Supersedes:** the **pinned-dark** stance — `data-scheme="dark"` hardcoded on
  `<html>` with a single-scheme `var()` fallback in `packages/web/index.html`
  (rationale in that file's old comment and the
  the design-system consumer handoff).
  Not a dated decision file, so nothing to back-link there.
- **Superseded by:** —

## Decision

Rip Deck's dashboard now **follows the OS light/dark preference by default** and
lets the operator override it, instead of pinning dark. The default `mode` is
`system`; a single cycling button in the header advances **light → dark →
system**, the pick is persisted, and the resolved scheme is applied to
`<html data-scheme>` with **zero flash of the wrong theme** on reload.

- The control is `@charcuterie/ui`'s **`ColorSchemeSwitcher`**, wrapped as
  `packages/web/src/components/SchemeSwitcher.tsx` and placed in the header's
  tower-controls row beside the column picker. The switcher is the whole engine:
  it wires `useColorScheme` to the three browser defaults from
  `@charcuterie/logic/browser` — `matchMedia` (OS resolver), `localStorage`
  (persistence, key `charcuterie-scheme`) and `data-scheme` on `<html>`
  (applier). This app only hands it its glyphs.
- The **first-paint** rule in `index.html` is now
  `@charcuterie/tokens`' **`buildFirstPaintScript(daylight)`** output, pasted
  verbatim. It sets `data-scheme` **before any stylesheet parses** from the same
  persisted/OS choice the runtime hook reads, so the pre-paint attribute and the
  hydrated React state always agree.
- `@charcuterie/logic@^1.1.0` joins `tokens`/`ui` (both already `^1.1.0`) as a
  direct dependency.

## Context

Light mode already worked here via `data-scheme` (M5 shipped `daylight`'s light
scheme and the token layer); what was missing was any way for a user to *pick*
it, and any way to *follow the OS*. The old HTML pinned dark on purpose — "read
from a phone at 2am and a lit room, neither is whatever the laptop thinks."
Charcuterie 1.1.0 shipped the switcher stack (`createColorScheme` /
`useColorScheme` / `@charcuterie/logic/browser` / `ColorSchemeToggle` /
`ColorSchemeSwitcher`) and the OS-following first-paint script, so the pin is no
longer the only way to get a legible page — it was the *absence* of a picker.

## Why

- **The pinned-dark fallback was one edit away from the shipped canvas bug.** A
  static `data-scheme` plus a single-hex `var()` fallback is fine only while the
  scheme is a constant. The moment it is dynamic, the fallback hex must **branch
  on the resolved scheme** — a dark-pinned fallback flashes dark on a
  light-resolved load. `buildFirstPaintScript` chooses the hex per resolved
  scheme (`#131822` dark / `#F5F7FA` light), both still wrapped in
  `var(--color-surface-base, …)` so the unlayered inline rule never outranks
  `bg-surface-base` once the bundle lands (the whole reason
  `firstPaintColour.test.ts` exists).
- **One generator, one gate.** `index.html` carries the library's exact string
  and `firstPaintColour.test.ts` asserts `toContain(buildFirstPaintScript(daylight))`
  — the `var()`, the resolution rule, the `storageKey`, the `color-scheme` and
  both hexes are all gated, and `index.html` and the generator can never drift.
- **Icons add no dependency.** Rip Deck ships no icon library (`kindIcon` is an
  emoji string). The sun/moon/monitor are inline `<svg>` inheriting
  `currentColor`, matching the fleet convention Charcuterie's own boards use —
  decoration beside the `IconButton`'s real accessible name.

## How `firstPaintColour.test.ts` stays honest

The test previously asserted the **broken/pinned** form (`data-scheme="dark"` in
the tag, a single-scheme fallback). It now asserts the OS-following behaviour
truthfully: `data-scheme` is **not** a constant in the `<html>` tag (both
`"dark"` and `"light"` literals are asserted absent, so a future edit cannot
silently re-pin), the generated script sets it from the resolved choice against
the shared `charcuterie-scheme` key, and every `background-color` in the inline
script routes through `var(--color-surface-base, …)`. `biome.json` excludes
`packages/web/index.html` from formatting — Biome rewrites the pasted script
(`function () {` → `() => {`) and that would break the verbatim `toContain`
gate; the file is a generator paste under test, so Biome must not touch it.

## Evidence

Verified live on the dev build (`VITE_MOCK=1`) over a `devshare` URL, driven
with Playwright in an isolated browser context. Measured, in
`__screenshots__/scheme-{1..4}-*.png`:

- **Fresh visitor, OS light** → `data-scheme=light`, `body` bg `rgb(245,247,250)`
  (`#F5F7FA`), switcher shows the **monitor** glyph, label "Colour scheme:
  System." (mode `system`, nothing stored).
- **Cycle → Light** → stored `light`, sun glyph, label "…Light. Activate to
  switch to Dark."
- **Cycle → Dark** → `data-scheme=dark`, bg `rgb(19,24,34)` (`#131822`), moon
  glyph.
- **Cycle → System, then flip OS to dark** → page follows the OS to dark **with
  no click** (stored `system`, `data-scheme=dark`), monitor glyph.
- **Reload with OS dark and nothing stored** → first paint is dark immediately —
  no flash of the wrong theme.

Cycle order confirmed `system → light → dark → system`. All 1285 tests, Biome
and typecheck green.

**Known and out of scope (at ship):** light mode was still half-done by design —
`RipCard` and seven other files kept 155 hardcoded dark colours (M5 handoff), so
the bay cards rendered dark on the light canvas. This change added the switcher +
OS-follow + first-paint; it did not finish the colour migration. **Finished
2026-08-09:**
[light-mode chrome and narrow poster](2026-08-09-light-mode-chrome-and-narrow-poster.md).
