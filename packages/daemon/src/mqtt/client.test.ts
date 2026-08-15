import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  AVAILABILITY_HEARTBEAT_MS,
  createMqttPublisher,
  isTopicMatch,
  type MqttClientLike,
  type MqttConnectionConfig,
} from "./client.ts"

/**
 * The transport is unit-tested against a fake broker seam — no
 * socket, no `example.com`, no credentials. What is being
 * tested is the part that is easy to get wrong and expensive to
 * discover on real hardware: retention flags, availability, and
 * per-topic routing.
 */

type PublishedMessage = {
  topic: string
  payload: string | Uint8Array
  isRetained: boolean
}

const createFakeClient = () => {
  const published: PublishedMessage[] = []
  const subscribed: string[] = []
  const messageListeners: ((params: {
    topic: string
    payload: string
  }) => void)[] = []
  const connectListeners: (() => void)[] = []
  let isEnded = false

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
    onConnect: (listener) => {
      connectListeners.push(listener)
    },
    endAsync: async () => {
      isEnded = true
    },
  }

  return {
    client,
    published,
    subscribed,
    messageListeners,
    connectListeners,
    deliver: (params: {
      topic: string
      payload: string
    }) => {
      for (const listener of messageListeners) {
        listener(params)
      }
    },
    isEnded: () => isEnded,
  }
}

const config: MqttConnectionConfig = {
  url: "mqtts://mqtt.example.invalid:8883",
  username: "rip-deck",
  password: "not-a-real-password",
  caFile: undefined,
  isRejectUnauthorized: true,
}

const AVAILABILITY = "rip-deck/tower/availability"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("createMqttPublisher — unconfigured", () => {
  it("returns a no-op publisher with no broker URL", async () => {
    // The daemon has to boot and rip with no broker at all;
    // MQTT is an output, never a gate.
    const publisher = await createMqttPublisher({
      config: { ...config, url: "" },
      availabilityTopic: AVAILABILITY,
      connect: async () => {
        throw new Error("must not connect")
      },
    })

    expect(publisher.isEnabled).toBe(false)

    await publisher.publish({
      topic: "anything",
      payload: "{}",
    })
    await publisher.subscribe({
      topics: ["anything"],
      handler: () => {},
    })
    await publisher.close()
  })
})

describe("createMqttPublisher — availability", () => {
  it("publishes online retained on connect", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    expect(fake.published).toEqual([
      {
        topic: AVAILABILITY,
        payload: "online",
        isRetained: true,
      },
    ])

    await publisher.close()
  })

  it("publishes offline retained on close", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await publisher.close()

    expect(fake.published.at(-1)).toEqual({
      topic: AVAILABILITY,
      payload: "offline",
      isRetained: true,
    })
    expect(fake.isEnded()).toBe(true)
  })

  it("re-asserts availability on every reconnect", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    for (const listener of fake.connectListeners) {
      listener()
    }
    await Promise.resolve()

    expect(
      fake.published.filter(
        (message) => message.payload === "online",
      ),
    ).toHaveLength(2)

    await publisher.close()
  })

  it("heals a stale retained offline every 60 s", async () => {
    // Another instance shutting down can leave a retained
    // `offline` behind while we are alive and pushing; HA then
    // ignores every push until something republishes `online`.
    vi.useFakeTimers()
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await vi.advanceTimersByTimeAsync(
      AVAILABILITY_HEARTBEAT_MS * 3,
    )

    expect(
      fake.published.filter(
        (message) => message.payload === "online",
      ),
    ).toHaveLength(4)

    await publisher.close()
  })

  it("stops the heartbeat once closed", async () => {
    vi.useFakeTimers()
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await publisher.close()
    const countAtClose = fake.published.length

    await vi.advanceTimersByTimeAsync(
      AVAILABILITY_HEARTBEAT_MS * 5,
    )

    expect(fake.published).toHaveLength(countAtClose)
  })

  it("survives a failing heartbeat", async () => {
    vi.useFakeTimers()
    const fake = createFakeClient()
    let isFirstPublishDone = false

    fake.client.publishAsync = async () => {
      if (isFirstPublishDone) {
        throw new Error("broker gone")
      }
      isFirstPublishDone = true
    }

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await vi.advanceTimersByTimeAsync(
      AVAILABILITY_HEARTBEAT_MS,
    )

    expect(console.error).toHaveBeenCalled()

    // The heartbeat must not take the process down with it.
    await publisher.close().catch(() => {})
  })
})

describe("createMqttPublisher — retention", () => {
  it("defaults to NOT retained", async () => {
    // The default matters: `rip/event` must not be retained or
    // Home Assistant re-announces a finished rip on reconnect.
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await publisher.publish({
      topic: "rip-deck/tower/rip/event",
      payload: "{}",
    })

    expect(fake.published.at(-1)?.isRetained).toBe(false)

    await publisher.close()
  })

  it("passes retention through when asked", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await publisher.publish({
      topic: "rip-deck/tower/rip/last",
      payload: "{}",
      isRetained: true,
    })

    expect(fake.published.at(-1)?.isRetained).toBe(true)

    await publisher.close()
  })
})

