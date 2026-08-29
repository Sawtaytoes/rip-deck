import {
  EMPTY_PROGRESS,
  type Job,
  makeVerdict,
  type VerdictConfidence,
  type VerdictKind,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import type { DriveAlertPayload } from "../mqtt/announcement.ts"
import { createRipDeckMqtt } from "../mqtt/bridge.ts"
import type {
  MqttClientLike,
  MqttConnectionConfig,
} from "../mqtt/client.ts"
import type {
  BayDiscFacts,
  DriveStatePayload,
} from "../mqtt/driveState.ts"
import { DEFAULT_TOPIC_CONFIG } from "../mqtt/topics.ts"
import {
  type BayState,
  createBayState,
} from "../rip/watcher.ts"
import {
  createBaySnapshot,
  createTowerSnapshot,
} from "./snapshot.ts"
import { buildTowerView } from "./towerView.ts"

/**
 * Stage 4's headline claim is PARITY: the `/json` view and the
 * MQTT payloads say the same thing about the same bay.
 *
 * These tests do not assert that two hand-written shapes look
 * alike. They run the real bridge against a fake broker, capture
 * what it would have published, and demand byte-for-byte
 * equality with what `/json` serves. If someone reshapes a
 * payload on either side, this fails — which matters most for
 * `rip/event`, whose shape is a contract owned by
 * `automation.job_status_announcement` in Home Assistant.
 */

const NOW_MS = 1_800_000_000_000

const buildJob = (overrides: Partial<Job> = {}): Job => ({
  id: "job-a",
  driveId: "usb-2-1-1-2-4-4-2",
  state: "ripping",
  startedAt: NOW_MS - 600_000,
  finishedAt: null,
  identity: {
    title: "Ivanhoe",
    year: 1952,
    discType: "bluray",
    source: "tmdb",
    posterUrl: null,
    volumeLabel: "IVANHOE",
    discNumber: null,
    discTotal: null,
  },
  progress: {
    ...EMPTY_PROGRESS,
    totalFraction: 0.43,
    totalLabel: "Backing up disc",
    currentLabel: "Saving file 3 of 78",
    throughputBytesPerSec: 22_020_096,
    etaSeconds: 900,
    etaTrend: "falling",
  },
  verdict: makeVerdict("ok", "suspected", []),
  failureReason: null,
  destinationPath: "/media/Disc-Rips/Ivanhoe",
  readErrorCount: 0,
  warnings: [],
  isAdopted: false,
  isKeepTryingRequested: false,
  ...overrides,
})

/** A bay latched on a disc it has finished with. */
const heldDiscFacts = (
  overrides: Partial<BayState> = {},
): BayDiscFacts => ({
  bay: {
    ...createBayState({
      driveId: "usb-2-1-1-2-4-4-2",
      atMs: NOW_MS,
    }),
    phase: "done",
    sizeSectors: 22_468_608,
    discName: "TROY",
    discType: "bluray",
    destinationPath: "/media/Disc-Rips/TROY",
    outcome: {
      kind: "completed",
      detail: "/media/Disc-Rips/TROY",
    },
    latchedAtMs: NOW_MS - 600_000,
    ...overrides,
  },
  isDrivePresent: true,
})

const buildBay = (input: {
  slot: number
  job?: Job | null
  isQuarantined?: boolean
  disc?: BayDiscFacts
}) =>
  createBaySnapshot({
    driveId: `usb-2-1-1-2-4-4-${input.slot}`,
    label: `0${input.slot} - Pioneer BDR-211M`,
    slot: input.slot,
    devPath: `/dev/sr${9 - input.slot}`,
    job: input.job ?? null,
    disc: input.disc ?? null,
    supervision: {
      driveId: `usb-2-1-1-2-4-4-${input.slot}`,
      restartCount: input.isQuarantined ? 3 : 0,
      startedAt: null,
      isQuarantined: input.isQuarantined ?? false,
      quarantineReason: input.isQuarantined
        ? "Crashed 3 times without staying up."
        : null,
    },
  })

type PublishedMessage = {
  topic: string
  payload: string | Uint8Array
  isRetained: boolean
}

const createFakeBroker = () => {
  const published: PublishedMessage[] = []

  const client: MqttClientLike = {
    publishAsync: async (message) => {
      published.push(message)
    },
    subscribeAsync: async () => {},
    onMessage: () => {},
    onConnect: () => {},
    endAsync: async () => {},
  }

  return { client, published }
}

const brokerConfig: MqttConnectionConfig = {
  url: "mqtts://broker.invalid:8883",
  username: "rip-deck",
  password: "not-a-real-password",
  caFile: undefined,
  isRejectUnauthorized: true,
}

const parsePayload = <Payload>(
  payload: string | Uint8Array,
): Payload =>
  JSON.parse(
    typeof payload === "string"
      ? payload
      : Buffer.from(payload).toString("utf8"),
  ) as Payload

const view = (input: {
  bays: ReturnType<typeof buildBay>[]
  lastRip?: {
    job: Job
    verdict: ReturnType<typeof makeVerdict>
    driveLabel: string
  } | null
}) =>
  buildTowerView({
    snapshot: createTowerSnapshot({
      bays: input.bays,
      lastRip: input.lastRip ?? null,
      isMqttEnabled: true,
    }),
    nowMs: NOW_MS,
    topicConfig: DEFAULT_TOPIC_CONFIG,
  })

describe("MQTT parity", () => {
  it("serves the same bay body the bridge publishes", async () => {
    const broker = createFakeBroker()
    const mqtt = await createRipDeckMqtt({
      config: brokerConfig,
      topicConfig: DEFAULT_TOPIC_CONFIG,
      connect: async () => broker.client,
    })

    const job = buildJob()

    await mqtt.publishDriveState({
      driveId: "usb-2-1-1-2-4-4-2",
      job,
      driveLabel: "02 - Pioneer BDR-211M",
      slot: 2,
      nowMs: NOW_MS,
    })

    const bay = view({ bays: [buildBay({ slot: 2, job })] })
      .bays[0]

    const message = broker.published.find(
      (candidate) => candidate.topic === bay.state_topic,
    )

    expect(message).toBeDefined()
    expect(
      parsePayload<DriveStatePayload>(
        message?.payload ?? "",
      ),
    ).toEqual(bay.state)
  })

  it("serves the TRAY half too, not just the job half", async () => {
    // `/json` promised "byte-for-byte the retained
    // `drive/<slug>` payload" while passing no tray facts at
    // all, so seven fields — `has_disc`,
    // `is_holding_finished_disc`, `disc_name`,
    // `destination_path`, `is_present`, `disc_size_sectors`,
    // `is_adopted` — were simply absent from every bay it
    // served. Those are exactly the fields that tell a bay
    // holding a finished disc apart from an empty one.
    const broker = createFakeBroker()
    const mqtt = await createRipDeckMqtt({
      config: brokerConfig,
      topicConfig: DEFAULT_TOPIC_CONFIG,
      connect: async () => broker.client,
    })

    const disc = heldDiscFacts()

    await mqtt.publishDriveState({
      driveId: "usb-2-1-1-2-4-4-2",
      job: null,
      driveLabel: "02 - Pioneer BDR-211M",
      slot: 2,
      nowMs: NOW_MS,
      disc,
    })

    const bay = view({
      bays: [buildBay({ slot: 2, disc })],
    }).bays[0]

    expect(bay.state).toMatchObject({
      has_disc: true,
      is_holding_finished_disc: true,
      disc_name: "TROY",
    })

    const message = broker.published.find(
      (candidate) => candidate.topic === bay.state_topic,
    )

    expect(
      parsePayload<DriveStatePayload>(
        message?.payload ?? "",
      ),
    ).toEqual(bay.state)
  })

  it("omits the tray fields when nobody described a tray", () => {
    // Absent, never defaulted. `has_disc: false` invented on
    // behalf of a producer that was never told about the tray —
    // a fixture, say — is the exact false "nothing loaded" the
    // fields exist to correct.
    const bay = view({ bays: [buildBay({ slot: 2 })] })
      .bays[0]

    expect("has_disc" in bay.state).toBe(false)
    expect("disc_name" in bay.state).toBe(false)
  })

  it("serves the tray command the ⏏ toggle reads", () => {
    // ⚠️ Not a reading of the drawer — there is none. It is
    // rip-deck's memory of its own last act, and without it
    // `nextTrayCommandFor` degrades to `open_bay` for every
    // empty bay, so the toggle never closes anything.
    expect(
      view({
        bays: [
          buildBay({
            slot: 2,
            disc: heldDiscFacts({
              lastTrayCommand: "open_bay",
            }),
          }),
        ],
      }).bays[0].last_tray_command,
    ).toBe("open_bay")

    expect(
      view({ bays: [buildBay({ slot: 2 })] }).bays[0]
        .last_tray_command,
    ).toBeNull()
  })

  it("serves the announcement payload unreshaped", async () => {
    const broker = createFakeBroker()
    const mqtt = await createRipDeckMqtt({
      config: brokerConfig,
      topicConfig: DEFAULT_TOPIC_CONFIG,
      connect: async () => broker.client,
    })

    const job = buildJob({
      state: "completed",
      finishedAt: NOW_MS,
    })
    const verdict = makeVerdict("ok", "confirmed", [])

    await mqtt.publishRipEvent({
      job,
      verdict,
      driveLabel: "02 - Pioneer BDR-211M",
    })

    const towerView = view({
      bays: [buildBay({ slot: 2, job })],
      lastRip: {
        job,
        verdict,
        driveLabel: "02 - Pioneer BDR-211M",
      },
    })

    const retained = broker.published.find(
      (candidate) =>
        candidate.topic === towerView.last_rip_topic,
    )

    // The retained `rip/last` copy is the one a dashboard reads,
    // so it is the one `/json` has to agree with.
    expect(retained?.isRetained).toBe(true)
    expect(parsePayload(retained?.payload ?? "")).toEqual(
      towerView.last_rip,
    )
  })

  it("serves the same alert body for a confirmed verdict", async () => {
    const broker = createFakeBroker()
    const mqtt = await createRipDeckMqtt({
      config: brokerConfig,
      topicConfig: DEFAULT_TOPIC_CONFIG,
      connect: async () => broker.client,
    })

    const verdict = makeVerdict("disc_dirty", "confirmed", [
      "Errors scattered across 11 regions",
    ])
    const job = buildJob({ verdict, readErrorCount: 11 })

    const isPublished = await mqtt.publishDriveAlert({
      driveId: "usb-2-1-1-2-4-4-2",
      verdict,
      driveLabel: "02 - Pioneer BDR-211M",
      slot: 2,
    })

    const bay = view({ bays: [buildBay({ slot: 2, job })] })
      .bays[0]

    expect(isPublished).toBe(true)

    const message = broker.published.find(
      (candidate) => candidate.topic === bay.alert_topic,
    )

    expect(
      parsePayload<DriveAlertPayload>(
        message?.payload ?? "",
      ),
    ).toEqual(bay.alert)
  })
})

describe("suspected vs confirmed", () => {
  it("shows a suspected verdict MQTT will not announce", () => {
    const verdict = makeVerdict("disc_dirty", "suspected", [
      "Errors scattered across 9 regions",
    ])

    const bay = view({
      bays: [
        buildBay({ slot: 2, job: buildJob({ verdict }) }),
      ],
    }).bays[0]

    // The card exists — that is the whole point of `suspected`.
    expect(bay.alert?.verdict).toBe("disc_dirty")
    expect(bay.verdict_confidence).toBe("suspected")
    // …but only two drives agreeing may wake the house.
    expect(bay.is_announceable).toBe(false)
    expect(bay.actions).not.toContain(
      "retry_in_another_drive",
    )
  })

  it("marks the confirmed twin announceable", () => {
    const verdict = makeVerdict("disc_dirty", "confirmed", [
      "Second drive agrees",
    ])

    const bay = view({
      bays: [
        buildBay({ slot: 8, job: buildJob({ verdict }) }),
      ],
    }).bays[0]

    expect(bay.is_announceable).toBe(true)
    expect(bay.actions).not.toContain(
      "retry_in_another_drive",
    )
  })

  it("offers no card at all for the default verdict", () => {
    const bay = view({
      bays: [buildBay({ slot: 2, job: buildJob() })],
    }).bays[0]

    // `ok` is the default and requires no evidence, so it is
    // not news and must not render as trouble.
    expect(bay.alert).toBeNull()
    expect(bay.is_announceable).toBe(false)
  })
})

describe("the tower view", () => {
  it("represents nine simultaneously-active bays", () => {
    const bays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) =>
      buildBay({
        slot,
        job: buildJob({ id: `job-${slot}` }),
      }),
    )

    const towerView = view({ bays })

    expect(towerView.bays).toHaveLength(9)
    expect(towerView.active_count).toBe(9)
    expect(
      new Set(towerView.bays.map((bay) => bay.state_topic))
        .size,
    ).toBe(9)
  })

  it("treats zero drives as normal, not as a fault", () => {
    const towerView = view({ bays: [] })

    // F3: the owner powers the tower independently. An empty
    // rack means "switched off".
    expect(towerView.is_tower_present).toBe(false)
    expect(towerView.drive_count).toBe(0)
    expect(towerView.error).toBe("")
    expect(towerView.alerts).toEqual([])
  })

  it("groups a hub fault into ONE alert, not four", () => {
    const verdict = makeVerdict("hub_fault", "confirmed", [
      "4 drives under hub 2-1.1.2.4 stopped together",
    ])

    const towerView = view({
      bays: [4, 5, 6, 7].map((slot) =>
        buildBay({
          slot,
          job: buildJob({ id: `job-${slot}`, verdict }),
        }),
      ),
    })

    expect(towerView.alerts).toHaveLength(1)
    expect(towerView.alerts[0].verdict).toBe("hub_fault")
    expect(towerView.alerts[0].subject).toBe("hub")
    expect(towerView.alerts[0].action).toBe("check_hub")
    expect(towerView.alerts[0].drive_ids).toHaveLength(4)
  })

  it("keeps a dirty disc and a scratched one apart", () => {
    const kinds: VerdictKind[] = [
      "disc_dirty",
      "disc_scratched",
    ]

    const towerView = view({
      bays: kinds.map((kind, index) =>
        buildBay({
          slot: index + 1,
          job: buildJob({
            id: `job-${kind}`,
            verdict: makeVerdict(kind, "confirmed", []),
          }),
        }),
      ),
    })

    expect(towerView.alerts).toHaveLength(2)
    // Opposite advice — cleaning a scratch never helps.
    expect(towerView.alerts[0].action).toBe("clean_disc")
    expect(towerView.alerts[1].action).toBe("replace_disc")
  })

  it("upgrades a grouped alert when any bay confirms", () => {
    const confidences: VerdictConfidence[] = [
      "suspected",
      "confirmed",
    ]

    const towerView = view({
      bays: confidences.map((confidence, index) =>
        buildBay({
          slot: index + 1,
          job: buildJob({
            id: `job-${confidence}`,
            verdict: makeVerdict(
              "disc_dirty",
              confidence,
              [],
            ),
          }),
        }),
      ),
    })

    expect(towerView.alerts).toHaveLength(1)
    expect(towerView.alerts[0].confidence).toBe("confirmed")
    expect(towerView.alerts[0].is_announceable).toBe(true)
  })

  it("surfaces a rising ETA rather than hiding it", () => {
    const bay = view({
      bays: [
        buildBay({
          slot: 3,
          job: buildJob({
            progress: {
              ...EMPTY_PROGRESS,
              totalFraction: 0.11,
              etaSeconds: 5_400,
              etaTrend: "rising",
            },
          }),
        }),
      ],
    }).bays[0]

    // C6: the same d(progress)/dt collapse the health engine
    // watches, visible before the rip fails.
    expect(bay.state.eta_trend).toBe("rising")
    expect(bay.state.verdict).toBe("ok")
  })

  it("offers the clear control on a quarantined drive", () => {
    const bay = view({
      bays: [buildBay({ slot: 5, isQuarantined: true })],
    }).bays[0]

    expect(bay.is_quarantined).toBe(true)
    expect(bay.quarantine_reason).not.toBeNull()
    // Quarantine is never self-healing; a human clears it.
    expect(bay.actions).toEqual(["clear_quarantine"])
  })

  it("offers keep-trying only while a bay is in trouble", () => {
    const troubled = view({
      bays: [
        buildBay({
          slot: 2,
          job: buildJob({
            verdict: makeVerdict(
              "disc_marginal_slow",
              "suspected",
              [],
            ),
          }),
        }),
      ],
    }).bays[0]

    const healthy = view({
      bays: [buildBay({ slot: 2, job: buildJob() })],
    }).bays[0]

    // D4: "keep trying" is an answer to a bad verdict, so it
    // must not clutter a bay that is simply working.
    expect(troubled.actions).toContain("keep_trying")
    expect(troubled.actions).toContain("give_up")
    expect(healthy.actions).toEqual(["cancel"])
  })

  it("labels a fixture response as fake", () => {
    const towerView = buildTowerView({
      snapshot: createTowerSnapshot(),
      nowMs: NOW_MS,
      isFake: true,
      fixture: "empty",
      topicConfig: DEFAULT_TOPIC_CONFIG,
    })

    expect(towerView.is_fake).toBe(true)
    expect(towerView.fixture).toBe("empty")
  })
})

