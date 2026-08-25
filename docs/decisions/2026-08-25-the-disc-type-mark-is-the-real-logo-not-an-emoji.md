# The disc-type mark is the real disc logo, not an emoji

Status: Accepted
Date: 2026-08-25
Type: UI / iconography
Supersedes: —
Superseded by: —

## Decision

The disc-type mark on a bay card is the **logo printed on that kind of disc**:
Compact Disc, DVD, Blu-ray Disc and Ultra HD Blu-ray. `format.kindIcon`, which
returned one emoji per `MediaKind`, is deleted. The marks live in
`packages/web/src/components/DiscKindLogo.tsx`.

Four rules come with it, and each one was a choice rather than a default:

1. **Inline SVG.** Not an icon package, and not an `<img>`. The art is checked
   into the component, so the dashboard needs no route to the internet — which
   is the normal state of the machine standing in front of the tower.
2. **The CD and DVD wordmarks take `currentColor`; Blu-ray and Ultra HD Blu-ray
   keep their blue.** That is how the four marks are actually printed. CD and
   DVD are monochrome by brand — black on a light label, white on a dark one —
   so they follow the colour scheme. Blu-ray and Ultra HD Blu-ray are
   recognised BY their blue. ⚠️ **Do not flatten all four to `currentColor`.**
   A grey Blu-ray logo undoes the reason for using the real marks at all.
3. **`data` and any unknown kind get a drawn disc**, not one of the four logos.
   A data disc carries whichever mark its blank was pressed with, so there is
   no logo to be right about.
4. **The mark names itself** with a `<title>`, rather than `aria-hidden`.

## Context

The owner asked for it directly:

> *"Rip Deck uses these diamond and square emojis for the different types of
> discs. Can we just add the CD/DVD/BD/UHD BD logos next to it for the type of
> disc instead?"*

He also supplied three of the four sources (dashboardicons.com) and said the
fourth would have to be found elsewhere, which it was.

## Why

`kindIcon` returned 🔷 for `bluray` and 🟦 for `uhd`. Neither shape says which
disc it means, and the pair that has to stay **distinguishable** was the pair
that looked most alike — a blue diamond beside a blue square, at 17px, on a
card the operator reads while walking past a nine-bay tower.

That is the same distinction the daemon works hardest to hold.
`armView.toArmKind` refuses to flatten a 4K disc into `bluray` — its own
comment says it will not do so "to win a prettier glyph" — and the UI was
quietly undoing that at the last step.

Rule 4 is the one that is easy to get backwards. An icon beside text is
normally decoration and takes `aria-hidden`, because the text already says it.
Here the text often does not: `discTypeText` returns null whenever the daemon
has no `disctype_label`, which is **every bay adopted from the ledger**. On
those cards the mark is the only place the disc type appears, so hiding it
would delete the information rather than de-duplicate it. The cost is that a
card which *does* carry a `disctype_label` now says the type twice.
`RipCard.test.tsx` asserts that duplicate on purpose, so a future reader finds
the trade written down rather than a surprise.

## Evidence

- Owner's request, this session (2026-08-25).
- PR [#11](https://github.com/Sawtaytoes/rip-deck/pull/11), with before/after
  screenshots in both colour schemes on the new `RipCard/EveryDiscKind` story.
- Art: CD, DVD and Blu-ray from
  [homarr-labs/dashboard-icons](https://dashboardicons.com) (CC0); Ultra HD
  Blu-ray from
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ultra_HD_Blu-ray_(logo).svg).
