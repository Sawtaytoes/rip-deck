# An operator command publishes the bay table at once, not at the next tick

- **Status:** Accepted
- **Date:** 2026-08-20
- **Type:** Correction
- **Supersedes:** —
- **Superseded by:** —

## Decision

`WatcherHandlers` gains **`onBayTableChanged`**, fired when an operator command
changes the bay table between two polls — `rememberTrayCommand` (a drawer
moved) and `runClearLoaded` (a reminder was forgotten). `towerFeed` handles it
with the same `syncRoster()` it runs on `onTickComplete`, so `/json` describes
the command before the command's own HTTP response is written.

It is a **second handler and not a reuse of `onTickComplete`**, because
`onTickComplete` means *"the table now describes this poll"*: nothing was
probed here, the sightings are exactly as old as they were, and a reader that
folded presence off this signal would be folding the previous tick's.

## Context

The owner, 2026-08-20:

> *"Rip-Deck is showing the disc tray is open. It is. I clicked 'eject', and it
> should close it, but it's not. Clicking 'Close Trays' at the top **did**
> work."*

The ⏏ toggle's direction has exactly one input — `last_tray_command`, which is
rip-deck's memory of its own last act, because tray position is unreadable
(`nextTrayCommandFor` argues this at length). `/json` carries that field only
through the roster `onTickComplete` republishes, and the poll is 5 s. The
dashboard, meanwhile, invalidates its `/json` query in the `finally` of the
tray POST — so the refetch that exists *specifically* to re-aim the toggle was
guaranteed to land before the daemon had published the thing it was fetching.

Reproduced live on the tower, through the deployed dashboard:

```
POST → {"command":"open_trays"}
POST ← Opened 1 drive: slot 2.
+4s   /json still: last_tray_command = "close_bay"   toggle label: "Open tray"
```

Press ⏏ inside that window and it sends `open_bay` at an already-open drawer —
a documented no-op, and therefore a button that visibly does nothing. `Close
trays` worked because it reads the daemon's in-memory table directly, which was
correct the whole time; only the published view lagged.

## Why

- The daemon already knew. This is not new state, it is state that was being
  withheld for up to a poll from the one reader that acts on it.
- Fixing it in the browser — an optimistic "we just opened it" flag — is
  explicitly rejected in `TrayToggle`'s own comments: it survives until the page
  reloads and then confidently points the wrong way, which is worse than a
  control that repeats itself.
- The same signal is what makes **Mark as taken out** feel immediate; the two
  defects the owner reported in one message shared this one cause of delay.

MQTT's `drive/<slug>` still catches up on the next sweep. Nothing there is
read within one poll of a button press, so it was left on the tick.

## Evidence

- Owner, 2026-08-20, quoted above.
- Live reproduction against `rip-deck.example.com` through a real browser, shown
  above.
- `the watcher, feeding the store > ⚠️ serves the new tray memory with NO tick
  in between` fails with `expected null to be 'open_bay'` when the feed's
  handler is removed.
