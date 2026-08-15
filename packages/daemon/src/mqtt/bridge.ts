import {
  isAnnounceable,
  type Job,
  type Verdict,
} from "@rip-deck/contracts"
import type { Liveness } from "../rip/liveness.ts"
import type { LoadedDiscsPayload } from "../rip/loadedDiscs.ts"
import type { ActivityPayload } from "./activity.ts"
import {
  buildDriveAlertPayload,
  buildRipEventPayload,
} from "./announcement.ts"
import {
  type CommandHandler,
  createMqttPublisher,
  type MqttConnect,
  type MqttConnectionConfig,
  type MqttPublisher,
} from "./client.ts"
import {
  createMqttConnectionConfig,
  createTopicConfig,
} from "./config.ts"
import {
  buildDiscoveryClearMessages,
  buildDiscoveryMessages,
  type DiscoveryDrive,
} from "./discovery.ts"
import {
  type BayDiscFacts,
  buildDriveStatePayload,
} from "./driveState.ts"
import {
  buildLivenessAlertPayload,
  isLivenessAlertable,
} from "./livenessAlert.ts"
import {
  buildTopics,
  driveSlug,
  type TopicConfig,
} from "./topics.ts"

/**
 * The rip-deck side of MQTT: which payload goes to which topic,
 * and — the part that is easy to get wrong and expensive to
 * discover — whether it is retained.
 *
 * The retention rules are load-bearing:
 *
 *  - `rip/event` is **NOT retained**. Retaining it would let
 *    Home Assistant re-announce a finished rip every time it
 *    reconnects, so the house would say "Ivanhoe finished
 *    ripping" at 3am after an HA restart.
 *  - `rip/last` **IS retained**, carrying the same payload, so
 *    the sensors read the last rip instead of `Unknown`.
 *  - `availability` **IS retained** and is the LWT target.
 *  - `drive/<slug>` **IS retained** — a dashboard must be able
 *    to read what each bay is doing right now.
 *  - `drive/<slug>/alert` is **NOT retained**. A live "go clean
 *    bay 7" must not fire again tomorrow.
 *
 * Nothing here throws on a broker problem. A rip that is going
 * fine must not fail because Mosquitto did.
 */

export type RipDeckMqtt = {
  isEnabled: boolean
  publishDiscovery: (params: {
    drives: DiscoveryDrive[]
    /**
     * Bay discovery object ids from the previous publish that
     * are no longer in `drives`. Cleared with empty retained
     * discovery configs so HA drops the orphan entities instead
     * of leaving path-keyed ghosts after a re-cable.
     */
    clearObjectIds?: readonly string[]
  }) => Promise<void>
  publishRipEvent: (params: {
    job: Job
    verdict: Verdict
    driveLabel: string
    /** The bay's slot, for the payload's spoken line. */
    slot?: number | null
  }) => Promise<void>
  publishActivity: (params: {
    payload: ActivityPayload
  }) => Promise<void>
  publishDriveState: (params: {
    driveId: string
    job: Job | null
    driveLabel: string
    slot: number | null
    nowMs?: number
    /** What is in the tray. See `DriveDiscState`. */
    disc?: BayDiscFacts
  }) => Promise<void>
  publishDriveAlert: (params: {
    driveId: string
    verdict: Verdict
    driveLabel: string
    slot: number | null
  }) => Promise<boolean>
  publishLivenessAlert: (params: {
    driveId: string
    liveness: Liveness
    driveLabel: string
    slot: number | null
  }) => Promise<boolean>
  subscribeToDriveCommands: (params: {
    handler: CommandHandler
  }) => Promise<void>
  publishCommandResponse: (params: {
    payload: unknown
  }) => Promise<void>
  /**
   * Ask Home Assistant to power the tower on. A bare `on` payload,
   * not JSON, so the HA automation is a one-line `payload: "on"`
   * trigger with no template to get wrong. NOT retained.
   */
  publishTowerPowerOn: () => Promise<void>
  publishTowerPowerOff: () => Promise<void>
  publishLoadedDiscs: (params: {
    payload: LoadedDiscsPayload
  }) => Promise<void>
  close: () => Promise<void>
}

