import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { DriveRegistry } from "../drives/registry.ts"
import { EMPTY_LOADED_DISCS } from "../rip/loadedDiscs.ts"
import { STABLE_USB } from "../rip/usbStability.ts"
import {
  type BaySighting,
  type BayState,
  createBayState,
  type RunningWatcher,
  type WatcherInput,
} from "../rip/watcher.ts"
import type { RipDeckMqtt } from "./bridge.ts"
import type { CommandHandler } from "./client.ts"
import {
  buildDriveDiscState,
  buildDriveStatePayload,
  type DriveStatePayload,
} from "./driveState.ts"
import {
  buildBayJob,
  createWatchMqtt,
  driveStateFingerprint,
  jobStateForBay,
  verdictForOutcome,
} from "./watchMqtt.ts"

/**
 * The rule under test, everywhere in this file: **a rip must
 * never depend on a broker being up.** A refused connection, a
 * rejected publish and an unset URL all have to end with the
 * daemon still running and the bays untouched.
 */

const NOW_MS = 1_780_000_000_000

const bay = (input: Partial<BayState>): BayState => ({
  ...createBayState({
    driveId: input.driveId ?? "usb-2-1.1.2.4.4.2",
    atMs: NOW_MS,
  }),
  ...input,
})

/**
 * A held disc, exactly as slots 7-9 held one for days.
 *
 * Latched `completed` by a daemon that is no longer running,
 * adopted from the ledger at startup, and still physically in
 * the tray. It has NO job — which is correct — and that is why
 * it used to publish the same `"idle"` an empty bay does.
 */
const heldDiscBay = (driveId: string, name: string) =>
  bay({
    driveId,
    phase: "done",
    sizeSectors: 22_468_608,
    discName: name,
    destinationPath: `/media/Disc-Rips/${name}`,
    outcome: {
      kind: "completed",
      detail: `backed up to /media/Disc-Rips/${name}`,
    },
    isAdopted: true,
    latchedAtMs: NOW_MS - 3_600_000,
  })

type Recorded = {
  discovery: unknown[]
  ripEvents: unknown[]
  activity: unknown[]
  driveStates: unknown[]
  /** What actually lands on `drive/<slug>`. */
  drivePayloads: DriveStatePayload[]
  commandResponses: unknown[]
  /** How many tower power-on requests were published. */
  powerOns: number
  powerOffs: number
  loaded: unknown[]
}

const createFakeMqtt = (
  options: { isEnabled?: boolean } = {},
) => {
  const recorded: Recorded = {
    discovery: [],
    ripEvents: [],
    activity: [],
    driveStates: [],
    drivePayloads: [],
    commandResponses: [],
    powerOns: 0,
    powerOffs: 0,
    loaded: [],
  }

  let isClosed = false
  let commandHandler: CommandHandler | null = null

  const mqtt: RipDeckMqtt = {
    isEnabled: options.isEnabled ?? true,
    publishDiscovery: async (params) => {
      recorded.discovery.push(params)
    },
    publishRipEvent: async (params) => {
      recorded.ripEvents.push(params)
    },
    publishActivity: async (params) => {
      recorded.activity.push(params)
    },
    publishDriveState: async (params) => {
      recorded.driveStates.push(params)

      // Built with the very same builder the real bridge uses,
      // so these assertions are about the JSON Home Assistant
      // reads rather than about the call that produced it.
      recorded.drivePayloads.push(
        buildDriveStatePayload({
          ...params,
          nowMs: params.nowMs ?? NOW_MS,
        }),
      )
    },
    publishDriveAlert: async () => false,
    publishLivenessAlert: async () => false,
    subscribeToDriveCommands: async ({ handler }) => {
      commandHandler = handler
    },
    publishCommandResponse: async ({ payload }) => {
      recorded.commandResponses.push(payload)
    },
    publishTowerPowerOn: async () => {
      recorded.powerOns += 1
    },
    publishTowerPowerOff: async () => {
      recorded.powerOffs += 1
    },
    publishLoadedDiscs: async ({ payload }) => {
      recorded.loaded.push(payload)
    },
    close: async () => {
      isClosed = true
    },
  }

  return {
    mqtt,
    recorded,
    isClosed: () => isClosed,
    /** Deliver one inbound `cmd/drive` message. */
    send: async (payload: string) => {
      await commandHandler?.({
        topic: "rip-deck/tower/cmd/drive",
        payload,
      })
    },
    hasCommandHandler: () => commandHandler !== null,
  }
}

