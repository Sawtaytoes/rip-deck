import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EMPTY_TRAY_SECTORS,
  inferDiscType,
} from "@rip-deck/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  type DriveRegistry,
  loadDriveRegistry,
} from "../drives/registry.ts"
import type { ProbedDrive } from "../drives/sysfs.ts"
import {
  BAY_LEDGER_VERSION,
  type BayLedger,
  parseBayLedger,
} from "./bayLedger.ts"
import type { CyanripCommand } from "./cyanripCommand.ts"
import { createGovernor } from "./governor.ts"
import type { MakemkvCommand } from "./ripCommand.ts"
import {
  applyBayDecision,
  applyBayOutcome,
  applyRipStarted,
  type BayDecision,
  type BayObservation,
  type BayOutcome,
  type BayRipInput,
  type BayState,
  buildBayCyanripInvocation,
  createBayState,
  decideBayAction,
  startWatcher,
  WATCHER_TUNING,
  type WatcherConfig,
  type WatcherDeps,
} from "./watcher.ts"

/**
 * The watcher.
 *
 * ⚠️ **Read this before trusting a green run.** These tests prove
 * the STATE MACHINE and the LOOP: that a finished disc is never
 * picked up again, that nothing here can eject, that one wedged
 * bay costs one bay, and that the cap is a cap. They prove
 * nothing at all about hardware. Nine concurrent rips have never
 * happened; no disc has ever been auto-detected by this code; the
 * cyanrip path has never met a CD. Every `runBayRip` below is a
 * fake that resolves when the test tells it to.
 *
 * The most important assertions in this file are the negative
 * ones. An auto-ripper's characteristic failure is not "it did
 * not rip" — it is "it ripped again, and again", which is the
 * flap-storm that killed valid rips in neighbouring bays wearing
 * different clothes.
 */

const SLOT_9 = "2-1.1.2.4.4.2"
const BLURAY_SECTORS = 66_000_000

/** The capture id a previous daemon left in the ledger. */
const LEDGER_JOB_UUID =
  "9c1e6a5d-2b8f-4e11-8d4a-3f2b1c8e0d4a"
const CD_SECTORS = 1_200_000

const probedDrive = (input: {
  driveId: string
  kernelName: string
  sizeSectors: number
}): ProbedDrive => ({
  address: {
    kernelName: input.kernelName,
    devPath: `/dev/${input.kernelName}`,
    scsiHost: 29,
    scsiAddress: "29:0:0:0",
  },
  identity: {
    usbPortPath: input.driveId,
    bridgeSerial: null,
    hubPath: input.driveId,
    hubChain: [],
    vendor: "PIONEER",
    model: "BD-RW BDR-211M",
    revision: "1.53",
    linkSpeed: 5_000,
  },
  media: {
    sizeSectors: input.sizeSectors,
    hasMedia: inferDiscType(input.sizeSectors) !== "none",
    capacityBytes: input.sizeSectors * 512,
    discType: inferDiscType(input.sizeSectors),
  },
})

const observation = (input: {
  isDrivePresent?: boolean
  hasMedia: boolean
  sizeSectors: number
}): BayObservation => ({
  isDrivePresent: input.isDrivePresent ?? true,
  hasMedia: input.hasMedia,
  sizeSectors: input.sizeSectors,
})

const discObservation = observation({
  hasMedia: true,
  sizeSectors: BLURAY_SECTORS,
})

const emptyObservation = observation({
  hasMedia: false,
  sizeSectors: EMPTY_TRAY_SECTORS,
})

/** Run one decide/apply round, the way the loop does. */
const step = (input: {
  bay: BayState
  observation: BayObservation
  isSlotAvailable?: boolean
  atMs?: number
}): { bay: BayState; decision: BayDecision } => {
  const decision = decideBayAction({
    bay: input.bay,
    observation: input.observation,
    isSlotAvailable: input.isSlotAvailable ?? true,
  })

  return {
    decision,
    bay: applyBayDecision({
      bay: input.bay,
      observation: input.observation,
      action: decision,
      atMs: input.atMs ?? 0,
      jobUuid: "job-uuid",
    }),
  }
}

/** An idle bay that has just been handed a disc and started. */
const ripping = (): BayState => {
  const started = step({
    bay: createBayState({ driveId: SLOT_9, atMs: 0 }),
    observation: discObservation,
  }).bay

  return applyRipStarted({ bay: started, atMs: 1 })
}

const finishedWith = (outcome: BayOutcome): BayState =>
  applyBayOutcome({ bay: ripping(), outcome, atMs: 2 })

describe("the per-bay state machine", () => {
  it("starts a rip when an armed bay gets a disc", () => {
    const { decision, bay } = step({
      bay: createBayState({ driveId: SLOT_9, atMs: 0 }),
      observation: discObservation,
    })

    expect(decision.action).toBe("start")
    expect(bay.phase).toBe("starting")
    expect(bay.startCount).toBe(1)
    expect(bay.sizeSectors).toBe(BLURAY_SECTORS)
    expect(bay.jobUuid).toBe("job-uuid")
  })

  it("holds an empty bay, forever, silently", () => {
    // Zero media is the normal state of eight bays while one rips
    // and of all nine while the tower is off (F3).
    const { decision, bay } = step({
      bay: createBayState({ driveId: SLOT_9, atMs: 0 }),
      observation: emptyObservation,
    })

    expect(decision.action).toBe("hold")
    expect(bay.phase).toBe("idle")
  })

  it("holds a bay that is already busy, disc or no disc", () => {
    for (const bay of [
      step({
        bay: createBayState({ driveId: SLOT_9, atMs: 0 }),
        observation: discObservation,
      }).bay,
      ripping(),
    ]) {
      expect(
        decideBayAction({
          bay,
          observation: discObservation,
          isSlotAvailable: true,
        }).action,
      ).toBe("hold")
    }
  })

  it("holds when the governor has no slot free", () => {
    const { decision, bay } = step({
      bay: createBayState({ driveId: SLOT_9, atMs: 0 }),
      observation: discObservation,
      isSlotAvailable: false,
    })

    expect(decision.action).toBe("hold")
    // Still armed: the disc is not rejected, it is queued by the
    // simple expedient of being asked about again next tick.
    expect(bay.phase).toBe("idle")
    expect(bay.startCount).toBe(0)
  })

  describe("never re-ripping the same disc", () => {
    // THE rule this file exists for. A poll loop that starts a rip
    // because the bay has media starts it again on the next tick.
    for (const outcome of [
      { kind: "completed", detail: "…" },
      { kind: "failed", detail: "…" },
      { kind: "needs_attention", detail: "…" },
    ] as const) {
      it(`holds a ${outcome.kind} disc that is still in the drive`, () => {
        let bay = finishedWith(outcome)
        expect(bay.phase).toBe("done")

        // Twenty polls, a hundred seconds of the disc sitting
        // there. Not one of them may start anything.
        for (let tick = 0; tick < 20; tick += 1) {
          const stepped = step({
            bay,
            observation: discObservation,
            atMs: tick * 5_000,
          })

          expect(stepped.decision.action).toBe("hold")
          bay = stepped.bay
        }

        expect(bay.phase).toBe("done")
        expect(bay.startCount).toBe(1)
      })
    }

    it("re-arms only after the tray is CONFIRMED empty", () => {
      let bay = finishedWith({
        kind: "completed",
        detail: "…",
      })

      // One empty reading is not evidence: the kernel reports the
      // same 1 GiB sentinel for an empty tray and an unreadable
      // one, and a disc being re-read mid-spin can produce it.
      const first = step({
        bay,
        observation: emptyObservation,
      })
      expect(first.decision.action).toBe("hold")
      expect(first.bay.phase).toBe("done")
      expect(first.bay.emptyObservationCount).toBe(1)

      const second = step({
        bay: first.bay,
        observation: emptyObservation,
      })
      expect(second.decision.action).toBe("rearm")
      bay = second.bay

      expect(bay.phase).toBe("idle")
      expect(bay.startCount).toBe(0)
      expect(bay.sizeSectors).toBeNull()
      expect(bay.outcome).toBeNull()
      // The capture id goes with the disc: `<uuid>.robot.log`
      // describes what was in the tray, and the tray is empty.
      expect(bay.jobUuid).toBeNull()

      // And only THEN does a new disc rip.
      expect(
        step({ bay, observation: discObservation }).decision
          .action,
      ).toBe("start")
    })

    it("does not treat a vanished drive as an ejected disc", () => {
      // USB re-enumeration is routine on this tower. If a drive
      // dropping off the bus counted as "the disc left", every
      // finished disc in the rack would be re-ripped the moment
      // the tower was power-cycled.
      let bay = finishedWith({
        kind: "completed",
        detail: "…",
      })

      for (let tick = 0; tick < 10; tick += 1) {
        const stepped = step({
          bay,
          observation: observation({
            isDrivePresent: false,
            hasMedia: false,
            sizeSectors: 0,
          }),
        })

        expect(stepped.decision.action).toBe("hold")
        bay = stepped.bay
      }

      expect(bay.phase).toBe("done")
      expect(bay.emptyObservationCount).toBe(0)

      // The drive comes back with the same disc still in it.
      expect(
        step({ bay, observation: discObservation }).decision
          .action,
      ).toBe("hold")
    })

    it("re-arms across a drive that flaps off the bus between empty reads", () => {
      // Regression — the 2026-07-27 12V-into-5V incident. A rip
      // failed while the tower's USB power was unstable, the
      // operator pulled the disc, and the bay stayed latched with
      // an empty tray. `emptyObservationCount` used to reset to 0
      // on any off-bus poll, so a drive flapping between two
      // confirmed-empty reads oscillated 1 → 0 → 1 → 0 and never
      // reached `rearmEmptyObservations`. An empty tray must clear
      // the verdict even when the drive cannot hold the bus.
      const bay = finishedWith({
        kind: "needs_attention",
        detail: "cyanrip exited null",
      })

      // First CONFIRMED-empty read: one is not evidence on its own.
      const first = step({
        bay,
        observation: emptyObservation,
      })
      expect(first.decision.action).toBe("hold")
      expect(first.bay.emptyObservationCount).toBe(1)

      // The drive drops off the bus — the exact poll that used to
      // zero the tally. It must HOLD it instead.
      const flap = step({
        bay: first.bay,
        observation: observation({
          isDrivePresent: false,
          hasMedia: false,
          sizeSectors: 0,
        }),
      })
      expect(flap.decision.action).toBe("hold")
      expect(flap.bay.emptyObservationCount).toBe(1)

      // Second CONFIRMED-empty read: NOW it re-arms to a fresh bay.
      const second = step({
        bay: flap.bay,
        observation: emptyObservation,
      })
      expect(second.decision.action).toBe("rearm")
      expect(second.bay.phase).toBe("idle")
      expect(second.bay.outcome).toBeNull()
    })

    it("keeps the capture id after the rip lands", () => {
      // It used to be cleared here, and that is what made an
      // adopted disc's card lose its log button: the ledger had
      // nothing to write down, so the restart restored no id and
      // `armView` refused to name a file from the placeholder.
      // The rip is over; `<uuid>.robot.log` is not.
      expect(
        finishedWith({ kind: "completed", detail: "…" })
          .jobUuid,
      ).toBe("job-uuid")
    })

    it("drops the capture id when the disc leaves", () => {
      // `no_media` is the disc going away before anything could
      // be done with it. Nothing about the last rip describes
      // this bay any more.
      expect(
        applyBayOutcome({
          bay: ripping(),
          outcome: { kind: "no_media", detail: "…" },
          atMs: 2,
        }).jobUuid,
      ).toBeNull()
    })

    it("does start when a different disc appears", () => {
      // A swap the poll loop happened not to catch mid-way. The
      // fingerprint is what notices.
      const bay = finishedWith({
        kind: "completed",
        detail: "…",
      })

      const stepped = step({
        bay,
        observation: observation({
          hasMedia: true,
          sizeSectors: CD_SECTORS,
        }),
      })

      expect(stepped.decision.action).toBe("start")
      expect(stepped.bay.startCount).toBe(2)
    })
  })

  describe("the flap backstop", () => {
    it("quarantines a bay whose disc keeps changing size", () => {
      // The one input the fingerprint latch cannot hold: a drive
      // reporting alternating sizes looks like a new disc every
      // time, forever. Bounded here rather than diagnosed.
      let bay = createBayState({ driveId: SLOT_9, atMs: 0 })
      const sizes = [BLURAY_SECTORS, CD_SECTORS]

      for (
        let attempt = 0;
        attempt < WATCHER_TUNING.maxStartsPerDisc;
        attempt += 1
      ) {
        const stepped = step({
          bay,
          observation: observation({
            hasMedia: true,
            sizeSectors: sizes[attempt % 2],
          }),
        })

        expect(stepped.decision.action).toBe("start")

        bay = applyBayOutcome({
          bay: applyRipStarted({
            bay: stepped.bay,
            atMs: attempt,
          }),
          outcome: { kind: "failed", detail: "…" },
          atMs: attempt,
        })
      }

      const stepped = step({
        bay,
        observation: observation({
          hasMedia: true,
          sizeSectors: sizes[1],
        }),
      })

      expect(stepped.decision.action).toBe("quarantine")
      expect(stepped.bay.phase).toBe("quarantined")
      expect(stepped.bay.outcome?.kind).toBe(
        "needs_attention",
      )
    })

    it("keeps counting starts across a no_media outcome", () => {
      // `no_media` re-arms the bay, so without the counter
      // surviving it a drive that produces it every time would
      // retry until someone noticed.
      let bay = createBayState({ driveId: SLOT_9, atMs: 0 })

      for (
        let attempt = 0;
        attempt < WATCHER_TUNING.maxStartsPerDisc;
        attempt += 1
      ) {
        const stepped = step({
          bay,
          observation: discObservation,
        })
        expect(stepped.decision.action).toBe("start")

        bay = applyBayOutcome({
          bay: stepped.bay,
          outcome: { kind: "no_media", detail: "…" },
          atMs: attempt,
        })

        expect(bay.phase).toBe("idle")
      }

      expect(
        step({ bay, observation: discObservation }).decision
          .action,
      ).toBe("quarantine")
    })

    it("leaves quarantine only when the disc is taken out", () => {
      let bay: BayState = {
        ...createBayState({ driveId: SLOT_9, atMs: 0 }),
        phase: "quarantined",
        startCount: WATCHER_TUNING.maxStartsPerDisc,
      }

      expect(
        step({ bay, observation: discObservation }).decision
          .action,
      ).toBe("hold")

      bay = step({ bay, observation: emptyObservation }).bay
      const rearmed = step({
        bay,
        observation: emptyObservation,
      })

      expect(rearmed.decision.action).toBe("rearm")
      expect(rearmed.bay.phase).toBe("idle")
      expect(rearmed.bay.startCount).toBe(0)
    })
  })

  it("has no decision that ejects, from any state", () => {
    // The hard constraint, asserted structurally rather than by
    // reading the code: whatever the bay and whatever the reading,
    // the machine can only ever start, re-arm, quarantine or hold.
    // There is no eject to reach.
    const phases = [
      "idle",
      "starting",
      "ripping",
      "done",
      "quarantined",
    ] as const

    const readings = [
      discObservation,
      emptyObservation,
      observation({
        hasMedia: true,
        sizeSectors: CD_SECTORS,
      }),
      observation({
        isDrivePresent: false,
        hasMedia: false,
        sizeSectors: 0,
      }),
      observation({ hasMedia: true, sizeSectors: 0 }),
    ]

    for (const phase of phases) {
      for (const reading of readings) {
        for (const startCount of [0, 3]) {
          for (const isSlotAvailable of [true, false]) {
            const decision = decideBayAction({
              bay: {
                ...createBayState({
                  driveId: SLOT_9,
                  atMs: 0,
                }),
                phase,
                startCount,
                emptyObservationCount: 5,
                sizeSectors: BLURAY_SECTORS,
              },
              observation: reading,
              isSlotAvailable,
            })

            expect([
              "start",
              "rearm",
              "quarantine",
              "hold",
            ]).toContain(decision.action)
          }
        }
      }
    }
  })
})