describe("createMqttPublisher — subscription routing", () => {
  it("delivers a message only to its own subscriber", async () => {
    // This is the castkit bug. It registered a fresh
    // `client.on("message")` per subscribe() call, so both
    // handlers below saw both messages and each one had to
    // re-filter by topic itself.
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    const commandTopics: string[] = []
    const alertTopics: string[] = []

    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/drive"],
      handler: ({ topic }) => {
        commandTopics.push(topic)
      },
    })
    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/alert"],
      handler: ({ topic }) => {
        alertTopics.push(topic)
      },
    })

    fake.deliver({
      topic: "rip-deck/tower/cmd/drive",
      payload: "{}",
    })

    expect(commandTopics).toEqual([
      "rip-deck/tower/cmd/drive",
    ])
    expect(alertTopics).toEqual([])

    await publisher.close()
  })

  it("registers exactly one broker-level listener", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    for (let i = 0; i < 5; i += 1) {
      await publisher.subscribe({
        topics: [`rip-deck/tower/cmd/${i}`],
        handler: () => {},
      })
    }

    expect(fake.messageListeners).toHaveLength(1)

    await publisher.close()
  })

  it("routes wildcard subscriptions", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    const seen: string[] = []

    await publisher.subscribe({
      topics: ["rip-deck/tower/drive/+/cmd"],
      handler: ({ topic }) => {
        seen.push(topic)
      },
    })

    fake.deliver({
      topic: "rip-deck/tower/drive/usb_2_1/cmd",
      payload: "{}",
    })
    fake.deliver({
      topic: "rip-deck/tower/drive/usb_2_1/alert",
      payload: "{}",
    })

    expect(seen).toEqual([
      "rip-deck/tower/drive/usb_2_1/cmd",
    ])

    await publisher.close()
  })

  it("fans one topic out to every handler on it", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    let callCount = 0
    const handler = () => {
      callCount += 1
    }

    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/drive"],
      handler,
    })
    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/drive"],
      handler: () => {
        callCount += 1
      },
    })

    fake.deliver({
      topic: "rip-deck/tower/cmd/drive",
      payload: "{}",
    })

    expect(callCount).toBe(2)

    await publisher.close()
  })

  it("subscribes on the broker too", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    await publisher.subscribe({
      topics: ["a/b", "c/d"],
      handler: () => {},
    })

    expect(fake.subscribed).toEqual(["a/b", "c/d"])

    await publisher.close()
  })

  it("delivers the payload as a string", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    const payloads: string[] = []

    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/drive"],
      handler: ({ payload }) => {
        payloads.push(payload)
      },
    })

    fake.deliver({
      topic: "rip-deck/tower/cmd/drive",
      payload: '{"action":"eject"}',
    })

    expect(payloads).toEqual(['{"action":"eject"}'])

    await publisher.close()
  })

  it("stops routing after close", async () => {
    const fake = createFakeClient()

    const publisher = await createMqttPublisher({
      config,
      availabilityTopic: AVAILABILITY,
      connect: async () => fake.client,
    })

    let callCount = 0

    await publisher.subscribe({
      topics: ["rip-deck/tower/cmd/drive"],
      handler: () => {
        callCount += 1
      },
    })

    await publisher.close()

    fake.deliver({
      topic: "rip-deck/tower/cmd/drive",
      payload: "{}",
    })

    expect(callCount).toBe(0)
  })
})

describe("isTopicMatch", () => {
  it("matches an exact topic", () => {
    expect(
      isTopicMatch({
        filter: "a/b/c",
        topic: "a/b/c",
      }),
    ).toBe(true)
  })

  it("rejects a different topic", () => {
    expect(
      isTopicMatch({
        filter: "a/b/c",
        topic: "a/b/d",
      }),
    ).toBe(false)
  })

  it("rejects a prefix of the filter", () => {
    expect(
      isTopicMatch({ filter: "a/b/c", topic: "a/b" }),
    ).toBe(false)
  })

  it("rejects a longer topic without a wildcard", () => {
    expect(
      isTopicMatch({ filter: "a/b", topic: "a/b/c" }),
    ).toBe(false)
  })

  it("matches a single level with +", () => {
    expect(
      isTopicMatch({ filter: "a/+/c", topic: "a/b/c" }),
    ).toBe(true)
    expect(
      isTopicMatch({
        filter: "a/+/c",
        topic: "a/b/x/c",
      }),
    ).toBe(false)
  })

  it("matches the remainder with #", () => {
    expect(
      isTopicMatch({ filter: "a/#", topic: "a/b/c/d" }),
    ).toBe(true)
    // MQTT says `a/#` also matches the parent `a`.
    expect(
      isTopicMatch({ filter: "a/#", topic: "a" }),
    ).toBe(true)
    expect(
      isTopicMatch({ filter: "a/#", topic: "b/c" }),
    ).toBe(false)
  })
})
