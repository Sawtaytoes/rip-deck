import { describe, expect, it } from "vitest"
import {
  adoptBayAtStartup,
  BAY_LEDGER_VERSION,
  type BayLedgerRecord,
  type BayTrayRecord,
  bayLedgerPath,
  ledgerFingerprint,
  parseBayLedger,
  toLedgerRecords,
  toTrayRecords,
  UNKNOWN_AT_STARTUP_DETAIL,
} from "./bayLedger.ts"
import {
  type BayObservation,
  type BayState,
  createBayState,
} from "./watcher.ts"

/**
 * Bay memory across a restart.
 *
 * ⚠️ **The assertion this file exists for is the first one**:
 * a restart with three finished discs still in their trays must
 * not re-rip them. That was live behaviour until this ledger —
 * `startWatcher` built its bay table from nothing, so every bay
 * came back `idle` and THE RULE (`done` + matching
 * `sizeSectors` → hold) could not fire. Measured cost on
 * 2026-07-26: three Troy discs, 225 GB, about two hours.
 *
 * The second thing it proves is that the fix did NOT quietly
 * ban the owner's headline feature. "Every inserted disc rips,
 * up to all nine at once" still holds for a tower that is
 * loaded and then started, as long as rip-deck has any memory at
 * all.
 */

const NOW_MS = 1_780_000_000_000
const BLURAY_SECTORS = 23_000_000

const observation = (
  input: Partial<BayObservation> = {},
): BayObservation => ({
  isDrivePresent: true,
  hasMedia: true,
  sizeSectors: BLURAY_SECTORS,
  ...input,
})

const DESTINATION_PATH = "/media/Disc-Rips/[BACKUP] TROY"

const JOB_UUID = "3f2b1c8e-0d4a-4f7b-9c1e-6a5d2b8f0e11"

const completedRecord = (
  input: Partial<BayLedgerRecord> = {},
): BayLedgerRecord => ({
  driveId: "usb-2-1.1.2.4.4.2",
  phase: "done",
  sizeSectors: BLURAY_SECTORS,
  discName: "TROY - THEATRICAL CUT",
  discType: "bluray",
  destinationPath: DESTINATION_PATH,
  jobUuid: JOB_UUID,
  outcome: {
    kind: "completed",
    detail: DESTINATION_PATH,
  },
  isLoadedDismissed: false,
  updatedAtMs: NOW_MS,
  ...input,
})

/** The disc half alone, which is what most of these assert. */
const fingerprintOf = (
  records: BayLedgerRecord[],
  trayCommands: BayTrayRecord[] = [],
): string => ledgerFingerprint({ records, trayCommands })

const bay = (input: Partial<BayState>): BayState => ({
  ...createBayState({
    driveId: "usb-2-1.1.2.4.4.2",
    atMs: NOW_MS,
  }),
  ...input,
})