/**
 * The registry as `config/drives.json` really writes it.
 *
 * `name` carries the slot prefix — `07 - Pioneer BDR-211M` —
 * because that is the label the owner reads off the rack. This
 * fixture used to write the bare model, which is why a green
 * suite let `"07 - 07 - Pioneer BDR-211M"` reach the house
 * speakers: the fixture was the only place a bare name existed.
 */
const registry: DriveRegistry = {
  towerRootPortPath: "usb-2-1.1",
  entries: [
    {
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      firmwareSerial: "SERIAL7",
      trueModel: "BDR-211M",
      reportedModel: "BDR-211M",
      usbPortPath: "usb-2-1.1.2.4.4.2",
      bridgeSerial: "BRIDGE7",
      isUhdCapable: true,
      // Nobody has measured an offset on this tower yet.
      readOffsetSamples: null,
    },
  ],
}

/** The probe answered for this drive on the last poll. */
const sighting = (
  driveId: string,
  isDrivePresent = true,
): BaySighting => ({
  driveId,
  isDrivePresent,
  slot: null,
  label: driveId,
  devPath: null,
  vendor: null,
  model: null,
  serial: null,
})

const createFakeWatcher = (
  bays: BayState[],
  runTrayCommand: RunningWatcher["runTrayCommand"] = () => {
    throw new Error("no tray commands in this fake")
  },
  // Every bay's drive present unless a test says otherwise: a
  // bay only exists at all because a probe once answered for it.
  sightings?: BaySighting[],
): RunningWatcher => ({
  tickNow: async () => {},
  stop: async () => {},
  getBays: () => bays,
  getBaySightings: () =>
    sightings ?? bays.map((each) => sighting(each.driveId)),
  getUsbStability: () => STABLE_USB,
  getLoadedDiscs: () => EMPTY_LOADED_DISCS,
  runTrayCommand,
})

const watcherInput = (): WatcherInput =>
  ({
    config: {
      registryPath: "config/drives.json",
    },
  }) as unknown as WatcherInput

describe("jobStateForBay", () => {
  it("counts the settle/identify window as work", () => {
    expect(
      jobStateForBay({
        bay: bay({ phase: "starting" }),
        outcome: null,
      }),
    ).toBe("identifying")
  })

  it("reports a quarantined bay as needing a human", () => {
    expect(
      jobStateForBay({
        bay: bay({ phase: "quarantined" }),
        outcome: null,
      }),
    ).toBe("needs_attention")
  })

  it("has no job for an idle bay", () => {
    expect(
      jobStateForBay({
        bay: bay({ phase: "idle" }),
        outcome: null,
      }),
    ).toBeNull()
  })
})

describe("buildBayJob", () => {
  const view = {
    slot: 7,
    name: "07 - Pioneer BDR-211M",
    identity: {
      title: "TROY",
      discType: "bluray" as const,
    },
    progress: null,
    jobUuid: null,
    outcome: null,
    publishedFingerprint: null,
  }

  it("says the name came off the disc, because it did", () => {
    // `manual` claims a human typed it. Nobody did —
    // `identifyDisc` read the volume label — and `source` is the
    // trust trail, so the wrong word here is a small lie a card
    // then repeats.
    const job = buildBayJob({
      bay: heldDiscBay("usb-2-1.1.2.4.4.2", "TROY"),
      view,
      state: "completed",
    })

    expect(job.identity?.source).toBe("disc")
  })

  it("takes the folder off the bay, not out of a sentence", () => {
    const job = buildBayJob({
      bay: heldDiscBay("usb-2-1.1.2.4.4.2", "TROY"),
      view,
      state: "completed",
    })

    expect(job.destinationPath).toBe(
      "/media/Disc-Rips/TROY",
    )
    expect(job.isAdopted).toBe(true)
  })
})