/* ------------------------------------------------------------ *
 * The loop.
 * ------------------------------------------------------------ */

const noopConfig: WatcherConfig = {
  destinationRoot: "/dev/null/dest",
  stateDir: "/dev/null/state",
  registryPath: "/dev/null/drives.json",
  makemkv: {
    command: "true",
    prefixArgs: [],
    wrapperArgs: null,
  } satisfies MakemkvCommand,
  cyanrip: {
    command: "true",
    prefixArgs: [],
    wrapperArgs: null,
  } satisfies CyanripCommand,
  eject: { command: "true", prefixArgs: [] },
  isolation: null,
}

/**
 * Let the dispatched task's promise chain settle.
 *
 * `dispatch` runs the outcome through catch/then/finally, so a
 * couple of microtask turns are not enough to see the bay's phase
 * change. A macrotask is.
 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A `runBayRip` whose every call is resolved by the test. */
const controllableRipper = (
  options: {
    /**
     * Report `onRipStarted`, moving the bay `starting` ->
     * `ripping` the way a real ripper does the instant its child
     * begins reading.
     *
     * Opt-in rather than the default only because the existing
     * suite pins the `starting` phase in six places; a rip on the
     * real tower is in `starting` for an instant at most. Turn it
     * on for anything that cares what a bay looks like AFTER it
     * has genuinely ripped.
     */
    reportsRipStarted?: boolean
  } = {},
) => {
  const started: BayRipInput[] = []
  const resolvers = new Map<
    string,
    (outcome: BayOutcome) => void
  >()

  const runBayRip = async (
    input: BayRipInput,
  ): Promise<BayOutcome> => {
    started.push(input)

    if (options.reportsRipStarted) input.onRipStarted?.()

    return await new Promise<BayOutcome>((resolve) => {
      resolvers.set(input.driveId, resolve)

      // A real ripper answers a cancel, so the fake has to as
      // well — otherwise `stop()` waits forever for it and the
      // test hangs rather than failing.
      input.signal.addEventListener("abort", () =>
        resolve({
          kind: "failed",
          detail: "cancelled_by_operator",
        }),
      )
    })
  }

  return {
    runBayRip,
    started,
    finish: (
      driveId: string,
      outcome: BayOutcome = {
        kind: "completed",
        detail: "/dest/Movie",
      },
    ) => {
      resolvers.get(driveId)?.(outcome)
      resolvers.delete(driveId)
    },
  }
}

const watcherDeps = (input: {
  probeDrives: () => Promise<ProbedDrive[]>
  runBayRip: WatcherDeps["runBayRip"]
  readLedger?: WatcherDeps["readLedger"]
  writeLedger?: WatcherDeps["writeLedger"]
  appendHistory?: WatcherDeps["appendHistory"]
  runTray?: WatcherDeps["runTray"]
}): WatcherDeps => ({
  probeDrives: input.probeDrives,
  loadRegistry: async () => ({
    towerRootPortPath: "",
    entries: [],
  }),
  runBayRip: input.runBayRip,
  // `hasPriorState: true` with no records is "rip-deck has run
  // before and nothing is recorded as finished", which is the
  // state every loop test below means. It is NOT the same as
  // the no-ledger case, which fails closed on a loaded disc —
  // that has its own tests in `bayLedger.test.ts` and below.
  readLedger:
    input.readLedger ??
    (async () => ({
      version: BAY_LEDGER_VERSION,
      records: [],
      trayCommands: [],
      hasPriorState: true,
    })),
  writeLedger: input.writeLedger ?? (async () => {}),
  appendHistory: input.appendHistory ?? (async () => {}),
  runTray:
    input.runTray ??
    (async () => ({
      isSuccessful: true,
      isCommandMissing: false,
      isTimedOut: false,
      exitCode: 0,
      detail: "opened",
    })),
  now: () => Date.now(),
})

const nineLoadedDrives = (): ProbedDrive[] =>
  Array.from({ length: 9 }, (_unused, index) =>
    probedDrive({
      driveId: `2-1.1.${index}`,
      kernelName: `sr${index}`,
      sizeSectors: BLURAY_SECTORS,
    }),
  )

