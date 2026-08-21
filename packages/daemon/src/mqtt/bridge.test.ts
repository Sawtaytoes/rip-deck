import {
  EMPTY_PROGRESS,
  HEALTH_THRESHOLDS,
  type Job,
  makeVerdict,
} from "@rip-deck/contracts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { assessLiveness } from "../rip/liveness.ts"
import { createRipDeckMqtt } from "./bridge.ts"
import type {
  MqttClientLike,
  MqttConnectionConfig,
} from "./client.ts"
import {
  buildTopics,
  DEFAULT_TOPIC_CONFIG,
} from "./topics.ts"

/**
 * The retention rules are the reason this file exists. Getting
 * `rip/event` retained would make the house re-announce a
 * finished rip on every Home Assistant restart; getting
 * `rip/last` unretained would leave every sensor `Unknown`.
 * Neither is visible without a broker, so it is asserted here.
 */

type PublishedMessage = {
  topic: string
  payload: string | Uint8Array
  isRetained: boolean
}

const createFakeBroker = () => {
  const published: PublishedMessage[] = []
  const subscribed: string[] = []
  const messageListeners: ((params: {
    topic: string
    payload: string
  }) => void)[] = []

  const client: MqttClientLike = {
    publishAsync: async (message) => {
      published.push(message)
    },
    subscribeAsync: async ({ topics }) => {
      subscribed.push(...topics)
    },
    onMessage: (listener) => {
      messageListeners.push(listener)
    },
    onConnect: () => {},
    endAsync: async () => {},
  }

  return {
    client,
    published,
    subscribed,
    deliver: (params: {
      topic: string
      payload: string
    }) => {
      for (const listener of messageListeners) {
        listener(params)
      }
    },
    /** Everything but the availability handshake. */
    messagesOn: (topic: string) =>
      published.filter(
        (message) => message.topic === topic,
      ),
  }
}

const config: MqttConnectionConfig = {
  url: "mqtts://mqtt.example.invalid:8883",
  username: "rip-deck",
  password: "not-a-real-password",
  caFile: undefined,
  isRejectUnauthorized: true,
}

const topics = buildTopics(DEFAULT_TOPIC_CONFIG)

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  driveId: "usb-2-1.1.2.4.4.2",
  state: "completed",
  startedAt: 0,
  finishedAt: 1,
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
  progress: EMPTY_PROGRESS,
  verdict: makeVerdict("ok", "confirmed", []),
  failureReason: null,
  destinationPath: null,
  readErrorCount: 0,
  isAdopted: false,
  isKeepTryingRequested: false,
  ...overrides,
})

const createBridge = async () => {
  const broker = createFakeBroker()

  const bridge = await createRipDeckMqtt({
    config,
    topicConfig: DEFAULT_TOPIC_CONFIG,
    connect: async () => broker.client,
  })

  return { bridge, broker }
}

/**
 * Parse a published payload back out for assertion.
 *
 * Typed as an index signature rather than `any` because
 * `JSON.parse` returns `any`, and an `any` here spreads through
 * every assertion in the file — which is exactly what
 * `no-unsafe-member-access` is for. `unknown` would be more
 * honest still, but every call site would then need a cast, and
 * the point of these tests is the topic and retention rules
 * rather than the payload's type.
 */
const parse = (
  message: PublishedMessage | undefined,
): Record<string, unknown> =>
  JSON.parse(String(message?.payload)) as Record<
    string,
    unknown
  >

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createRipDeckMqtt — no broker configured", () => {
  it("still hands back a usable bridge", async () => {
    // The daemon must rip on a machine with no Mosquitto.
    const bridge = await createRipDeckMqtt({
      config: { ...config, url: "" },
      connect: async () => {
        throw new Error("must not connect")
      },
    })

    expect(bridge.isEnabled).toBe(false)

    await bridge.publishRipEvent({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })
    await bridge.close()
  })
})

