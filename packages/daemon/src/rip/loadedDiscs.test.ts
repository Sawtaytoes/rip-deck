import { describe, expect, it } from "vitest"
import {
  buildLoadedDiscsPayload,
  type LedgerLoadedRecord,
  type LoadedDiscBay,
  phantomLoadedBays,
  shouldPublishLoadedDiscs,
  summariseLoadedDiscs,
} from "./loadedDiscs.ts"

/**
 * The take-the-discs-out reminder.
 *
 * ⚠️ **The most important test in this file is the one about NOT
 * publishing.** Every other fact rip-deck emits describes what is
 * happening now and is worthless once the tower is dark; this one
 * is a chore that is *loudest* when the tower is dark, so it is
 * retained — and a retained topic is only as trustworthy as the
 * rule that decides what may overwrite it. A daemon that restarts
 * against a powered-off tower knows nothing, and "nothing" must
 * never be published as "all clear".
 */

const NOW_MS = 1_780_000_000_000

const bay = (
  input: Partial<LoadedDiscBay> = {},
): LoadedDiscBay => ({
  slot: 7,
  label: "07 - Pioneer BDR-211M",
  isDrivePresent: true,
  hasDisc: true,
  isLatched: true,
  isRipped: true,
  title: "TROY - BONUS DISC",
  ...input,
})

describe("summariseLoadedDiscs", () => {
  it("counts only discs rip-deck is finished with", () => {
    const summary = summariseLoadedDiscs([
      bay({ slot: 7 }),
      // Mid-rip: not the operator's to collect yet.
      bay({ slot: 8, isLatched: false }),
      // Empty tray.
      bay({ slot: 9, hasDisc: false }),
    ])

    expect(summary.count).toBe(1)
    expect(summary.discs.map((d) => d.slot)).toEqual([7])
  })

  it("reads the rack in slot order", () => {
    const summary = summariseLoadedDiscs([
      bay({ slot: 9 }),
      bay({ slot: 2 }),
      // An unregistered bay has no slot and sorts LAST — a bare
      // `?? 0` would put it in front of slot 2.
      bay({ slot: null, label: "2-1.3.2" }),
      bay({ slot: 7 }),
    ])

    expect(summary.discs.map((d) => d.slot)).toEqual([
      2,
      7,
      9,
      null,
    ])
  })

  it("still answers with every drive off the bus", () => {
    // ⚠️ The whole point. A powered-off tower has nothing to
    // probe, so this is answered from the bay and sighting tables
    // — which `tickNow` keeps rather than drops when a drive
    // leaves. If this ever regresses to reading presence, the
    // reminder goes silent exactly when it is needed.
    const summary = summariseLoadedDiscs([
      bay({ slot: 7, isDrivePresent: false }),
      bay({ slot: 8, isDrivePresent: false }),
    ])

    expect(summary.count).toBe(2)
    expect(summary.isTowerOn).toBe(false)
    expect(summary.message).toContain("2 discs are still")
    expect(summary.message).toContain("slots 7 and 8")
  })

  it("says what to do, and it changes with the power", () => {
    // A reminder naming a control that cannot work right now is
    // the held-card defect in a different costume.
    expect(
      summariseLoadedDiscs([bay({ isDrivePresent: true })])
        .message,
    ).toContain("Press Open trays")

    expect(
      summariseLoadedDiscs([bay({ isDrivePresent: false })])
        .message,
    ).toContain("The tower is off")
  })

  it("agrees in number for one disc", () => {
    const summary = summariseLoadedDiscs([bay({ slot: 9 })])

    expect(summary.message).toContain("1 disc is still")
    expect(summary.message).toContain("slot 9")
    expect(summary.spokenMessage).toBe(
      "A disc is still in the optical ripper tower, in slot 9.",
    )
  })

  it("says nothing at all when the trays are empty", () => {
    const summary = summariseLoadedDiscs([
      bay({ hasDisc: false }),
    ])

    expect(summary.count).toBe(0)
    expect(summary.message).toBe("")
    expect(summary.spokenMessage).toBe("")
  })

  it("never speaks a drive model", () => {
    // Same rule as `spoken_message`: "07 - Pioneer BDR-211M"
    // comes out of a house speaker as a part number.
    const spoken = summariseLoadedDiscs([
      bay({ slot: 7 }),
      bay({ slot: 8 }),
    ]).spokenMessage

    expect(spoken).not.toContain("Pioneer")
    expect(spoken).not.toContain("BDR")
  })
})