describe("startWatcher", () => {
  it("starts nine rips for nine inserted discs", async () => {
    // The owner's request, in one assertion.
    const ripper = controllableRipper()
    const drives = nineLoadedDrives()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()

    expect(ripper.started).toHaveLength(9)
    expect(
      watcher
        .getBays()
        .every((bay) => bay.phase === "starting"),
    ).toBe(true)

    await watcher.stop()
  })

  it("honours a smaller cap and picks the rest up later", async () => {
    const ripper = controllableRipper()
    const drives = nineLoadedDrives()
    const governor = createGovernor({
      maxConcurrentRips: 3,
    })

    const watcher = startWatcher(
      { config: noopConfig, governor },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(3)

    // Polling again while the cap is full must not start a fourth.
    await watcher.tickNow()
    expect(ripper.started).toHaveLength(3)

    ripper.finish("2-1.1.0")
    await flush()

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(4)
    expect(governor.getActiveCount()).toBe(3)

    await watcher.stop()
  })

  it("never re-rips a bay that already finished", async () => {
    const ripper = controllableRipper()
    const drives = [
      probedDrive({
        driveId: SLOT_9,
        kernelName: "sr0",
        sizeSectors: BLURAY_SECTORS,
      }),
    ]

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    expect(watcher.getBays()[0].phase).toBe("done")

    // Forty polls with the finished disc still in the tray.
    for (let tick = 0; tick < 40; tick += 1) {
      await watcher.tickNow()
    }

    expect(ripper.started).toHaveLength(1)

    await watcher.stop()
  })

  it("lets one wedged bay cost exactly one bay", async () => {
    // The architectural claim, tested: bay 0's rip never resolves.
    // The other eight must still start, and the poll loop must
    // still be answering.
    const ripper = controllableRipper()
    const drives = nineLoadedDrives()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(9)

    for (let index = 1; index < 9; index += 1) {
      ripper.finish(`2-1.1.${index}`)
    }
    await flush()

    const bays = watcher.getBays()
    expect(
      bays.filter((bay) => bay.phase === "done"),
    ).toHaveLength(8)
    expect(
      bays.filter((bay) => bay.phase === "starting"),
    ).toHaveLength(1)

    // And the loop still works.
    await watcher.tickNow()
    expect(ripper.started).toHaveLength(9)

    await watcher.stop()
  })

  it("abandons a probe that never answers, without wedging", async () => {
    // sysfs reads are not supposed to be able to hang. "Not
    // supposed to" is not a guarantee worth betting nine bays on.
    vi.useFakeTimers()

    try {
      const ripper = controllableRipper()
      const notes: string[] = []

      const watcher = startWatcher(
        {
          config: noopConfig,
          governor: createGovernor({
            maxConcurrentRips: 9,
          }),
          handlers: {
            onNote: (message) => notes.push(message),
          },
        },
        watcherDeps({
          probeDrives: () => new Promise(() => {}),
          runBayRip: ripper.runBayRip,
        }),
      )

      const tick = watcher.tickNow()
      await vi.advanceTimersByTimeAsync(
        WATCHER_TUNING.probeTimeoutMs + 1,
      )
      await tick

      expect(
        notes.some((note) =>
          note.includes("did not answer"),
        ),
      ).toBe(true)
      expect(ripper.started).toHaveLength(0)

      // A second tick must not queue a second probe behind the
      // first — that is how a wedge becomes a pile of handles.
      const second = watcher.tickNow()
      await vi.advanceTimersByTimeAsync(
        WATCHER_TUNING.probeTimeoutMs + 1,
      )
      await second

      await watcher.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats an empty bus as normal, not as a fault", async () => {
    // F3: the tower is powered independently of this service.
    const notes: string[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
        handlers: { onNote: (note) => notes.push(note) },
      },
      watcherDeps({
        probeDrives: async () => [],
        runBayRip: controllableRipper().runBayRip,
      }),
    )

    await watcher.tickNow()
    await watcher.tickNow()

    expect(notes).toEqual([
      expect.stringContaining("valid state"),
    ])

    await watcher.stop()
  })

  it("turns a thrown pipeline into an outcome, not a crash", async () => {
    // This promise is created inside a timer callback. A rejection
    // there takes down all nine bays and the API with them.
    const governor = createGovernor({
      maxConcurrentRips: 9,
    })
    const outcomes: BayOutcome[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor,
        handlers: {
          onBayOutcome: (event) =>
            outcomes.push(event.outcome),
        },
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: async () => {
          throw new Error("makemkvcon is not installed")
        },
      }),
    )

    await watcher.tickNow()
    await flush()

    expect(outcomes).toEqual([
      {
        kind: "failed",
        detail: "makemkvcon is not installed",
      },
    ])
    expect(governor.getActiveCount()).toBe(0)
    expect(watcher.getBays()[0].phase).toBe("done")

    await watcher.stop()
  })

  it("cancels running rips on stop rather than orphaning them", async () => {
    // E5 in its smallest form. `runRipJob` escalates the signal to
    // SIGKILL on its own; the watcher's job is to raise it.
    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: async (input) => {
          return await new Promise<BayOutcome>(
            (resolve) => {
              input.signal.addEventListener("abort", () =>
                resolve({
                  kind: "failed",
                  detail: "cancelled_by_operator",
                }),
              )
            },
          )
        },
      }),
    )

    await watcher.tickNow()
    await watcher.stop()

    expect(watcher.getBays()[0].outcome?.detail).toBe(
      "cancelled_by_operator",
    )
  })

  it("keys bays on the port path, never on /dev/srN", async () => {
    // srN reshuffles on every USB re-enumeration. A bay's memory
    // of "already ripped" attached to a name that moves is worse
    // than no memory: it latches the wrong bay and re-rips the
    // right one.
    const ripper = controllableRipper()
    let kernelName = "sr0"

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName,
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    // The bus renumbers. Same physical drive, same disc.
    kernelName = "sr7"
    await watcher.tickNow()
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(1)
    expect(watcher.getBays()).toHaveLength(1)
    expect(watcher.getBays()[0].driveId).toBe(SLOT_9)

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * Startup adoption — bay memory across a restart.
 * ------------------------------------------------------------ */

describe("startWatcher bay memory", () => {
  it("does not re-rip a finished disc after a restart", async () => {
    // The regression the ledger exists for. Before it, a
    // restart with three finished discs still in their trays
    // re-ripped all three: a fresh bay is `idle`, so THE RULE
    // could not fire.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [
            {
              driveId: SLOT_9,
              phase: "done",
              sizeSectors: BLURAY_SECTORS,
              discName: "TROY - THEATRICAL CUT",
              discType: "bluray",
              destinationPath: "/dest/[BACKUP] TROY",
              jobUuid: LEDGER_JOB_UUID,
              outcome: {
                kind: "completed",
                detail: "/dest/[BACKUP] TROY",
              },
              isLoadedDismissed: false,
              updatedAtMs: 1,
            },
          ],
        }),
      }),
    )

    await watcher.tickNow()
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(0)
    expect(watcher.getBays()[0].phase).toBe("done")
    expect(watcher.getBays()[0].outcome?.kind).toBe(
      "completed",
    )
    // And it knows WHICH disc it is holding. Without these the
    // dashboard falls back to the bay's own label, which is how
    // three Troy discs came back as "07 - Pioneer BDR-211M".
    expect(watcher.getBays()[0].discName).toBe(
      "TROY - THEATRICAL CUT",
    )
    expect(watcher.getBays()[0].destinationPath).toBe(
      "/dest/[BACKUP] TROY",
    )
    // And what it is and where its log is. The type routes the
    // poster lookup; the capture id is what keeps the held
    // card's log button — `armView` mints no filename from
    // `towerFeed`'s `<driveId>@<ms>` placeholder.
    expect(watcher.getBays()[0].discType).toBe("bluray")
    expect(watcher.getBays()[0].jobUuid).toBe(
      LEDGER_JOB_UUID,
    )

    await watcher.stop()
  })

  it("writes down what the disc was and which rip read it", async () => {
    // The write side of the same two fields. `onIdentified`
    // already fires minutes before the outcome, so both are in
    // hand with no extra device access — and if they do not
    // reach the ledger here, the restart above has nothing to
    // restore.
    const ripper = controllableRipper()
    const written: BayLedger[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: CD_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        writeLedger: async ({ ledger }) => {
          written.push(ledger)
        },
      }),
    )

    await watcher.tickNow()

    const jobUuid = ripper.started[0].jobUuid

    ripper.started[0].onIdentified?.({
      title: "BEETHOVEN - SYMPHONY NO 9",
      discType: "cd",
    })

    ripper.finish(SLOT_9)
    await flush()

    const [record] = written[written.length - 1].records

    expect(record.discType).toBe("cd")
    expect(record.jobUuid).toBe(jobUuid)

    await watcher.stop()
  })

  it("holds a loaded disc when it has no memory at all", async () => {
    // No ledger on disk: rip-deck cannot tell a fresh tower from
    // three finished discs left in their trays. Fail closed.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: false,
          records: [],
          trayCommands: [],
        }),
      }),
    )

    await watcher.tickNow()

    expect(ripper.started).toHaveLength(0)
    expect(
      watcher
        .getBays()
        .every((bay) => bay.phase === "done"),
    ).toBe(true)

    await watcher.stop()
  })

  it("writes the latched bays down when a rip finishes", async () => {
    const ripper = controllableRipper()
    const written: unknown[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        writeLedger: async (params) => {
          written.push(params.ledger)
        },
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    // Two writes, and both earn their place. The first is the
    // empty ledger the first tick lays down — that is what
    // gives the NEXT restart `hasPriorState`, so the fail-closed
    // hold on a loaded disc happens once per state directory
    // and not forever. The second is the outcome, written
    // immediately rather than at the next tick: a rip that
    // finishes and is SIGKILLed five seconds later must not
    // come back as a disc nobody remembers ripping.
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ records: [] })
    expect(written[1]).toMatchObject({
      records: [
        {
          driveId: SLOT_9,
          phase: "done",
          sizeSectors: BLURAY_SECTORS,
        },
      ],
    })

    await watcher.stop()
  })

  it("remembers what the disc was and where it went", async () => {
    // The rip is the only thing that ever knows either: the
    // name comes off `identifyDisc` minutes before the outcome,
    // and the destination is decided by the ripper at publish
    // time (a collision renames it). Both have to land on the
    // bay and then on the disk, or the next restart holds a
    // disc it cannot name — which is the state the dashboard
    // was in.
    const ripper = controllableRipper()
    const written: { records: unknown[] }[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        writeLedger: async (params) => {
          written.push(params.ledger)
        },
      }),
    )

    await watcher.tickNow()

    const rip = ripper.started[0]

    rip.onIdentified?.({
      title: "TROY - BONUS DISC",
      discType: "bluray",
    })

    // Known before the outcome is, exactly as a real rip has
    // it — and readable while the rip is still running.
    expect(watcher.getBays()[0].discName).toBe(
      "TROY - BONUS DISC",
    )

    rip.onDestination?.("/dest/[BACKUP] TROY - BONUS DISC")
    ripper.finish(SLOT_9)
    await flush()

    expect(watcher.getBays()[0]).toMatchObject({
      discName: "TROY - BONUS DISC",
      destinationPath: "/dest/[BACKUP] TROY - BONUS DISC",
    })

    expect(written[written.length - 1]).toMatchObject({
      records: [
        {
          driveId: SLOT_9,
          discName: "TROY - BONUS DISC",
          destinationPath:
            "/dest/[BACKUP] TROY - BONUS DISC",
        },
      ],
    })

    await watcher.stop()
  })

  it("does not label a new disc with the last one's name", async () => {
    // The tray was emptied and reloaded, so `applyBayDecision`
    // starts a fresh rip. Carrying the previous disc's name and
    // folder into it would put the wrong title on the card for
    // as long as identify takes — and, if that rip failed
    // before identify, forever.
    const ripper = controllableRipper()
    // A genuinely DIFFERENT disc has a different size — and it must,
    // for this test to mean what it says. A disc that reappears at
    // the SAME sector count as the one just finished is held as that
    // same disc coming back (the power-cycle fail-closed rule), not
    // re-ripped, so modelling "a different disc" with the same size
    // would test the hold, not the fresh-rip this is about.
    let sizeSectors = BLURAY_SECTORS

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors,
          }),
        ],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    ripper.started[0].onIdentified?.({
      title: "TROY - BONUS DISC",
      discType: "bluray",
    })
    ripper.started[0].onDestination?.("/dest/TROY")
    ripper.finish(SLOT_9)
    await flush()

    // Out it comes. The re-arm debounce wants more than one
    // empty reading before it believes the tray.
    sizeSectors = 0
    await watcher.tickNow()
    await watcher.tickNow()
    await watcher.tickNow()

    // And a different disc goes in — a different film, a different
    // size.
    sizeSectors = BLURAY_SECTORS - 4_000_000
    await watcher.tickNow()

    expect(watcher.getBays()[0].phase).toBe("starting")
    expect(watcher.getBays()[0].discName).toBeNull()
    expect(watcher.getBays()[0].destinationPath).toBeNull()

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * Loaded-discs memory — the "still in the tower" reminder,
 * rebuilt from the on-disk ledger so it survives a restart with
 * the tower off.
 * ------------------------------------------------------------ */

