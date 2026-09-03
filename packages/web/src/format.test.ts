import type { JobState } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"

import {
  bayActionLabel,
  bayActionsFor,
  discLabel,
  discTypeText,
  driveName,
  elapsedText,
  estimatedCompletionText,
  etaText,
  etaTrendText,
  humanDuration,
  isBayHeld,
  isVerdictActionable,
  kindLabel,
  latestPerDrive,
  nextTrayCommandFor,
  ripBucket,
  ripVisual,
  ripWarningLines,
  throughputText,
  trayActionsFor,
  trayReportToActionResult,
  verdictTone,
} from "./format"
import { buildBayView, buildRip } from "./testing/buildRip"
import type { TrayCommandReport } from "./types"

describe("kindLabel", () => {
  it("keeps 4K distinct from Blu-ray", () => {
    // `armView.toArmKind` refuses to call a 4K disc a Blu-ray to
    // win a prettier glyph, so the UI must not undo that. The
    // marks are held to the same rule in
    // `DiscKindLogo.test.tsx`.
    expect(kindLabel("uhd")).toBe("4K")
    expect(kindLabel("bluray")).toBe("Blu-ray")
  })

  it("falls back for a kind it has never seen", () => {
    expect(kindLabel("hd-dvd")).toBe("hd-dvd")
  })
})

describe("ripVisual", () => {
  it("fills and labels a running rip", () => {
    const visual = ripVisual(buildRip({ percent: 43.2 }))

    expect(visual.state).toBe("running")
    expect(visual.fillPercent).toBe(43.2)
    expect(visual.percentText).toBe("43.2%")
  })

  it("sweeps rather than fills during the preamble", () => {
    // Active with no percent is the AACS/BD+ handshake, which is
    // genuinely slow and emits nothing. A full bar would read as
    // finished and an empty one as wedged.
    const visual = ripVisual(
      buildRip({ active: true, percent: null }),
    )

    expect(visual.state).toBe("indeterminate")
  })

  it("marks a finished rip done", () => {
    const visual = ripVisual(
      buildRip({
        status: "success",
        active: false,
        percent: 100,
      }),
    )

    expect(visual.state).toBe("done")
    expect(visual.percentText).toBe("done")
  })

  // The one rule that overrides everything, with one word
  // changed on 2026-08-27: never report a rip that had read
  // errors as a PLAIN success. It is not a failure either — the
  // backup exists — so it gets the third colour
  // ([decision](https://mkdocs.octen.dev/workspace/rip-deck/docs/decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure/)).
  it("refuses to paint a read-error rip as plain done", () => {
    const visual = ripVisual(
      buildRip({
        status: "success",
        active: false,
        percent: 100,
        read_error_count: 12,
      }),
    )

    expect(visual.state).toBe("warning")
    expect(visual.percentText).toBe("warning")
  })

  it("paints a warning even when the error count did not travel", () => {
    // `warnings` and `read_error_count` are two different
    // fields, and the retained MQTT payload carries only a
    // flag. Either one alone must reach amber.
    const visual = ripVisual(
      buildRip({
        status: "success",
        active: false,
        percent: 100,
        read_error_count: 0,
        warnings: [
          "MakeMKV's hash check found corrupt files.",
        ],
      }),
    )

    expect(visual.state).toBe("warning")
  })

  it("still paints a genuinely FAILED rip as failed", () => {
    const visual = ripVisual(
      buildRip({
        status: "fail",
        active: false,
        percent: 62,
        read_error_count: 41,
      }),
    )

    expect(visual.state).toBe("failed")
  })
})

describe("etaText", () => {
  // §2.4: the viewer extrapolated the ETA from elapsed and
  // percent, and every MakeMKV stage restarts PRGV from zero, so
  // that fit crossed a discontinuity and reported a rising ETA
  // on a healthy rip. We only ever show the measured figure.
  it("renders the daemon's measured seconds", () => {
    expect(etaText(900)).toBe("~15m left")
    expect(etaText(4_500)).toBe("~1h15m left")
  })

  it("says nothing rather than guessing when there is no rate", () => {
    expect(etaText(null)).toBe("")
    expect(etaText(0)).toBe("")
  })
})

