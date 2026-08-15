/**
 * Topic scheme.
 *
 * Follows the house convention `<service>/<noun>/<verb-or-state>`
 * with a configurable base, matching `arm/tower` before it
 * (and `truenas/<task>/…`, `bambuddy/printers/…`, `castkit`).
 *
 * The retain rules are load-bearing, not stylistic:
 *  - `rip/event` is NOT retained, so Home Assistant cannot
 *    re-announce a finished rip when it reconnects or restarts.
 *  - `rip/last` IS retained, so the sensors read the last rip
 *    instead of `Unknown` after a restart.
 *  - `availability` IS retained, and is the LWT target.
 *  - `drive/<slug>/alert` is NOT retained — a live "go clean
 *    bay 7" alert must not fire again tomorrow.
 */

export type TopicConfig = {
  /** Default `rip-deck/tower`. */
  base: string
  /** Default `rip-deck_tower`. HA discovery node id. */
  nodeId: string
  /** Default `homeassistant`. */
  discoveryPrefix: string
}

export const DEFAULT_TOPIC_CONFIG: TopicConfig = {
  base: "rip-deck/tower",
  nodeId: "rip-deck_tower",
  discoveryPrefix: "homeassistant",
}

export const buildTopics = (config: TopicConfig) => {
  const { base } = config

  return {
    availability: `${base}/availability`,

    /** Terminal rip event. NOT retained — HA trigger. */
    ripEvent: `${base}/rip/event`,
    /** Last rip. Retained — sensor state. */
    ripLast: `${base}/rip/last`,

    /**
     * Tower-wide "is anything happening". Retained.
     *
     * Retained because the one automation that consumes it —
     * "power the tower off once it has been idle for X" — must
     * be able to read the answer the moment Home Assistant
     * restarts, not X minutes later. It is safe to retain for
     * the same reason `drive/<slug>` is: it describes a state,
     * not an event, so replaying it says nothing false.
     */
    activity: `${base}/activity`,

    /** Live per-bay progress. Retained. */
    driveState: (slug: string) => `${base}/drive/${slug}`,
    /**
     * Live mid-rip trouble alert. NOT retained.
     *
     * This is the thing ARM structurally could not do: its
     * health verdict was computed at rip END, so "bay 7 is
     * stalling, go clean the disc" could only ever arrive after
     * the rip had already failed.
     */
    driveAlert: (slug: string) =>
      `${base}/drive/${slug}/alert`,

    /**
     * What is still sitting in the tower. RETAINED.
     *
     * ⚠️ **Retained is load-bearing here, not a convenience.** The
     * fact this carries — "three discs are still in there" — is a
     * chore that stays true while the tower is DARK, and a daemon
     * restarted against a powered-off tower can see nothing at all
     * to rebuild it from. The broker holding the last thing
     * rip-deck knew is what makes the reminder survive that.
     * `shouldPublishLoadedDiscs` is the matching rule on the write
     * side: a daemon that knows nothing must not publish a false
     * all-clear over it (`rip/loadedDiscs.ts`).
     *
     * Safe to retain for the same reason `drive/<slug>` is: it
     * describes a state, not an event, so replaying it says
     * nothing false.
     */
    loaded: `${base}/loaded`,

    /** Inbound commands. */
    cmdDrive: `${base}/cmd/drive`,
    /** Command results. NOT retained. */
    respDrive: `${base}/resp/drive`,

    /**
     * OUTBOUND, and the one topic rip-deck publishes as a request
     * rather than a state: "the operator pressed Open while the
     * tower was off — turn it on."  A small Home Assistant
     * automation subscribes and drives
     * `switch.optical_ripper_power_control_power`
     * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md)).
     * NOT retained — it is a momentary request, not a state, and a
     * retained "on" replayed on HA restart would power the tower on
     * unbidden.
     *
     * The payload is the bare word **`on`** or **`off`** — `off`
     * added 2026-07-30 for the dashboard's Tower-off button
     * ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)).
     * ⚠️ An automation subscribing to this topic MUST branch on the
     * payload. One that assumes `on` — as the first version of
     * `automation.control_optical_ripper_tower` did, because `on`
     * was the only word — turns the tower ON when asked to switch
     * it off.
     */
    cmdPower: `${base}/cmd/power`,

    discoveryConfig: (
      component: string,
      objectId: string,
    ) =>
      `${config.discoveryPrefix}/${component}/` +
      `${config.nodeId}/${objectId}/config`,
  }
}

/** MQTT-safe slug for a drive, from its stable id. */
export const driveSlug = (driveId: string): string =>
  driveId.toLowerCase().replace(/[^a-z0-9]+/g, "_")