describe("startWatcher loaded-discs memory", () => {
  const troyRecord = {
    driveId: SLOT_9,
    phase: "done" as const,
    sizeSectors: BLURAY_SECTORS,
    discName: "TROY - THEATRICAL CUT",
    discType: "bluray" as const,
    destinationPath: "/dest/[BACKUP] TROY",
    jobUuid: LEDGER_JOB_UUID,
    outcome: {
      kind: "completed" as const,
      detail: "/dest/[BACKUP] TROY",
    },
    isLoadedDismissed: false,
    updatedAtMs: 1,
  }

  it("rebuilds the reminder from the ledger with the tower off, and never re-rips it", async () => {
    // The gap this closes: a daemon restarted against a dark
    // tower probes, sees zero drives and builds no bays — so the
    // old fold answered "nothing loaded" even though the ledger
    // on disk knew about a finished disc still in slot 9.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        // Tower off: nothing on the bus at all.
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [troyRecord],
        }),
      }),
    )

    await watcher.tickNow()

    const loaded = watcher.getLoadedDiscs()

    expect(loaded.count).toBe(1)
    expect(loaded.isTowerOn).toBe(false)
    // Readable ledger, so a genuine finding — not blind, and
    // therefore publishable rather than withheld.
    expect(loaded.isBlind).toBe(false)
    expect(loaded.discs[0].title).toBe(
      "TROY - THEATRICAL CUT",
    )

    // ⚠️ The safety half: the phantom is display-only. No bay was
    // built for a drive that is not on the bus, so nothing could
    // start a rip.
    expect(watcher.getBays()).toHaveLength(0)
    expect(ripper.started).toHaveLength(0)

    await watcher.stop()
  })

  it("clear_loaded forgets the reminder, persists the clear, and reports the count", async () => {
    const ripper = controllableRipper()
    const written: BayLedger[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [troyRecord],
        }),
        writeLedger: async ({ ledger }) => {
          written.push(ledger)
        },
      }),
    )

    await watcher.tickNow()
    expect(watcher.getLoadedDiscs().count).toBe(1)

    const report = await watcher.runTrayCommand({
      request: { kind: "clear_loaded" },
    })

    expect(report.is_accepted).toBe(true)
    expect(report.command).toBe("clear_loaded")
    expect(report.message).toContain("1 disc")

    // Forgotten: the phantom is gone, and the answer is a real
    // all-clear (readable, not blind) that a publish can clear the
    // retained reminder with.
    const cleared = watcher.getLoadedDiscs()
    expect(cleared.count).toBe(0)
    expect(cleared.isBlind).toBe(false)

    // And it was written through, so a restart reads the same
    // all-clear rather than the record we just dropped.
    expect(
      written[written.length - 1]?.records,
    ).toHaveLength(0)

    await watcher.stop()
  })

  it("⚠️ clear_loaded clears a PRESENT bay whose drive still claims the disc", async () => {
    // The defect: with the tower ON — the normal case, since the
    // reminder itself says "Press Open trays" — every loaded disc
    // is a PRESENT one, and `clear_loaded` used to leave those
    // alone so as not to "claim a disc anyone can see is gone".
    // Nobody can see it. These drives keep reporting their disc
    // long after the tray opens, so the owner took the disc out,
    // pressed Mark as taken out repeatedly, and the banner never
    // moved.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        // On the bus, and still reporting the finished disc.
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [troyRecord],
        }),
      }),
    )

    await watcher.tickNow()

    const before = watcher.getLoadedDiscs()

    expect(before.count).toBe(1)
    expect(before.isTowerOn).toBe(true)

    const report = await watcher.runTrayCommand({
      request: { kind: "clear_loaded" },
    })

    expect(report.is_accepted).toBe(true)
    expect(report.message).toContain("1 disc")
    expect(watcher.getLoadedDiscs().count).toBe(0)

    // ⚠️ The safety half, and the reason this is a flag rather
    // than a deleted bay: the disc may genuinely still be in
    // there. The bay stays latched and the next poll — which
    // still reads media — must not rip it.
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(0)
    expect(watcher.getBays()[0]?.phase).toBe("done")
    expect(watcher.getLoadedDiscs().count).toBe(0)

    await watcher.stop()
  })

  it("⚠️ a dismissed record is not resurrected as a phantom", async () => {
    // The gap a bay-only flag would leave. With the tower dark a
    // restarted daemon builds NO bays, so the LEDGER RECORD is
    // what speaks for the bay (`phantomLoadedBays`) — and
    // switching the rack off is the very next thing the owner does
    // after taking the discs out. Without the dismissal riding the
    // record, the reminder he just cleared comes straight back on
    // the next deploy.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        // Tower off, exactly as `clear_loaded`'s own ledger test:
        // no bay is built, so only the record can answer.
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [
            { ...troyRecord, isLoadedDismissed: true },
          ],
        }),
      }),
    )

    await watcher.tickNow()

    expect(watcher.getLoadedDiscs().count).toBe(0)
    // ⚠️ And still a REAL all-clear rather than a blind one, so a
    // publish clears the retained reminder instead of withholding.
    expect(watcher.getLoadedDiscs().isBlind).toBe(false)

    await watcher.stop()
  })

  it("a new disc in a dismissed bay reminds again", async () => {
    // The dismissal is about ONE disc. It dies with that disc, or
    // it silences the reminder for every disc that follows.
    const ripper = controllableRipper({
      reportsRipStarted: true,
    })

    let sizeSectors: number | null = BLURAY_SECTORS

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () =>
          sizeSectors === null
            ? [
                probedDrive({
                  driveId: SLOT_9,
                  kernelName: "sr0",
                  sizeSectors: 0,
                }),
              ]
            : [
                probedDrive({
                  driveId: SLOT_9,
                  kernelName: "sr0",
                  sizeSectors,
                }),
              ],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [troyRecord],
        }),
      }),
    )

    await watcher.tickNow()
    await watcher.runTrayCommand({
      request: { kind: "clear_loaded" },
    })
    expect(watcher.getLoadedDiscs().count).toBe(0)

    // The drive finally agrees: the tray reads empty, the bay
    // re-arms, and the dismissal goes with the disc it was about.
    sizeSectors = null
    await watcher.tickNow()
    await watcher.tickNow()
    await watcher.tickNow()

    // Re-armed, so the dismissal died with the disc rather than
    // outliving it — and the bay is ready to remind about the
    // next one.
    expect(watcher.getBays()[0]?.phase).toBe("idle")
    expect(watcher.getBays()[0]?.isLoadedDismissed).toBe(
      false,
    )

    await watcher.stop()
  })

  it("does not wipe the ledger while blind (tower off)", async () => {
    // ⚠️ The root-cause fix. A daemon restarted against a dark
    // tower builds NO bays, so a naive persist would write an
    // empty record set over the disk — erasing the memory of a
    // disc left in a powered-off tower, which the next daemon then
    // re-rips. The poll must leave the ledger alone when it can
    // see nothing.
    const ripper = controllableRipper()
    const written: BayLedger[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        // Tower off: no drive answers, so no bay is built.
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [troyRecord],
        }),
        writeLedger: async ({ ledger }) => {
          written.push(ledger)
        },
      }),
    )

    await watcher.tickNow()
    await watcher.tickNow()

    // The empty-and-blind poll wrote nothing — the record on disk
    // survives untouched, and the in-memory reminder still has it.
    expect(
      written.some((l) => l.records.length === 0),
    ).toBe(false)
    expect(watcher.getLoadedDiscs().count).toBe(1)

    await watcher.stop()
  })

  it("does not wipe latched records while blind just because trayCommands remain", async () => {
    // Measured 2026-08-09 after THE PEOPLE VS LARRY FLYNT finished:
    // bays.json had `records: []` but a full set of close_bay
    // trayCommands. The old guard only skipped a blind write when
    // BOTH records AND trayCommands were empty, so tray memory
    // alone punched a hole and wiped finished-disc records.
    const ripper = controllableRipper()
    const written: BayLedger[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          // The standing tray-command section that used to defeat
          // the blind guard.
          trayCommands: [
            {
              driveId: SLOT_9,
              lastTrayCommand: "close_bay" as const,
              updatedAtMs: 1,
            },
          ],
          records: [troyRecord],
        }),
        writeLedger: async ({ ledger }) => {
          written.push(ledger)
        },
      }),
    )

    await watcher.tickNow()
    await watcher.tickNow()

    expect(
      written.some((l) => l.records.length === 0),
    ).toBe(false)
    expect(watcher.getLoadedDiscs().count).toBe(1)

    await watcher.stop()
  })

  it("keeps a just-finished disc in the ledger when the tower then goes dark", async () => {
    // Live path: rip completes → tower powers off (user walks away
    // or auto power-off). The latched bay must stay in memory AND
    // on disk so discs_loaded and the next restart both know.
    const ripper = controllableRipper()
    const written: BayLedger[] = []
    let drives: ProbedDrive[] = [
      probedDrive({
        driveId: SLOT_9,
        kernelName: "sr0",
        sizeSectors: BLURAY_SECTORS,
      }),
    ]

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
        writeLedger: async ({ ledger }) => {
          written.push(structuredClone(ledger))
        },
      }),
    )

    await watcher.tickNow()
    await flush()
    ripper.finish(SLOT_9)
    await flush()

    expect(watcher.getBays()[0]?.phase).toBe("done")
    expect(watcher.getLoadedDiscs().count).toBe(1)
    expect(written.some((l) => l.records.length > 0)).toBe(
      true,
    )

    // Bus goes dark — same shape as a powered-off tower.
    drives = []
    await watcher.tickNow()
    await watcher.tickNow()

    expect(watcher.getBays()[0]?.phase).toBe("done")
    expect(watcher.getLoadedDiscs().count).toBe(1)
    expect(watcher.getLoadedDiscs().isTowerOn).toBe(false)

    const firstRecordIdx = written.findIndex(
      (l) => l.records.length > 0,
    )
    expect(firstRecordIdx).toBeGreaterThanOrEqual(0)
    for (
      let i = firstRecordIdx + 1;
      i < written.length;
      i++
    ) {
      expect(written[i]?.records.length).toBeGreaterThan(0)
    }

    await watcher.stop()
  })

  it("does not drop a completion write that races a poll write", async () => {
    // Completion calls persistLedger while a slow poll write can
    // still be in flight. Dropping the newer payload left the disk
    // on the older empty set.
    const ripper = controllableRipper()
    const written: BayLedger[] = []
    // Boxed so the assignment inside writeLedger is not narrowed
    // to `never` by control-flow analysis when we call it later.
    const gate: { release: (() => void) | null } = {
      release: null,
    }

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        writeLedger: async ({ ledger }) => {
          // First write blocks until the test releases it, so the
          // completion's persist collides with an in-flight poll.
          if (written.length === 0) {
            await new Promise<void>((resolve) => {
              gate.release = resolve
            })
          }
          written.push(structuredClone(ledger))
        },
      }),
    )

    await watcher.tickNow()
    // Poll write is now in flight (blocked). Finish the rip so
    // completion queues a second persist.
    ripper.finish(SLOT_9)
    await flush()

    expect(gate.release).not.toBeNull()
    gate.release?.()
    await flush()
    await flush()

    expect(
      written.some((l) =>
        l.records.some(
          (r) => r.driveId === SLOT_9 && r.phase === "done",
        ),
      ),
    ).toBe(true)
    expect(watcher.getLoadedDiscs().count).toBe(1)

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * Cold power-on — a disc present when the tower comes on is
 * adopted (held / ledger-recognised), never blind-re-ripped,
 * because the drive enumerates a moment before its disc is
 * readable and the first sighting looks empty.
 * ------------------------------------------------------------ */

describe("startWatcher cold power-on", () => {
  const empty = () =>
    probedDrive({
      driveId: SLOT_9,
      kernelName: "sr0",
      sizeSectors: 0,
    })
  const loaded = () =>
    probedDrive({
      driveId: SLOT_9,
      kernelName: "sr0",
      sizeSectors: BLURAY_SECTORS,
    })

  it("holds a disc that appears after the empty first-sight — never re-rips it", async () => {
    // ⚠️ The Soylent Green regression. Tower off, then on: the
    // drive enumerates EMPTY (spin-up), then the loaded disc
    // becomes readable a poll later. It must NOT be treated as a
    // fresh insert and ripped.
    const ripper = controllableRipper()
    let drives: ProbedDrive[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: false,
          trayCommands: [],
          records: [],
        }),
      }),
    )

    await watcher.tickNow() // tower off
    drives = [empty()] // powers on, disc not readable yet
    await watcher.tickNow()
    drives = [loaded()] // disc becomes readable
    await watcher.tickNow()
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(0)
    const bay = watcher.getBays()[0]
    expect(bay.phase).toBe("done")
    expect(bay.outcome?.kind).toBe("needs_attention")

    await watcher.stop()
  })

  it("recognises a finished disc across a cold power-on from its ledger record", async () => {
    const ripper = controllableRipper()
    let drives: ProbedDrive[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          trayCommands: [],
          records: [
            {
              driveId: SLOT_9,
              phase: "done",
              sizeSectors: BLURAY_SECTORS,
              discName: "TROY - THEATRICAL CUT",
              discType: "bluray",
              destinationPath: "/dest/[BACKUP] TROY",
              jobUuid: LEDGER_JOB_UUID,
              outcome: {
                kind: "completed",
                detail: "/dest/[BACKUP] TROY",
              },
              isLoadedDismissed: false,
              updatedAtMs: 1,
            },
          ],
        }),
      }),
    )

    await watcher.tickNow()
    drives = [empty()]
    await watcher.tickNow()
    drives = [loaded()]
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(0)
    const bay = watcher.getBays()[0]
    expect(bay.phase).toBe("done")
    expect(bay.outcome?.kind).toBe("completed")
    expect(bay.discName).toBe("TROY - THEATRICAL CUT")

    await watcher.stop()
  })

  it("rips a genuinely new disc loaded before power-on (the owner's decision)", async () => {
    // hasPriorState with no record for this disc: the "load the
    // tower, then power it on" case. A new disc still rips — held
    // is only for discs rip-deck already finished.
    const ripper = controllableRipper()
    let drives: ProbedDrive[] = []

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    drives = [empty()]
    await watcher.tickNow()
    drives = [loaded()]
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(1)

    await watcher.stop()
  })

  it("still rips a disc that is present at the very first sighting", async () => {
    // Drive already spun up (daemon started after the tower was
    // on): the disc is readable at first sight, so the owner's
    // load-then-start decision rips it, unchanged.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [loaded()],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(1)

    await watcher.stop()
  })

  it("rips a real insert once the tray has settled empty", async () => {
    // The normal path must survive: a drive that has been empty
    // long enough to settle rips the next disc inserted into it.
    const ripper = controllableRipper()
    let drives = [empty()]

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
      }),
    )

    // Settle: empty for more than `settleEmptyObservations` polls.
    await watcher.tickNow()
    await watcher.tickNow()
    await watcher.tickNow()
    await watcher.tickNow()
    expect(ripper.started).toHaveLength(0)

    // Now a genuine insert.
    drives = [loaded()]
    await watcher.tickNow()
    expect(ripper.started).toHaveLength(1)

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * Tower power-cycle on a RUNNING daemon — the case the cold
 * power-on guard misses, because the daemon never restarts, the
 * in-memory ledger is a snapshot frozen before this disc was
 * ripped, and the ~10s spin-up re-arms the finished bay. The
 * disc that comes back must be held from the bay's OWN memory,
 * never re-ripped
 * ([decision](docs/decisions/2026-07-31-power-cycle-holds-a-finished-disc-from-bay-memory.md)).
 * ------------------------------------------------------------ */

