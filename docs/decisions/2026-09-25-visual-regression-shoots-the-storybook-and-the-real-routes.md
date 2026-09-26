# Visual regression shoots the Storybook and the real routes

- **Status:** Accepted
- **Date:** 2026-09-25
- **Type:** CI / testing
- **Supersedes:** —
- **Superseded by:** —

## Decision

Rip Deck runs a `vrt` job on every non-docs pull request and on every push to `main`,
through Charcuterie's shared `shared-vrt.yml@workflows-v1`. Reg-suit compares the
shots against the baseline in the repo's own bucket and reports at
`https://rip-deck.reg-suit.octen.dev`. Two sources feed one directory:

1. **`storybook/`** — every story in `packages/web` (VerdictBadge, RipCard,
   DriveRail), in the dark and light schemes, captured by Charcuterie's shared
   Storybook capture. 14 stories, 28 shots.
2. **`routes/`** — the real routes, rendered by `yarn vrt:capture`
   (`packages/web/src/vrt/routes.vrt.tsx` on `packages/web/vitest.vrt.config.ts`), a
   Vitest browser-mode file that writes PNGs instead of asserting. 42 shots:
   - the dashboard on all 12 fixture scenarios in the Wide View (1280 wide), and on 4
     of them in the Narrow View (390 wide), full page height;
   - the kiosk at CastKit's 480x320 panel on 4 scenarios, one slot detail page, and
     the loading card CastKit caches;
   - the history in the Wide View and the Narrow View;
   - the dashboard and the history in dark and light. The kiosk pins
     `data-scheme="dark"` on its own `<main>`, so its six shots are taken once: the
     first run shot them in both schemes and every pair was byte-identical.

Every shot shows the bundled fixtures (`mockDataSource`, the daemon's scenarios
transcribed), never a live rack.

## Context

The owner's fleet rule of 2026-09-25 is that every owned app on Charcuterie runs VRT,
from Storybook stories or from tests. Rip Deck's Storybook covers three components.
The pages the owner actually looks at are the dashboard, the kiosk that CastKit shows
on the tower, and the history, and none of them has a story.

## Why

- **Tests, not new stories, for the routes.** The component suite already renders
  whole pages in real Chromium on the fixture scenarios. A capture file reuses that
  harness and its data. Stories for whole pages would have been a second Storybook
  built only for VRT.
- **Kept out of `yarn test`.** The capture matches `*.vrt.tsx` under its own config,
  so a normal test run never writes screenshots, and the capture never runs the
  suite.
- **What had to be pinned for the shots to repeat byte for byte:**
  - `Date` is faked from before the first import, because the mock history stamps
    its rows at module load. Only `Date` is faked, because react-query and the
    mock's response delay need real timers.
  - The mock's drift moves the lead rip 0.6% on every poll. The capture's data
    source rebuilds the scenario without advancing it.
  - The browser context fixes the time zone (UTC), the locale (en-US), the pixel
    ratio (1) and reduced motion. A stylesheet removes animations, transitions and
    the caret.
  - `useLayoutColumns` reads `window.innerHeight`. A full-page shot grows the frame
    to the page's height, so the capture pins `innerWidth` and `innerHeight` at the
    route's viewport. Without the pin, the nine-rips dashboard reflowed from three
    columns to two while the shot was taken, and the shot cut off mid-card.
  - The Playwright window is 1400x8000. Vitest scales the test frame down to fit the
    window, and the default 1280x720 window gave 0.9-scale, blurred shots.
- **Two Chromium revisions.** The Storybook capture uses the shared tool's pinned
  Playwright. The route capture uses this repo's own Playwright and installs its own
  headless shell in `captureCommand`. Each source is compared only with its own
  baseline, so the two revisions never meet.

## Evidence

- Owner, 2026-09-25, T3 Code chat on the agentic branch
  `t3code/fix-castkit-time-weather-text`: *"We have Storybook, so that's on avenue for
  VRT shots, and some tests can also do them if it makes sense."* Fleet decision:
  `agentic/docs/decisions/2026-09-25-every-owned-charcuterie-app-runs-vrt.md`.
- Determinism, measured locally on 2026-09-25: the full CI sequence (Storybook build,
  shared Storybook capture, `yarn vrt:capture`) ran twice into `.vrt-actual`, and all
  PNGs had identical sha256 sums. A third route capture with the host set to
  `TZ=America/Los_Angeles` was also identical, which shows that the context's time
  zone pin holds.
- Found by the first capture: in the Narrow View, a history card with the wide UHD
  logo squeezes its title to one letter per line (`EYES WIDE SHUT - 4K`). The
  baseline records the page as it is. The fix belongs to its own change.
