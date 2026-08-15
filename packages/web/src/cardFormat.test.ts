import { describe, expect, it } from "vitest"

import {
  bareDriveModel,
  isTrayOffered,
  jobActionsFor,
  trayOutcomeFor,
} from "./cardFormat"
import { buildBayView } from "./testing/buildRip"
import {
  buildTrayBayReport,
  buildTrayCommandReport,
} from "./testing/stubDataSource"

describe("bareDriveModel", () => {
  // §3: "the drives are prefixed with their slot number. Do we
  // need that if we're going to say 'slot 9' anyway?"
  it("drops the registry's slot prefix", () => {
    expect(
      bareDriveModel({
        label: "07 - Pioneer BDR-211M",
        slot: 7,
      }),
    ).toBe("Pioneer BDR-211M")
  })

  // The strip is conservative on purpose. A label whose leading
  // number is NOT this bay's slot is not a prefix — it is part
  // of the name, and mangling it leaves the operator holding a
  // drive he cannot find in the registry.
  it("leaves a number that is not this bay's slot alone", () => {
    expect(
      bareDriveModel({
        label: "07 - Pioneer BDR-211M",
        slot: 9,
      }),
    ).toBe("07 - Pioneer BDR-211M")
  })

  it("leaves a model that merely starts with a number alone", () => {
    expect(
      bareDriveModel({ label: "4K Something", slot: 4 }),
    ).toBe("4K Something")
  })

  it("says nothing when there is no label", () => {
    expect(bareDriveModel({ label: null, slot: 7 })).toBe(
      "",
    )
  })
})

describe("jobActionsFor", () => {
  // One drawer, one control. The two tray WORDS are still the
  // daemon's vocabulary; they are just no longer buttons.
  it("leaves the tray pair to the ⏏ toggle", () => {
    const actions = jobActionsFor(
      buildBayView({
        actions: ["cancel", "open_bay", "close_bay"],
        state: {
          ...buildBayView().state,
          state: "completed",
        },
      }),
    )

    expect(actions).toEqual(["cancel"])
  })
})

describe("isTrayOffered", () => {
  it("offers nothing to a bay that is ripping", () => {
    // Opening that tray destroys 90 GB and an hour. The daemon
    // would refuse it anyway; a button that exists only to be
    // refused is one somebody stops believing.
    expect(isTrayOffered(buildBayView())).toBe(false)
  })

  it("offers the toggle once the rip is over", () => {
    expect(
      isTrayOffered(
        buildBayView({
          state: {
            ...buildBayView().state,
            state: "completed",
          },
        }),
      ),
    ).toBe(true)
  })

  // The day the daemon publishes tray commands in `bay.actions`,
  // `trayActionsFor` deliberately returns nothing and those win.
  it("follows the daemon once it publishes the words itself", () => {
    expect(
      isTrayOffered(
        buildBayView({
          actions: ["open_bay"],
          state: {
            ...buildBayView().state,
            state: "completed",
          },
        }),
      ),
    ).toBe(true)
  })
})

describe("trayOutcomeFor", () => {
  const driveId = "usb-2-1-1-2-4-4-7"

  // ⚠️ The case that matters. `is_accepted: true` with a
  // `refused_ripping` bay means "I heard you, and no".
  it("reads the bay's refusal, never the rack-wide message", () => {
    expect(
      trayOutcomeFor({
        lastError: null,
        driveId,
        report: buildTrayCommandReport({
          is_accepted: true,
          message: "Opened 8 trays.",
          bays: [
            buildTrayBayReport({
              result: "refused_ripping",
              detail: "Slot 7 is ripping.",
            }),
          ],
        }),
      }),
    ).toEqual({
      text: "Slot 7 is ripping.",
      isTrouble: true,
    })
  })

  it("reads a moved drawer as no trouble", () => {
    expect(
      trayOutcomeFor({
        lastError: null,
        driveId,
        report: buildTrayCommandReport(),
      }),
    ).toEqual({ text: "Slot 7 opened.", isTrouble: false })
  })

  it("stays quiet about a bay the command never touched", () => {
    expect(
      trayOutcomeFor({
        lastError: null,
        driveId: "usb-some-other-bay",
        report: buildTrayCommandReport(),
      }),
    ).toBeNull()
  })

  // A command the daemon could not even read produces a
  // rejection with no bays in it. There is no per-bay sentence
  // to prefer, and silence would leave the press unanswered.
  it("falls back to the message when the report has no bays", () => {
    expect(
      trayOutcomeFor({
        lastError: null,
        driveId,
        report: buildTrayCommandReport({
          is_accepted: false,
          command: null,
          message: "Unrecognised command.",
          bays: [],
        }),
      }),
    ).toEqual({
      text: "Unrecognised command.",
      isTrouble: true,
    })
  })

  it("reports a transport failure as itself", () => {
    expect(
      trayOutcomeFor({
        lastError: "Error: /api/tray failed: 503",
        driveId,
        report: null,
      }),
    ).toEqual({
      text: "Error: /api/tray failed: 503",
      isTrouble: true,
    })
  })
})