describe("startWatcher tower power-cycle", () => {
  const empty = () =>
    probedDrive({
      driveId: SLOT_9,
      kernelName: "sr0",
      sizeSectors: 0,
    })
  const loaded = (sectors: number = BLURAY_SECTORS) =>
    probedDrive({
      driveId: SLOT_9,
      kernelName: "sr0",
      sizeSectors: sectors,
    })

  // The daemon read its ledger at boot and it was EMPTY — this
  // disc is ripped later, in-session. So nothing on disk can
  // recognise it across the power-cycle; only the bay's own
  // `lastFinished` can. This is the exact production condition
  // (Desk Set finished during a 10-hour uptime).
  const emptyLedger = async () => ({
    version: BAY_LEDGER_VERSION,
    hasPriorState: true,
    trayCommands: [],
    records: [],
  })

  it("holds a disc it ripped THIS session across a power-cycle — never re-rips it", async () => {
    const ripper = controllableRipper()
    let drives: ProbedDrive[] = [loaded()]

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
        readLedger: emptyLedger,
      }),
    )

    // Rip it to completion, as a running daemon would.
    await watcher.tickNow()
    expect(ripper.started).toHaveLength(1)
    ripper.finish(SLOT_9, {
      kind: "completed",
      detail: "/dest/[BACKUP] Desk Set - Blu-ray",
    })
    await flush()
    expect(watcher.getBays()[0].phase).toBe("done")

    // Tower powers OFF — the drive drops off the bus.
    drives = []
    await watcher.tickNow()
    await watcher.tickNow()

    // Tower powers ON — the drive enumerates but its disc is not
    // readable yet. Six empty polls is well past both the re-arm
    // and the settle thresholds: the bug's whole cause.
    drives = [empty()]
    for (let tick = 0; tick < 6; tick += 1) {
      await watcher.tickNow()
    }

    // The disc finally reads. It must be recognised as the one
    // already backed up, and held — not re-ripped.
    drives = [loaded()]
    await watcher.tickNow()
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(1)
    const bay = watcher.getBays()[0]
    expect(bay.phase).toBe("done")
    expect(bay.outcome?.kind).toBe("completed")

    await watcher.stop()
  })

  it("still rips a genuinely different disc after the finished one is taken out", async () => {
    // The fail-closed hold must not swallow the normal path: eject
    // the finished disc, load a DIFFERENT one, and it rips.
    const ripper = controllableRipper()
    let drives: ProbedDrive[] = [loaded()]

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => drives,
        runBayRip: ripper.runBayRip,
        readLedger: emptyLedger,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9, {
      kind: "completed",
      detail: "/dest/[BACKUP] Desk Set - Blu-ray",
    })
    await flush()
    expect(watcher.getBays()[0].phase).toBe("done")

    // The operator takes the disc out — a genuine, settled empty.
    drives = [empty()]
    for (let tick = 0; tick < 6; tick += 1) {
      await watcher.tickNow()
    }
    expect(watcher.getBays()[0].phase).toBe("idle")

    // A different disc goes in. Different size → not the finished
    // one → it rips.
    drives = [loaded(CD_SECTORS)]
    await watcher.tickNow()
    await watcher.tickNow()

    expect(ripper.started).toHaveLength(2)

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * Tray commands — the operator's button.
 * ------------------------------------------------------------ */

describe("startWatcher tray commands", () => {
  const trayRecorder = () => {
    const moved: {
      action: string
      devPath: string
    }[] = []

    return {
      moved,
      runTray: async (params: {
        action: "open" | "close"
        devPath: string
      }) => {
        moved.push({
          action: params.action,
          devPath: params.devPath,
        })

        return {
          isSuccessful: true,
          isCommandMissing: false,
          isTimedOut: false,
          exitCode: 0,
          detail:
            params.action === "open" ? "opened" : "closed",
        }
      },
    }
  }

  it("powers the tower on for Open trays when the tower is off", async () => {
    // Off = no drives on the bus (a valid state — the rack is
    // powered independently). The bulk Open publishes the power-on
    // request an HA automation acts on, and moves no tray this
    // press. Close on an off tower does NOT power it on.
    let powerOns = 0
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
        publishTowerPowerOn: () => {
          powerOns += 1
        },
      },
      watcherDeps({
        probeDrives: async () => [],
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
        runTray: tray.runTray,
      }),
    )

    const openReport = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(powerOns).toBe(1)
    expect(openReport.message).toContain("powering it on")
    expect(tray.moved).toEqual([])

    const closeReport = await watcher.runTrayCommand({
      request: { kind: "close_trays" },
    })

    expect(powerOns).toBe(1)
    expect(closeReport.counts.closed).toBe(0)

    await watcher.stop()
  })

  it("opens finished bays first, then the rest on the next press", async () => {
    // The stateless escalation. Slot 9 holds a finished disc; slot
    // 8 is empty. The first press resolves `openScope: "finished"`
    // and opens only slot 9. Once slot 9's drawer is open, the
    // second press sees every finished bay already open, widens to
    // `"all"`, and opens the empty slot 8 too.
    const ripper = controllableRipper()
    const tray = trayRecorder()
    const SLOT_8 = "2-1.1.2.4.4.3"

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
          probedDrive({
            driveId: SLOT_8,
            kernelName: "sr1",
            sizeSectors: EMPTY_TRAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    const first = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr0" },
    ])
    expect(
      first.bays.find((b) => b.drive_id === SLOT_8)?.result,
    ).toBe("skipped_not_finished")

    const second = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(
      tray.moved.some(
        (move) => move.devPath === "/dev/sr1",
      ),
    ).toBe(true)
    expect(
      second.bays.find((b) => b.drive_id === SLOT_8)
        ?.result,
    ).toBe("opened_not_ripped")

    await watcher.stop()
  })

  it("opens only the finished bay when the drawer memory says open but the disc ripped", async () => {
    // The regression, measured on the live tower 2026-08-20:
    // "Opened 9 drives" on the FIRST press, with a single finished
    // disc in the rack and eight empty bays.
    //
    // `lastTrayCommand` is the only drawer knowledge there is, and
    // it is written ONLY when rip-deck itself moves a tray - never
    // when the operator pushes one shut by hand, which is how a
    // disc gets loaded after pressing ▲. So a bay can carry
    // `open_bay` into a rip and out the far side of it.
    //
    // `open_trays` folds that field to ask "is every finished bay
    // already open?". Against the stale value it answered yes,
    // widened the scope to `"all"`, and opened every empty drawer
    // too. The tower proved the mechanism the other way round the
    // same night: with the same bay's memory reading `close_bay`,
    // the identical press opened slot 2 alone and skipped the
    // other eight.
    //
    // `applyRipStarted` now records `close_bay`, because a drive
    // cannot read a disc with its drawer hanging out.
    const ripper = controllableRipper({
      reportsRipStarted: true,
    })
    const tray = trayRecorder()
    const SLOT_8 = "2-1.1.2.4.4.3"

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
          probedDrive({
            driveId: SLOT_8,
            kernelName: "sr1",
            sizeSectors: EMPTY_TRAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
        // The drawer rip-deck last opened, remembered across the
        // disc going in. This is the state the live tower was in.
        readLedger: async () => ({
          version: BAY_LEDGER_VERSION,
          hasPriorState: true,
          records: [],
          trayCommands: [
            {
              driveId: SLOT_9,
              lastTrayCommand: "open_bay" as const,
              updatedAtMs: 1,
            },
          ],
        }),
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    tray.moved.length = 0

    const first = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    // Only the finished bay. Slot 8 is empty and stays shut.
    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr0" },
    ])
    expect(
      first.bays.find((b) => b.drive_id === SLOT_8)?.result,
    ).toBe("skipped_not_finished")

    await watcher.stop()
  })

  it("⚠️ never opens a bay that is ripping", async () => {
    // The assertion this whole command surface is judged on.
    const ripper = controllableRipper()
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(9)

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(tray.moved).toHaveLength(0)
    expect(report.counts.refused).toBe(9)
    expect(report.counts.opened).toBe(0)
    expect(report.message.startsWith("Refused")).toBe(true)

    await watcher.stop()
  })

  it("opens exactly the finished bays, and says which", async () => {
    const ripper = controllableRipper()
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: "2-1.1.0",
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
          probedDrive({
            driveId: "2-1.1.1",
            kernelName: "sr1",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()

    ripper.finish("2-1.1.0")
    await flush()

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
      requestId: "press-1",
    })

    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr0" },
    ])
    expect(report.request_id).toBe("press-1")
    expect(report.counts.opened).toBe(1)
    expect(report.counts.refused).toBe(1)

    await watcher.stop()
  })

  it("opens every loaded bay when NOTHING is finished", async () => {
    // ⚠️ Tonight's tower, in one assertion (G5). Nine bays with
    // the owner's audio CDs in them, nothing ripped this
    // session: the selective rule answered
    // `skipped_not_finished` nine times and moved no drawer at
    // all, twice, while he stood at the rack. *"If there's no
    // pass-fail like right now, the button should open and
    // close all of them."*
    //
    // No tick first, on purpose: the poll loop has not adopted
    // these bays, so every one of them is unknown — which is
    // also the shortest way to say "nothing on this tower is
    // finished with".
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
        runTray: tray.runTray,
      }),
    )

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(tray.moved).toHaveLength(9)
    expect(
      tray.moved.every((move) => move.action === "open"),
    ).toBe(true)
    expect(report.counts.refused).toBe(0)
    expect(report.message).toContain("Opened 9 drives")
    // The spoken line describes THIS command, not a rip
    // session that never happened.
    expect(report.message).not.toContain("never ripped")

    await watcher.stop()
  })

  it("moves bulk trays one at a time on the shared USB tree", async () => {
    let inFlight = 0
    let maxInFlight = 0

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
        runTray: async ({ action }) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await Promise.resolve()
          inFlight -= 1

          return {
            isSuccessful: true,
            isCommandMissing: false,
            isTimedOut: false,
            exitCode: 0,
            detail: action === "open" ? "opened" : "closed",
          }
        },
      }),
    )

    await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(maxInFlight).toBe(1)
    await watcher.stop()
  })

  it("⚠️ opens the idle bays and still refuses the ripping one", async () => {
    // The fallback's safety case. The cap is one, so bay 1 rips
    // and the other eight sit idle holding discs — nothing is
    // finished, so ▲ falls back to "open all". "All" still
    // excludes the bay holding 90 GB half-written.
    const ripper = controllableRipper()
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 1 }),
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(1)

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(report.counts.refused).toBe(1)
    expect(tray.moved).toHaveLength(8)
    expect(
      tray.moved.some(
        (move) => move.devPath === "/dev/sr0",
      ),
    ).toBe(false)
    expect(report.message.startsWith("Refused")).toBe(true)

    await watcher.stop()
  })

  it("opens the empty bay too in 'all' scope", async () => {
    // ⚠️ Flipped by the 2026-07-30 redesign. Nothing here is
    // finished, so the fold resolves `openScope: "all"` — the
    // escalation opens EVERY non-ripping bay, empty ones included,
    // so a disc can be loaded into them. The old fallback skipped
    // an empty drawer; "open all" no longer does.
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: "2-1.1.0",
            kernelName: "sr0",
            sizeSectors: EMPTY_TRAY_SECTORS,
          }),
          probedDrive({
            driveId: "2-1.1.1",
            kernelName: "sr1",
            sizeSectors: CD_SECTORS,
          }),
        ],
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
        runTray: tray.runTray,
      }),
    )

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    // Both open — order is concurrent, so assert the set.
    expect(
      tray.moved.map((move) => move.devPath).sort(),
    ).toEqual(["/dev/sr0", "/dev/sr1"])
    expect(
      tray.moved.every((m) => m.action === "open"),
    ).toBe(true)
    // Neither disc was ripped, so both count as opened_not_ripped.
    expect(report.counts.opened_not_ripped).toBe(2)

    await watcher.stop()
  })

  it("skips a bay it never opened, on close", async () => {
    // ⚠️ Flipped by the 2026-07-30 redesign. Close trays now closes
    // only what `lastTrayCommand` says is open. The bay below holds
    // a disc and rip-deck has no memory of touching its drawer, so
    // it is left alone as `skipped_already_closed` — the old
    // close-all would have sent it a no-op close.
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: CD_SECTORS,
          }),
        ],
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
        runTray: tray.runTray,
      }),
    )

    const report = await watcher.runTrayCommand({
      request: { kind: "close_trays" },
    })

    expect(tray.moved).toEqual([])
    expect(report.counts.closed).toBe(0)
    expect(report.bays[0].result).toBe(
      "skipped_already_closed",
    )

    await watcher.stop()
  })

  it("moves no tray on bulk close while any bay is ripping", async () => {
    const ripper = controllableRipper()
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: "2-1.1.0",
            kernelName: "sr0",
            sizeSectors: EMPTY_TRAY_SECTORS,
          }),
          probedDrive({
            driveId: "2-1.1.1",
            kernelName: "sr1",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()

    // Open the idle bay while sr1 keeps ripping. This is the
    // exact state the live failure reached before Close Trays.
    await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })
    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr0" },
    ])
    tray.moved.length = 0

    const report = await watcher.runTrayCommand({
      request: { kind: "close_trays" },
    })

    // The per-bay refusal on sr1 is not enough: closing sr0 can
    // reset the shared hub and destroy sr1's rip. The whole bulk
    // close therefore moves nothing.
    expect(tray.moved).toEqual([])
    expect(report.counts.closed).toBe(0)
    expect(report.counts.refused).toBe(1)
    expect(
      report.bays.find(
        (entry) => entry.drive_id === "2-1.1.0",
      )?.result,
    ).toBe("skipped_untouched")

    await watcher.stop()
  })

  it("resolves /dev/srN fresh, because it reshuffles", async () => {
    // A tray command resolved from a five-second-old probe can
    // open the wrong bay, and "the wrong bay" means one that
    // was ripping.
    const ripper = controllableRipper()
    const tray = trayRecorder()
    let kernelName = "sr0"

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName,
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    kernelName = "sr7"

    await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr7" },
    ])

    await watcher.stop()
  })

  it("answers a single-bay command aimed at nothing", async () => {
    const ripper = controllableRipper()
    const tray = trayRecorder()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()

    const report = await watcher.runTrayCommand({
      request: { kind: "open_bay", target: { slot: 4 } },
    })

    expect(tray.moved).toHaveLength(0)
    expect(report.bays[0].result).toBe(
      "skipped_not_present",
    )

    await watcher.stop()
  })

  it("reports a failed eject rather than claiming success", async () => {
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: async () => ({
          isSuccessful: false,
          isCommandMissing: true,
          isTimedOut: false,
          exitCode: null,
          detail:
            "this rip-deck image has no `eject` binary, so no " +
            "tray could be moved.",
        }),
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    const report = await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(report.counts.opened).toBe(0)
    expect(report.counts.failed).toBe(1)
    expect(report.message).toContain("no `eject` binary")

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * The one thing the ⏏ toggle can honestly stand on.
 * ------------------------------------------------------------ */

/**
 * What rip-deck last did to a drawer, and what it did not do.
 *
 * ⚠️ Tray POSITION is unreadable — sysfs reports media, not the
 * door, and telling an open tray from a closed empty one needs a
 * `CDROM_DRIVE_STATUS` ioctl Node cannot issue. So the dashboard's
 * open/close toggle is an inference off this memory, and the two
 * assertions that matter are that it records a tray that MOVED and
 * only a tray that moved, and that it survives the restart the
 * next press comes after.
 */
describe("startWatcher tray memory", () => {
  const trayWatcher = (input: {
    probeDrives: () => Promise<ProbedDrive[]>
    runBayRip: WatcherDeps["runBayRip"]
    readLedger?: WatcherDeps["readLedger"]
    writeLedger?: WatcherDeps["writeLedger"]
  }) =>
    startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        ...input,
        runTray: async (params) => ({
          isSuccessful: true,
          isCommandMissing: false,
          isTimedOut: false,
          exitCode: 0,
          detail:
            params.action === "open" ? "opened" : "closed",
        }),
      }),
    )

  const loadedBay = async (): Promise<ProbedDrive[]> => [
    probedDrive({
      driveId: SLOT_9,
      kernelName: "sr0",
      sizeSectors: BLURAY_SECTORS,
    }),
  ]

  it("remembers the bay it opened", async () => {
    const ripper = controllableRipper()
    const watcher = trayWatcher({
      probeDrives: loadedBay,
      runBayRip: ripper.runBayRip,
    })

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    expect(watcher.getBays()[0].lastTrayCommand).toBe(
      "open_bay",
    )

    await watcher.stop()
  })

  it("⚠️ does not move on a REFUSED command", async () => {
    // A refusal touched no drawer, so it is not news about one.
    // A toggle that flipped here would tell the owner his
    // ripping bay is open — and the press after that reads
    // `close_bay`, aimed at a drive mid-rip.
    const ripper = controllableRipper()
    const watcher = trayWatcher({
      probeDrives: loadedBay,
      runBayRip: ripper.runBayRip,
    })

    await watcher.tickNow()
    expect(ripper.started).toHaveLength(1)

    const report = await watcher.runTrayCommand({
      request: {
        kind: "open_bay",
        target: { driveId: SLOT_9 },
      },
    })

    expect(report.counts.refused).toBe(1)
    expect(watcher.getBays()[0].lastTrayCommand).toBeNull()

    await watcher.stop()
  })

  it("does not move on a SKIPPED command either", async () => {
    // ▼ skips a bay rip-deck never opened (close-only-open):
    // nothing was sent, so there is nothing to remember. The
    // finished disc is still in the drive, and its drawer was
    // never touched, so Close leaves it `skipped_already_closed`.
    const ripper = controllableRipper()

    const watcher = trayWatcher({
      probeDrives: async () => [
        probedDrive({
          driveId: SLOT_9,
          kernelName: "sr0",
          sizeSectors: BLURAY_SECTORS,
        }),
      ],
      runBayRip: ripper.runBayRip,
    })

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    const report = await watcher.runTrayCommand({
      request: { kind: "close_trays" },
    })

    expect(report.bays[0].result).toBe(
      "skipped_already_closed",
    )
    expect(watcher.getBays()[0].lastTrayCommand).toBeNull()

    await watcher.stop()
  })

  it("keeps the memory when the disc is taken out", async () => {
    // The press this feature exists for comes AFTER the owner
    // takes the disc out of the drawer rip-deck opened — and
    // that removal re-arms the bay, which rebuilds every other
    // field from scratch. Dropping the tray memory there would
    // reset the toggle to "open" at the exact moment he reaches
    // for it to close.
    const ripper = controllableRipper()
    let sizeSectors = BLURAY_SECTORS

    const watcher = trayWatcher({
      probeDrives: async () => [
        probedDrive({
          driveId: SLOT_9,
          kernelName: "sr0",
          sizeSectors,
        }),
      ],
      runBayRip: ripper.runBayRip,
    })

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    await watcher.runTrayCommand({
      request: { kind: "open_trays" },
    })

    // The disc is lifted out. Two empty readings re-arm the bay.
    sizeSectors = EMPTY_TRAY_SECTORS
    await watcher.tickNow()
    await watcher.tickNow()

    expect(watcher.getBays()[0].phase).toBe("idle")
    expect(watcher.getBays()[0].lastTrayCommand).toBe(
      "open_bay",
    )

    await watcher.stop()
  })

  it("survives a restart, through the ledger on disk", async () => {
    // Without this the toggle resets to "open" on every deploy,
    // which is the whole reason the memory is in the ledger and
    // not in the browser.
    const ripper = controllableRipper()
    let written = ""

    const first = trayWatcher({
      probeDrives: loadedBay,
      runBayRip: ripper.runBayRip,
      writeLedger: async ({ ledger }) => {
        // Through JSON, because that is the only form the next
        // daemon ever sees it in.
        written = JSON.stringify({
          version: ledger.version,
          records: ledger.records,
          trayCommands: ledger.trayCommands,
        })
      },
    })

    await first.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    await first.runTrayCommand({
      request: { kind: "open_trays" },
    })
    await first.stop()

    const restarted = trayWatcher({
      probeDrives: loadedBay,
      runBayRip: async () => {
        throw new Error(
          "a held disc must never start a rip",
        )
      },
      readLedger: async () => parseBayLedger(written),
    })

    await restarted.tickNow()

    const bay = restarted.getBays()[0]

    expect(bay.lastTrayCommand).toBe("open_bay")
    // And the rest of the record still holds the disc, which is
    // the behaviour this section may not regress.
    expect(bay.phase).toBe("done")

    await restarted.stop()
  })
})