describe("verdictForOutcome", () => {
  it("never claims a named fault it did not measure", () => {
    // The watcher knows the rip ended badly, not why. Naming a
    // cause here would send someone to clean a disc because a
    // hub lost power.
    const verdict = verdictForOutcome({
      kind: "failed",
      detail: "read_errors (exit 1)",
    })

    expect(verdict.kind).toBe("unknown")
    expect(verdict.confidence).toBe("suspected")
    expect(verdict.evidence).toEqual([
      "read_errors (exit 1)",
    ])
  })

  it("defaults to ok, which needs no evidence", () => {
    expect(
      verdictForOutcome({
        kind: "completed",
        detail: "/media/Disc-Rips/x",
      }).kind,
    ).toBe("ok")
  })
})

describe("driveStateFingerprint", () => {
  const emptyTray = buildDriveDiscState({
    bay: bay({ phase: "idle" }),
    isDrivePresent: true,
  })

  it("ignores the clock, so an unchanged bay is not republished", () => {
    const shared = {
      state: "ripping" as const,
      jobId: "job-1",
      title: "Ivanhoe",
      progressPercent: 42,
      verdictKind: "ok",
      disc: emptyTray,
    }

    expect(driveStateFingerprint(shared)).toBe(
      driveStateFingerprint({ ...shared }),
    )
    expect(driveStateFingerprint(shared)).not.toBe(
      driveStateFingerprint({
        ...shared,
        progressPercent: 43,
      }),
    )
  })

  it("moves when the tray does, even though the state word does not", () => {
    // The regression this half of the payload could otherwise
    // introduce: a held disc and an empty bay BOTH publish
    // `state: "idle"`, so a fingerprint over the job alone
    // would never notice the disc coming out and the retained
    // topic would claim a loaded bay forever.
    const shared = {
      state: null,
      jobId: "",
      title: null,
      progressPercent: 0,
      verdictKind: "ok",
    }

    expect(
      driveStateFingerprint({ ...shared, disc: emptyTray }),
    ).not.toBe(
      driveStateFingerprint({
        ...shared,
        disc: buildDriveDiscState({
          bay: heldDiscBay("usb-2-1.1.2.4.4.2", "TROY"),
          isDrivePresent: true,
        }),
      }),
    )
  })
})

