import {
  buildTopics,
  DEFAULT_TOPIC_CONFIG,
  driveSlug,
  type TopicConfig,
} from "./topics.ts"

/**
 * Home Assistant MQTT-discovery payloads for the rip tower.
 *
 * Recipe copied from castkit's
 * `packages/server/src/homeAssistant/browserDiscovery.ts`:
 * retained config messages under
 * `<prefix>/<component>/<nodeId>/<objectId>/config`, one shared
 * `device` block so every entity lands on a single HA device,
 * and the bridge availability topic attached to all of them.
 *
 * Publishing these auto-creates, per bay: a status sensor
 * carrying the whole state JSON as attributes, a progress
 * sensor, and a diagnostic sensor for the last mid-rip alert
 * (H3). Plus five tower-level sensors: three reading the
 * retained last-rip payload, and two reading the retained
 * activity payload that the tower power-off automation triggers
 * on.
 *
 * The availability topic attached to every one of them is what
 * makes that automation safe: when the daemon dies, the LWT
 * takes all of these `unavailable`, and an unavailable
 * "0 active rips" is not an idle tower.
 *
 * Discovery messages ARE retained — that is what makes the
 * entities survive an HA restart. This is not in tension with
 * `rip/event` being unretained: the config describes the entity,
 * the event is the thing that must not replay.
 *
 * Deliberately NOT modelled here: the `rip/event` announcement
 * itself. `automation.job_status_announcement` triggers on the
 * raw topic and reads the payload directly (H2) — wrapping it in
 * an entity would change what the automation sees, and the spec
 * says only the source topic may change.
 */

export type DiscoveryMessage = {
  topic: string
  isRetained: true
  payload: Record<string, unknown>
}

/** A bay, as far as Home Assistant needs to know. */
export type DiscoveryDrive = {
  /** Runtime drive id (USB port path today); state topics derive from it. */
  driveId: string
  /** Display label, e.g. "07 - Pioneer BDR-211M". */
  label: string
  slot: number | null
}

/**
 * Stable Home Assistant discovery object id for a bay.
 *
 * ⚠️ **Must not embed the USB port path.** The tower's root path has
 * already moved (`2-1.1.2` → `2-1.3` on 2026-07-30) and will move
 * again on any re-cable. Discovery `unique_id` is how HA keys an
 * entity for life — when it was the path slug, every re-enumeration
 * minted a second set of bay sensors while the tablet-dash tiles
 * stayed wired to the first set, so the dashboard showed idle empty
 * bays while a disc was mid-rip on the live path.
 *
 * Slot is the number on the front of the rack and is what
 * `config/drives.json` already treats as the human identity. State
 * topics still use the runtime path slug (that is where the
 * retained bay payload is published); only the discovery object id
 * / unique_id are slot-stable so HA updates `state_topic` in place
 * when the path changes.
 *
 * Unregistered bays (slot null) fall back to the path slug — same
 * as before — because there is nothing stabler to key on yet.
 */
export const bayDiscoveryObjectId = (
  drive: DiscoveryDrive,
): string => {
  if (drive.slot != null && drive.slot > 0) {
    return `slot_${String(drive.slot).padStart(2, "0")}`
  }
  return driveSlug(drive.driveId)
}

/**
 * Empty retained discovery configs that remove HA entities.
 *
 * HA treats a retained empty payload on a discovery config topic
 * as "delete this entity". Used when a bay leaves the set, or when
 * migrating off path-keyed object ids so the old sensors do not
 * keep reappearing after a broker restart.
 */
export const buildDiscoveryClearMessages = ({
  objectIds,
  config = DEFAULT_TOPIC_CONFIG,
}: {
  objectIds: readonly string[]
  config?: TopicConfig
}): Array<{
  topic: string
  isRetained: true
  payload: ""
}> => {
  const topics = buildTopics(config)
  const suffixes = ["status", "progress", "alert"] as const

  return objectIds.flatMap((objectId) =>
    suffixes.map((suffix) => ({
      topic: topics.discoveryConfig(
        "sensor",
        `${objectId}_${suffix}`,
      ),
      isRetained: true as const,
      payload: "" as const,
    })),
  )
}

const buildDeviceBlock = (config: TopicConfig) => ({
  identifiers: [config.nodeId],
  name: "Rip Deck",
  manufacturer: "Rip Deck",
  model: "USB Blu-ray rip tower",
})

