# An empty tray retires the finished card

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** code / correctness
- **Supersedes:** —
- **Superseded by:** —

## Decision

A bay the watcher has re-armed — `phase: "idle"` with no size — publishes **no
job**. `syncRoster` replaces that bay's `BayRecord` with a fresh one, so the
finished run stops being displayed the moment its disc leaves the tray.

The record still outlives its outcome while the disc is **in** the drive. That
was always the point of it, and it does not change.

## Context

The owner, with all nine trays empty:

> "The image itself seems broken because it's showing drives on hold with no
> discs. NO discs in the tower right now."

He was right, and the daemon already knew it. Measured on the tower at the same
moment:

- The `size` attribute under `/sys/block` read `2097151` on all nine drives —
  the 1 GiB sentinel the kernel reports for an empty tray, which
  `settle.ts` documents by name.
- No drive carried `ID_CDROM_MEDIA`.
- `/json` agreed, per bay: `has_disc: false`, `disc_size_sectors: null`.

And yet:

| Slots | Published state |
| --- | --- |
| 1–4 | `needs_attention`, each with a job id |
| 5–7 | `idle` — correct |
| 8–9 | `completed`, at `progress_percent: 100`, and slot 8 still raising a health **alert** about a disc that had left the building |

## Why

`readBayFacts` reads the outcome as `bay.outcome ?? record.outcome`. The bay's
own outcome is cleared by `rearm` when the disc leaves. The record's is not, and
nothing ever cleared it — `liveRecordOf` says so in its own words:

> a record outlives its outcome so the finished card stays on the dashboard; the
> next event from that bay is a new disc and therefore a new run

That is correct while the disc is in the tray. It has **no stopping condition
when the disc is simply taken out**, because an empty bay is quiet. No next
event ever comes, so the card stays forever.

**Slots 5–7 are the proof, not the exception.** They cleared correctly, and they
are exactly the bays whose last outcome came from startup **adoption**. Adoption
emits a note and deliberately never an outcome, so no record was ever created to
go stale. Every bay that latched a real outcome event in this process stuck;
every bay that did not, cleared. That is the whole pattern, and it rules out the
tray reading, the poll loop and the re-arm — all three were working.

## Evidence

`hasBayReArmed` names the one condition that says a record has outlived what it
describes:

```ts
export const hasBayReArmed = (bay: BayState): boolean =>
  bay.phase === "idle" && bay.sizeSectors === null
```

Three states are deliberately **not** re-arms, and each has a test:

- **A finished disc still in the tray** is `phase: "done"`. Its card stays; the
  eject button acts on exactly that card.
- **A drive off the bus** never reaches `idle` at all — `decideBayAction` holds a
  drive it cannot see rather than deciding about it, so a powered-off tower keeps
  its whole rack.
- **A rip in flight** is `starting` or `ripping`.

Both new failing-first tests were confirmed against the unfixed code: `clears a
completed card once the disc is taken out` and `clears a needs_attention card the
same way` fail without the change and pass with it.

`last_rip` is untouched. It is written once at the outcome event into its own
store slot, so the Home Assistant "what happened most recently" sensor survives
the record being retired.

## What this does NOT fix

The four LG and ASUS drives in slots 1–4 still have a hardware fault of their
own: repeated `DID_TIME_OUT` on 30-second reads followed by USB resets, recorded
before any tray command was issued. This decision is about a stale card. It is
not a fix for those drives, and it must not be read as one.