/* ------------------------------------------------------------ *
 * What the poll saw, for readers that are not the state machine.
 * ------------------------------------------------------------ */

describe("startWatcher sightings", () => {
  const towerRegistry: DriveRegistry = {
    towerRootPortPath: "2-1.1",
    entries: [
      {
        slot: 2,
        // Prefixed, as `config/drives.json` writes it.
        name: "02 - LG WH14NS40",
        firmwareSerial: "EXAMPLE00001",
        trueModel: "LG WH14NS40",
        reportedModel: "BW-16D1HT",
        usbPortPath: "2-1.0",
        bridgeSerial: "",
        isUhdCapable: true,
        readOffsetSamples: null,
      },
    ],
  }

  it("says what the drive is, not what it claims", async () => {
    // The probe reports vendor ASUS / model BD-RW BDR-211M for
    // every fake drive here. Slots 2-4 really are LG drives
    // running OmniDrive firmware that reports them as ASUS, so
    // a self-reported model is the one fact on this tower that
    // is known to lie — the registry overrules it.
    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      {
        ...watcherDeps({
          probeDrives: async () => [
            probedDrive({
              driveId: "2-1.0",
              kernelName: "sr4",
              sizeSectors: 0,
            }),
          ],
          runBayRip: async () => ({
            kind: "completed",
            detail: "",
          }),
        }),
        loadRegistry: async () => towerRegistry,
      },
    )

    await watcher.tickNow()

    expect(watcher.getBaySightings()).toEqual([
      {
        driveId: "2-1.0",
        isDrivePresent: true,
        slot: 2,
        label: "02 - LG WH14NS40",
        devPath: "/dev/sr4",
        vendor: "LG",
        model: "WH14NS40",
        serial: "EXAMPLE00001",
      },
    ])

    await watcher.stop()
  })

  it("stops calling a bay present once it leaves the bus", async () => {
    // `isPresent` used to be hardcoded true in the API, so bays
    // lingered as present forever after the tower was switched
    // off — which the owner does independently of this service.
    let isPoweredOn = true

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () =>
          isPoweredOn
            ? [
                probedDrive({
                  driveId: "2-1.0",
                  kernelName: "sr4",
                  sizeSectors: 0,
                }),
              ]
            : [],
        runBayRip: async () => ({
          kind: "completed",
          detail: "",
        }),
      }),
    )

    await watcher.tickNow()
    isPoweredOn = false
    await watcher.tickNow()

    const [sighting] = watcher.getBaySightings()

    expect(sighting.isDrivePresent).toBe(false)
    // Still named — a bay that vanished is worth showing as
    // gone rather than dropping off the rack.
    expect(sighting.driveId).toBe("2-1.0")
    // But not addressed: `/dev/sr4` now belongs to whatever
    // inherits the name at the next re-enumeration.
    expect(sighting.devPath).toBeNull()

    await watcher.stop()
  })

  it("announces the tick only once every bay is decided", async () => {
    // The whole point of the signal. `onNote` fires at the TOP
    // of the tick, when the bay table still describes the
    // previous poll — which on the first tick is nothing at
    // all, and is why `/json` served three bays of nine.
    const seen: { note: number; tick: number } = {
      note: -1,
      tick: -1,
    }

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 0 }),
        handlers: {
          onNote: () => {
            seen.note = watcher.getBays().length
          },
          onTickComplete: () => {
            seen.tick = watcher.getBays().length
          },
        },
      },
      watcherDeps({
        probeDrives: async () => nineLoadedDrives(),
        runBayRip: async () => ({
          kind: "completed",
          detail: "",
        }),
      }),
    )

    await watcher.tickNow()

    expect(seen.note).toBe(0)
    expect(seen.tick).toBe(9)

    await watcher.stop()
  })
})

