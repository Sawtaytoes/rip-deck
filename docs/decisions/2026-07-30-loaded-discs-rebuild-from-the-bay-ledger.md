# The loaded-discs reminder is rebuilt from the on-disk ledger, not held in MQTT

Status: Accepted
Date: 2026-07-30
Type: architecture / code
Refines: [The dashboard can switch the tower off, and remembers what it trapped](2026-07-30-the-dashboard-can-switch-the-tower-off.md)

## Decision

The "N discs are still in the tower" reminder is rip-deck's own state, and its
system of record is the **bay ledger on disk** (`$RIP_DECK_STATE_DIR/bays.json`,
`bayLedger.ts`) — not the broker's retained `loaded` topic. On startup the
watcher rebuilds the loaded-discs summary from the ledger for any drive the live
probe did not answer for (`phantomLoadedBays`), so the fact survives a daemon
restart against a powered-off tower without depending on the broker to have kept
it.

Concretely:

- **`persistLedger` never wipes the ledger while blind.** This is the enabling
  fix, added in 1.2.3 after the first cut shipped: the poll loop builds no bays
  when no drive is on the bus, so a naive persist wrote an *empty* record set over
  the disk on every tower-off tick — erasing the memory of a disc left in a
  powered-off tower, so the next daemon re-ripped it (measured live: an
  already-backed-up Soylent Green UHD would have re-ripped ~90 GB). The poll now
  passes `isBlind` and an empty result is persisted only when a drive is present
  to have gone empty; an operator clear/rip keeps writing (it changed a known
  bay). Without this, the reminder below and the ledger's own re-rip protection
  do not actually survive a tower-off restart, which is the one case they exist
  for.
- **`loadedDiscsNow` folds two memories, not one.** The live bay + sighting
  tables as before, PLUS a phantom for every latched ledger record whose driveId
  is not already a live bay. A phantom is `isDrivePresent: false` and is folded
  **only** into the loaded-discs summary — it never enters the `bays` map
  `decideBayAction` iterates, so it cannot start a rip or move a tray. When the
  tower powers back on, the drive answers a probe, a real bay is adopted for that
  driveId (`adoptBayAtStartup`, fail-closed), and it excludes the phantom — the
  real bay wins with no double-count.
- **`/json` and MQTT read the ONE summary.** `main.ts` folds
  `watcher.getLoadedDiscs()` into every live snapshot, and `buildTowerView`
  prefers it over recomputing from the (empty-after-restart) bay table. So the
  dashboard banner and the reminder never disagree.
- **`isBlind` replaces "empty means unknown".** An empty summary is withheld from
  the retained topic only when the daemon is genuinely blind — no drive on the
  bus AND the ledger was not readable. A readable ledger that recorded nothing is
  a real all-clear and IS published, so a stale reminder clears itself.
- **A manual clear: the `clear_loaded` command.** A "Mark as taken out" button on
  the reminder banner, and a bare/JSON `clear_loaded` on the same `cmd/drive` +
  `POST /api/tray` surface as the tray commands (so a Home Assistant button can
  clear it too). It drops the ledger's latched records and any kept-but-absent
  bay, then republishes an all-clear. A drive that is on the bus and still holds
  its disc is NOT forgotten — clearing lies only about discs nobody can see.

The retained `loaded` topic stays, but as a **downstream mirror** so Home
Assistant can read the last value the instant it reconnects — not as the memory
of record.

## Context

The [tower-off decision](2026-07-30-the-dashboard-can-switch-the-tower-off.md)
shipped the reminder answered "from the bay and sighting tables … because a
powered-off tower has nothing to probe", and leaned on the retained MQTT topic to
carry it across a daemon restart, since a fresh daemon builds no bays against a
dark tower. `rip/loadedDiscs.ts` said outright: *"That memory does not survive a
daemon restart with the tower off … the ledger on disk knows, but nothing reads
it into a bay for a drive that is not there."*

The owner questioned exactly that shape:

> *"Why not store some JSON file locally in the app config dataset like other apps and use
> that for state management? … MQTT is only related to Home Assistant in my
> setup. … Rip Deck's state needs to stay inside Rip Deck. … If you reboot Rip
> Deck, it'll have to check to see if anything's changed or allow a manual
> clearing of that state."*

He was right on two counts. First, the durable memory already existed — the bay
ledger, written precisely so a restart does not re-rip finished discs — and the
only gap was that nothing rebuilt the *reminder* from it. Second, the retained
MQTT topic was doing a job that belongs to rip-deck's own disk state, and the
symptom was concrete: after a restart with the tower off, Home Assistant kept
reminding (retained topic) but the **Web UI banner went blank**, because
`buildTowerView` recomputed the loaded set from an empty bay table.

## Why

- **One source of truth, inside rip-deck.** The ledger already records, per bay,
  the disc still in it (phase, size, name, type, outcome, job). Rebuilding the
  reminder from it makes the fact rip-deck's own, computed identically on the
  dashboard and on the wire. MQTT becomes an output, which is what every other
  topic here already is.
- **The Web UI and HA now agree after any restart.** The blank-banner asymmetry
  is gone: both read `getLoadedDiscs()`.
- **The safety rule is unchanged in spirit and stronger in fact.** "Unknown is
  not idle" still holds; `isBlind` just draws the line where the ledger's
  readability actually is, so a genuine all-clear can clear a stale reminder
  instead of being suppressed forever.
- **Phantoms cannot re-rip or auto-eject — by construction.** They are display
  facts that never enter the bay table. A cleared or forgotten disc that later
  returns on a powered-on drive is re-adopted through the fail-closed startup
  path, which HOLDS rather than re-rips — the same safe direction the ledger's
  own false-match argument already relies on.

## Evidence

- Owner quote above (chat 2026-07-30), following the tower-off shipment.
- `packages/daemon/src/rip/loadedDiscs.test.ts` — `phantomLoadedBays` rebuilds a
  loaded disc from a ledger record alone, yields to a live bay for the same
  drive, and `shouldPublishLoadedDiscs` now publishes a readable all-clear while
  withholding a blind one.
- `packages/daemon/src/rip/watcher.test.ts` — "rebuilds the reminder from the
  ledger with the tower off, and never re-rips it" (asserts `getBays()` is empty
  and no rip started) and "clear_loaded forgets the reminder, persists the clear,
  and reports the count".
- `packages/web/src/components/ClearLoadedButton.test.tsx` — the button sends a
  plain `clear_loaded` and surfaces a failure rather than swallowing it.