describe("the USB-flap banner", () => {
  it("is null while the bus is steady", () => {
    const towerView = buildTowerView({
      snapshot: createTowerSnapshot(),
      nowMs: NOW_MS,
      topicConfig: DEFAULT_TOPIC_CONFIG,
    })

    expect(towerView.usb_alert).toBeNull()
  })

  it("raises a hub-fault banner naming the flapping bays", () => {
    const towerView = buildTowerView({
      snapshot: createTowerSnapshot({
        bays: [
          createBaySnapshot({
            driveId: "2-2.3",
            label: "07 - Pioneer BDR-211M",
            slot: 7,
          }),
        ],
        usbStability: {
          isUnstable: true,
          flappingDriveIds: ["2-2.3"],
          transitionCount: 5,
        },
      }),
      nowMs: NOW_MS,
      topicConfig: DEFAULT_TOPIC_CONFIG,
    })

    // The red hardware tone and the "check the hub/cable" action,
    // reused from `hub_fault` — but with a flap-specific message.
    expect(towerView.usb_alert?.verdict).toBe("hub_fault")
    expect(towerView.usb_alert?.action).toBe("check_hub")
    expect(towerView.usb_alert?.drive_ids).toEqual([
      "2-2.3",
    ])
    expect(towerView.usb_alert?.labels).toEqual([
      "07 - Pioneer BDR-211M",
    ])
    expect(towerView.usb_alert?.message).toContain(
      "keeps dropping and reconnecting",
    )
    // A banner, not a voice announcement.
    expect(towerView.usb_alert?.is_announceable).toBe(false)
  })

  it("stays out of the per-bay alerts list", () => {
    // The flap is what HOLDS bays, so folding it into `alerts` —
    // which the dashboard filters to non-held bays — would let its
    // own symptom hide it. It lives in `usb_alert` alone.
    const towerView = buildTowerView({
      snapshot: createTowerSnapshot({
        usbStability: {
          isUnstable: true,
          flappingDriveIds: ["2-2.3"],
          transitionCount: 5,
        },
      }),
      nowMs: NOW_MS,
      topicConfig: DEFAULT_TOPIC_CONFIG,
    })

    expect(towerView.alerts).toEqual([])
    expect(towerView.usb_alert).not.toBeNull()
  })
})