/* ------------------------------------------------------------ *
 * The drive read offset, from the file to the argv.
 * ------------------------------------------------------------ */

/**
 * The one chain this feature is.
 *
 * A drive's AccurateRip read offset is worth nothing until it
 * reaches cyanrip's `-s`, and every link between
 * `config/drives.json` and that flag is somewhere it can be
 * dropped silently. So this section walks the whole chain with
 * the REAL loader against a REAL file on disk — no stubbed
 * registry — and ends on the argv itself.
 *
 * ⚠️ **Types lining up is not the evidence.** This repo has
 * shipped five functions that were written, unit-tested and
 * called by nothing; the audit that found them is two days old.
 * A test asserting the field exists would have passed against
 * every one of them.
 *
 * The one link no test can cross is the spawn: `ripAudioCd` is
 * behind `waitForSettledMedia` and `detectDiscType`, which read
 * `/sys/block/srN` directly, so it needs the tower. That is why
 * `buildBayCyanripInvocation` is its own exported function —
 * `ripAudioCd` hands it the same `BayRipInput` this test does.
 */
describe("the drive read offset reaches cyanrip", () => {
  const OFFSET_DRIVE = "2-1.7"

  /**
   * A slot map on disk, in the shape `config/drives.json`
   * writes it — including the `$comment` keys, which are real
   * and which the loader must ignore rather than choke on.
   */
  const writeRegistryFile = async (
    readOffsetSamples: number | null,
  ): Promise<{
    path: string
    cleanup: () => Promise<void>
  }> => {
    const dir = await mkdtemp(
      join(tmpdir(), "rip-deck-offset-"),
    )
    const path = join(dir, "drives.json")

    await writeFile(
      path,
      JSON.stringify({
        $comment: [
          "Keyed on firmwareSerial, never on model.",
        ],
        towerRootPortPath: "2-1",
        drives: [
          {
            slot: 3,
            name: "03 - LG WH14NS40",
            // The serial is the key. Slots 2-4 are LG drives
            // whose OmniDrive firmware reports them as ASUS, so
            // an offset looked up from either model string
            // below would be the wrong drive's.
            firmwareSerial: "EXAMPLE00003",
            trueModel: "LG WH14NS40",
            reportedModel: "BW-16D1HT",
            usbPortPath: OFFSET_DRIVE,
            bridgeSerial: "123456789283",
            isUhdCapable: true,
            readOffsetSamples,
          },
        ],
      }),
    )

    return {
      path,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  /**
   * Dispatch one CD in that drive and hand back the bay input
   * the watcher built for it.
   */
  const dispatchedBayInput = async (
    readOffsetSamples: number | null,
  ): Promise<BayRipInput> => {
    const file = await writeRegistryFile(readOffsetSamples)
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: {
          ...noopConfig,
          registryPath: file.path,
        },
        governor: createGovernor({ maxConcurrentRips: 1 }),
      },
      {
        ...watcherDeps({
          probeDrives: async () => [
            probedDrive({
              driveId: OFFSET_DRIVE,
              kernelName: "sr7",
              sizeSectors: CD_SECTORS,
            }),
          ],
          runBayRip: ripper.runBayRip,
        }),
        // The REAL loader, reading the REAL file. A stub here
        // would prove only that the test can invent a number.
        loadRegistry: loadDriveRegistry,
      },
    )

    await watcher.tickNow()
    await watcher.stop()
    await file.cleanup()

    expect(ripper.started).toHaveLength(1)

    return ripper.started[0]
  }

  it("carries a measured offset onto the argv", async () => {
    const input = await dispatchedBayInput(-472)

    expect(input.readOffsetSamples).toBe(-472)

    const invocation = buildBayCyanripInvocation({
      cyanrip: noopConfig.cyanrip,
      incompletePath:
        "/media/Disc-Rips/.rip-deck-incomplete",
      rip: input,
    })

    // The assertion the whole feature exists for. Without `-s`
    // the rip is complete, audibly identical and sample-shifted
    // from the reference, so AccurateRip answers "not in
    // database" forever and it reads as a metadata bug.
    expect(invocation.args).toContain("-s")
    expect(
      invocation.args[invocation.args.indexOf("-s") + 1],
    ).toBe("-472")

    // And it is cyanrip's own device flag it lands beside, not
    // some other bay's.
    expect(invocation.args).toContain("/dev/sr7")
  })

  it("says nothing at all when no offset is measured", async () => {
    // The state all nine drives are in today. Absent must
    // behave exactly as before this feature existed: no flag,
    // no warning, no log line — the same way an absent
    // `RIP_DECK_MQTT_URL` is a supported state and not an error.
    const input = await dispatchedBayInput(null)

    expect(input.readOffsetSamples).toBeNull()

    expect(
      buildBayCyanripInvocation({
        cyanrip: noopConfig.cyanrip,
        incompletePath:
          "/media/Disc-Rips/.rip-deck-incomplete",
        rip: input,
      }).args,
    ).not.toContain("-s")
  })

  it("drops an implausible offset rather than passing it", async () => {
    // Fails toward omitting the flag. A rip with no offset is
    // the everyday state; a rip with a garbage one is silently
    // shifted, which is strictly worse than an unverified rip.
    const input = await dispatchedBayInput(9_999_999)

    expect(input.readOffsetSamples).toBeNull()

    expect(
      buildBayCyanripInvocation({
        cyanrip: noopConfig.cyanrip,
        incompletePath:
          "/media/Disc-Rips/.rip-deck-incomplete",
        rip: input,
      }).args,
    ).not.toContain("-s")
  })

  it("gives a drive the registry never heard of no offset", async () => {
    // An unknown drive and an unmeasured one collapse to the
    // same answer on purpose: both mean "no offset for this
    // drive", and guessing one from the model is the thing this
    // field exists to prevent.
    const file = await writeRegistryFile(-472)
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: { ...noopConfig, registryPath: file.path },
        governor: createGovernor({ maxConcurrentRips: 1 }),
      },
      {
        ...watcherDeps({
          probeDrives: async () => [
            probedDrive({
              driveId: "2-9.9.9",
              kernelName: "sr9",
              sizeSectors: CD_SECTORS,
            }),
          ],
          runBayRip: ripper.runBayRip,
        }),
        loadRegistry: loadDriveRegistry,
      },
    )

    await watcher.tickNow()
    await watcher.stop()
    await file.cleanup()

    expect(ripper.started[0].readOffsetSamples).toBeNull()
  })
})

/**
 * `rip_bay` — the operator ripping a held bay from the dashboard.
 *
 * The dead end this closes: a held card told the owner to run
 * `rip-deck rip --slot N --name "…"` and offered ⏏ as its only
 * control — and ⏏ does not un-hold on this rig, because the drives
 * keep reporting the disc after the tray opens. *"I don't have a
 * way to do anything actionable other than eject. Horrible user
 * experience."*
 * ([decision](docs/decisions/2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md))
 *
 * ⚠️ **The first test in this block is the refusal.** This command
 * starts a rip on a drive from outside the poll loop, so the
 * question that matters is not "does it work" but "what can it
 * reach". It must reach nothing a rip already owns.
 */
