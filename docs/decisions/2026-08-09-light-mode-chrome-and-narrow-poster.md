# Light-mode chrome uses Charcuterie tokens; poster and title stay on narrow cards

- **Status:** Accepted
- **Date:** 2026-08-09
- **Type:** web / theming / layout
- **Supersedes:** the "light mode is still half-done by design" caveat in
  [2026-08-03-first-paint-follows-the-os-scheme.md](2026-08-03-first-paint-follows-the-os-scheme.md)
- **Superseded by:** —

## Decision

1. **Bay chrome and action controls use Charcuterie semantic tokens / `Button`,
   not dark-only hexes.** Card shells, slot chips, drive-rail pills, tray
   controls, empty states, and status banners map to
   `bg-surface-*` / `text-content-*` / `border-border-*` /
   `*-intent-*-{surface,border,content}` so light and dark schemes both render
   correctly. Hand-rolled `bg-[#171a21]` / `border-[#333b49]` / `text-slate-*`
   chrome is gone from the eight files M5 left behind.

2. **The poster and the disc title stay visible on a narrow card.** The
   thumbnail is no longer `hidden … @md/bay:block`. It always shows when
   present, at `w-16` under the bay container threshold and `w-28` at
   `@md/bay` and up. The title uses `break-words` (not `truncate`) and the
   header row `flex-wrap`s so Keep trying / Give up / Cancel cannot crush the
   name to `"T…"`.

## Context

The scheme switcher + OS-following first paint shipped 2026-08-03, but the bay
cards were still painted with M5's leftover dark hexes — light mode showed a
light page chrome around dark cards. Independently, the owner used the live
dashboard on a phone: portrait and landscape both hid the poster until a
1-column layout cleared the 28rem / 448px `@container/bay` threshold, and the
title ellipsised behind the action buttons.

## Why

- **Hardcoded dark is not a scheme.** `data-scheme="light"` cannot restyle
  `#171a21`. Tokens answer to the attribute; hexes do not.
- **`Button appearance="outline" intent=…` is the same fix TrayToggle already
  took** — a role, not a colour. Danger (cancel / give up / tower off) and
  warning (held-bay actions) stay intent-named.
- **Narrow density was about *detail* density, not identity.** Elapsed, stage,
  path, and drive-info remain `@max-md/bay:hidden`. The poster and the title
  *are* what a collapsed card is about; hiding them made a phone view useless
  for "which disc is this".

## Evidence

Owner screenshots (2026-08-09): light page, dark bay card; portrait +
landscape auto columns missing poster and title until 1-column landscape.

```
> light mode seems to still be showing dark mode stuff. Did we not update
> those to be Charcuterie?
> in narrow view, I don't like how it hides the rip title and the poster image.
> I'd still like to disable those [hides].
```