describe("createWatchMqtt", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("survives a broker that refuses the connection", async () => {
    // THE test. `createMqttPublisher` throws when a configured
    // broker rejects us, and that throw at daemon startup would
    // take nine bays down with it.
    const watchMqtt = createWatchMqtt({
      createMqtt: async () => {
        throw new Error("Connection refused")
      },
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())

    await expect(
      watchMqtt.start({
        watcher: createFakeWatcher([bay({})]),
      }),
    ).resolves.toBeUndefined()

    expect(watchMqtt.isEnabled()).toBe(false)
  })

  it("publishes nothing when MQTT is unconfigured", async () => {
    // The no-op publisher path: `rip-deck rip` on a laptop with
    // no Mosquitto is a supported state, not a misconfiguration.
    const fake = createFakeMqtt({ isEnabled: false })

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([bay({})]),
    })

    expect(fake.recorded.discovery).toHaveLength(0)
    expect(fake.recorded.activity).toHaveLength(0)
    expect(watchMqtt.isEnabled()).toBe(false)
  })

  it("keeps the console handlers it wraps", () => {
    const onBayOutcome = vi.fn()
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    const wrapped = watchMqtt.withPublishing({
      ...watcherInput(),
      handlers: { onBayOutcome },
    })

    wrapped.handlers?.onBayOutcome?.({
      driveId: "usb-2-1.1.2.4.4.2",
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      outcome: {
        kind: "completed",
        detail: "/dest/Ivanhoe",
      },
    })

    expect(onBayOutcome).toHaveBeenCalledTimes(1)
  })

  it("announces a finished rip under the disc's own name", async () => {
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    const wrapped = watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })

    wrapped.handlers?.onBayIdentified?.({
      driveId: "usb-2-1.1.2.4.4.2",
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      identity: { title: "Ivanhoe", discType: "bluray" },
    })

    wrapped.handlers?.onBayOutcome?.({
      driveId: "usb-2-1.1.2.4.4.2",
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      outcome: {
        kind: "completed",
        detail: "/dest/Ivanhoe",
      },
      jobUuid: "job-uuid-1",
    })

    await vi.waitFor(() => {
      expect(fake.recorded.ripEvents).toHaveLength(1)
    })

    // The title is the one field a listener actually hears, and
    // `Unknown disc finished ripping` is the failure mode this
    // whole identity path exists to prevent.
    expect(fake.recorded.ripEvents[0]).toMatchObject({
      driveLabel: "07 - Pioneer BDR-211M",
      job: {
        id: "job-uuid-1",
        state: "completed",
        identity: { title: "Ivanhoe" },
      },
    })
  })

  it("stays quiet when the disc left before anything happened", async () => {
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    const wrapped = watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })

    wrapped.handlers?.onBayOutcome?.({
      driveId: "usb-2-1.1.2.4.4.2",
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      outcome: {
        kind: "no_media",
        detail: "the disc was gone before it settled",
      },
    })

    expect(fake.recorded.ripEvents).toHaveLength(0)
  })

  it("does not let a rejected publish escape", async () => {
    const fake = createFakeMqtt()
    fake.mqtt.publishRipEvent = async () => {
      throw new Error("broker went away mid-session")
    }

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    const wrapped = watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })

    expect(() =>
      wrapped.handlers?.onBayOutcome?.({
        driveId: "usb-2-1.1.2.4.4.2",
        slot: 7,
        name: "Pioneer BDR-211M",
        outcome: { kind: "failed", detail: "read_errors" },
      }),
    ).not.toThrow()
  })

  it("names the bays from the registry before any of them speaks", async () => {
    // Nine idle bays emit no events at all, so discovery driven
    // only by the event stream would leave the tower with no
    // entities until something went wrong.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })

    expect(fake.recorded.discovery[0]).toEqual({
      // First publish has nothing to tombstone yet.
      clearObjectIds: [],
      drives: [
        {
          driveId: "usb-2-1.1.2.4.4.2",
          label: "07 - Pioneer BDR-211M",
          slot: 7,
        },
      ],
    })
  })

  it("never prefixes a label that already has its slot", async () => {
    // `"06 - 06 - Pioneer BDR-211M"`, live on fifteen retained
    // topics in 0.4.0. The registry's `name` IS the label, so
    // every path out of this module carries it verbatim — and
    // `/json`, which never re-prefixed, was already right.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    const wrapped = watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })

    wrapped.handlers?.onBayOutcome?.({
      driveId: "usb-2-1.1.2.4.4.2",
      slot: 7,
      name: "07 - Pioneer BDR-211M",
      outcome: { kind: "completed", detail: "/dest/Troy" },
    })

    await vi.waitFor(() => {
      expect(fake.recorded.ripEvents).toHaveLength(1)
    })

    // The entity name Home Assistant shows…
    expect(fake.recorded.discovery[0]).toMatchObject({
      drives: [{ label: "07 - Pioneer BDR-211M" }],
    })

    // …and the one the house speakers read aloud.
    expect(fake.recorded.ripEvents[0]).toMatchObject({
      driveLabel: "07 - Pioneer BDR-211M",
    })
  })

  it("passes a handler it does not wrap straight through", async () => {
    // `onTickComplete` is the signal the API feed reads its
    // whole nine-bay roster on, and this is the only path that
    // wraps the feed's handlers in production. Listing the
    // handlers by hand here would drop it silently and take the
    // dashboard's roster with it.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    let tickCount = 0

    const wrapped = watchMqtt.withPublishing({
      ...watcherInput(),
      handlers: {
        onTickComplete: () => {
          tickCount += 1
        },
      },
    })

    wrapped.handlers?.onTickComplete?.()

    expect(tickCount).toBe(1)
  })

  it("publishes the activity payload the power-off rule reads", async () => {
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([
        bay({
          driveId: "usb-2-1.1.2.4.4.2",
          phase: "ripping",
        }),
      ]),
    })

    expect(fake.recorded.activity).toEqual([
      {
        payload: {
          active_rip_count: 1,
          drive_count: 1,
          is_idle: false,
          last_activity_at: NOW_MS,
          updated_at: NOW_MS,
        },
      },
    ])
  })

  it("does not republish a bay whose state has not moved", async () => {
    vi.useFakeTimers()

    const fake = createFakeMqtt()
    const bays = [bay({ phase: "idle" })]

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
      sweepIntervalMs: 1_000,
      heartbeatMs: 60_000,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher(bays),
    })

    await vi.advanceTimersByTimeAsync(5_000)

    // Nine idle bays at a retained message each every five
    // seconds is 108 messages a minute saying nothing.
    expect(fake.recorded.driveStates).toHaveLength(1)
    expect(fake.recorded.activity).toHaveLength(1)

    await watchMqtt.stop()
  })

  it("tells a held disc apart from an empty bay", async () => {
    // THE defect: all nine bays published `idle` while three
    // Troy discs sat latched `completed` in slots 7-9, so Home
    // Assistant's list of loaded slots rendered `[]` and the
    // trapped-disc warning could never fire.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([
        heldDiscBay("usb-2-1.1.2.4.4.2", "TROY"),
        bay({
          driveId: "usb-2-1.1.2.4.4.3",
          phase: "idle",
        }),
      ]),
    })

    const [held, empty] = fake.recorded.drivePayloads

    // `state` is untouched on purpose — a finished rip is not a
    // running job, and this word already feeds an HA sensor.
    // The tray fields are what carry the difference.
    expect(held?.state).toBe("idle")
    expect(empty?.state).toBe("idle")

    expect(held?.has_disc).toBe(true)
    expect(held?.is_holding_finished_disc).toBe(true)
    expect(held?.is_present).toBe(true)
    expect(held?.disc_size_sectors).toBe(22_468_608)

    expect(empty?.has_disc).toBe(false)
    expect(empty?.is_holding_finished_disc).toBe(false)
    expect(empty?.disc_size_sectors).toBeNull()
  })

  it("names the held disc a restart has no job for", async () => {
    // An adopted bay never ran in this process, so nothing in
    // the event stream knows its title — `title` is null and
    // stays null. `disc_name` is the ledger's memory, and the
    // only way a warning can say WHICH disc is stuck.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([
        heldDiscBay("usb-2-1.1.2.4.4.2", "TROY"),
      ]),
    })

    expect(fake.recorded.drivePayloads[0]).toMatchObject({
      title: null,
      disc_name: "TROY",
      is_adopted: true,
      destination_path: "/media/Disc-Rips/TROY",
    })
  })

  it("keeps the disc when the drive leaves the bus", async () => {
    // A USB re-enumeration is routine on this tower and it does
    // NOT empty the tray. Two fields, because they are two
    // facts: the drive is unreachable, the disc is still in it.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher(
        [heldDiscBay("usb-2-1.1.2.4.4.2", "TROY")],
        undefined,
        [sighting("usb-2-1.1.2.4.4.2", false)],
      ),
    })

    expect(fake.recorded.drivePayloads[0]).toMatchObject({
      is_present: false,
      has_disc: true,
      is_holding_finished_disc: true,
    })
  })

  it("republishes when the disc finally comes out", async () => {
    // Both readings publish `state: "idle"`, so without the
    // tray in the fingerprint the retained topic would go on
    // claiming a loaded bay for the life of the daemon.
    vi.useFakeTimers()

    const fake = createFakeMqtt()
    const bays = [heldDiscBay("usb-2-1.1.2.4.4.2", "TROY")]

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
      sweepIntervalMs: 1_000,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher(bays),
    })

    // The human took it out; the watcher re-armed the bay.
    bays[0] = bay({
      driveId: "usb-2-1.1.2.4.4.2",
      phase: "idle",
    })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(fake.recorded.drivePayloads).toHaveLength(2)
    expect(fake.recorded.drivePayloads[1]?.has_disc).toBe(
      false,
    )

    await watchMqtt.stop()
  })

  it("closes the bridge on stop, so HA sees offline", async () => {
    // The fail-closed hinge: a daemon that has stopped watching
    // must not leave a retained "0 active rips" behind that
    // reads as an idle tower.
    const fake = createFakeMqtt()

    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({
      watcher: createFakeWatcher([]),
    })
    await watchMqtt.stop()

    expect(fake.isClosed()).toBe(true)
  })
})

