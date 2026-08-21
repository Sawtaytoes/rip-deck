import { describe, expect, it } from "vitest"
import {
  buildClearLoadedResponse,
  buildTrayCommandMessage,
  buildTrayCommandRejection,
  buildTrayCommandResponse,
  buildTrayPowerOnResponse,
  buildTraySpokenMessage,
  decideTrayBayAction,
  formatBayList,
  hasFinishedDisc,
  isBayTargeted,
  isBulkOpenEligible,
  isRipCompleted,
  parseTrayCommand,
  type TrayBayResult,
} from "./trayCommand.ts"
import {
  type BayObservation,
  type BayState,
  createBayState,
} from "./watcher.ts"

/**
 * The operator's tray commands.
 *
 * ⚠️ **The most important test in this file is the refusal.**
 * `starting` and `ripping` must be refused for every command
 * kind, bulk or targeted: opening a tray mid-rip destroys 90 GB
 * and an hour, and this command surface is the only thing in
 * rip-deck that can reach a drive a rip owns.
 *
 * The second most important is that a press always says
 * something. An operator who hears nothing cannot tell a broken
 * button from a broken daemon, which is why even an unparseable
 * payload produces a published answer.
 */

const NOW_MS = 1_780_000_000_000

const bay = (input: Partial<BayState>): BayState => ({
  ...createBayState({
    driveId: "usb-2-1.1.2.4.4.2",
    atMs: NOW_MS,
  }),
  ...input,
})

const completedBay = (): BayState =>
  bay({
    phase: "done",
    sizeSectors: 23_000_000,
    outcome: { kind: "completed", detail: "/dest/Troy" },
  })

const loaded = (
  input: Partial<BayObservation> = {},
): BayObservation => ({
  isDrivePresent: true,
  hasMedia: true,
  sizeSectors: 23_000_000,
  ...input,
})

const result = (
  input: Partial<TrayBayResult>,
): TrayBayResult => ({
  driveId: "usb-2-1.1.2.4.4.2",
  slot: 7,
  label: "07 - Pioneer BDR-211M",
  resultKind: "opened",
  detail: "opened",
  ...input,
})