describe("publishRipEvent — the retention contract", () => {
  it("does NOT retain rip/event", async () => {
    // Retained, HA would re-announce a finished rip every time
    // it reconnected — the house saying "Ivanhoe finished
    // ripping" at 3am after a restart.
    const { bridge, broker } = await createBridge()

    await bridge.publishRipEvent({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    const events = broker.messagesOn(topics.ripEvent)

    expect(events).toHaveLength(1)
    expect(events[0]?.isRetained).toBe(false)

    await bridge.close()
  })

  it("DOES retain rip/last", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishRipEvent({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    const last = broker.messagesOn(topics.ripLast)

    expect(last).toHaveLength(1)
    expect(last[0]?.isRetained).toBe(true)

    await bridge.close()
  })

  it("sends the identical payload to both topics", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishRipEvent({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    expect(
      broker.messagesOn(topics.ripEvent)[0]?.payload,
    ).toBe(broker.messagesOn(topics.ripLast)[0]?.payload)

    await bridge.close()
  })

  it("publishes the payload the HA automation reads", async () => {
    // The shape itself is locked by announcement.test.ts; this
    // asserts the bridge does not mangle it in transit.
    const { bridge, broker } = await createBridge()

    await bridge.publishRipEvent({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    const payload = parse(
      broker.messagesOn(topics.ripEvent)[0],
    )

    expect(payload.title).toBe("Ivanhoe")
    expect(payload.result).toBe("success")
    expect(payload.ok).toBe(true)
    expect(payload.disctype).toBe("bluray")
    expect(payload.drive).toBe("07 - Pioneer BDR-211M")
    expect(payload.health).toBe("ok")

    await bridge.close()
  })
})

describe("publishDriveState", () => {
  it("retains the per-bay state", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishDriveState({
      driveId: "usb-2-1.1.2.4.4.2",
      job: job({ state: "ripping" }),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    const messages = broker.messagesOn(
      "rip-deck/tower/drive/usb_2_1_1_2_4_4_2",
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.isRetained).toBe(true)
    expect(parse(messages[0]).state).toBe("ripping")

    await bridge.close()
  })

  it("puts the held disc on the wire", async () => {
    // The bay a rip has finished with has no job, so everything
    // a consumer can use to tell it apart from an empty bay
    // rides in these fields. If they stop reaching the topic,
    // the trapped-disc warning silently stops firing.
    const { bridge, broker } = await createBridge()

    await bridge.publishDriveState({
      driveId: "usb-2-1.1.2.4.4.2",
      job: null,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
      disc: {
        bay: {
          driveId: "usb-2-1.1.2.4.4.2",
          phase: "done",
          sizeSectors: 22_468_608,
          discName: "TROY",
          discType: "bluray",
          destinationPath: "/Disc-Rips/TROY",
          outcome: {
            kind: "completed",
            detail: "backed up",
          },
          isAdopted: true,
          latchedAtMs: 500,
          jobUuid: null,
          lastTrayCommand: null,
          startCount: 1,
          emptyObservationCount: 0,
          hasSettledEmpty: false,
          lastFinished: null,
          isLoadedDismissed: false,
          updatedAtMs: 900,
        },
        isDrivePresent: true,
      },
    })

    const payload = parse(
      broker.messagesOn(
        "rip-deck/tower/drive/usb_2_1_1_2_4_4_2",
      )[0],
    )

    expect(payload.state).toBe("idle")
    expect(payload.has_disc).toBe(true)
    expect(payload.is_holding_finished_disc).toBe(true)
    expect(payload.disc_name).toBe("TROY")

    await bridge.close()
  })

  it("slugs the drive id into the topic", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishDriveState({
      driveId: "usb-2-1.1.2.4.4.2",
      job: null,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(broker.published.at(-1)?.topic).toBe(
      "rip-deck/tower/drive/usb_2_1_1_2_4_4_2",
    )

    await bridge.close()
  })
})

describe("publishDriveAlert", () => {
  it("does NOT retain the alert", async () => {
    // A live "go clean bay 7" must not fire again tomorrow.
    const { bridge, broker } = await createBridge()

    const isPublished = await bridge.publishDriveAlert({
      driveId: "usb-2-1.1.2.4.4.2",
      verdict: makeVerdict("disc_dirty", "confirmed", [
        "12 read errors, scattered",
      ]),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(isPublished).toBe(true)

    const messages = broker.messagesOn(
      "rip-deck/tower/drive/usb_2_1_1_2_4_4_2/alert",
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.isRetained).toBe(false)
    expect(parse(messages[0]).action).toBe("clean_disc")

    await bridge.close()
  })

  it("stays silent on a merely suspected verdict", async () => {
    // One drive disagreeing with a disc is a UI hint and a
    // "retry in another drive", not an interruption.
    const { bridge, broker } = await createBridge()

    const isPublished = await bridge.publishDriveAlert({
      driveId: "usb-2-1.1.2.4.4.2",
      verdict: makeVerdict("disc_dirty", "suspected", []),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(isPublished).toBe(false)
    expect(
      broker.messagesOn(
        "rip-deck/tower/drive/usb_2_1_1_2_4_4_2/alert",
      ),
    ).toHaveLength(0)

    await bridge.close()
  })

  it("stays silent on a healthy rip", async () => {
    const { bridge } = await createBridge()

    expect(
      await bridge.publishDriveAlert({
        driveId: "usb-2-1.1.2.4.4.2",
        verdict: makeVerdict("ok", "confirmed", []),
        driveLabel: "07 - Pioneer BDR-211M",
        slot: 7,
      }),
    ).toBe(false)

    await bridge.close()
  })
})

describe("publishLivenessAlert — H3", () => {
  const pastGraceMs =
    HEALTH_THRESHOLDS.stallGraceMs + 60_000

  const hung = assessLiveness({
    startedAtMs: 0,
    lastForwardProgressAtMs: pastGraceMs,
    lastEventAtMs:
      pastGraceMs + HEALTH_THRESHOLDS.stallTimeoutMs,
    nowMs:
      pastGraceMs +
      HEALTH_THRESHOLDS.stallTimeoutMs +
      1_000,
    isKeepTryingRequested: false,
  })

  const working = assessLiveness({
    startedAtMs: 0,
    lastForwardProgressAtMs: pastGraceMs,
    lastEventAtMs: pastGraceMs,
    nowMs: pastGraceMs,
    isKeepTryingRequested: false,
  })

  it("publishes a mid-rip stall unretained", async () => {
    const { bridge, broker } = await createBridge()

    const isPublished = await bridge.publishLivenessAlert({
      driveId: "usb-2-1.1.2.4.4.2",
      liveness: hung,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(isPublished).toBe(true)

    const messages = broker.messagesOn(
      "rip-deck/tower/drive/usb_2_1_1_2_4_4_2/alert",
    )

    expect(messages[0]?.isRetained).toBe(false)
    expect(parse(messages[0]).message).toBe(hung.reason)

    await bridge.close()
  })

  it("says nothing while the rip is working", async () => {
    const { bridge, broker } = await createBridge()

    expect(
      await bridge.publishLivenessAlert({
        driveId: "usb-2-1.1.2.4.4.2",
        liveness: working,
        driveLabel: "07 - Pioneer BDR-211M",
        slot: 7,
      }),
    ).toBe(false)
    expect(
      broker.messagesOn(
        "rip-deck/tower/drive/usb_2_1_1_2_4_4_2/alert",
      ),
    ).toHaveLength(0)

    await bridge.close()
  })
})

describe("publishDiscovery", () => {
  it("retains every discovery message", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishDiscovery({
      drives: [
        {
          driveId: "usb-2-1.1.2.4.4.2",
          label: "07 - Pioneer BDR-211M",
          slot: 7,
        },
      ],
    })

    const discoveryMessages = broker.published.filter(
      (message) =>
        message.topic.startsWith("homeassistant/"),
    )

    expect(discoveryMessages).toHaveLength(9)
    expect(
      discoveryMessages.every(
        (message) => message.isRetained,
      ),
    ).toBe(true)

    await bridge.close()
  })
})

describe("commands", () => {
  it("subscribes to the drive command topic", async () => {
    const { bridge, broker } = await createBridge()

    const seen: string[] = []

    await bridge.subscribeToDriveCommands({
      handler: ({ payload }) => {
        seen.push(payload)
      },
    })

    expect(broker.subscribed).toEqual([topics.cmdDrive])

    broker.deliver({
      topic: topics.cmdDrive,
      payload: '{"action":"eject"}',
    })

    expect(seen).toEqual(['{"action":"eject"}'])

    await bridge.close()
  })

  it("does not deliver unrelated topics to the handler", async () => {
    // The castkit bug would have delivered this.
    const { bridge, broker } = await createBridge()

    const seen: string[] = []

    await bridge.subscribeToDriveCommands({
      handler: ({ payload }) => {
        seen.push(payload)
      },
    })

    broker.deliver({
      topic: topics.ripEvent,
      payload: "{}",
    })

    expect(seen).toEqual([])

    await bridge.close()
  })

  it("publishes command results unretained", async () => {
    const { bridge, broker } = await createBridge()

    await bridge.publishCommandResponse({
      payload: { ok: true },
    })

    const messages = broker.messagesOn(topics.respDrive)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.isRetained).toBe(false)

    await bridge.close()
  })
})