describe("startWatcher rip_bay", () => {
  const trayRecorder = (isClosingSuccessful = true) => {
    const moved: { action: string; devPath: string }[] = []

    return {
      moved,
      runTray: async (params: {
        action: "open" | "close"
        devPath: string
      }) => {
        moved.push({
          action: params.action,
          devPath: params.devPath,
        })

        return {
          isSuccessful:
            params.action === "close"
              ? isClosingSuccessful
              : true,
          isCommandMissing: false,
          isTimedOut: false,
          exitCode: isClosingSuccessful ? 0 : 1,
          detail:
            params.action === "open"
              ? "opened"
              : isClosingSuccessful
                ? "closed"
                : "CDROMCLOSETRAY: Input/output error",
        }
      },
    }
  }

  /**
   * One bay, ripped once, latched `needs_attention`. The state
   * every test below starts from and the state the owner was
   * looking at.
   */
  const heldTower = async (
    input: {
      maxConcurrentRips?: number
      isClosingSuccessful?: boolean
    } = {},
  ) => {
    const ripper = controllableRipper()
    const tray = trayRecorder(
      input.isClosingSuccessful ?? true,
    )

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({
          maxConcurrentRips: input.maxConcurrentRips ?? 9,
        }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
        runTray: tray.runTray,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9, {
      kind: "needs_attention",
      detail: "could not read a name off this disc.",
    })
    await flush()

    return { watcher, ripper, tray }
  }

  it("⚠️ never starts a second rip on a ripping bay", async () => {
    // The one assertion this command surface is judged on, and the
    // reason `rip_bay` lives on the tray surface at all: it goes
    // through `decideTrayBayAction`'s first branch like every other
    // command, so it is unreachable for a bay a rip owns.
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    await flush()

    // Targeted by drive id: this tower has no registry in these
    // tests, so no bay has a slot number.
    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: "Whatever The Operator Typed",
      },
    })

    expect(report.counts.refused).toBe(1)
    expect(report.counts.rip_started).toBe(0)
    expect(report.bays[0].result).toBe("refused_ripping")
    // One rip, the one the poll loop started. Not two.
    expect(ripper.started).toHaveLength(1)

    ripper.finish(SLOT_9)
    await watcher.stop()
  })

  it("rips a held bay under the name the operator typed", async () => {
    const { watcher, ripper } = await heldTower()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: "Soylent Green - UHD",
      },
    })

    expect(report.is_accepted).toBe(true)
    expect(report.counts.rip_started).toBe(1)
    expect(report.bays[0].result).toBe("rip_started")

    // The name reaches the ripper, which is what makes identify
    // skippable — running it again on a disc it could not name
    // returns the same nothing and holds the bay a second time.
    expect(ripper.started).toHaveLength(2)
    expect(ripper.started[1].explicitName).toBe(
      "Soylent Green - UHD",
    )

    // And the hold is gone: `applyBayDecision`'s `start` clears the
    // outcome, so the card stops saying "held" the moment the
    // dashboard refetches.
    const bay = watcher
      .getBays()
      .find((b) => b.driveId === SLOT_9)

    expect(bay?.phase).toBe("starting")
    expect(bay?.outcome).toBe(null)

    ripper.finish(SLOT_9)
    await watcher.stop()
  })

  it("re-identifies when no name is given (Try again)", async () => {
    // The other half of the card. A disc held by a transient
    // identify race — which is what latched slot 9 — just needs the
    // read attempted again on a settled disc.
    const { watcher, ripper } = await heldTower()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: null,
      },
    })

    expect(report.counts.rip_started).toBe(1)
    expect(ripper.started[1].explicitName).toBe(null)
    expect(report.bays[0].detail).toContain(
      "the disc's own name",
    )

    ripper.finish(SLOT_9)
    await watcher.stop()
  })

  it("closes a tray rip-deck opened before reading the disc", async () => {
    // On this rig an OPEN tray still reports its disc, so nothing
    // upstream can tell — and a held bay has usually been opened by
    // someone trying to un-hold it. Reading an open tray fails in a
    // way that looks like a bad disc.
    const { watcher, ripper, tray } = await heldTower()

    await watcher.runTrayCommand({
      request: {
        kind: "open_bay",
        target: { driveId: SLOT_9 },
      },
    })

    await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: "Soylent Green - UHD",
      },
    })

    expect(tray.moved).toEqual([
      { action: "open", devPath: "/dev/sr0" },
      { action: "close", devPath: "/dev/sr0" },
    ])
    expect(ripper.started).toHaveLength(2)

    ripper.finish(SLOT_9)
    await watcher.stop()
  })

  it("does not start a rip it cannot close the tray for", async () => {
    const { watcher, ripper, tray } = await heldTower({
      isClosingSuccessful: false,
    })

    await watcher.runTrayCommand({
      request: {
        kind: "open_bay",
        target: { driveId: SLOT_9 },
      },
    })

    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: "Soylent Green - UHD",
      },
    })

    expect(report.bays[0].result).toBe("failed")
    expect(report.counts.rip_started).toBe(0)
    // No second rip, and no lease taken for one.
    expect(ripper.started).toHaveLength(1)
    expect(tray.moved).toHaveLength(2)

    await watcher.stop()
  })

  it("refuses loudly rather than queueing when every slot is busy", async () => {
    // A button that silently means "in a while" is the other kind
    // of dead end. The governor still has the last word — an
    // operator cannot push a rip past the cap just because he
    // pressed a button rather than inserting a disc.
    //
    // Cap of one, two bays: slot 9 rips (and holds the only lease),
    // slot 8 is held and is the one the operator presses Rip on.
    const ripper = controllableRipper()
    const SLOT_8 = "2-1.1.2.4.4.3"

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 1 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_8,
            kernelName: "sr1",
            sizeSectors: BLURAY_SECTORS,
          }),
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: BLURAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
      }),
    )

    // Tick once: one of the two takes the single lease. Hold it
    // there and latch the other one.
    await watcher.tickNow()
    await flush()

    const [rippingId] = ripper.started.map(
      (start) => start.driveId,
    )
    const heldId = rippingId === SLOT_9 ? SLOT_8 : SLOT_9

    await watcher.tickNow()
    await flush()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: heldId },
        name: "Soylent Green - UHD",
      },
    })

    expect(report.counts.rip_started).toBe(0)
    expect(report.bays[0].result).toBe("failed")
    expect(report.bays[0].detail).toContain(
      "every rip slot is busy",
    )
    // Still exactly the one rip the governor allowed, and the held
    // bay was not left claimed by a rip that never started.
    expect(ripper.started).toHaveLength(1)
    expect(
      watcher.getBays().find((b) => b.driveId === heldId)
        ?.phase,
    ).not.toBe("starting")

    ripper.finish(rippingId)
    await watcher.stop()
  })

  it("says there is nothing to rip in an empty bay", async () => {
    const ripper = controllableRipper()

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors: EMPTY_TRAY_SECTORS,
          }),
        ],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "rip_bay",
        target: { driveId: SLOT_9 },
        name: null,
      },
    })

    expect(report.bays[0].result).toBe("skipped_no_disc")
    expect(report.message).toContain("no disc in this bay")
    expect(ripper.started).toHaveLength(0)

    await watcher.stop()
  })
})

/**
 * `power_off` — cutting mains to the tower from the dashboard.
 *
 * ⚠️ **Every test in this block is about the refusal.** This is
 * the single most destructive thing the command surface can
 * reach: trapping a loaded disc costs a walk downstairs, cutting
 * power mid-rip costs 90 GB and an hour, and those two are not
 * traded off against each other. The owner chose warn-then-power-
 * off for a loaded-but-idle tower, and a running rip is not that
 * case ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)).
 */
describe("startWatcher power_off", () => {
  const poweredTower = (input: {
    runBayRip: WatcherDeps["runBayRip"]
    sizeSectors?: number
  }) => {
    let powerOffs = 0

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
        publishTowerPowerOff: () => {
          powerOffs += 1
        },
      },
      watcherDeps({
        probeDrives: async () => [
          probedDrive({
            driveId: SLOT_9,
            kernelName: "sr0",
            sizeSectors:
              input.sizeSectors ?? BLURAY_SECTORS,
          }),
        ],
        runBayRip: input.runBayRip,
      }),
    )

    return { watcher, powerOffs: () => powerOffs }
  }

  it("⚠️ REFUSES while a bay is ripping, and cuts nothing", () => {
    // `reportsRipStarted` is the whole point of this test, not a
    // detail: without it the fake never calls `onRipStarted`, the
    // bay stays `starting`, and this asserted the refusal for a
    // phase in which NOTHING IS RIPPING — which is the bug the
    // block below covers, passing here for the wrong reason.
    const ripper = controllableRipper({
      reportsRipStarted: true,
    })
    const tower = poweredTower({
      runBayRip: ripper.runBayRip,
    })

    return (async () => {
      await tower.watcher.tickNow()
      await flush()

      const report = await tower.watcher.runTrayCommand({
        request: { kind: "power_off" },
      })

      expect(tower.powerOffs()).toBe(0)
      expect(report.counts.refused).toBe(1)
      expect(report.message).toContain(
        "NOT powering the tower off",
      )
      expect(report.spoken_message).toBe(
        "Not turning the optical ripper tower off. A rip is " +
          "still running, and cutting power now would lose it.",
      )

      ripper.finish(SLOT_9)
      await tower.watcher.stop()
    })()
  })

  it("cuts power for a bay that is only STARTING", () => {
    // ⚠️ Regression, live 2026-08-26. `starting` is settle → type
    // → identify: the ripper child is spawned only after
    // `applyRipStarted` has moved the bay to `ripping`, so a
    // `starting` bay has written nothing and a power cut loses
    // nothing.
    //
    // It had no upper bound either. A wedged USB bus left five
    // bays `starting` for 75 minutes — `identifyDisc` was waiting
    // on a `makemkvcon` that SIGKILL could not reach — and one
    // refused bay refuses the whole press. So the Tower off
    // button, the only control here that clears a wedged bus, was
    // held shut by the wedge, and the owner had to pull the plug.
    const ripper = controllableRipper()
    const tower = poweredTower({
      runBayRip: ripper.runBayRip,
    })

    return (async () => {
      await tower.watcher.tickNow()
      await flush()

      const report = await tower.watcher.runTrayCommand({
        request: { kind: "power_off" },
      })

      expect(tower.powerOffs()).toBe(1)
      expect(report.counts.refused).toBe(0)
      expect(report.message).toContain(
        "Turning the optical ripper tower off",
      )

      ripper.finish(SLOT_9)
      await tower.watcher.stop()
    })()
  })

  it("fails closed when the bus will not answer", () => {
    // A bus we could not read is NOT a bus with nothing running
    // on it. The one input that could refuse this press is
    // missing, so the press is refused rather than guessed.
    let powerOffs = 0

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
        publishTowerPowerOff: () => {
          powerOffs += 1
        },
      },
      watcherDeps({
        probeDrives: () =>
          new Promise<ProbedDrive[]>(() => {
            // Never resolves — the watchdog in `probe()` wins.
          }),
        runBayRip: async () => {
          throw new Error("no rip may start in this test")
        },
      }),
    )

    return (async () => {
      const report = await watcher.runTrayCommand({
        request: { kind: "power_off" },
      })

      expect(powerOffs).toBe(0)
      expect(report.counts.failed).toBe(1)
      expect(report.message).toContain(
        "was NOT powered off",
      )

      await watcher.stop()
    })()
  })

  it("warns about the discs it is about to trap, then goes", async () => {
    // The owner's own call when asked: he knows what is in his
    // tower, and a control that argues with him about a
    // reversible, self-inflicted inconvenience is the held-card
    // defect again. A RUNNING RIP is the case that is refused
    // instead, and it is refused above.
    const ripper = controllableRipper()
    const tower = poweredTower({
      runBayRip: ripper.runBayRip,
    })

    await tower.watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    const report = await tower.watcher.runTrayCommand({
      request: { kind: "power_off" },
    })

    expect(tower.powerOffs()).toBe(1)
    expect(report.is_accepted).toBe(true)
    expect(report.message).toContain(
      "Turning the optical ripper tower off",
    )
    expect(report.message).toContain(
      "1 disc is still loaded",
    )
    expect(report.message).toContain(
      "will not open its tray",
    )

    await tower.watcher.stop()
  })

  it("says nothing about discs when there are none", async () => {
    const tower = poweredTower({
      sizeSectors: EMPTY_TRAY_SECTORS,
      runBayRip: async () => {
        throw new Error("no rip may start in this test")
      },
    })

    await tower.watcher.tickNow()

    const report = await tower.watcher.runTrayCommand({
      request: { kind: "power_off" },
    })

    expect(tower.powerOffs()).toBe(1)
    expect(report.message).toBe(
      "Turning the optical ripper tower off.",
    )
    expect(report.spoken_message).toBe(
      "Turning the optical ripper tower off.",
    )

    await tower.watcher.stop()
  })

  it("remembers what is loaded after the drives go away", async () => {
    // ⚠️ The reminder's whole reason for existing. Once the tower
    // is off there is nothing to probe — but `tickNow` KEEPS a bay
    // whose drive left the bus, and the sighting keeps its slot
    // and label, so the answer outlives the power.
    const ripper = controllableRipper()
    let isTowerOn = true

    const watcher = startWatcher(
      {
        config: noopConfig,
        governor: createGovernor({ maxConcurrentRips: 9 }),
      },
      watcherDeps({
        probeDrives: async () =>
          isTowerOn
            ? [
                probedDrive({
                  driveId: SLOT_9,
                  kernelName: "sr0",
                  sizeSectors: BLURAY_SECTORS,
                }),
              ]
            : [],
        runBayRip: ripper.runBayRip,
      }),
    )

    await watcher.tickNow()
    ripper.finish(SLOT_9)
    await flush()

    expect(watcher.getLoadedDiscs().count).toBe(1)
    expect(watcher.getLoadedDiscs().isTowerOn).toBe(true)

    // The switch flips. Every drive leaves the bus.
    isTowerOn = false
    await watcher.tickNow()

    const loaded = watcher.getLoadedDiscs()

    expect(loaded.count).toBe(1)
    expect(loaded.isTowerOn).toBe(false)
    expect(loaded.message).toContain("The tower is off")

    await watcher.stop()
  })
})
