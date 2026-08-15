import { describe, expect, it } from "vitest"
import {
  bayDiscoveryObjectId,
  buildDiscoveryClearMessages,
  buildDiscoveryMessages,
  type DiscoveryDrive,
} from "./discovery.ts"
import {
  buildTopics,
  DEFAULT_TOPIC_CONFIG,
} from "./topics.ts"

const drives: DiscoveryDrive[] = [
  {
    driveId: "2-1.3.3",
    label: "07 - Pioneer BDR-211M",
    slot: 7,
  },
  {
    driveId: "2-1.3.2",
    label: "08 - Pioneer BDR-211M",
    slot: 8,
  },
]

const topics = buildTopics(DEFAULT_TOPIC_CONFIG)

describe("buildDiscoveryMessages", () => {
  it("emits six tower sensors plus three per bay", () => {
    const messages = buildDiscoveryMessages({ drives })

    expect(messages).toHaveLength(6 + 3 * 2)
  })

  it("reads the activity sensors off the activity topic", () => {
    // These two are the tower power-off automation's only
    // inputs. Pointing either at another topic would leave it
    // triggering on something that does not mean "idle".
    const messages = buildDiscoveryMessages({ drives })

    const activity = messages.filter(
      (message) =>
        message.payload.state_topic === topics.activity,
    )

    expect(
      activity.map((message) => message.payload.unique_id),
    ).toEqual([
      "rip-deck_tower_active_rips",
      "rip-deck_tower_last_activity",
    ])
  })

  it("retains every config message", () => {
    // Unretained discovery means the entities vanish on an HA
    // restart, which is the classic MQTT-discovery footgun.
    const messages = buildDiscoveryMessages({ drives })

    expect(
      messages.every((message) => message.isRetained),
    ).toBe(true)
  })

  it("puts every entity on one HA device", () => {
    const messages = buildDiscoveryMessages({ drives })

    for (const message of messages) {
      expect(message.payload.device).toEqual({
        identifiers: ["rip-deck_tower"],
        name: "Rip-Deck",
        manufacturer: "Rip-Deck",
        model: "USB Blu-ray rip tower",
      })
    }
  })

  it("attaches the bridge availability topic", () => {
    const messages = buildDiscoveryMessages({ drives })

    for (const message of messages) {
      expect(message.payload.availability_topic).toBe(
        topics.availability,
      )
      expect(message.payload.payload_not_available).toBe(
        "offline",
      )
    }
  })

  it("gives every entity a unique unique_id", () => {
    const messages = buildDiscoveryMessages({ drives })
    const uniqueIds = messages.map(
      (message) => message.payload.unique_id,
    )

    expect(new Set(uniqueIds).size).toBe(messages.length)
  })

  it("reads the tower sensors off the RETAINED last-rip topic", () => {
    // `rip/event` must never be retained, so an entity reading
    // it would be blank after every restart. `rip/last` exists
    // precisely so the sensors have something to read.
    const messages = buildDiscoveryMessages({ drives })
    const lastRip = messages.find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_last_rip",
    )

    expect(lastRip?.payload.state_topic).toBe(
      topics.ripLast,
    )
    expect(
      messages.some(
        (message) =>
          message.payload.state_topic === topics.ripEvent,
      ),
    ).toBe(false)
  })

  it("keys discovery on the slot, not the USB path", () => {
    // Path-keyed unique_ids broke the tablet-dash bay tiles
    // when the tower moved 2-1.1.2 → 2-1.3: HA kept the old
    // entities (pretty names) on the dead topics and minted a
    // second set on the live path. Slot is stable across re-cables.
    const messages = buildDiscoveryMessages({ drives })
    const status = messages.find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_slot_07_status",
    )

    expect(status?.topic).toBe(
      "homeassistant/sensor/rip-deck_tower/" +
        "slot_07_status/config",
    )
    // State still lives under the runtime path slug.
    expect(status?.payload.state_topic).toBe(
      "rip-deck/tower/drive/2_1_3_3",
    )
  })

  it("falls back to the path slug when the slot is unknown", () => {
    const messages = buildDiscoveryMessages({
      drives: [
        {
          driveId: "2-1.3.9",
          label: "2-1.3.9",
          slot: null,
        },
      ],
    })
    const status = messages.find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_2_1_3_9_status",
    )

    expect(status?.topic).toContain("2_1_3_9_status")
    expect(status?.payload.state_topic).toBe(
      "rip-deck/tower/drive/2_1_3_9",
    )
  })

  it("rewrites state_topic when the same slot moves path", () => {
    const before = buildDiscoveryMessages({
      drives: [
        {
          driveId: "2-1.1.2.3",
          label: "07 - Pioneer BDR-211M",
          slot: 7,
        },
      ],
    }).find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_slot_07_status",
    )
    const after = buildDiscoveryMessages({
      drives: [
        {
          driveId: "2-1.3.3",
          label: "07 - Pioneer BDR-211M",
          slot: 7,
        },
      ],
    }).find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_slot_07_status",
    )

    // Same unique_id → HA updates the existing entity in place.
    expect(before?.payload.unique_id).toBe(
      after?.payload.unique_id,
    )
    expect(before?.payload.state_topic).toBe(
      "rip-deck/tower/drive/2_1_1_2_3",
    )
    expect(after?.payload.state_topic).toBe(
      "rip-deck/tower/drive/2_1_3_3",
    )
  })

  it("points the alert sensor at the unretained alert topic", () => {
    const messages = buildDiscoveryMessages({ drives })
    const alert = messages.find(
      (message) =>
        message.payload.unique_id ===
        "rip-deck_tower_slot_07_alert",
    )

    expect(alert?.payload.state_topic).toBe(
      "rip-deck/tower/drive/2_1_3_3/alert",
    )
    expect(alert?.payload.entity_category).toBe(
      "diagnostic",
    )
  })

  it("builds empty retained tombstones for removed bays", () => {
    const clears = buildDiscoveryClearMessages({
      objectIds: ["slot_07", "2_1_1_2_3"],
    })

    expect(clears).toHaveLength(6)
    expect(
      clears.every((message) => message.isRetained),
    ).toBe(true)
    expect(
      clears.every((message) => message.payload === ""),
    ).toBe(true)
    expect(clears.map((message) => message.topic)).toEqual(
      expect.arrayContaining([
        "homeassistant/sensor/rip-deck_tower/slot_07_status/config",
        "homeassistant/sensor/rip-deck_tower/2_1_1_2_3_status/config",
      ]),
    )
  })

  it("formats slot object ids as zero-padded slot_NN", () => {
    expect(
      bayDiscoveryObjectId({
        driveId: "2-1.3.4.2",
        label: "05 - Pioneer BDR-212U",
        slot: 5,
      }),
    ).toBe("slot_05")
  })

  it("honours a non-default topic config", () => {
    const messages = buildDiscoveryMessages({
      drives: [],
      config: {
        base: "rip-deck/spare",
        nodeId: "rip-deck_spare",
        discoveryPrefix: "ha",
      },
    })

    expect(
      messages[0]?.topic.startsWith("ha/sensor/"),
    ).toBe(true)
    expect(messages[0]?.payload.state_topic).toBe(
      "rip-deck/spare/rip/last",
    )
  })

  it("emits only the tower sensors with no drives", () => {
    // Zero drives present is a valid normal state (F3), not an
    // error — the tower is powered independently.
    expect(
      buildDiscoveryMessages({ drives: [] }),
    ).toHaveLength(6)
  })
})