describe("adoptBayAtStartup", () => {
  it("holds a finished disc that is still in its tray", () => {
    // THE regression. Without the ledger this bay comes back
    // `idle` and `decideBayAction` falls straight through to
    // `start`.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord(),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("done")
    expect(adopted.sizeSectors).toBe(BLURAY_SECTORS)
    expect(adopted.outcome?.kind).toBe("completed")
  })

  it("gives the held disc back its name and its folder", () => {
    // The Stage 7 defect. The name and the destination existed
    // only inside `outcome.detail`'s English sentence, so the
    // dashboard fell back to the BAY's label — the owner's three
    // Troy discs read as "07 - Pioneer BDR-211M" — and the path
    // was rendered as health evidence. Restoring them here is
    // what lets `towerFeed` pass both through as fields instead
    // of parsing prose.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord(),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.discName).toBe("TROY - THEATRICAL CUT")
    expect(adopted.destinationPath).toBe(DESTINATION_PATH)
  })

  it("gives the held disc back its type and its log", () => {
    // Both are unre-derivable here. `decideDiscType` needs udev
    // and a settled drive, and the capture id belongs to a rip
    // this process never ran — without it `towerFeed` falls back
    // to its `<driveId>@<ms>` placeholder, `armView` refuses to
    // name a file from that, and the card's log button vanishes
    // on every deploy.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord(),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.discType).toBe("bluray")
    expect(adopted.jobUuid).toBe(JOB_UUID)
  })

  it("remembers the tray on a bay with no disc in it", () => {
    // ⚠️ THE assertion the ⏏ toggle rests on. The bay the owner
    // presses next is the EMPTY one he has just taken a disc out
    // of, and every branch above returns the armed `idle` state
    // for it — so a tray memory restored only onto held discs
    // would answer only the bays that need no answer, and the
    // toggle would reset to "open" on every deploy.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: {
        driveId: "usb-2-1.1.2.4.4.2",
        lastTrayCommand: "open_bay",
        updatedAtMs: NOW_MS - 60_000,
      },
      record: undefined,
      hasPriorState: true,
      observation: observation({
        hasMedia: false,
        sizeSectors: 0,
      }),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("idle")
    expect(adopted.lastTrayCommand).toBe("open_bay")
  })

  it("keeps the tray memory on a HELD disc too", () => {
    // The other branch: a bay rip-deck opened, whose disc the
    // owner then left in the drawer. Nothing about adopting the
    // disc may overwrite what was done to the tray.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: {
        driveId: "usb-2-1.1.2.4.4.2",
        lastTrayCommand: "open_bay",
        updatedAtMs: NOW_MS - 60_000,
      },
      record: completedRecord(),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("done")
    expect(adopted.lastTrayCommand).toBe("open_bay")
  })

  it("names nothing on the fail-closed hold", () => {
    // No ledger at all, so there is no name to restore and the
    // disc has not been read. A label invented here would be the
    // exact fabrication this change exists to remove.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: undefined,
      hasPriorState: false,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.discName).toBeNull()
    expect(adopted.destinationPath).toBeNull()
  })

  it("marks the held disc as adopted, and dates it", () => {
    // The API has no other way to know. An adopted bay emits
    // exactly one "held on startup" note — which looks like any
    // other bay speaking — and never an outcome, so `/json`
    // rendered three held Troy discs as idle bays with an `ok`
    // verdict until the bay itself said otherwise.
    const finishedAtMs = NOW_MS - 7_200_000

    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord({
        updatedAtMs: finishedAtMs,
      }),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.isAdopted).toBe(true)
    // The instant the PREVIOUS daemon finished with the disc.
    // `updatedAtMs` cannot carry this: the first hold decision
    // of this very tick overwrites it with the clock.
    expect(adopted.latchedAtMs).toBe(finishedAtMs)
  })

  it("dates a fail-closed hold to now, having no better", () => {
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: undefined,
      hasPriorState: false,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.isAdopted).toBe(true)
    expect(adopted.latchedAtMs).toBe(NOW_MS)
  })

  it("does not call an armed bay's next disc adopted", () => {
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord(),
      hasPriorState: true,
      observation: observation({
        hasMedia: false,
        sizeSectors: 0,
      }),
      atMs: NOW_MS,
    })

    expect(adopted.isAdopted).toBe(false)
    expect(adopted.latchedAtMs).toBeNull()
  })

  it("restores a quarantine rather than re-arming it", () => {
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord({
        phase: "quarantined",
        outcome: {
          kind: "needs_attention",
          detail: "started three times",
        },
      }),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("quarantined")
  })

  it("arms an empty bay, ledger or no ledger", () => {
    for (const hasPriorState of [true, false]) {
      expect(
        adoptBayAtStartup({
          driveId: "usb-2-1.1.2.4.4.2",
          trayRecord: undefined,
          record: completedRecord(),
          hasPriorState,
          observation: observation({
            hasMedia: false,
            sizeSectors: 0,
          }),
          atMs: NOW_MS,
        }).phase,
      ).toBe("idle")
    }
  })

  it("still rips a NEW disc when rip-deck has memory", () => {
    // The owner's headline decision: "if I insert 9 discs,
    // start 9 rips". A ledger that exists and does not mention
    // this disc is positive evidence that it is new, so the
    // hold must not fire.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: completedRecord({ sizeSectors: 1_234 }),
      hasPriorState: true,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("idle")
    expect(adopted.outcome).toBeNull()
  })

  it("holds a loaded disc when there is NO memory at all", () => {
    // The one genuinely ambiguous case, and the one that
    // matters on the deploy that introduces this file: three
    // finished discs are sitting in the tower and nothing on
    // disk says so. Fail closed.
    const adopted = adoptBayAtStartup({
      driveId: "usb-2-1.1.2.4.4.2",
      trayRecord: undefined,
      record: undefined,
      hasPriorState: false,
      observation: observation(),
      atMs: NOW_MS,
    })

    expect(adopted.phase).toBe("done")
    expect(adopted.outcome?.kind).toBe("needs_attention")
    expect(adopted.outcome?.detail).toBe(
      UNKNOWN_AT_STARTUP_DETAIL,
    )
    // The fingerprint is carried so THE RULE holds it from the
    // next tick on, rather than re-deciding every five seconds.
    expect(adopted.sizeSectors).toBe(BLURAY_SECTORS)
  })

  it("never adopts a bay whose drive is off the bus", () => {
    // A drive missing from the probe says nothing about its
    // disc — USB re-enumeration is routine on this tower.
    expect(
      adoptBayAtStartup({
        driveId: "usb-2-1.1.2.4.4.2",
        trayRecord: undefined,
        record: undefined,
        hasPriorState: false,
        observation: observation({
          isDrivePresent: false,
          hasMedia: false,
        }),
        atMs: NOW_MS,
      }).phase,
    ).toBe("idle")
  })
})