describe("estimatedCompletionText", () => {
  it("adds the daemon's measured ETA to the current clock time", () => {
    const now = new Date("2026-07-26T12:12:00").getTime()
    const expectedTime = new Intl.DateTimeFormat(
      undefined,
      {
        hour: "numeric",
        minute: "2-digit",
      },
    ).format(new Date(now + 900_000))

    expect(estimatedCompletionText(900, now)).toBe(
      `Estimated finish ${expectedTime}`,
    )
  })

  it("says nothing until the daemon has measured a rate", () => {
    expect(estimatedCompletionText(null)).toBe("")
    expect(estimatedCompletionText(0)).toBe("")
  })
})

describe("etaTrendText", () => {
  it("speaks only for a rising ETA", () => {
    // 49 of 722 progress lines on a flawless Blu-ray reported a
    // rising ETA. Saying it is right; alarming is not, and
    // "falling"/"steady" are what every healthy rip does.
    expect(etaTrendText("rising")).toBe("ETA rising")
    expect(etaTrendText("falling")).toBe("")
    expect(etaTrendText("steady")).toBe("")
    expect(etaTrendText(null)).toBe("")
  })
})

describe("humanDuration / elapsedText / throughputText", () => {
  it("formats compactly and clamps negatives", () => {
    expect(humanDuration(-5)).toBe("0s")
    expect(humanDuration(45)).toBe("45s")
    expect(humanDuration(240)).toBe("4m")
    expect(humanDuration(4_320)).toBe("1h12m")
    expect(humanDuration(3_600)).toBe("1h")
  })

  it("parses the daemon's local wall-clock timestamps", () => {
    // `formatLocalTimestamp` writes local time, not UTC. Parsing
    // this as UTC would put the start hours in the future and
    // every elapsed figure on the page would clamp to 0s.
    const now = new Date("2026-07-26T12:12:00").getTime()

    expect(elapsedText("2026-07-26 12:00:00", now)).toBe(
      "12m elapsed",
    )
  })

  it("says nothing without a start time", () => {
    expect(elapsedText(null)).toBe("")
  })

  it("renders throughput in MB/s", () => {
    expect(throughputText(21 * 1024 * 1024)).toBe(
      "21.0 MB/s",
    )
    expect(throughputText(null)).toBe("")
  })
})

describe("driveName", () => {
  it("strips the /dev prefix", () => {
    expect(driveName("/dev/sr0")).toBe("sr0")
    expect(driveName(null)).toBe("?")
  })
})

describe("ripBucket", () => {
  it("puts an active rip in ripping", () => {
    expect(ripBucket(buildRip({ active: true }))).toBe(
      "ripping",
    )
  })

  it("puts a clean finished rip in recent", () => {
    expect(
      ripBucket(
        buildRip({ active: false, status: "success" }),
      ),
    ).toBe("recent")
  })

  it("wants a human for a failure", () => {
    expect(
      ripBucket(
        buildRip({ active: false, status: "fail" }),
      ),
    ).toBe("attention")
  })

  it("wants a human for read errors on a 'successful' rip", () => {
    expect(
      ripBucket(
        buildRip({
          active: false,
          status: "success",
          read_error_count: 3,
        }),
      ),
    ).toBe("attention")
  })

  it("wants a human for a non-ok verdict", () => {
    expect(
      ripBucket(
        buildRip({
          active: false,
          status: "success",
          verdict: "disc_scratched",
        }),
      ),
    ).toBe("attention")
  })
})

describe("latestPerDrive", () => {
  // The key is `drive_id`, not `/dev/srN`. srN reshuffles on
  // every USB re-enumeration — which is what happens each time
  // the tower is power-cycled — so keying on it merges two
  // bays' histories into one card.
  it("keeps one card per stable drive id", () => {
    const latest = latestPerDrive([
      buildRip({
        job_uuid: "new",
        drive_id: "usb-a",
        drive: "/dev/sr0",
      }),
      buildRip({
        job_uuid: "old",
        drive_id: "usb-a",
        drive: "/dev/sr0",
      }),
      buildRip({
        job_uuid: "other",
        drive_id: "usb-b",
        drive: "/dev/sr0",
      }),
    ])

    expect(latest.map((rip) => rip.job_uuid)).toEqual([
      "new",
      "other",
    ])
  })

  it("does not merge two bays that share an srN", () => {
    const latest = latestPerDrive([
      buildRip({ drive_id: "usb-a", drive: "/dev/sr0" }),
      buildRip({ drive_id: "usb-b", drive: "/dev/sr0" }),
    ])

    expect(latest).toHaveLength(2)
  })
})