describe("shouldPublishLoadedDiscs", () => {
  it("⚠️ refuses to publish a blind all-clear", () => {
    // The case: the daemon restarted while the tower was off AND
    // the ledger was unreadable, so it knows NOTHING — the summary
    // is empty out of ignorance, not because the discs came out.
    // The watcher marks that with `isBlind`. Publishing it over the
    // retained reminder would leave the owner coming home to a
    // dashboard that had quietly forgotten three discs.
    const blind = summariseLoadedDiscs([], {
      isBlind: true,
    })

    expect(blind.count).toBe(0)
    expect(blind.isTowerOn).toBe(false)
    expect(blind.isBlind).toBe(true)
    expect(shouldPublishLoadedDiscs(blind)).toBe(false)
  })

  it("publishes a readable all-clear from disk", () => {
    // The disk-first correction: the daemon restarted against a
    // dark tower but READ its ledger, which recorded nothing
    // loaded. That is a genuine all-clear — the discs are out — so
    // it publishes and a stale reminder clears itself, even with no
    // drive on the bus to see. `isBlind` defaults false: an empty
    // summary is only withheld when the watcher says it is blind.
    const readable = summariseLoadedDiscs([])

    expect(readable.count).toBe(0)
    expect(readable.isTowerOn).toBe(false)
    expect(readable.isBlind).toBe(false)
    expect(shouldPublishLoadedDiscs(readable)).toBe(true)
  })

  it("is never blind while a drive is on the bus", () => {
    // A present drive can always be re-probed, so `isBlind` is
    // forced false whatever the caller passes.
    const present = summariseLoadedDiscs(
      [bay({ hasDisc: false, isDrivePresent: true })],
      { isBlind: true },
    )

    expect(present.isBlind).toBe(false)
    expect(shouldPublishLoadedDiscs(present)).toBe(true)
  })

  it("publishes a real all-clear", () => {
    // Bays we can SEE, and they are empty. The discs came out —
    // that is evidence, and it clears the reminder.
    const seen = summariseLoadedDiscs([
      bay({ hasDisc: false, isDrivePresent: true }),
    ])

    expect(seen.count).toBe(0)
    expect(shouldPublishLoadedDiscs(seen)).toBe(true)
  })

  it("publishes a finding even with the tower dark", () => {
    // The reminder itself, republished so `updated_at` stays
    // fresh while the tower is off.
    expect(
      shouldPublishLoadedDiscs(
        summariseLoadedDiscs([
          bay({ isDrivePresent: false }),
        ]),
      ),
    ).toBe(true)
  })
})

describe("phantomLoadedBays", () => {
  const record = (
    input: Partial<LedgerLoadedRecord> = {},
  ): LedgerLoadedRecord => ({
    driveId: "usb-2-1-3-4",
    phase: "done",
    discName: "TROY - BONUS DISC",
    isRipped: true,
    ...input,
  })

  // Slot 7 for the one driveId the tests use, driveId as the label
  // for anything the registry never heard of — the same collapse
  // `placementForDriveId` makes.
  const placementOf = (driveId: string) =>
    driveId === "usb-2-1-3-4"
      ? { slot: 7, label: "07 - Pioneer BDR-211M" }
      : { slot: null, label: driveId }

  it("rebuilds a loaded disc from a ledger record alone", () => {
    // The whole point: a restart against a dark tower, no bay
    // built, the fact reconstructed from disk.
    const [phantom, ...rest] = phantomLoadedBays({
      records: [record()],
      liveDriveIds: new Set(),
      placementOf,
    })

    expect(rest).toHaveLength(0)
    expect(phantom).toEqual({
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      // ⚠️ Never on the bus — a phantom is a display fact, never a
      // rip input, and this false is what keeps it out of every
      // probe-driven path.
      isDrivePresent: false,
      hasDisc: true,
      isLatched: true,
      isRipped: true,
      title: "TROY - BONUS DISC",
    })
  })

  it("folds through summarise into a real reminder", () => {
    // End to end: ledger record → phantom → the sentence the
    // banner and Home Assistant read, with the tower off.
    const summary = summariseLoadedDiscs(
      phantomLoadedBays({
        records: [record()],
        liveDriveIds: new Set(),
        placementOf,
      }),
      // A restart with the tower off but a readable ledger: known,
      // not blind, so the all-clear/finding publishes.
      { isBlind: false },
    )

    expect(summary.count).toBe(1)
    expect(summary.isTowerOn).toBe(false)
    expect(summary.message).toContain("1 disc is still")
    expect(summary.message).toContain("The tower is off")
  })

  it("yields to a live bay for the same drive", () => {
    // Once the tower is back and the drive answers, a REAL bay is
    // adopted for that driveId; the phantom must step aside or the
    // disc is counted twice.
    expect(
      phantomLoadedBays({
        records: [record()],
        liveDriveIds: new Set(["usb-2-1-3-4"]),
        placementOf,
      }),
    ).toHaveLength(0)
  })

  it("carries a quarantined hold, and an unread disc's null name", () => {
    const [phantom] = phantomLoadedBays({
      records: [
        record({
          phase: "quarantined",
          discName: null,
          isRipped: false,
        }),
      ],
      liveDriveIds: new Set(),
      placementOf,
    })

    expect(phantom?.isLatched).toBe(true)
    expect(phantom?.isRipped).toBe(false)
    expect(phantom?.title).toBeNull()
  })
})

describe("buildLoadedDiscsPayload", () => {
  it("carries the numbers AND the finished sentences", () => {
    // Home Assistant's job is deciding WHEN to remind, not
    // composing an English list out of a slot array in Jinja.
    const payload = buildLoadedDiscsPayload({
      summary: summariseLoadedDiscs([
        bay({ slot: 7, title: "TROY - BONUS DISC" }),
        bay({
          slot: 9,
          title: null,
          isRipped: false,
          isDrivePresent: false,
        }),
      ]),
      nowMs: NOW_MS,
    })

    expect(payload.count).toBe(2)
    expect(payload.slots).toEqual([7, 9])
    expect(payload.discs[0]).toEqual({
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      title: "TROY - BONUS DISC",
      is_ripped: true,
    })
    expect(payload.discs[1].is_ripped).toBe(false)
    expect(payload.message).not.toBe("")
    expect(payload.spoken_message).not.toBe("")
    expect(payload.updated_at).toBe(NOW_MS)
  })

  it("omits a slotless bay from `slots` but not from `discs`", () => {
    // `slots` is the operator's numbering, so a bay that has none
    // cannot appear in it — and dropping the disc entirely would
    // make the count disagree with the list.
    const payload = buildLoadedDiscsPayload({
      summary: summariseLoadedDiscs([
        bay({ slot: null, label: "2-1.3.2" }),
      ]),
      nowMs: NOW_MS,
    })

    expect(payload.count).toBe(1)
    expect(payload.slots).toEqual([])
    expect(payload.discs).toHaveLength(1)
  })
})