describe("toLedgerRecords", () => {
  it("remembers only latched bays", () => {
    const records = toLedgerRecords([
      bay({
        driveId: "a",
        phase: "done",
        outcome: { kind: "completed", detail: "/dest/a" },
      }),
      bay({
        driveId: "b",
        phase: "quarantined",
        outcome: { kind: "needs_attention", detail: "x" },
      }),
      bay({ driveId: "c", phase: "idle" }),
      // Mid-flight. Writing this down would claim a result for
      // a rip that the crash we are recovering from
      // interrupted.
      bay({ driveId: "d", phase: "ripping" }),
      bay({ driveId: "e", phase: "starting" }),
    ])

    expect(records.map((record) => record.driveId)).toEqual(
      ["a", "b"],
    )
  })

  it("writes the disc name and the destination down", () => {
    // Without these two on the record there is nothing for
    // `adoptBayAtStartup` to restore, and the card after a
    // restart is nameless again.
    const [record] = toLedgerRecords([
      bay({
        phase: "done",
        discName: "TROY - THEATRICAL CUT",
        destinationPath: DESTINATION_PATH,
        outcome: {
          kind: "completed",
          detail: DESTINATION_PATH,
        },
      }),
    ])

    expect(record.discName).toBe("TROY - THEATRICAL CUT")
    expect(record.destinationPath).toBe(DESTINATION_PATH)
  })

  it("writes the disc type and the capture id down", () => {
    // The type routes the poster lookup — a music provider for
    // an audio CD, a film one for a film — and the capture id
    // names `<uuid>.robot.log`, which is the only reason a held
    // disc's card still offers its log after a restart.
    const [record] = toLedgerRecords([
      bay({
        phase: "done",
        discType: "cd",
        jobUuid: JOB_UUID,
        outcome: { kind: "completed", detail: "/dest/a" },
      }),
    ])

    expect(record.discType).toBe("cd")
    expect(record.jobUuid).toBe(JOB_UUID)
  })
})

describe("toTrayRecords", () => {
  it("remembers a tray rip-deck moved, in ANY phase", () => {
    // Phase-blind on purpose, and the `idle` bay is the whole
    // point: the ⏏ toggle's question — "does the next press
    // close it?" — is asked about a bay whose disc has already
    // been taken out. `toLedgerRecords` would have dropped it.
    const records = toTrayRecords([
      bay({ driveId: "a", lastTrayCommand: "open_bay" }),
      bay({
        driveId: "b",
        phase: "ripping",
        lastTrayCommand: "close_bay",
      }),
      bay({ driveId: "c", phase: "done" }),
    ])

    expect(records).toEqual([
      {
        driveId: "a",
        lastTrayCommand: "open_bay",
        updatedAtMs: NOW_MS,
      },
      {
        driveId: "b",
        lastTrayCommand: "close_bay",
        updatedAtMs: NOW_MS,
      },
    ])
  })

  it("says nothing about a drawer it never touched", () => {
    // Absent, not `null`: "I have done nothing to this bay" is
    // the reading `nextTrayCommandFor` degrades to `open_bay`
    // on, and writing a row for all nine bays would claim
    // otherwise.
    expect(toTrayRecords([bay({ driveId: "a" })])).toEqual(
      [],
    )
  })
})