describe("verdictTone", () => {
  // Dirty and scratched are the pair this project turns on:
  // identical symptoms, opposite advice. They share a tone on
  // purpose — the difference lives in the sentence, and a colour
  // difference would invite reading the colour instead.
  it("gives dirty and scratched the same tone", () => {
    expect(verdictTone("disc_dirty")).toBe("disc")
    expect(verdictTone("disc_scratched")).toBe("disc")
  })

  it("separates hardware trouble from disc trouble", () => {
    expect(verdictTone("hub_fault")).toBe("hardware")
    expect(verdictTone("drive_failing")).toBe("hardware")
    expect(verdictTone("key_expired")).toBe("hardware")
    expect(verdictTone("ok")).toBe("ok")
  })
})

describe("bayActionLabel", () => {
  it("names every action the daemon can publish", () => {
    expect(bayActionLabel("clear_quarantine")).toBe(
      "Clear quarantine",
    )
    expect(bayActionLabel("retry_in_another_drive")).toBe(
      "Retry in another drive",
    )
    expect(bayActionLabel("keep_trying")).toBe(
      "Keep trying",
    )
    expect(bayActionLabel("give_up")).toBe("Give up")
    expect(bayActionLabel("cancel")).toBe("Cancel")
  })

  it("calls the tray commands what they move", () => {
    expect(bayActionLabel("open_bay")).toBe("Open tray")
    expect(bayActionLabel("close_bay")).toBe("Close tray")
  })
})

describe("ripWarningLines", () => {
  it("puts each warning sentence on its own scan line", () => {
    expect(
      ripWarningLines(
        "One read error at 788.3 MB. The copy was saved. Play the disc.",
      ),
    ).toEqual([
      "One read error at 788.3 MB.",
      "The copy was saved.",
      "Play the disc.",
    ])
  })
})

/**
 * The one control the UI derives rather than renders.
 *
 * The safety half of these tests is the important half:
 * `docs/eject-and-durable-bay-state.md` §2 makes refusing a
 * mid-rip tray command the FIRST branch of `decideTrayBayAction`,
 * and the daemon would refuse one regardless — but a button that
 * exists only to be refused is a button somebody eventually
 * stops believing.
 */
describe("trayActionsFor", () => {
  const bayInState = (state: JobState | "idle") =>
    buildBayView({
      state: { ...buildBayView().state, state },
    })

  it("offers nothing while a rip owns the drive", () => {
    const owned: (JobState | "idle")[] = [
      "settling",
      "identifying",
      "queued",
      "ripping",
      "throttled",
      "stalled",
      "finalising",
    ]

    for (const state of owned) {
      expect(trayActionsFor(bayInState(state))).toEqual([])
    }
  })

  it("offers to open a bay holding a finished disc", () => {
    const latched: (JobState | "idle")[] = [
      "completed",
      "failed",
      "cancelled",
      "needs_attention",
    ]

    for (const state of latched) {
      expect(trayActionsFor(bayInState(state))).toEqual([
        "open_bay",
      ])
    }
  })

  it("offers to close a bay that re-armed empty", () => {
    // Tray POSITION is unreadable, so this is inferred from the
    // one thing that is readable: the bay saw empty readings and
    // re-armed, so there is no disc to hand back. Closing an
    // already-closed tray is a documented no-op.
    expect(trayActionsFor(bayInState("idle"))).toEqual([
      "close_bay",
    ])
  })

  it("offers both on a quarantined bay", () => {
    // Quarantine says nothing about what is in the drive, and a
    // disc trapped in a bay no button opens is the case the tray
    // command exists for.
    expect(
      trayActionsFor(
        buildBayView({
          is_quarantined: true,
          state: { ...buildBayView().state, state: "idle" },
        }),
      ),
    ).toEqual(["open_bay", "close_bay"])
  })

  it("offers nothing for a drive that is off the bus", () => {
    expect(
      trayActionsFor(
        buildBayView({
          is_present: false,
          state: { ...buildBayView().state, state: "idle" },
        }),
      ),
    ).toEqual([])
  })

  it("yields to the daemon the day it publishes these", () => {
    // `bay.actions` is the list the tower view publishes per
    // bay, and it wins. This function is the stand-in, not a
    // second opinion.
    expect(
      trayActionsFor(
        buildBayView({
          actions: ["open_bay"],
          state: {
            ...buildBayView().state,
            state: "completed",
          },
        }),
      ),
    ).toEqual([])
  })

  it("offers nothing for a bay we have no view of", () => {
    expect(trayActionsFor(undefined)).toEqual([])
  })
})

