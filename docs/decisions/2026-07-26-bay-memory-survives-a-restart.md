# Bay memory survives a restart, and an unaccountable disc is held

Status: Accepted
Date: 2026-07-26
Type: safety / data loss prevention

## Decision

`rip-deck watch` persists its latched bays to
`$RIP_DECK_STATE_DIR/bays.json` and hydrates them at startup
(`packages/daemon/src/rip/bayLedger.ts`).

The first time the process observes a bay, `adoptBayAtStartup` decides:

| Reading | Ledger | Result |
| --- | --- | --- |
| No disc, or drive off the bus | anything | Armed. Normal behaviour. |
| Disc, fingerprint matches a record | valid | Restored to its recorded `done`/`quarantined` state. THE RULE holds it, and the eject command can see it. |
| Disc, no matching record | **valid** | Armed, and it rips. A ledger that exists and does not mention this disc is evidence it is new. |
| Disc, no matching record | **missing or corrupt** | **HELD**, latched `needs_attention`, NOT ripped. |

The fingerprint is `sizeSectors` from `/sys/block/srN/size`, per bay.

Adoption reports through `onBayNote`, **never `onBayOutcome`** — an outcome
publishes `rip/event`, so adopting three finished discs at boot would announce
three rips that did not just happen, on every restart.

## Context

`startWatcher` built `const bays = new Map<string, BayState>()` and hydrated it
from nothing. Every bay came back `idle`, so THE RULE — `phase === "done"` plus a
matching `sizeSectors` → hold — could not fire, and `decideBayAction` fell
straight through to `action: "start"`.

The state directory held per-job artefacts (`<uuid>.robot.log`,
`.samples.jsonl`, `.features.json`, `.heartbeat`) and no record of a bay.

Found on 2026-07-26 while trying to redeploy the daemon: three finished Troy
discs were sitting in closed trays, and restarting to pick up new code would
have re-ripped all three — 225 GB, about two hours. It also meant the eject
command being added in the same session would have opened **zero** drives, since
completed-ness lived only in the map the restart erased.

## Why

**A duplicate 90 GB rip is a far worse failure than a disc that waits for a
human.** The collision path renames rather than clobbers, so nothing would be
destroyed — but hours of drive time would be, and the dataset would fill with
second copies nobody asked for. Fail closed on ambiguity is already this
codebase's rule; this is the same rule applied to the one input nobody had
persisted.

**`sizeSectors` is a weak disc fingerprint, and is strong enough here.** Two
studio Blu-rays of identical size are not rare, and `watcher.ts` says so. But
this record is **per bay**: a false match needs the same bay to have been
reloaded, while the daemon was down, with a different disc of exactly the same
sector count. And the error direction is safe — a false match HOLDS a disc that
should have been ripped, which a human notices, rather than re-ripping one that
should not.

**The hold is keyed on "any memory at all", not on "was it loaded at startup".**
The wider rule would ban a capability the owner explicitly asked for: *"I want it
to rip as many discs as I insert. If I insert 9 discs, start 9 rips."* Loading
the tower and then starting rip-deck is a normal thing to do and still produces
nine rips. Widening a narrow safety rule until it bans something the owner asked
for is the exact mistake `../HANDOFF-eject-and-open-questions.md` §1 documents,
and it would have been made twice in one session.

**The hold is a one-off per state directory.** The first tick writes a ledger, so
`hasPriorState` is true from the next boot on.

**The way out is a button press.** A held disc says so on the console and in the
`/json` feed; opening the tray and closing it again re-arms the bay through the
normal empty-tray path, and the disc rips. That is the same two presses the eject
button already provides.

**A corrupt ledger reads as no memory, not as empty memory.** A truncated file
has lost the record of what finished; treating it as "nothing was finished" would
re-rip the rack.

## Consequences to watch

- **A ledger write failure is logged and never fatal.** A read-only state
  directory costs the memory of what finished, never a rip — the same bargain
  `mqtt/watchMqtt.ts` makes with the broker. The consequence is that the next
  restart falls into the fail-closed branch and holds.
- **A disc swapped in for one of exactly the same size, while the daemon was
  down, is held rather than ripped.** Reported, not silent.
- **A stronger fingerprint exists and is not used yet.** `identifyDisc` reads the
  disc's own name, and `runBayRip` already calls it before every rip — so a
  ledger check *after* identify would catch what `sizeSectors` cannot, at no
  extra device cost. Deliberately not built here: it changes `runBayRip`, and
  what was needed was the smallest change that stops the re-rip. See
  `../eject-and-durable-bay-state.md`.

## Evidence

`packages/daemon/src/rip/watcher.ts` before this change: `startWatcher` creates
an empty `bays` map with no hydration; `decideBayAction` consults only that map
plus the live observation.

Live state directory on Tower, checked 2026-07-26 by the session lead: per-job
artefacts only, no bay or completed-disc record.

Owner, on the tower at the time: three finished discs deliberately left in closed
trays, to be ejected with the new button as the live test
(`../HANDOFF-eject-and-open-questions.md` §0).