describe("ledgerFingerprint", () => {
  it("ignores the clock, so a held bay is not rewritten", () => {
    // `updatedAtMs` moves every tick for a held bay; comparing
    // serialised ledgers would rewrite the file every five
    // seconds forever.
    expect(fingerprintOf([completedRecord()])).toBe(
      fingerprintOf([
        completedRecord({ updatedAtMs: NOW_MS + 60_000 }),
      ]),
    )
  })

  it("changes when the disc name or destination does", () => {
    // A bay whose phase and outcome kind are unchanged but
    // whose name was re-read (or corrected with `--name`) must
    // still reach the disk. Leaving these out of the
    // fingerprint would persist the first name a bay ever had
    // and keep it forever.
    expect(fingerprintOf([completedRecord()])).not.toBe(
      fingerprintOf([
        completedRecord({ discName: "TROY - BONUS DISC" }),
      ]),
    )

    expect(fingerprintOf([completedRecord()])).not.toBe(
      fingerprintOf([
        completedRecord({
          destinationPath: `${DESTINATION_PATH} (2)`,
        }),
      ]),
    )
  })

  it("changes when only a tray moved", () => {
    // The sharpest case for including the tray half: opening a
    // bay changes NOTHING on its disc record — same phase, same
    // outcome, often no record at all — so a fingerprint over
    // the records alone would skip the write, and the ⏏ toggle
    // would come back from the restart pointing the wrong way.
    expect(fingerprintOf([completedRecord()], [])).not.toBe(
      fingerprintOf(
        [completedRecord()],
        [
          {
            driveId: "usb-2-1.1.2.4.4.2",
            lastTrayCommand: "open_bay",
            updatedAtMs: NOW_MS,
          },
        ],
      ),
    )
  })

  it("changes when an outcome does", () => {
    expect(fingerprintOf([completedRecord()])).not.toBe(
      fingerprintOf([
        completedRecord({
          outcome: {
            kind: "failed",
            detail: "read errors",
          },
        }),
      ]),
    )
  })
})

