import { readFileSync } from "node:fs"
import mqtt from "mqtt"

/**
 * Thin MQTT client wrapper.
 *
 * VENDORED from castkit's
 * `packages/shared/src/mqtt/publisher.ts`. That package is
 * `private: true`, has no build step, and exposes raw `.ts`
 * through a workspace-only subpath export — there is no
 * consumable artifact, so this is a copy rather than a
 * dependency. Keep the two in mind when fixing bugs; they are
 * now separate code.
 *
 * Three things were kept deliberately:
 *
 *  - **No-op when unconfigured.** With no broker URL the daemon
 *    still boots and rips; MQTT is an output, never a gate.
 *  - **Last Will.** If we die, HA sees `offline` rather than a
 *    frozen last-known state.
 *  - **60 s availability heartbeat.** A second instance shutting
 *    down (or a stale LWT) can leave a retained `offline` on a
 *    broker while we are alive and pushing — HA then ignores
 *    every push. Republishing `online` heals that within one
 *    interval.
 *
 * One thing was FIXED in the copy: castkit's `subscribe()`
 * registered a fresh `client.on("message")` listener per call,
 * so every handler received every message and each one had to
 * re-filter by topic itself. Here a single dispatcher is
 * registered once at connect and routes per topic filter
 * (`isTopicMatch`), so a handler only ever sees its own topics.
 */

/** Broker-connection subset of the daemon's MQTT config. */
export type MqttConnectionConfig = {
  url: string
  username: string
  password: string
  caFile: string | undefined
  isRejectUnauthorized: boolean
}

export type CommandHandler = (params: {
  topic: string
  payload: string
}) => void | Promise<void>

export type MqttPublisher = {
  isEnabled: boolean
  publish: (params: {
    topic: string
    payload: string | Uint8Array
    isRetained?: boolean
  }) => Promise<void>
  subscribe: (params: {
    topics: string[]
    handler: CommandHandler
  }) => Promise<void>
  close: () => Promise<void>
}

/**
 * The broker seam.
 *
 * Everything below this type is pure routing and retention
 * policy, which is the part worth unit-testing. Tests pass a
 * fake `connect`; production gets `connectViaMqttJs`.
 */
export type MqttClientLike = {
  publishAsync: (params: {
    topic: string
    payload: string | Uint8Array
    isRetained: boolean
  }) => Promise<void>
  subscribeAsync: (params: {
    topics: string[]
  }) => Promise<void>
  onMessage: (
    listener: (params: {
      topic: string
      payload: string
    }) => void,
  ) => void
  onConnect: (listener: () => void) => void
  endAsync: () => Promise<void>
}

export type MqttConnect = (params: {
  config: MqttConnectionConfig
  availabilityTopic: string
}) => Promise<MqttClientLike>

/** How long a stale retained `offline` can outlive us. */
export const AVAILABILITY_HEARTBEAT_MS = 60_000

/**
 * Does an MQTT topic filter match a concrete topic?
 *
 * `+` matches exactly one level, `#` matches the rest including
 * the level it sits on (`a/#` matches `a`). This is what makes
 * one dispatcher possible: without it, routing would have to
 * fall back on castkit's "every handler sees everything".
 */
export const isTopicMatch = ({
  filter,
  topic,
}: {
  filter: string
  topic: string
}): boolean => {
  if (filter === topic) return true

  const filterParts = filter.split("/")
  const topicParts = topic.split("/")

  for (let i = 0; i < filterParts.length; i += 1) {
    const filterPart = filterParts[i]

    if (filterPart === "#") {
      return i === filterParts.length - 1
    }

    if (i >= topicParts.length) return false

    if (
      filterPart !== "+" &&
      filterPart !== topicParts[i]
    ) {
      return false
    }
  }

  return filterParts.length === topicParts.length
}

const createNoopPublisher = (): MqttPublisher => ({
  isEnabled: false,
  publish: async () => {},
  subscribe: async () => {},
  close: async () => {},
})

const connectViaMqttJs: MqttConnect = async ({
  config,
  availabilityTopic,
}) => {
  const client = await mqtt.connectAsync(config.url, {
    username: config.username || undefined,
    password: config.password || undefined,
    ca: config.caFile
      ? [readFileSync(config.caFile)]
      : undefined,
    rejectUnauthorized: config.isRejectUnauthorized,
    will: {
      topic: availabilityTopic,
      payload: Buffer.from("offline"),
      retain: true,
      qos: 1,
    },
  })

  return {
    publishAsync: async ({
      topic,
      payload,
      isRetained,
    }) => {
      await client.publishAsync(
        topic,
        typeof payload === "string"
          ? payload
          : Buffer.from(payload),
        { retain: isRetained, qos: 1 },
      )
    },
    subscribeAsync: async ({ topics }) => {
      await client.subscribeAsync(topics, { qos: 1 })
    },
    onMessage: (listener) => {
      client.on("message", (topic, payloadBuffer) => {
        listener({
          topic,
          payload: payloadBuffer.toString(),
        })
      })
    },
    onConnect: (listener) => {
      client.on("connect", () => {
        listener()
      })
    },
    endAsync: async () => {
      await client.endAsync()
    },
  }
}

export const createMqttPublisher = async ({
  config,
  availabilityTopic,
  connect = connectViaMqttJs,
}: {
  config: MqttConnectionConfig
  availabilityTopic: string
  connect?: MqttConnect
}): Promise<MqttPublisher> => {
  // No broker configured is a supported state, not an error:
  // `rip-deck rip` must work on a laptop with no Mosquitto.
  if (!config.url) {
    console.log("[mqtt] no broker URL set — MQTT disabled")
    return createNoopPublisher()
  }

  const client = await connect({
    config,
    availabilityTopic,
  })

  const publishOnline = () =>
    client.publishAsync({
      topic: availabilityTopic,
      payload: "online",
      isRetained: true,
    })

  await publishOnline()
  console.log(`[mqtt] connected to ${config.url}`)

  const heartbeatInterval = setInterval(() => {
    publishOnline().catch((error) => {
      console.error(
        "[mqtt] availability heartbeat failed",
        error,
      )
    })
  }, AVAILABILITY_HEARTBEAT_MS)

  // mqtt.js auto-reconnects; re-assert availability each time.
  client.onConnect(() => {
    publishOnline().catch(() => {})
  })

  // ONE dispatcher, registered once. castkit added a listener
  // per `subscribe()` call, which meant N handlers each saw N
  // topics and every handler had to re-filter by topic.
  const handlersByFilter = new Map<
    string,
    Set<CommandHandler>
  >()

  client.onMessage(({ topic, payload }) => {
    for (const [filter, handlers] of handlersByFilter) {
      if (!isTopicMatch({ filter, topic })) continue

      for (const handler of handlers) {
        void handler({ topic, payload })
      }
    }
  })

  return {
    isEnabled: true,
    publish: async ({
      topic,
      payload,
      isRetained = false,
    }) => {
      await client.publishAsync({
        topic,
        payload,
        isRetained,
      })
    },
    subscribe: async ({ topics, handler }) => {
      for (const topic of topics) {
        const handlers = handlersByFilter.get(topic)

        if (handlers) handlers.add(handler)
        else handlersByFilter.set(topic, new Set([handler]))
      }

      await client.subscribeAsync({ topics })
    },
    close: async () => {
      clearInterval(heartbeatInterval)
      handlersByFilter.clear()

      await client.publishAsync({
        topic: availabilityTopic,
        payload: "offline",
        isRetained: true,
      })
      await client.endAsync()
    },
  }
}