describe("parseTrayCommand", () => {
  it("takes a bare bulk command, so HA needs no template", () => {
    expect(parseTrayCommand("open_trays")).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "open_trays" },
    })

    expect(parseTrayCommand(" close_trays \n")).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "close_trays" },
    })

    // `clear_loaded` is bulk too — it takes no bay — so an HA
    // button clearing the reminder is a one-line `mqtt.publish`.
    expect(parseTrayCommand("clear_loaded")).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "clear_loaded" },
    })
  })

  it("takes clear_loaded as JSON with a request id", () => {
    expect(
      parseTrayCommand(
        '{"command":"clear_loaded","request_id":"z9"}',
      ),
    ).toEqual({
      isValid: true,
      requestId: "z9",
      request: { kind: "clear_loaded" },
    })
  })

  it("takes JSON with a request id", () => {
    expect(
      parseTrayCommand(
        '{"command":"open_trays","request_id":"abc"}',
      ),
    ).toEqual({
      isValid: true,
      requestId: "abc",
      request: { kind: "open_trays" },
    })
  })

  it("still accepts the pre-rename words, mapped to the new kinds", () => {
    // A retained `cmd/drive` payload or a not-yet-reflashed button
    // can still say `open_completed`/`close_open`; a silently-dead
    // button is the failure this surface exists to prevent.
    expect(parseTrayCommand("open_completed")).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "open_trays" },
    })

    expect(
      parseTrayCommand('{"command":"close_open"}'),
    ).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "close_trays" },
    })
  })

  it("addresses one bay by slot or by drive id", () => {
    expect(
      parseTrayCommand('{"command":"open_bay","slot":7}'),
    ).toEqual({
      isValid: true,
      requestId: null,
      request: { kind: "open_bay", target: { slot: 7 } },
    })

    expect(
      parseTrayCommand(
        '{"command":"close_bay","drive_id":"usb-2-1.1"}',
      ),
    ).toEqual({
      isValid: true,
      requestId: null,
      request: {
        kind: "close_bay",
        target: { driveId: "usb-2-1.1" },
      },
    })
  })

  it("refuses, with a reason, rather than going quiet", () => {
    // Every one of these ends up published on resp/drive.
    for (const payload of [
      "",
      "eject_everything",
      "{ not json",
      '{"command":"open_bay"}',
      '{"command":"nope"}',
      "[]",
    ]) {
      const parsed = parseTrayCommand(payload)

      expect(parsed.isValid).toBe(false)
      if (!parsed.isValid) {
        expect(parsed.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it("never invents a bay for a single-bay command", () => {
    // A missing slot must not default to "all of them".
    const parsed = parseTrayCommand(
      '{"command":"open_bay","slot":"seven"}',
    )

    expect(parsed.isValid).toBe(false)
  })
})

describe("parseTrayCommand — rip_bay", () => {
  it("takes a slot and an operator-supplied name", () => {
    const parsed = parseTrayCommand(
      JSON.stringify({
        command: "rip_bay",
        slot: 9,
        name: "Soylent Green - UHD",
      }),
    )

    expect(parsed).toEqual({
      isValid: true,
      requestId: null,
      request: {
        kind: "rip_bay",
        target: { slot: 9 },
        name: "Soylent Green - UHD",
      },
    })
  })

  it("reads a blank name as no name, not as a disc called ''", () => {
    // "Try again" and "Rip with this name" are the same command
    // with and without a name, and the input starts empty. A folder
    // named after trailing whitespace is a disc nobody finds again.
    for (const name of ["", "   ", "\t\n"]) {
      const parsed = parseTrayCommand(
        JSON.stringify({
          command: "rip_bay",
          drive_id: "2-1.3.1",
          name,
        }),
      )

      expect(parsed).toEqual({
        isValid: true,
        requestId: null,
        request: {
          kind: "rip_bay",
          target: { driveId: "2-1.3.1" },
          name: null,
        },
      })
    }
  })

  it("trims a name rather than ripping into a padded folder", () => {
    const parsed = parseTrayCommand(
      JSON.stringify({
        command: "rip_bay",
        slot: 9,
        name: "  Soylent Green - UHD  ",
      }),
    )

    expect(
      parsed.isValid && parsed.request.kind === "rip_bay"
        ? parsed.request.name
        : "unparsed",
    ).toBe("Soylent Green - UHD")
  })

  it("refuses a rip with no bay named", () => {
    const parsed = parseTrayCommand(
      JSON.stringify({
        command: "rip_bay",
        name: "Soylent Green - UHD",
      }),
    )

    expect(parsed.isValid).toBe(false)
    expect(parsed.isValid ? "" : parsed.reason).toContain(
      "`slot`",
    )
  })

  it("is not a bare command word", () => {
    // The bare form exists so the RODRET automation needs no
    // template. Ripping a bay always names one, so it always
    // needs JSON.
    const parsed = parseTrayCommand("rip_bay")

    expect(parsed.isValid).toBe(false)
    expect(parsed.isValid ? "" : parsed.reason).toContain(
      "is not a bulk command",
    )
  })
})

describe("decideTrayBayAction", () => {
  it("⚠️ REFUSES a bay that is ripping, every command kind", () => {
    for (const phase of ["starting", "ripping"] as const) {
      for (const request of [
        { kind: "open_trays" },
        { kind: "close_trays" },
        { kind: "open_bay", target: { slot: 7 } },
        { kind: "close_bay", target: { slot: 7 } },
        // `rip_bay` overrules the latch, the fingerprint and the
        // start counter — and this one thing it does not overrule.
        // A second rip on a drive one already owns is two writers.
        {
          kind: "rip_bay",
          target: { slot: 7 },
          name: "Soylent Green - UHD",
        },
      ] as const) {
        const decision = decideTrayBayAction({
          request,
          bay: bay({ phase }),
          observation: loaded(),
        })

        expect(decision.action).toBe("refuse")
        if (decision.action === "refuse") {
          expect(decision.resultKind).toBe(
            "refused_ripping",
          )
          expect(decision.detail).toContain("REFUSED")
        }
      }
    }
  })

  it("refuses a ripping bay even with an empty-looking tray", () => {
    // A disc that vanishes mid-rip is `ripJob`'s business. Two
    // opinions about one device is how a drive gets two
    // writers.
    const decision = decideTrayBayAction({
      request: { kind: "open_bay", target: { slot: 7 } },
      bay: bay({ phase: "ripping" }),
      observation: loaded({ hasMedia: false }),
    })

    expect(decision.action).toBe("refuse")
  })

  it("opens a finished bay on the bulk command", () => {
    expect(
      decideTrayBayAction({
        request: { kind: "open_trays" },
        bay: completedBay(),
        observation: loaded(),
      }),
    ).toEqual({ action: "open" })
  })

  it("leaves an idle bay alone while the tower has finished ones", () => {
    const decision = decideTrayBayAction({
      request: { kind: "open_trays" },
      bay: bay({ phase: "idle" }),
      observation: loaded(),
      openScope: "finished",
    })

    expect(decision).toMatchObject({
      action: "skip",
      resultKind: "skipped_not_finished",
    })
  })

  it("is selective by default, for a caller that never asked", () => {
    // `openScope` is optional and defaults to `"finished"`, the
    // narrow reading. A caller that forgot it must not get a
    // surprise nine-drawer open.
    expect(
      decideTrayBayAction({
        request: { kind: "open_trays" },
        bay: bay({ phase: "idle" }),
        observation: loaded(),
      }),
    ).toMatchObject({ resultKind: "skipped_not_finished" })
  })

  it("does not flap a tray whose disc has already gone", () => {
    const decision = decideTrayBayAction({
      request: { kind: "open_trays" },
      bay: completedBay(),
      observation: loaded({ hasMedia: false }),
      openScope: "finished",
    })

    expect(decision).toMatchObject({
      action: "skip",
      resultKind: "skipped_no_disc",
    })
  })

  it("opens a loaded bay of any phase in 'all' scope", () => {
    // The escalation / nothing-finished press: `"all"` opens every
    // present, non-ripping bay regardless of phase. The refusal
    // above is the only thing it does not reach.
    for (const phase of ["idle", "done"] as const) {
      expect(
        decideTrayBayAction({
          request: { kind: "open_trays" },
          bay: bay({ phase }),
          observation: loaded(),
          openScope: "all",
        }),
      ).toEqual({ action: "open" })
    }

    // Including a bay this process has never seen.
    expect(
      decideTrayBayAction({
        request: { kind: "open_trays" },
        bay: null,
        observation: loaded(),
        openScope: "all",
      }),
    ).toEqual({ action: "open" })
  })

  it("OPENS an empty bay in 'all' scope, so a disc can be loaded", () => {
    // ⚠️ The behaviour flipped with the 2026-07-30 redesign. The
    // old fallback skipped an empty drawer; the escalation's "open
    // all" (second press, or nothing finished) opens every
    // non-ripping bay including empty ones — the owner: "If pressed
    // a second time, open all." An empty bay opened is a bay ready
    // to take a disc.
    expect(
      decideTrayBayAction({
        request: { kind: "open_trays" },
        bay: bay({ phase: "idle" }),
        observation: loaded({ hasMedia: false }),
        openScope: "all",
      }),
    ).toEqual({ action: "open" })
  })

  it("⚠️ REFUSES a ripping bay in 'all' scope too", () => {
    // The one that matters. In `"all"` scope ▲ is "open all" — and
    // "all" still may not mean the bay holding 90 GB half-written.
    // The refusal is the FIRST branch; the scope logic lives inside
    // the command switch, below it, and cannot reach around it.
    for (const request of [
      { kind: "open_trays" },
      { kind: "close_trays" },
    ] as const) {
      expect(
        decideTrayBayAction({
          request,
          bay: bay({ phase: "ripping" }),
          observation: loaded(),
          openScope: "all",
        }),
      ).toMatchObject({
        action: "refuse",
        resultKind: "refused_ripping",
      })
    }
  })

  it("closes only bays rip-deck opened, skipping the rest", () => {
    // ⚠️ The 2026-07-30 redesign: Close trays closes what
    // `lastTrayCommand` says is open, not every present bay. A bay
    // rip-deck never opened is already shut, so it is skipped as
    // `skipped_already_closed` rather than sent a no-op close.
    // `lastTrayCommand` is the authority — disc presence is not.
    for (const observation of [
      loaded({ hasMedia: false }),
      loaded(),
    ]) {
      expect(
        decideTrayBayAction({
          request: { kind: "close_trays" },
          bay: completedBay(), // lastTrayCommand null
          observation,
        }),
      ).toMatchObject({
        action: "skip",
        resultKind: "skipped_already_closed",
      })
    }

    // A bay it DID open closes, disc still reading or not.
    expect(
      decideTrayBayAction({
        request: { kind: "close_trays" },
        bay: bay({
          phase: "idle",
          lastTrayCommand: "open_bay",
        }),
        observation: loaded(),
      }),
    ).toEqual({ action: "close" })
  })

  it("closes a bay it opened, even one still reading a disc", () => {
    // ⚠️ The regression that shipped and was caught on the rack,
    // 2026-07-27. `open_trays` opened slots 7-9 and every
    // one of them went on reporting `hasMedia` — so the branch
    // above skipped exactly the bays the paired command had just
    // opened, and the owner's short-▲ / short-▼ pair could not
    // round-trip. Only a per-bay `close_bay` could shut them.
    //
    // `lastTrayCommand` is a record of what rip-deck did to the
    // drawer; `hasMedia` is a guess about the door from the
    // medium. The record wins.
    expect(
      decideTrayBayAction({
        request: { kind: "close_trays" },
        bay: bay({
          phase: "done",
          sizeSectors: 23_000_000,
          outcome: {
            kind: "needs_attention",
            detail: "held on startup",
          },
          lastTrayCommand: "open_bay",
        }),
        observation: loaded(),
      }),
    ).toEqual({ action: "close" })
  })

  it("still refuses a ripping bay it once opened", () => {
    // Ordering, not behaviour: the refusal is the FIRST branch
    // and nothing added after it may reach around. A bay ripping
    // now, that rip-deck opened at some point in the past, is
    // still untouchable.
    expect(
      decideTrayBayAction({
        request: { kind: "close_trays" },
        bay: bay({
          phase: "ripping",
          sizeSectors: 23_000_000,
          lastTrayCommand: "open_bay",
        }),
        observation: loaded(),
      }),
    ).toMatchObject({
      action: "refuse",
      resultKind: "refused_ripping",
    })
  })

  it("skips a drive that is not on the bus", () => {
    expect(
      decideTrayBayAction({
        request: { kind: "open_trays" },
        bay: completedBay(),
        observation: loaded({ isDrivePresent: false }),
      }),
    ).toMatchObject({
      action: "skip",
      resultKind: "skipped_not_present",
    })
  })

  it("obeys a targeted command on any non-ripping bay", () => {
    // The escape hatch for the bays the bulk rule does not
    // reach — including an idle, empty one.
    expect(
      decideTrayBayAction({
        request: { kind: "open_bay", target: { slot: 7 } },
        bay: bay({ phase: "idle" }),
        observation: loaded({ hasMedia: false }),
      }),
    ).toEqual({ action: "open" })
  })
})

describe("isBulkOpenEligible", () => {
  it("covers every latched bay, not just the successful ones", () => {
    // The decision this unit made and is flagging: every one of
    // these is a bay rip-deck will never touch again until a
    // human takes the disc out.
    for (const kind of [
      "completed",
      "failed",
      "needs_attention",
    ] as const) {
      expect(
        isBulkOpenEligible(
          bay({
            phase: "done",
            outcome: { kind, detail: "x" },
          }),
        ),
      ).toBe(true)
    }

    // Quarantine qualifies on the phase alone. It is the one
    // latch the poll loop applies itself, and the way out of it
    // is documented as "take the disc out" — so a button that
    // could not open it would be a button that cannot do the
    // one thing quarantine asks for.
    expect(
      isBulkOpenEligible(
        bay({
          phase: "quarantined",
          outcome: {
            kind: "needs_attention",
            detail: "started three times",
          },
        }),
      ),
    ).toBe(true)
  })

  it("excludes idle and in-flight bays", () => {
    for (const phase of [
      "idle",
      "starting",
      "ripping",
    ] as const) {
      expect(isBulkOpenEligible(bay({ phase }))).toBe(false)
    }

    expect(isBulkOpenEligible(null)).toBe(false)
  })
})

describe("hasFinishedDisc", () => {
  it("is the tower-wide question, per bay", () => {
    expect(
      hasFinishedDisc({
        bay: completedBay(),
        observation: loaded(),
      }),
    ).toBe(true)

    // Not finished with: the fallback's whole premise.
    expect(
      hasFinishedDisc({
        bay: bay({ phase: "idle" }),
        observation: loaded(),
      }),
    ).toBe(false)
  })

  it("⚠️ needs the disc to still be IN there", () => {
    // A latched bay the operator already emptied is finished
    // with — and pressing ▲ would still move nothing, which is
    // the dead button the fallback exists to prevent. So the
    // fallback engages exactly when the selective open would
    // have been a no-op.
    expect(
      hasFinishedDisc({
        bay: completedBay(),
        observation: loaded({ hasMedia: false }),
      }),
    ).toBe(false)

    expect(
      hasFinishedDisc({
        bay: completedBay(),
        observation: loaded({ isDrivePresent: false }),
      }),
    ).toBe(false)
  })
})

describe("isRipCompleted", () => {
  it("is the narrow reading, so nothing is announced as ripped that was not", () => {
    expect(isRipCompleted(completedBay())).toBe(true)

    expect(
      isRipCompleted(
        bay({
          phase: "done",
          outcome: {
            kind: "needs_attention",
            detail: "no name on the disc",
          },
        }),
      ),
    ).toBe(false)
  })
})

describe("isBayTargeted", () => {
  it("matches on slot or on the stable drive id", () => {
    expect(
      isBayTargeted({
        target: { slot: 7 },
        driveId: "usb-2-1.1",
        slot: 7,
      }),
    ).toBe(true)

    expect(
      isBayTargeted({
        target: { slot: 7 },
        driveId: "usb-2-1.1",
        slot: 8,
      }),
    ).toBe(false)

    expect(
      isBayTargeted({
        target: { driveId: "usb-2-1.1" },
        driveId: "usb-2-1.1",
        slot: null,
      }),
    ).toBe(true)
  })
})

describe("formatBayList", () => {
  it("reads like a sentence", () => {
    expect(formatBayList([result({ slot: 7 })])).toBe(
      "slot 7",
    )

    expect(
      formatBayList([
        result({ slot: 7 }),
        result({ slot: 8 }),
      ]),
    ).toBe("slots 7 and 8")

    expect(
      formatBayList([
        result({ slot: 7 }),
        result({ slot: 8 }),
        result({ slot: 9 }),
      ]),
    ).toBe("slots 7, 8 and 9")
  })

  it("falls back to the label when there is no slot", () => {
    expect(
      formatBayList([
        result({ slot: null, label: "usb-2-1.1" }),
      ]),
    ).toBe("slot usb-2-1.1")
  })
})

describe("buildTrayCommandMessage", () => {
  it("says the refusal FIRST", () => {
    const message = buildTrayCommandMessage({
      request: { kind: "open_trays" },
      results: [
        result({ slot: 7, resultKind: "opened" }),
        result({
          slot: 4,
          resultKind: "refused_ripping",
          detail: "REFUSED — this bay is ripping.",
        }),
      ],
    })

    expect(message.startsWith("Refused")).toBe(true)
    expect(message).toContain("slot 4")
    expect(message).toContain("Opened 1 drive")
  })

  it("names the discs that were never ripped", () => {
    // The whole justification for opening more than the
    // successful bays: nothing is lost silently.
    const message = buildTrayCommandMessage({
      request: { kind: "open_trays" },
      results: [
        result({ slot: 7, resultKind: "opened" }),
        result({
          slot: 8,
          resultKind: "opened_not_ripped",
        }),
        result({
          slot: 9,
          resultKind: "opened_not_ripped",
        }),
      ],
    })

    expect(message).toContain("Opened 3 drives")
    expect(message).toContain(
      "2 of those were never ripped",
    )
    expect(message).toContain("slots 8 and 9")
  })

  it("refuses in the VERB of the command that ran", () => {
    // Measured on the live tower 2026-08-20: a `close_trays`
    // press with slot 2 mid-rip answered "Refused to OPEN slot 2",
    // which is the one sentence Home Assistant speaks out loud.
    // Every non-rip_bay, non-power_off command shared the open
    // wording.
    expect(
      buildTrayCommandMessage({
        request: { kind: "close_trays" },
        results: [
          result({
            slot: 2,
            resultKind: "refused_ripping",
            detail: "REFUSED — this bay is ripping.",
          }),
        ],
      }),
    ).toBe("Refused to close slot 2: still ripping.")

    expect(
      buildTrayCommandMessage({
        request: { kind: "open_trays" },
        results: [
          result({
            slot: 2,
            resultKind: "refused_ripping",
            detail: "REFUSED — this bay is ripping.",
          }),
        ],
      }),
    ).toBe("Refused to open slot 2: still ripping.")
  })

  it("lists the opened drawers in slot order", () => {
    // The list is what the operator walks the rack against, so it
    // reads in rack order. Concatenating `opened` then
    // `openedNotRipped` produced "slots 2, 1, 3, 4, 5, 6, 7, 8
    // and 9" on the live tower: the single ripped bay sorted ahead
    // of eight empty ones that were already in order. The
    // never-ripped split is a separate sentence and keeps its own
    // ordering.
    const message = buildTrayCommandMessage({
      request: { kind: "open_trays" },
      results: [
        result({ slot: 2, resultKind: "opened" }),
        ...[1, 3, 4].map((slot) =>
          result({ slot, resultKind: "opened_not_ripped" }),
        ),
      ],
    })

    expect(message).toContain(
      "Opened 4 drives: slots 1, 2, 3 and 4.",
    )
  })

  it("reads as a plain open-all in fallback mode", () => {
    // ⚠️ Nine drawers opened because the tower had nothing
    // selective to do. "8 of those were never ripped" is news
    // after a rip session and noise on an idle tower — nothing
    // was ripped, and the operator asked for all of them.
    const message = buildTrayCommandMessage({
      request: { kind: "open_trays" },
      openScope: "all",
      results: Array.from({ length: 9 }, (_unused, index) =>
        result({
          slot: index + 1,
          resultKind: "opened_not_ripped",
        }),
      ),
    })

    expect(message).toBe(
      "Opened 9 drives: slots 1, 2, 3, 4, 5, 6, 7, 8 and 9.",
    )
    expect(message).not.toContain("never ripped")
  })

  it("never returns silence", () => {
    // A button that moved nothing has to say so.
    expect(
      buildTrayCommandMessage({
        request: { kind: "open_trays" },
        openScope: "finished",
        results: [
          result({ resultKind: "skipped_not_finished" }),
        ],
      }),
    ).toBe(
      "Nothing to open — no finished discs are loaded.",
    )

    // …and says which nothing. In fallback mode there were no
    // finished discs by definition, so blaming them would send
    // the operator looking for a rip that never ran.
    expect(
      buildTrayCommandMessage({
        request: { kind: "open_trays" },
        openScope: "all",
        results: [
          result({ resultKind: "skipped_no_disc" }),
        ],
      }),
    ).toBe("Nothing to open — no discs are loaded.")

    expect(
      buildTrayCommandMessage({
        request: { kind: "close_trays" },
        results: [],
      }),
    ).toContain("No trays to close")
  })

  it("carries a failure's own words", () => {
    expect(
      buildTrayCommandMessage({
        request: { kind: "open_trays" },
        results: [
          result({
            slot: 7,
            resultKind: "failed",
            detail:
              "this rip-deck image has no `eject` binary",
          }),
        ],
      }),
    ).toContain("no `eject` binary")
  })
})

describe("buildTrayCommandResponse", () => {
  it("counts every outcome, so a dashboard need not re-derive them", () => {
    const payload = buildTrayCommandResponse({
      request: { kind: "open_trays" },
      requestId: "abc",
      startedAtMs: NOW_MS,
      finishedAtMs: NOW_MS + 1_200,
      results: [
        result({ slot: 7, resultKind: "opened" }),
        result({
          slot: 8,
          resultKind: "opened_not_ripped",
        }),
        result({
          slot: 4,
          resultKind: "refused_ripping",
        }),
        result({ slot: 5, resultKind: "failed" }),
        result({
          slot: 6,
          resultKind: "skipped_not_finished",
        }),
        result({ slot: 3, resultKind: "skipped_no_disc" }),
      ],
    })

    expect(payload.request_id).toBe("abc")
    expect(payload.command).toBe("open_trays")
    expect(payload.is_accepted).toBe(true)
    expect(payload.counts).toEqual({
      opened: 1,
      opened_not_ripped: 1,
      closed: 0,
      refused: 1,
      failed: 1,
      skipped: 2,
      rip_started: 0,
    })
    expect(payload.bays).toHaveLength(6)
    expect(payload.bays[0]).toEqual({
      drive_id: "usb-2-1.1.2.4.4.2",
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      result: "opened",
      detail: "opened",
    })
  })
})

describe("buildTrayCommandRejection", () => {
  it("answers a command it could not even read", () => {
    const payload = buildTrayCommandRejection({
      requestId: null,
      reason: "the payload is not valid JSON",
      atMs: NOW_MS,
    })

    expect(payload.is_accepted).toBe(false)
    expect(payload.command).toBeNull()
    expect(payload.message).toContain("not valid JSON")
    expect(payload.bays).toEqual([])
  })
})

describe("buildClearLoadedResponse", () => {
  it("reports how many discs it forgot, and moves no tray", () => {
    const payload = buildClearLoadedResponse({
      requestId: "r1",
      atMs: NOW_MS,
      cleared: 2,
    })

    expect(payload.is_accepted).toBe(true)
    expect(payload.command).toBe("clear_loaded")
    expect(payload.request_id).toBe("r1")
    expect(payload.message).toContain("2 discs")
    // The reminder is a screen chore; nothing for a speaker.
    expect(payload.spoken_message).toBe("")
    expect(payload.bays).toEqual([])
    expect(payload.counts.opened).toBe(0)
  })

  it("answers a no-op honestly rather than going quiet", () => {
    // Nothing was loaded, so nothing cleared — but a button that
    // says nothing reads as broken.
    const payload = buildClearLoadedResponse({
      requestId: null,
      atMs: NOW_MS,
      cleared: 0,
    })

    expect(payload.is_accepted).toBe(true)
    expect(payload.message).toContain(
      "no reminder to clear",
    )
  })

  it("says '1 disc', not '1 discs'", () => {
    expect(
      buildClearLoadedResponse({
        requestId: null,
        atMs: NOW_MS,
        cleared: 1,
      }).message,
    ).toContain("1 disc marked")
  })
})

/**
 * The half a house speaker reads.
 *
 * `automation.control_optical_ripper_tower` speaks a tray
 * problem's text verbatim, and `message` is written for a reader —
 * counts, colon lists and, on a failure, the device's own words.
 * Spoken, the owner called that "weird computer-style text"
 * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)).
 * These tests are the guard on the difference: the spoken line
 * says less, and never says the parts a listener cannot act on.
 */
describe("buildTrayCommandMessage — rip_bay", () => {
  it("says ripping ONCE", () => {
    // Measured on the live tower 2026-07-30: gluing the bay's own
    // detail onto the stem produced "Ripping slot 9: reading the
    // disc's own name, then ripping". Both strings are published;
    // the card renders the detail beside this one.
    const message = buildTrayCommandMessage({
      request: {
        kind: "rip_bay",
        target: { slot: 9 },
        name: null,
      },
      results: [
        result({
          slot: 9,
          resultKind: "rip_started",
          detail:
            "reading the disc's own name, then ripping",
        }),
      ],
    })

    expect(message).toBe("Ripping slot 9.")
  })

  it("says the bay's own sentence when nothing started", () => {
    // A `rip_bay` is aimed at ONE bay, so the bulk fallbacks
    // ("Nothing to open — no finished discs are loaded") would be
    // describing a set that does not exist.
    expect(
      buildTrayCommandMessage({
        request: {
          kind: "rip_bay",
          target: { slot: 9 },
          name: null,
        },
        results: [
          result({
            slot: 9,
            resultKind: "skipped_no_disc",
            detail: "there is no disc in this bay to rip",
          }),
        ],
      }),
    ).toBe(
      "Nothing to rip: there is no disc in this bay to rip.",
    )
  })

  it("names the refusal as a rip refusal, not an open one", () => {
    expect(
      buildTrayCommandMessage({
        request: {
          kind: "rip_bay",
          target: { slot: 9 },
          name: null,
        },
        results: [
          result({
            slot: 9,
            resultKind: "refused_ripping",
          }),
        ],
      }),
    ).toBe("Refused: slot 9 is already ripping.")
  })
})

describe("buildTraySpokenMessage", () => {
  it("says the refusal and NOTHING else", () => {
    // The one line that means stop. On screen it is followed by
    // the accounting; spoken, the accounting buries it.
    const spoken = buildTraySpokenMessage({
      request: { kind: "open_trays" },
      results: [
        result({ slot: 7, resultKind: "opened" }),
        result({
          slot: 4,
          resultKind: "refused_ripping",
          detail: "REFUSED — this bay is ripping.",
        }),
      ],
    })

    expect(spoken).toBe(
      "Not opening slot 4 — it is still ripping.",
    )
    expect(spoken).not.toContain("Opened")
  })

  it("agrees in number when several bays are refused", () => {
    expect(
      buildTraySpokenMessage({
        request: { kind: "open_trays" },
        results: [
          result({
            slot: 8,
            resultKind: "refused_ripping",
          }),
          result({
            slot: 9,
            resultKind: "refused_ripping",
          }),
        ],
      }),
    ).toBe(
      "Not opening slots 8 and 9 — they are still ripping.",
    )
  })

  it("never speaks the device's own words on a failure", () => {
    // `detail` here is whatever `eject` printed. It belongs on
    // the card and in the log; through TTS it is the exact
    // complaint this field exists to answer.
    const spoken = buildTraySpokenMessage({
      request: { kind: "open_trays" },
      results: [
        result({
          slot: 5,
          resultKind: "failed",
          detail:
            "eject exited 1: `/dev/sr4`: CDROMEJECT: Input/" +
            "output error",
        }),
      ],
    })

    expect(spoken).toBe(
      "One bay did not answer: slot 5. Nothing else was " +
        "affected.",
    )
    expect(spoken).not.toContain("CDROMEJECT")
    expect(spoken).not.toContain("`")
  })

  it("keeps the counts and the slot list off the speaker", () => {
    const results = [
      result({ slot: 1, resultKind: "opened" }),
      result({ slot: 2, resultKind: "opened_not_ripped" }),
      result({ slot: 3, resultKind: "opened_not_ripped" }),
    ]

    // The written line is a table; the spoken one is a fact.
    expect(
      buildTrayCommandMessage({
        request: { kind: "open_trays" },
        results,
      }),
    ).toContain("slots 1, 2 and 3")

    expect(
      buildTraySpokenMessage({
        request: { kind: "open_trays" },
        results,
      }),
    ).toBe("Opened 3 trays.")
  })

  it("says which nothing happened", () => {
    expect(
      buildTraySpokenMessage({
        request: { kind: "close_trays" },
        results: [
          result({ resultKind: "skipped_already_closed" }),
        ],
      }),
    ).toBe("Nothing to close.")

    expect(
      buildTraySpokenMessage({
        request: { kind: "open_trays" },
        results: [
          result({ resultKind: "skipped_not_finished" }),
        ],
      }),
    ).toBe("Nothing to open.")
  })

  it("drops the sender-facing reason from a rejection", () => {
    // Every `reason` is written for whoever has to fix the
    // sender — it quotes the payload and names JSON fields.
    const rejection = buildTrayCommandRejection({
      requestId: null,
      reason:
        "`open_evrything` is not a bulk command. The bare " +
        "form takes `open_trays` or `close_trays`.",
      atMs: NOW_MS,
    })

    expect(rejection.message).toContain("`open_evrything`")
    expect(rejection.spoken_message).toBe(
      "Rip-Deck could not understand that command. Nothing " +
        "was touched.",
    )
    expect(rejection.spoken_message).not.toContain("`")
  })

  it("is on every payload this module can publish", () => {
    // A field that only exists on the paths someone happened to
    // test is the one that surprises the next listener.
    const payloads = [
      buildTrayCommandResponse({
        request: { kind: "open_trays" },
        requestId: null,
        results: [result({ resultKind: "opened" })],
        startedAtMs: NOW_MS,
        finishedAtMs: NOW_MS + 1,
      }),
      buildTrayPowerOnResponse({
        requestId: null,
        atMs: NOW_MS,
      }),
      buildTrayCommandRejection({
        requestId: null,
        reason: "empty command payload",
        atMs: NOW_MS,
      }),
    ]

    for (const payload of payloads) {
      expect(payload.spoken_message).not.toBe("")
      expect(payload.spoken_message).not.toContain("`")
      expect(payload.spoken_message).not.toContain("--")
    }
  })
})
