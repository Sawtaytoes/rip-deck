# The health-verdict gate counts its own corpus, and what it publishes is always `suspected`

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** Architecture / product
- **Supersedes:** the hand-flipped `IS_HEALTH_VERDICT_PUBLISHED` constant
- **Superseded by:** —

## Decision

Three changes, one mechanism.

1. **The "not published yet" paragraph is deleted.** Every bay card's evidence list
   opened with four sentences about rip-deck's own build state, ending "tuning them
   needs about 30 real rips of data (there are 3)".
2. **The `unknown` verdict prints no message.** `VerdictBadge` renders nothing for an
   `unknown` verdict with no evidence, and renders the evidence alone when there is
   some. The rip's own outcome sentence — `empty_output …`, the path a partial rip was
   kept at — survives on both sides of the gate, because it is a fact about the rip and
   not about the health engine.
3. **The gate opens itself.** `health/publish.ts` no longer holds a boolean somebody has
   to remember to flip. `health/corpus.ts` counts `*.features.json` in
   `$RIP_DECK_STATE_DIR` and looks for at least one job that went badly; the gate latches
   open at 30 with one. It is refreshed at daemon start and after each rip seals its
   vector — the only two moments the count can change — so every read is synchronous and
   nothing on the watcher poll or the request path waits on a `readdir`.

When the gate is open, `api/towerFeed.ts` shows the engine's real verdict, read back from
`<jobUuid>.verdict.json` through `health/verdictStore.ts`.

**Everything the gate publishes is forced to `confidence: "suspected"`** by `hedged()`.
`isAnnounceable` asks for exactly one property, so a verdict published by the automatic
gate can be read on a card and can never announce over MQTT.

## Context

The owner saw the paragraph on a card and asked what it was and whether it could go.

Three conditions had been written down for flipping the constant by hand: about 30 feature
vectors exist; at least one records a job that went badly; and `HEALTH_THRESHOLDS` has
actually been tuned from them.

The first two are countable. The third is a human act that leaves no trace on disk — no
program can tell a tuned threshold from a guess that has not changed. The options put to
the owner were: open on the counts and hedge every result; open on the counts and let the
engine's confidence stand; or require a marker file written by hand when tuning happens.

## Why

**The paragraph could not stay.** It was a statement about rip-deck's build state printed
on a household appliance's status card, it repeated verbatim on all nine bays, and its
count was typed by hand — so it was wrong from the first rip after it was written. Both
faults have one cause: a fact about the state directory was kept somewhere other than the
state directory.

**Counting is better than remembering.** The gate reads the same files a tuning query
would read. It cannot go stale, it needs no environment variable, and it needs nobody to
notice that the corpus arrived.

**Hedging is what makes counting safe.** At the instant the gate opens on file counts, the
thresholds behind every verdict are still the invented ones. A verdict marked `suspected`
next to a message that names a physical action is worth showing, and being wrong costs a
glance at a card. A `confirmed` verdict reaches MQTT, and being wrong there is the
confidently-wrong alert the whole health model exists to prevent.

`key_expired` loses a little by this: MakeMKV reports it directly (D8) rather than through
any threshold, so it was never a guess. Exempting it would mean keeping a list of which
kinds are threshold-free, and such a list is wrong the first time somebody adds a kind and
forgets it. One rule at one boundary is worth the loss.

**The recorded verdict is untouched.** `<uuid>.verdict.json` keeps whatever the engine
actually said, including `confirmed`. That file is evidence for tuning, not a report to
anybody, and re-judging a corpus later must not be confused by a hedge applied for
display.

**The marker file was refused, and the reason matters.** It is the most honest option, and
the owner declined it as one more manual step of the kind he had just asked to remove. He
was explicit that the tuning condition is his own to keep.

## Evidence

The owner, on first seeing the text (chat 2026-08-26):

> What's this Rip Deck text? … Something about the disc health? Is it something we can get
> rid of?

On the three options:

> Yes! 1 and 2 are great! Then we need to flip 3 automatically when it gathers enough
> info. We can do that. No need to have an env var.

On the tuning condition no program can check:

> Open on counts; verdicts stay hedged. I wanna make sure it, so it just works right now,
> and let's not worry about me manipulating the files. I'm not gonna do that. This is on
> the honor system.