export const buildDiscoveryMessages = ({
  drives,
  config = DEFAULT_TOPIC_CONFIG,
}: {
  drives: DiscoveryDrive[]
  config?: TopicConfig
}): DiscoveryMessage[] => {
  const topics = buildTopics(config)
  const device = buildDeviceBlock(config)

  const availability = {
    availability_topic: topics.availability,
    payload_available: "online",
    payload_not_available: "offline",

    /**
     * Prefix every entity with the device name.
     *
     * Without it Home Assistant would mint `sensor.active_rips`
     * and `sensor.last_rip` — bare nouns in a global namespace
     * that the next integration to publish a "status" sensor
     * would collide with, and which give a reader no clue what
     * they belong to. With it the minted ids carry the device
     * name AND the area HA has the device in, so a per-bay
     * status sensor lands as
     * `sensor.rip_deck_07_pioneer_bdr_211m_status` —
     * matching how every other device in this house is
     * addressed (`switch.optical_ripper_power_control_power`).
     * Do not write templates against a bare `sensor.rip_deck_*`
     * id: the prefix moves with the area.
     * Safe to set now and only now: nothing has ever been
     * published, so there are no existing entity ids to break.
     */
    has_entity_name: true,
  }

  const towerMessages: DiscoveryMessage[] = [
    {
      topic: topics.discoveryConfig("sensor", "last_rip"),
      isRetained: true,
      payload: {
        ...availability,
        name: "Last rip",
        unique_id: `${config.nodeId}_last_rip`,
        state_topic: topics.ripLast,
        value_template: "{{ value_json.title }}",
        json_attributes_topic: topics.ripLast,
        icon: "mdi:disc",
        device,
      },
    },
    {
      topic: topics.discoveryConfig(
        "sensor",
        "last_rip_result",
      ),
      isRetained: true,
      payload: {
        ...availability,
        name: "Last rip result",
        unique_id: `${config.nodeId}_last_rip_result`,
        state_topic: topics.ripLast,
        value_template: "{{ value_json.result }}",
        device,
      },
    },
    {
      // The legacy four-value health vocabulary the house
      // announcement speaks (H2), surfaced as its own sensor so
      // a dashboard can show what was said without re-deriving
      // it from the richer verdict.
      topic: topics.discoveryConfig(
        "sensor",
        "last_rip_health",
      ),
      isRetained: true,
      payload: {
        ...availability,
        name: "Last rip health",
        unique_id: `${config.nodeId}_last_rip_health`,
        state_topic: topics.ripLast,
        value_template: "{{ value_json.health }}",
        device,
      },
    },
    {
      // The input the tower power-off automation triggers on.
      // A count rather than a boolean, so "how many" is legible
      // on a dashboard and `below: 1` is the whole trigger.
      topic: topics.discoveryConfig(
        "sensor",
        "active_rips",
      ),
      isRetained: true,
      payload: {
        ...availability,
        name: "Active rips",
        unique_id: `${config.nodeId}_active_rips`,
        state_topic: topics.activity,
        value_template: "{{ value_json.active_rip_count }}",
        json_attributes_topic: topics.activity,
        state_class: "measurement",
        icon: "mdi:disc-player",
        device,
      },
    },
    {
      // The take-the-discs-out chore, as an entity a reminder
      // automation can trigger on. A COUNT, like `active_rips`,
      // so `above: 0` is the whole trigger and the number is
      // legible on a dashboard; the slots, titles and the
      // ready-made sentences ride the attributes, because
      // composing an English list out of a slot array in Jinja is
      // the job rip-deck already did.
      //
      // Its topic is the one retained payload built to outlive a
      // powered-off tower, so this entity keeps its value while
      // there is nothing to measure — which is exactly when the
      // reminder is worth having.
      topic: topics.discoveryConfig(
        "sensor",
        "discs_loaded",
      ),
      isRetained: true,
      payload: {
        ...availability,
        name: "Discs loaded",
        unique_id: `${config.nodeId}_discs_loaded`,
        state_topic: topics.loaded,
        value_template: "{{ value_json.count }}",
        json_attributes_topic: topics.loaded,
        state_class: "measurement",
        icon: "mdi:disc",
        device,
      },
    },
    {
      // The second half of the fail-closed test: an idle count
      // is only trustworthy if you can also see how long ago it
      // was last confirmed.
      topic: topics.discoveryConfig(
        "sensor",
        "last_activity",
      ),
      isRetained: true,
      payload: {
        ...availability,
        name: "Last activity",
        unique_id: `${config.nodeId}_last_activity`,
        state_topic: topics.activity,
        device_class: "timestamp",
        value_template:
          "{{ (value_json.last_activity_at / 1000) " +
          "| timestamp_utc }}",
        entity_category: "diagnostic",
        icon: "mdi:clock-outline",
        device,
      },
    },
  ]

  const driveMessages = drives.flatMap(
    (drive): DiscoveryMessage[] => {
      // State still lives under the runtime path slug — that is
      // the topic `publishDriveState` writes. Discovery keys on
      // the stable object id so HA does not mint a new entity
      // when the path moves; it only rewrites state_topic.
      const stateSlug = driveSlug(drive.driveId)
      const objectId = bayDiscoveryObjectId(drive)
      const stateTopic = topics.driveState(stateSlug)

      return [
        {
          topic: topics.discoveryConfig(
            "sensor",
            `${objectId}_status`,
          ),
          isRetained: true,
          payload: {
            ...availability,
            name: `${drive.label} status`,
            unique_id: `${config.nodeId}_${objectId}_status`,
            state_topic: stateTopic,
            value_template: "{{ value_json.state }}",
            json_attributes_topic: stateTopic,
            icon: "mdi:disc-player",
            device,
          },
        },
        {
          topic: topics.discoveryConfig(
            "sensor",
            `${objectId}_progress`,
          ),
          isRetained: true,
          payload: {
            ...availability,
            name: `${drive.label} progress`,
            unique_id: `${config.nodeId}_${objectId}_progress`,
            state_topic: stateTopic,
            value_template:
              "{{ value_json.progress_percent }}",
            unit_of_measurement: "%",
            state_class: "measurement",
            device,
          },
        },
        {
          // Fed by a NOT-retained topic on purpose, so this
          // sensor goes unknown after a restart rather than
          // re-showing yesterday's "go clean bay 7".
          topic: topics.discoveryConfig(
            "sensor",
            `${objectId}_alert`,
          ),
          isRetained: true,
          payload: {
            ...availability,
            name: `${drive.label} alert`,
            unique_id: `${config.nodeId}_${objectId}_alert`,
            state_topic: topics.driveAlert(stateSlug),
            value_template: "{{ value_json.message }}",
            json_attributes_topic:
              topics.driveAlert(stateSlug),
            entity_category: "diagnostic",
            icon: "mdi:alert-circle-outline",
            device,
          },
        },
      ]
    },
  )

  return [...towerMessages, ...driveMessages]
}
