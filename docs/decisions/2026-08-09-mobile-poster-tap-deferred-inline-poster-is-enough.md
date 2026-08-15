# Mobile poster tap is deferred — the inline poster on narrow cards is enough for now

- **Status:** Accepted (deferred product work)
- **Date:** 2026-08-09
- **Type:** web / UX / deferred
- **Supersedes:** —
- **Superseded by:** —

## Decision

**Do not change the narrow-card tap model right now.** The always-on inline poster
(and full title) from
[2026-08-09-light-mode-chrome-and-narrow-poster](2026-08-09-light-mode-chrome-and-narrow-poster.md)
is **good enough**: when `rip.poster` is set, the thumb shows on phone density and
opens Charcuterie's `Lightbox` when tapped; title is no longer truncated away.

**May revisit later** (not a commitment, not a backlog ticket — a breadcrumb):

- Replace the full-bleed "tap card → MakeMKV log" overlay on narrow cards with a
  poster-first or detail-sheet gesture (logs demoted to an explicit control).
- Options explored with the owner as an interactive phone-frame mockup:
  [`docs/previews/2026-08-09-mobile-poster-tap-options.html`](../previews/2026-08-09-mobile-poster-tap-options.html)
  (Current / A lightbox / B detail sheet / D split gestures / C banner-only).

Until someone reopens this with a picked option, leave the gesture as shipped.

## Context

After the light-mode + narrow-poster PR, the owner saw the **name** on phone but
thought there was **no poster**. That was largely a **screenshot gap**: mock
fixtures leave `poster: null`, so PR after-shots showed light cards with titles
and no art. On live data with OMDb, Current already mounts the thumb + Lightbox.

A follow-up interaction redesign (tap → poster instead of logs) was mocked and
devshared. Owner:

> If it already has the poster in Current, then we're good. It wasn't showing
> that in your PR, so I didn't know it was there. Document that we might wanna
> look at this again in the future, but it's good for now.

## Why

- Identity on phone is "title + cover when we have one" — that already ships.
- Rewiring the full-bleed log overlay is real product work with tradeoffs; no
  urgency once the cover is visible.
- Keeping the mock under `docs/previews/` means a future session does not re-argue
  options from prose alone.

## PR screenshots note

Visual PRs for bay cards should use a fixture (or inject a poster URL) that
sets `poster` when the change is about the thumb — otherwise after-shots look
like the art was never added. Fleet rule:
[agentic visual PRs attach before/after](../../../agentic/docs/decisions/2026-08-09-visual-prs-get-before-after-screenshots-attached.md).
