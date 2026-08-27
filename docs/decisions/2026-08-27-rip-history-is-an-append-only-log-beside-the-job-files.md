# Rip history is an append-only log beside the job files

- **Status**: Accepted
- **Date**: 2026-08-27
- **Type**: Architecture
- **Supersedes**: —
- **Superseded by**: —

## Decision

Every rip that reaches a terminal outcome appends one JSON line to
`$RIP_DECK_STATE_DIR/history.jsonl`. `GET /api/history` reads that
log, filters it, sorts it newest-first, slices a page, and only
then joins each returned row to its `<uuid>.features.json` and
`<uuid>.verdict.json`. The dashboard gets a second route,
`/history`.

Four rules fall out of it, and each one is load-bearing:

1. **The log holds only what the BAY knows** — the disc's name,
   its type, where the rip landed, the slot, and rip-deck's own
   outcome sentence. Bytes, duration, read errors and the health
   verdict are NOT copied in; they are joined at read time.
2. **The join is per PAGE, never per log.** Enriching every row
   would be two file opens per rip ever done, on every request.
   `?limit=` caps at 200 for that reason — it bounds file opens,
   not bytes.
3. **Nothing is ever pruned.** A row is a few hundred bytes.
4. **The verdict passes the same gate the bay card passes** —
   `isHealthVerdictPublished()` and `hedged()`.

## Context

The owner, 2026-08-27:

> *"there's no way to view rips that were previously done since
> the last time the image restarted. We do display current rips
> from before the image restarted, but I'd like a way to also see
> older ones, check by date, etc."*

He is right about the cause, and it is not the restart. `bays.json`
holds **one record per bay and overwrites it**
([bay memory](2026-07-26-bay-memory-survives-a-restart.md)). It
exists to stop a finished disc being re-ripped, and the moment the
next disc lands in that tray the previous one is gone — restart or
no restart.

The per-job files under `$RIP_DECK_STATE_DIR` DO survive forever,
and there were 26 of them on the tower the day this shipped, back
to 2026-07-26. What they do not carry is the only field a human
recognises: the disc's NAME. It reaches rip-deck from udev
([decision](2026-08-26-a-discs-name-comes-from-udev-before-makemkvcon.md)),
lives on `BayState`, is written to the bay ledger — and is then
overwritten.

So the two halves of a history row were both on disk and had never
been joined, and the join could only be made at one instant: the
outcome latch, where the name and the outcome are both in hand.

## Why

**Why JSONL and not a second JSON document like `bays.json`.**
`bays.json` is current state: it changes, so it is a whole-file
rewrite behind a fingerprint and an in-flight guard. History does
not change. One rip is one line, written once by a single
`appendFile`, never edited — which makes it the cheapest and
safest thing a finishing rip can do, and means a crash mid-write
costs the last line and nothing else. Versions are per LINE, so a
future v2 writer appends beside the v1 rows and the reader keeps
both. There is no restart that costs the history.

**Why the measurements are joined rather than copied.**
`verdictStore.ts` already states the rule: *"`<jobUuid>.verdict.json`
is already the authority"*. A copy would be a second thing to keep
in step — and it would be taken too early, because the sampler
seals its feature vector AFTER the outcome latches.

**Why a backfilled row has no disc name, and why none is invented.**
Three routes to an old rip's name were measured against the real
27-capture corpus on 2026-08-27, and all three are dead:

| Route | Result |
| --- | --- |
| `makemkvcon`'s `DRV:` disc-name field | **Empty in all 27 captures.** `backup` mode never prints it. |
| `MSG:5072`'s destination folder | Names the `.rip-deck-incomplete-<uuid>` temporary. The rename into the library is the LAST step — that is `leftovers.ts`'s whole design. |
| Matching a rip folder in `/media/Disc-Rips` by mtime | The closest folder mtime was **over a day** from the job's end, for every one of the 13 successful jobs. |

A name attached to the wrong rip is worse than no name, so the row
says `"Name not recorded"` and the wire carries `is_named: false`
to keep that apart from *"rip-deck was there and could not read a
label"*. Those are different facts and the reader is owed the
difference.

**Why the history page is ONE COLUMN.** The fleet rule is that a
list of cards is a grid; it was narrowed on 2026-08-25 to exclude
items that are a title, a summary line and some chips, because
prose is scanned down a column. Every row here is exactly that —
there is no poster and no tile to anchor on. `BayGrid` on the
dashboard stays a grid, correctly: a bay card has a progress bar,
a poster and a tray control.

**Why it is not on `/json`.** Same argument `/api/leftovers` makes,
one step further. `/json` is a synchronous memory read a browser
polls every five seconds; this reads a log off disk and then opens
two files per row. And a finished rip does not change, so the page
fetches when it opens and when a filter moves, never on a timer.

## Evidence

- Owner, chat 2026-08-27: *"Can we add an 'old rips' or something
  view to Rip Deck? Right now, there's no way to view rips that
  were previously done since the last time the image restarted. …
  I'd like a way to also see older ones, check by date, etc."*
- Owner, same chat, on the three questions put to him: the view is
  called **History**; the 26 existing jobs are **backfilled**; rows
  are kept **forever**.
- Measured on the live tower's state directory, 2026-08-27: 26
  `*.features.json`, 27 `*.robot.log`, 23 `*.verdict.json`, back to
  2026-07-26. 13 successful jobs, 13 failed.
- The mtime-join measurement is in
  `packages/daemon/src/rip/ripHistoryBackfill.ts`'s header and
  pinned by its tests.
