# A blind ledger write must not wipe finished-disc records

Status: Accepted  
Date: 2026-08-09  
Type: bugfix  
Supersedes:  
Superseded by:  
Refines: [2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md](2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)

## Decision

`persistLedger` when the poll is **blind** (no drive on the bus):

1. **Never writes `records: []`.** Tray-command memory alone is not
   evidence that finished discs left the tower. Only a non-blind empty
   (tower on, trays readable) or an explicit `clear_loaded` may publish
   an empty latched set.
2. **Does not drop a completion that races an in-flight poll write.**
   If a write is already in flight, the newest payload is queued and
   flushed in `finally` — not discarded.

## Context

After *THE PEOPLE VS LARRY FLYNT* finished cleanly (~92 GB, MakeMKV
"Backup done"), on-disk `bays.json` held:

```json
{ "records": [], "trayCommands": [ /* close_bay on six idle bays */ ] }
```

So `discs_loaded` could not rebuild from the ledger after a restart or
a dark tower, even though the bay had latched `done` in memory and HA
still showed a holding-finished status on the bay sensor until redeploy.

The blind guard only skipped when **both** `records` and `trayCommands`
were empty. A dark-tower tick with idle bays that still remembered
`close_bay` therefore rewrote the file with empty records and wiped any
latched disc the previous write had stored.

Separately, `if (isLedgerWriteInFlight) return` dropped a completion's
persist when a poll write was mid-flight, so the disk could stay on an
older empty fingerprint.

## Why

- The loaded-discs reminder and fail-closed startup adoption both trust
  the ledger for "what is still in the tray when the bus is dark."
- Tray position (`lastTrayCommand`) is a different fact with a different
  lifetime; it must not authorise erasing finished-disc records.
- A rip that just finished is the highest-value ledger update; losing it
  to a race reintroduces re-rip-on-restart.

## Evidence

- Live `bays.json` after the UHD success (2026-08-09): empty `records`,
  non-empty `trayCommands`.
- New tests: blind + standing trayCommands does not write empty records;
  finish-then-tower-off keeps `getLoadedDiscs().count === 1` and never
  wipes; completion survives an in-flight poll write.