/**
 * Every combination of the two things the ⏏ toggle can read.
 *
 * There are only two, and neither is the tray: whether a disc was
 * read, and what rip-deck last did to the bay. Tray POSITION is
 * unknowable (`docs/eject-and-durable-bay-state.md` §2), so the
 * whole of the toggle's correctness is this table — which is why
 * it is enumerated rather than sampled.
 */
describe("nextTrayCommandFor", () => {
  const bayWith = (input: {
    discSizeSectors?: number | null
    lastTrayCommand?: "open_bay" | "close_bay" | null
  }) =>
    buildBayView({
      disc_size_sectors: input.discSizeSectors,
      last_tray_command: input.lastTrayCommand,
    })

  it("closes a bay it opened, even one still reading a disc", () => {
    // ⚠️ This test used to assert the OPPOSITE, on what looked
    // like the one fact in here rather than an inference: a
    // drive cannot read a disc through an open drawer, so a disc
    // means the tray is shut.
    //
    // The tower disagrees. Measured 2026-07-27 against the live
    // rack: `open_trays` opened slots 7, 8 and 9, and all
    // three went on reporting a disc afterwards. Under the old
    // rule the toggle offers `open_bay` forever and can never
    // send its second press — which is the whole feature the
    // owner asked for ("pushing eject again should close it").
    //
    // So the remembered command wins. It is the one thing here
    // that is a record of what happened rather than a guess
    // about a door nobody can see.
    expect(
      nextTrayCommandFor(
        bayWith({
          discSizeSectors: 48_000_000,
          lastTrayCommand: "open_bay",
        }),
      ),
    ).toBe("close_bay")
  })

  it("opens a disc-holding bay it has never commanded", () => {
    // No memory: a human loaded this and the only useful offer
    // is to open it. Enumerated rather than sampled, because
    // "absent" and "explicitly null" reach this differently.
    for (const lastTrayCommand of [
      null,
      undefined,
    ] as const) {
      expect(
        nextTrayCommandFor(
          bayWith({
            discSizeSectors: 48_000_000,
            lastTrayCommand,
          }),
        ),
      ).toBe("open_bay")
    }
  })

  it("re-opens a bay it closed, disc or no disc", () => {
    for (const discSizeSectors of [48_000_000, null]) {
      expect(
        nextTrayCommandFor(
          bayWith({
            discSizeSectors,
            lastTrayCommand: "close_bay",
          }),
        ),
      ).toBe("open_bay")
    }
  })

  it("closes an empty bay it last opened", () => {
    expect(
      nextTrayCommandFor(
        bayWith({
          discSizeSectors: null,
          lastTrayCommand: "open_bay",
        }),
      ),
    ).toBe("close_bay")
  })

  it("opens an empty bay it last closed", () => {
    expect(
      nextTrayCommandFor(
        bayWith({
          discSizeSectors: null,
          lastTrayCommand: "close_bay",
        }),
      ),
    ).toBe("open_bay")
  })

  it("opens an empty bay it has never touched", () => {
    // Nothing is known. Opening is the act the owner can SEE and
    // undo; a close on an already-closed tray is a documented
    // no-op, i.e. a button that appears broken.
    expect(
      nextTrayCommandFor(
        bayWith({
          discSizeSectors: null,
          lastTrayCommand: null,
        }),
      ),
    ).toBe("open_bay")
  })

  it("degrades to open when the daemon serves neither field", () => {
    // ⚠️ `last_tray_command` and `disc_size_sectors` are both
    // OPTIONAL: a daemon older than either is still one this
    // dashboard renders. Absent must not read as "open tray",
    // which `undefined === "open_bay"` would never do — but this
    // pins it, because the day someone flips the comparison the
    // toggle starts closing trays nobody opened.
    const bare = buildBayView()

    expect(bare.disc_size_sectors).toBeUndefined()
    expect(bare.last_tray_command).toBeUndefined()
    expect(nextTrayCommandFor(bare)).toBe("open_bay")
  })
})