describe("createWatchMqtt tray commands", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const start = async (
    fake: ReturnType<typeof createFakeMqtt>,
    watcher = createFakeWatcher([bay({})]),
  ) => {
    const watchMqtt = createWatchMqtt({
      createMqtt: async () => fake.mqtt,
      loadRegistry: async () => registry,
      now: () => NOW_MS,
    })

    watchMqtt.withPublishing(watcherInput())
    await watchMqtt.start({ watcher })

    return watchMqtt
  }

  it("subscribes, so the button reaches the watcher at all", async () => {
    // `cmd/drive` was documented and unsubscribed for a
    // release. The topic existing is not the feature.
    const fake = createFakeMqtt()
    await start(fake)

    expect(fake.hasCommandHandler()).toBe(true)
  })

  it("routes a bare command and publishes the report", async () => {
    const fake = createFakeMqtt()

    const requests: unknown[] = []

    await start(
      fake,
      createFakeWatcher([bay({})], async (request) => {
        requests.push(request)

        return {
          request_id: null,
          command: "open_trays",
          is_accepted: true,
          message: "Opened 1 drive: slot 7.",
          spoken_message: "Opened 1 tray.",
          started_at: NOW_MS,
          finished_at: NOW_MS,
          counts: {
            opened: 1,
            opened_not_ripped: 0,
            closed: 0,
            refused: 0,
            failed: 0,
            skipped: 0,
            rip_started: 0,
          },
          bays: [],
        }
      }),
    )

    await fake.send("open_trays")

    expect(requests).toEqual([
      {
        request: { kind: "open_trays" },
        requestId: null,
      },
    ])
    expect(fake.recorded.commandResponses).toHaveLength(1)
    expect(fake.recorded.commandResponses[0]).toMatchObject(
      {
        is_accepted: true,
        message: "Opened 1 drive: slot 7.",
        spoken_message: "Opened 1 tray.",
      },
    )
  })

  it("answers a payload it could not parse", async () => {
    // An operator who presses a button and hears nothing cannot
    // tell a broken button from a broken daemon.
    const fake = createFakeMqtt()
    await start(fake)

    await fake.send("{ not json")

    expect(fake.recorded.commandResponses).toHaveLength(1)
    expect(fake.recorded.commandResponses[0]).toMatchObject(
      {
        is_accepted: false,
        command: null,
      },
    )
  })

  it("answers even when the watcher throws", async () => {
    const fake = createFakeMqtt()

    await start(
      fake,
      createFakeWatcher([bay({})], () => {
        throw new Error("sysfs is on fire")
      }),
    )

    await fake.send("close_trays")

    expect(fake.recorded.commandResponses[0]).toMatchObject(
      {
        is_accepted: false,
        message: "Tray command refused: sysfs is on fire",
      },
    )
  })

  it("keeps ripping when the broker refuses the subscribe", async () => {
    // Same bargain as every publish here: the broker costs the
    // button, never a rip.
    const fake = createFakeMqtt()

    fake.mqtt.subscribeToDriveCommands = async () => {
      throw new Error("not authorised")
    }

    await expect(start(fake)).resolves.toBeDefined()
  })
})
