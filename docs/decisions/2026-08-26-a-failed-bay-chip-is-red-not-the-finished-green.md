# A failed bay's chip is red, and a cancelled one is neither red nor green

Status: Accepted
Date: 2026-08-26
Type: UI / colour
Supersedes: —
Superseded by: —

## Decision

`DriveRail`'s chip no longer treats `failed` as a kind of "done".

1. **A bay whose rip `failed` gets the danger chip.** Same red as a
   quarantined bay. The word on the chip is what separates the two —
   `failed` against `quarantined`.
2. **That branch runs BEFORE the verdict branch.** A failed bay keeps its
   verdict as the chip's WORD when the verdict asks for something
   (`disc_scratched`), but the colour stays red rather than dropping to the
   verdict's amber.
3. **A `cancelled` bay gets a neutral chip.** The owner stopped it on
   purpose, so it is not an alarm. It produced no backup, so it is not green
   either.
4. `completed` is unchanged: the calm green chip reading `done`.

## Context

The owner reported it in one sentence, about the live rack:

> *"When Rip Deck fails, the color of the badge is green, not red."*

The cause was one `Set`:

```ts
/** A rip is finished with this bay, one way or another. */
const LATCHED_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
])
```

Every member of it returned `state: "done"`, which is the success chip. The
detail string was the only thing that differed, so the rail showed
`03 failed` painted in success green, next to `02 done` in the same colour.

## Why

**"Finished" and "succeeded" are two different facts, and the chip was
answering the wrong one.** The rail exists so that one glance down the row
says whether anything wants a human. A rip that failed produced no backup at
all — it is the loudest thing the rail can have on it, and it was wearing the
quietest colour available.

**Most failures reached that branch, which is why it was not caught earlier.**
The verdict branch above it catches a failure only when the health engine
judged the disc. `towerFeed` stamps the non-actionable `unknown` on every bay
nothing measured, and the health-verdict gate is still shut on this tower
(see the same day's corpus decision), so in practice a failed rip fell
straight through to the latched set.

**The failure outranks its own verdict.** "Go clean the disc" and "there is
no backup" are two facts. The verdict names the ACTION, so it is worth
keeping as the word on the chip, but amber says "this is a caution" about a
bay that has nothing to show for an hour of reading.

**No fixture reproduced it.** The one failed bay in `mockDataSource` —
`held-at-startup` slot 1 — carries `disc_scratched`, an actionable verdict,
so it took the amber branch and never the green one. That is why this shipped:
the mock had no failed bay whose verdict asks for nothing.

## Evidence

Reproduced and fixed against a new `DriveRail` story, both stories captured
in the dark scheme.

Before, `EveryState`: slot 03 `failed` and slot 04 `cancelled` both green,
indistinguishable from slot 02 `done`. Slot 05 (`failed`, `disc_scratched`)
amber.

After: 03 and 05 red, 04 neutral grey, 02 still green.

Four new unit tests pin it, and they assert the CLASS rather than the text —
the old code already printed the right word and the wrong colour, so a text
assertion would have passed throughout.

New `DriveRail.stories.tsx` renders the whole row, because a chip's colour is
only ever read against the eight beside it. `1422` tests, `yarn lint` and
`yarn typecheck` all pass.

## What this does NOT change

The card itself. `RIP_VISUAL_INTENT.failed` was already `danger` and
`CARD_BORDER.failed` already `border-intent-danger-border`, and `ripBucket`
already put a failed rip in the attention bucket. The rail was the one
surface that disagreed with the rest of the dashboard.
