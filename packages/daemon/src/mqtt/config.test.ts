import { describe, expect, it } from "vitest"
import {
  createMqttConnectionConfig,
  createTopicConfig,
} from "./config.ts"

describe("createMqttConnectionConfig", () => {
  it("yields an empty URL when nothing is set", () => {
    // An unset broker is a supported state, and an empty URL is
    // what selects the no-op publisher.
    expect(createMqttConnectionConfig({}).url).toBe("")
  })

  it("reads the broker settings from the environment", () => {
    const config = createMqttConnectionConfig({
      RIP_DECK_MQTT_URL: "mqtts://example.com:8883",
      RIP_DECK_MQTT_USERNAME: "rip-deck",
      RIP_DECK_MQTT_PASSWORD: "from-dot-env",
      RIP_DECK_MQTT_CA_FILE: "/config/ca.crt",
    })

    expect(config.url).toBe("mqtts://example.com:8883")
    expect(config.username).toBe("rip-deck")
    expect(config.password).toBe("from-dot-env")
    expect(config.caFile).toBe("/config/ca.crt")
  })

  it("verifies the certificate by default", () => {
    // Turning TLS verification off has to be a deliberate act,
    // not the default nobody remembers to switch back.
    expect(
      createMqttConnectionConfig({}).isRejectUnauthorized,
    ).toBe(true)
  })

  it("allows an explicit opt-out", () => {
    expect(
      createMqttConnectionConfig({
        RIP_DECK_MQTT_REJECT_UNAUTHORIZED: "false",
      }).isRejectUnauthorized,
    ).toBe(false)
  })

  it("treats an empty CA path as absent", () => {
    expect(
      createMqttConnectionConfig({
        RIP_DECK_MQTT_CA_FILE: "",
      }).caFile,
    ).toBeUndefined()
  })
})

describe("createTopicConfig", () => {
  it("defaults to the tower tower", () => {
    expect(createTopicConfig({})).toEqual({
      base: "rip-deck/tower",
      nodeId: "rip-deck_tower",
      discoveryPrefix: "homeassistant",
    })
  })

  it("can be pointed elsewhere for a second host", () => {
    expect(
      createTopicConfig({
        RIP_DECK_MQTT_BASE: "rip-deck/spare",
        RIP_DECK_MQTT_NODE_ID: "rip-deck_spare",
      }),
    ).toEqual({
      base: "rip-deck/spare",
      nodeId: "rip-deck_spare",
      discoveryPrefix: "homeassistant",
    })
  })
})
