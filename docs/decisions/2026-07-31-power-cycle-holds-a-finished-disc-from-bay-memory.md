# A tower power-cycle holds a finished disc from the bay's own memory

Status: Accepted
Date: 2026-07-31
Type: correctness / bug fix
Supersedes:
Superseded by:

## Decision

A disc that reappears on a bay this daemon has already seen, whose **size matches
a disc the bay remembers FINISHING**, is that same disc coming back on the bus
after the tower's USB power cycled — not a fresh insert. It is **held**, never
re-ripped.

The memory is a new field, `BayState.lastFinished` (a `BayLedgerRecord`), set the
instant a rip latches terminal (`applyBayOutcome`, the quarantine branch, and
`adoptBayAtStartup`'s adopted branches) and — the whole point — **carried across a
re-arm**, where every other disc field is wiped. The poll loop's re-adopt gate now
fires on either:

- **(a)** the bay never read genuinely empty since the drive came up
  (`!hasSettledEmpty`) — the cold power-on case
  ([2026-07-31-a-disc-present-at-power-on-is-adopted-not-ripped.md](2026-07-31-a-disc-present-at-power-on-is-adopted-not-ripped.md)),
  unchanged; or
- **(b)** the present disc's size matches `lastFinished` (or the startup ledger
  record) — the running-daemon power-cycle case this ADR adds.

A bay already holding this disc as terminal is left to THE RULE in
`decideBayAction`, so the re-adopt fires **once**, on the tick the re-armed bay
recognises its disc is back, and emits one "held on power-on" note.

## Context

Found live, 2026-07-31, during a joint test. `rip-deck:1.2.4` shipped a
cold-power-on guard (decision above) keyed on `hasSettledEmpty`: a rip starts only
from a bay whose tray was confirmed empty for `settleEmptyObservations` (3) polls
first. It passed its tests and was believed to fix the power-cycle re-rip.

It did not. Switching the tower off and on with a **completed** Desk Set Blu-ray
loaded, the daemon **re-ripped it** — caught at 2.2%, the finished backup
untouched (rips stage to `.rip-deck-incomplete-<uuid>` and rename on success), and
the errant rip stopped by `docker stop` on the sibling ripper container.

Why 1.2.4 missed it, traced from the daemon log
(`19:36:07 9 drive(s) present → 19:36:17 waiting to settle → 19:36:25 makemkv`):

1. **The daemon never restarted.** Only the tower's USB power cycled, so
   `adoptBayAtStartup` — the whole of the cold-power-on fix — never ran. It runs at
   process start, and the process had been up ten hours.
2. **The in-memory `ledger` is a startup snapshot.** It is read once, lazily, on
   the first tick and never refreshed as rips complete. Desk Set finished *during*
   the ten-hour uptime, so it was simply not in that snapshot — and a disk re-read
   would not have helped, because…
3. **A re-arm erases the on-disk record before the disc reads.** The drive
   enumerates ~10 s before its disc is readable, reporting an empty tray. Two such
   present-empty polls re-arm the `done` bay to `idle` (`rearmEmptyObservations`,
   which the [12V-incident ADR](2026-07-28-empty-tray-clears-a-terminal-verdict.md)
   deliberately makes hold across an off-bus gap — untouched here), and `rearm`
   **hard-sets `hasSettledEmpty: true`**. `persistLedger` then writes the now-idle
   bay through, dropping the done record from `bays.json`.

So by the time the disc reads, the bay is `idle`, `hasSettledEmpty` is `true`, and
neither the frozen ledger nor the erased disk record can say the disc was already
ripped. 1.2.4's guard, keyed on exactly the flag the re-arm poisons, waved it
through as a fresh insert.

## Why

**The re-arm is not the enemy, and must not be touched.** Its "hold the empty
count across an off-bus poll" behaviour is the
[12V-incident fix](2026-07-28-empty-tray-clears-a-terminal-verdict.md), with a
locked-in regression test (`present-empty → off-bus → present-empty` must re-arm).
The re-arm *will* fire during a spin-up and there is no timing that safely stops
it. So the fix lives at the disc's **return**, and the memory it needs must
**survive the re-arm** — which the ledger (frozen snapshot; erased on disk) does
not. The bay's own `lastFinished` does.

**Keyed on the record, not on a debounce flag.** `hasSettledEmpty` is an in-memory
guess a spin-up poisons; a `BayLedgerRecord` size-match is durable evidence. The
size is exact and stable by the time a decision is made (the "waiting to settle"
pre-roll is post-decision), and the live `/sys/block/srN/size` read `65695360` —
matching the record to the sector — confirms the signal is sound.

**Fail-closed, as everything here is.** A disc whose size matches a finished record
is held; the owner presses **Rip** to redo it (the
[dashboard-rip button](2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)). A
**genuinely different** disc has a different size, so it is not matched and rips
under the owner's rule. The one edge — a different film pressed to the *exact* same
sector count, reinserted after an eject — is held rather than auto-ripped: an
astronomically rare collision, and holding it costs a button press where
re-ripping costs 90 GB and an hour. That is this repo's standing trade
(`UNKNOWN_AT_STARTUP_DETAIL`).

This **refines** the cold-power-on decision rather than superseding it: (a) is that
decision's rule, still in force. (b) is the running-daemon case it could not see,
because it only ever modelled a fresh process against a cold tower.

## Evidence

- Root cause reproduced as a failing integration test,
  `watcher.test.ts` → *"holds a disc it ripped THIS session across a power-cycle —
  never re-rips it"*: rip a disc to completion in-session (empty ledger, as in
  production), drop the drive off the bus, six spin-up empty polls (past both
  thresholds), then the disc returns. Asserts `ripper.started` stays at **1**.
  **Fails on `origin/main` (`length 2` — the re-rip), passes on the fix.**
- Companion test *"still rips a genuinely different disc after the finished one is
  taken out"* holds the normal path: eject, load a different-size disc, it rips
  (`started` reaches 2).
- Live: `switch.optical_ripper_power_control_power` off→on with Desk Set
  (`2-1.3.4.4.2`, `sizeSectors 65695360`) loaded; 1.2.4 re-ripped it (job
  `2091c08e…`, "Processing BD+ code", 2.2 %). Backup `[BACKUP] Desk Set - Blu-ray`
  verified byte-present before and after (BDMV/CERTIFICATE/MAKEMKV).
- Full suite: **1280 pass**; tsc, biome, eslint clean.
- Owner decision, 2026-07-31: *"Build fail-closed hold + redeploy"* — a disc
  matching a completed record for that drive is held on power-on; a confirmed eject
  re-arms the bay.