export const createRipDeckMqtt = async ({
  config = createMqttConnectionConfig(),
  topicConfig = createTopicConfig(),
  connect,
}: {
  config?: MqttConnectionConfig
  topicConfig?: TopicConfig
  connect?: MqttConnect
} = {}): Promise<RipDeckMqtt> => {
  const topics = buildTopics(topicConfig)

  const publisher: MqttPublisher =
    await createMqttPublisher({
      config,
      availabilityTopic: topics.availability,
      connect,
    })

  const publishJson = async (params: {
    topic: string
    payload: unknown
    isRetained: boolean
  }) => {
    await publisher.publish({
      topic: params.topic,
      payload: JSON.stringify(params.payload),
      isRetained: params.isRetained,
    })
  }

  return {
    isEnabled: publisher.isEnabled,

    publishDiscovery: async ({
      drives,
      clearObjectIds,
    }) => {
      // Tombstones first so a slot that moved path does not
      // briefly keep two discovery configs for the same bay.
      for (const message of buildDiscoveryClearMessages({
        objectIds: clearObjectIds ?? [],
        config: topicConfig,
      })) {
        await publisher.publish({
          topic: message.topic,
          payload: message.payload,
          isRetained: message.isRetained,
        })
      }

      for (const message of buildDiscoveryMessages({
        drives,
        config: topicConfig,
      })) {
        await publishJson({
          topic: message.topic,
          payload: message.payload,
          isRetained: message.isRetained,
        })
      }
    },

    publishRipEvent: async (input) => {
      const payload = buildRipEventPayload(input)

      // Same payload, two topics, two retention answers. This
      // pair is the whole H2 contract: the automation triggers
      // on the unretained event, the sensors read the retained
      // copy.
      await publishJson({
        topic: topics.ripEvent,
        payload,
        isRetained: false,
      })
      await publishJson({
        topic: topics.ripLast,
        payload,
        isRetained: true,
      })
    },

    publishActivity: async ({ payload }) => {
      // Retained, and that is the point: the power-off
      // automation must be able to read "nothing is running"
      // the instant Home Assistant restarts, rather than
      // waiting a heartbeat to find out.
      await publishJson({
        topic: topics.activity,
        payload,
        isRetained: true,
      })
    },

    publishDriveState: async ({
      driveId,
      job,
      driveLabel,
      slot,
      nowMs = Date.now(),
      disc,
    }) => {
      await publishJson({
        topic: topics.driveState(driveSlug(driveId)),
        payload: buildDriveStatePayload({
          job,
          driveLabel,
          slot,
          nowMs,
          disc,
        }),
        isRetained: true,
      })
    },

    publishDriveAlert: async ({
      driveId,
      verdict,
      driveLabel,
      slot,
    }) => {
      // Only a confirmed, non-ok verdict may announce: a disc
      // verdict seen on one drive is a UI hint and a "retry in
      // another drive", not something worth interrupting anyone
      // over.
      if (!isAnnounceable(verdict)) return false

      await publishJson({
        topic: topics.driveAlert(driveSlug(driveId)),
        payload: buildDriveAlertPayload({
          verdict,
          driveLabel,
          slot,
        }),
        isRetained: false,
      })

      return true
    },

    publishLivenessAlert: async ({
      driveId,
      liveness,
      driveLabel,
      slot,
    }) => {
      // H3: say mid-rip that a bay has stopped moving. ARM could
      // only ever say it after the rip had already failed.
      if (!isLivenessAlertable(liveness)) return false

      await publishJson({
        topic: topics.driveAlert(driveSlug(driveId)),
        payload: buildLivenessAlertPayload({
          liveness,
          driveLabel,
          slot,
        }),
        isRetained: false,
      })

      return true
    },

    subscribeToDriveCommands: async ({ handler }) => {
      await publisher.subscribe({
        topics: [topics.cmdDrive],
        handler,
      })
    },

    publishCommandResponse: async ({ payload }) => {
      await publishJson({
        topic: topics.respDrive,
        payload,
        isRetained: false,
      })
    },

    publishTowerPowerOn: async () => {
      // Raw `on`, not `publishJson` — the HA side matches a bare
      // payload, and a JSON-quoted `"on"` is one avoidable mismatch.
      await publisher.publish({
        topic: topics.cmdPower,
        payload: "on",
        isRetained: false,
      })
    },

    publishTowerPowerOff: async () => {
      await publisher.publish({
        topic: topics.cmdPower,
        payload: "off",
        isRetained: false,
      })
    },

    publishLoadedDiscs: async ({ payload }) => {
      // RETAINED — see `topics.loaded`. This is the one payload
      // whose whole job is to outlive the tower's power, and the
      // broker is what holds it while rip-deck can see nothing.
      await publishJson({
        topic: topics.loaded,
        payload,
        isRetained: true,
      })
    },

    close: async () => {
      await publisher.close()
    },
  }
}