describe("parseBayLedger", () => {
  it("round-trips a written ledger", () => {
    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [completedRecord()],
      }),
    )

    expect(parsed.hasPriorState).toBe(true)
    expect(parsed.records).toHaveLength(1)
  })

  it("treats a corrupt file as NO memory, not empty memory", () => {
    // The difference decides whether a loaded disc rips. A
    // truncated ledger has lost the record of what finished, so
    // it must fail closed exactly like a missing one.
    for (const raw of [
      "{ not json",
      "[]",
      '{"version":99,"records":[]}',
    ]) {
      expect(parseBayLedger(raw).hasPriorState).toBe(false)
    }
  })

  it("forgets a v1 ledger, so its discs are held", () => {
    // The cost of the v2 bump, stated as a test rather than as
    // a hope. The ledger sitting on the tower right now is v1
    // and has no `discName`/`destinationPath`; it reads as NO
    // memory, which is `adoptBayAtStartup`'s fail-closed branch
    // — every loaded disc HELD and flagged, never re-ripped.
    // The owner sees "held on startup" once, and the first tick
    // writes a v2 ledger.
    const parsed = parseBayLedger(
      JSON.stringify({
        version: 1,
        records: [
          {
            driveId: "usb-2-1.1.2.4.4.2",
            phase: "done",
            sizeSectors: BLURAY_SECTORS,
            outcome: {
              kind: "completed",
              detail: DESTINATION_PATH,
            },
            updatedAtMs: NOW_MS,
          },
        ],
      }),
    )

    expect(parsed.hasPriorState).toBe(false)
    expect(parsed.records).toEqual([])

    // And that is what holds the disc: no record, no memory.
    expect(
      adoptBayAtStartup({
        driveId: "usb-2-1.1.2.4.4.2",
        trayRecord: undefined,
        record: parsed.records[0],
        hasPriorState: parsed.hasPriorState,
        observation: observation(),
        atMs: NOW_MS,
      }).outcome?.detail,
    ).toBe(UNKNOWN_AT_STARTUP_DETAIL)
  })

  it("drops a v2 record missing the new fields", () => {
    // Only reachable by hand-editing — `toLedgerRecords`
    // always writes both — and the safe reading of a
    // half-written record is to drop it, which holds that bay's
    // disc rather than trusting the half that is there.
    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [
          completedRecord(),
          {
            driveId: "usb-2-1.1.2.4.4.3",
            phase: "done",
            sizeSectors: BLURAY_SECTORS,
            outcome: { kind: "completed", detail: "x" },
            updatedAtMs: NOW_MS,
          },
        ],
      }),
    )

    expect(parsed.records).toHaveLength(1)
  })

  it("reads a dismissal, and an absent one as not dismissed", () => {
    // The reminder the operator already silenced must stay
    // silenced across the deploy that lands ten minutes later —
    // and a ledger written before the field existed must not read
    // as "he said it was out", which would go quiet about a disc
    // nobody has touched.
    const withoutField: Partial<BayLedgerRecord> =
      completedRecord()

    delete withoutField.isLoadedDismissed

    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [
          withoutField,
          completedRecord({
            driveId: "usb-2-1.1.2.4.4.3",
            isLoadedDismissed: true,
          }),
        ],
      }),
    )

    expect(parsed.records[0].isLoadedDismissed).toBe(false)
    expect(parsed.records[1].isLoadedDismissed).toBe(true)

    // And it rides the adoption, so the bay comes back dismissed
    // rather than reminding about a disc already taken out.
    expect(
      adoptBayAtStartup({
        driveId: "usb-2-1.1.2.4.4.3",
        record: parsed.records[1],
        trayRecord: undefined,
        hasPriorState: true,
        observation: observation(),
        atMs: NOW_MS,
      }).isLoadedDismissed,
    ).toBe(true)
  })

  it("keeps a v2 record written before discType existed", () => {
    // The other side of the strictness above, and the reason
    // `BAY_LEDGER_VERSION` stayed at 2. v2 has never deployed,
    // so several v2 writers exist across this stage — a file
    // from an earlier one is a real v2 file that simply has no
    // `discType`/`jobUuid`. Dropping it would hold that bay's
    // disc for no reason at all; absent reads as null, which is
    // what "nobody recorded this" already means here.
    const withoutNewFields: Partial<BayLedgerRecord> =
      completedRecord()

    delete withoutNewFields.discType
    delete withoutNewFields.jobUuid

    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [withoutNewFields],
      }),
    )

    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].discType).toBeNull()
    expect(parsed.records[0].jobUuid).toBeNull()
    // And the disc is still HELD by its fingerprint, which is
    // the whole point of not dropping the record.
    expect(parsed.records[0].sizeSectors).toBe(
      BLURAY_SECTORS,
    )
  })

  it("reads the tray memory back, and only real commands", () => {
    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [],
        trayCommands: [
          {
            driveId: "a",
            lastTrayCommand: "open_bay",
            updatedAtMs: NOW_MS,
          },
          // Neither is a thing rip-deck can do to one drawer. A
          // toggle driven by a value nobody wrote would mean the
          // opposite of what it says, and the cost of dropping
          // it is one press of a button that opens a tray.
          {
            driveId: "b",
            lastTrayCommand: "open_completed",
            updatedAtMs: NOW_MS,
          },
          { driveId: "c", updatedAtMs: NOW_MS },
        ],
      }),
    )

    expect(parsed.trayCommands).toEqual([
      {
        driveId: "a",
        lastTrayCommand: "open_bay",
        updatedAtMs: NOW_MS,
      },
    ])
  })

  it("treats a missing tray section as nothing moved", () => {
    // Not an error, and not a reason to distrust the records
    // beside it: no tray memory is exactly "rip-deck has moved
    // nothing", which the toggle degrades to `open_bay` on.
    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [completedRecord()],
      }),
    )

    expect(parsed.trayCommands).toEqual([])
    expect(parsed.records).toHaveLength(1)
  })

  it("drops records it cannot trust rather than throwing", () => {
    const parsed = parseBayLedger(
      JSON.stringify({
        version: BAY_LEDGER_VERSION,
        records: [
          completedRecord(),
          { driveId: 7 },
          { driveId: "x", phase: "ripping" },
        ],
      }),
    )

    expect(parsed.records).toHaveLength(1)
  })
})

describe("bayLedgerPath", () => {
  it("lives beside the job artefacts", () => {
    expect(bayLedgerPath("/var/lib/rip-deck")).toBe(
      "/var/lib/rip-deck/bays.json",
    )
  })
})
