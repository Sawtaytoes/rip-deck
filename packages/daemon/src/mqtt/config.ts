import type { MqttConnectionConfig } from "./client.ts"
import {
  DEFAULT_TOPIC_CONFIG,
  type TopicConfig,
} from "./topics.ts"

/**
 * MQTT settings, read from the environment.
 *
 * NO CREDENTIALS LIVE IN THIS REPO. The broker is
 * `example.com:8883` over TLS and the `rip-deck` Mosquitto
 * login's password belongs in the workspace root `.env`, never
 * in git. An unset `RIP_DECK_MQTT_URL` is a supported state, not
 * a misconfiguration — it yields the no-op publisher.
 *
 * Variable names follow the existing `RIP_DECK_*` scheme
 * (`RIP_DECK_DEST`, `RIP_DECK_STATE_DIR`, `RIP_DECK_MAKEMKVCON`).
 */

export type EnvLike = Record<string, string | undefined>

export const createMqttConnectionConfig = (
  env: EnvLike = process.env,
): MqttConnectionConfig => ({
  url: env.RIP_DECK_MQTT_URL ?? "",
  username: env.RIP_DECK_MQTT_USERNAME ?? "",
  password: env.RIP_DECK_MQTT_PASSWORD ?? "",
  caFile: env.RIP_DECK_MQTT_CA_FILE || undefined,
  // Default ON. The broker presents a real certificate, so an
  // opt-out has to be a deliberate act rather than the default
  // we forget to turn back on.
  isRejectUnauthorized:
    env.RIP_DECK_MQTT_REJECT_UNAUTHORIZED !== "false",
})

export const createTopicConfig = (
  env: EnvLike = process.env,
): TopicConfig => ({
  base: env.RIP_DECK_MQTT_BASE ?? DEFAULT_TOPIC_CONFIG.base,
  nodeId:
    env.RIP_DECK_MQTT_NODE_ID ??
    DEFAULT_TOPIC_CONFIG.nodeId,
  discoveryPrefix:
    env.RIP_DECK_MQTT_DISCOVERY_PREFIX ??
    DEFAULT_TOPIC_CONFIG.discoveryPrefix,
})