describe("trayReportToActionResult", () => {
  const buildReport = (
    bays: TrayCommandReport["bays"],
  ): TrayCommandReport => ({
    request_id: null,
    command: "open_bay",
    is_accepted: true,
    message: "Opened 1 drive: slot 7.",
    started_at: 0,
    finished_at: 1,
    counts: {
      opened: 0,
      opened_not_ripped: 0,
      closed: 0,
      refused: 0,
      failed: 0,
      skipped: 0,
    },
    bays,
  })

  const bayReport = (
    result: TrayCommandReport["bays"][number]["result"],
    detail: string,
  ) => ({
    drive_id: "usb-2-1-1-2-4-4-7",
    slot: 7,
    label: "07 - Pioneer BDR-211M",
    result,
    detail,
  })

  it("counts an opened tray as a success", () => {
    expect(
      trayReportToActionResult({
        driveId: "usb-2-1-1-2-4-4-7",
        report: buildReport([
          bayReport("opened", "the tray is open"),
        ]),
      }),
    ).toEqual({ ok: true, msg: "the tray is open" })
  })

  /**
   * ⚠️ `is_accepted: true` and a refused bay is "I heard you,
   * and no". Reporting it as success is how a control claims it
   * opened the drive it correctly protected — and the detail is
   * the only sentence saying why, so it must arrive intact.
   */
  it("does not launder a refusal into a success", () => {
    const detail =
      "REFUSED — this bay is ripping. Opening the tray now " +
      "would destroy the rip in progress. Nothing was touched."

    expect(
      trayReportToActionResult({
        driveId: "usb-2-1-1-2-4-4-7",
        report: buildReport([
          bayReport("refused_ripping", detail),
        ]),
      }),
    ).toEqual({ ok: false, msg: detail })
  })

  it("keeps a skip's own words rather than the summary", () => {
    expect(
      trayReportToActionResult({
        driveId: "usb-2-1-1-2-4-4-7",
        report: buildReport([
          bayReport(
            "skipped_no_disc",
            "there is no disc in this bay",
          ),
        ]),
      }),
    ).toEqual({
      ok: false,
      msg: "there is no disc in this bay",
    })
  })

  it("falls back to the summary when the bay is not in the report", () => {
    // A rejection (`is_accepted: false`) carries no bays at all,
    // so its one sentence is all there is to show.
    expect(
      trayReportToActionResult({
        driveId: "usb-2-1-1-2-4-4-7",
        report: {
          ...buildReport([]),
          is_accepted: false,
          message: "Tray command refused: no bay is that.",
        },
      }),
    ).toEqual({
      ok: false,
      msg: "Tray command refused: no bay is that.",
    })
  })
})

describe("isBayHeld", () => {
  // Every `needs_attention` outcome in the watcher is a refusal
  // BEFORE a rip — the disc never settled, its name could not be
  // read, MakeMKV would not list the drive, or rip-deck has no
  // bay memory. All of them leave the disc in the drive.
  it("is a bay rip-deck stopped short of ripping", () => {
    expect(
      isBayHeld(
        buildBayView({
          state: {
            ...buildBayView().state,
            state: "needs_attention",
          },
        }),
      ),
    ).toBe(true)
  })

  it("is not a rip that failed", () => {
    expect(
      isBayHeld(
        buildBayView({
          state: {
            ...buildBayView().state,
            state: "failed",
          },
        }),
      ),
    ).toBe(false)
  })

  it("leaves quarantine to its own card", () => {
    // Quarantine is the BAY out of service, not the disc, and
    // `QuarantinedBayCard` already says so.
    expect(
      isBayHeld(
        buildBayView({
          is_quarantined: true,
          state: {
            ...buildBayView().state,
            state: "needs_attention",
          },
        }),
      ),
    ).toBe(false)
  })
})

/**
 * The conflation that put three finished backups under a red
 * banner on the live rack.
 *
 * `towerFeed` stamps `unknown` on every bay it did not measure —
 * deliberately, and its header explains at length why `ok` there
 * would be a lie. `unknown` means "nothing judged this rip", not
 * "this rip is suspect", and reading an absence of measurement as
 * evidence of a problem is the same mistake the verdict model
 * exists to prevent, one layer up.
 */
describe("isVerdictActionable", () => {
  it("asks nothing for the three verdicts that need nobody", () => {
    expect(isVerdictActionable("ok")).toBe(false)
    expect(isVerdictActionable("unknown")).toBe(false)
    // "Slow but reading cleanly. Leaving it to run is fine."
    expect(isVerdictActionable("disc_marginal_slow")).toBe(
      false,
    )
  })

  it("asks for something on every verdict that names an act", () => {
    for (const kind of [
      "disc_dirty",
      "disc_scratched",
      "drive_failing",
      "enumeration_flap",
      "key_expired",
      "hub_fault",
    ] as const) {
      expect(isVerdictActionable(kind)).toBe(true)
    }
  })
})

describe("an unmeasured completed rip", () => {
  const completedUnmeasured = buildRip({
    status: "success",
    active: false,
    percent: 100,
    verdict: "unknown",
    verdict_confidence: "suspected",
    is_adopted: true,
    label: null,
    volume_label: null,
    disctype: "unknown",
    disctype_label: null,
    kind: "unknown",
  })

  it("is recent, not something that needs attention", () => {
    expect(ripBucket(completedUnmeasured)).toBe("recent")
  })

  it("still needs a human if it had read errors", () => {
    // The one rule that overrides everything. An unmeasured
    // verdict is not permission to call this finished.
    expect(
      ripBucket(
        buildRip({
          ...completedUnmeasured,
          read_error_count: 3,
        }),
      ),
    ).toBe("attention")
  })

  it("reads quietly rather than as hardware trouble", () => {
    expect(verdictTone("unknown")).toBe("unmeasured")
    expect(verdictTone("unknown")).not.toBe("hardware")
  })

  it("says nothing where it has no disc name", () => {
    // `towerFeed` gives an adopted bay `identity: null`, so
    // there is genuinely no name. The word "disc" is not more
    // information than a blank; it just looks like one.
    expect(discLabel(completedUnmeasured)).toBeNull()
    expect(discTypeText(completedUnmeasured)).toBeNull()
  })

  it("still names the disc when the daemon knows it", () => {
    expect(discLabel(buildRip())).toBe("Ivanhoe")
    expect(discTypeText(buildRip())).toBe("Blu-ray")
  })
})

describe("bayActionsFor", () => {
  const completedBay = buildBayView({
    state: {
      ...buildBayView().state,
      state: "completed",
      verdict: "unknown",
    },
    actions: ["retry_in_another_drive"],
  })

  // ⚠️ The dangerous one. This fired on three completed,
  // verified, 225 GB backups at once on the live rack, and
  // pressing it is the duplicate rip the bay ledger was built to
  // prevent.
  it("never offers a re-rip on a finished job", () => {
    expect(bayActionsFor(completedBay)).not.toContain(
      "retry_in_another_drive",
    )
  })

  it("never offers one when there is no verdict to confirm", () => {
    // The control exists to confirm a SUSPECTED disc verdict in
    // a second drive. `unknown` is the absence of a measurement,
    // so a second drive has nothing to agree with.
    expect(
      bayActionsFor(
        buildBayView({
          state: {
            ...buildBayView().state,
            state: "ripping",
            verdict: "unknown",
          },
          actions: ["retry_in_another_drive", "cancel"],
        }),
      ),
    ).toEqual(["cancel"])
  })

  it("keeps it on a real suspected disc verdict", () => {
    expect(
      bayActionsFor(
        buildBayView({
          state: {
            ...buildBayView().state,
            verdict: "disc_dirty",
          },
          actions: ["retry_in_another_drive", "cancel"],
        }),
      ),
    ).toEqual(["retry_in_another_drive", "cancel"])
  })

  it("adds the tray control a finished bay has earned", () => {
    expect(bayActionsFor(completedBay)).toEqual([
      "open_bay",
    ])
  })
})
