import type { BayState } from "../rip/watcher.ts"

/**
 * "Is the tower doing anything?", published retained to
 * `<base>/activity`.
 *
 * This topic exists for exactly one consumer: the Home Assistant
 * automation that powers the tower off once it has been idle for
 * a while. That makes it a safety input, not a dashboard field,
 * and every choice below follows from one rule — **unknown is
 * not idle**.
 *
 * ## Why it is not simply "are any trays closed"
 *
 * The owner's first phrasing was *"if no rips or drive changes in
 * X time, **or all drives closed now**, then shut off tower"*.
 * The second half cannot be built: rip-deck NEVER ejects (B3), so
 * every tray is closed during every rip. Measured on the live
 * tower 2026-07-26 — nine trays closed, three discs mid-copy — a
 * "all drives closed" rule would have cut power to three running
 * rips. Only the first half is implemented, and it is expressed
 * as work in progress rather than as door positions.
 *
 * ## What makes it fail closed
 *
 *  - The payload is **derived from bays, not from an absence of
 *    news.** A daemon that has stopped polling stops publishing,
 *    and the LWT flips `<base>/availability` to `offline`, which
 *    takes every discovered entity `unavailable`. Unavailable is
 *    not idle.
 *  - It is **republished on a heartbeat even when nothing
 *    changes**, so a subscriber can tell "idle and healthy" from
 *    "the publisher went away" by looking at how long ago the
 *    last message arrived.
 *  - `last_activity_at` starts at **now** on the first fold. A
 *    daemon that has just restarted knows nothing about the
 *    minutes before it, so it claims the idle clock rather than
 *    inheriting a zero that would read as "idle since 1970".
 */

export const ACTIVITY_TUNING = {
  /**
   * How often bays are re-read and, if anything moved, published.
   *
   * The watcher's own poll interval. Sampling faster than the
   * thing being sampled buys nothing.
   */
  sweepIntervalMs: 5_000,

  /**
   * Republish even when nothing changed, at least this often.
   *
   * This is what makes staleness detectable downstream: a
   * consumer that has not heard from us in several heartbeats
   * knows the silence is ours, not the tower's. Matched to the
   * availability heartbeat in `client.ts` on purpose — two clocks
   * for the same "are we alive" question would eventually
   * disagree.
   */
  heartbeatMs: 60_000,
} as const

/** Bay phases in which a ripper is, or is about to be, running. */
const ACTIVE_BAY_PHASES = new Set(["starting", "ripping"])

export type ActivitySnapshot = {
  activeRipCount: number
  driveCount: number
  /**
   * Every bay's identity, phase and disc fingerprint, as one
   * string.
   *
   * A disc going in or coming out changes it; a bay starting or
   * finishing a rip changes it; a drive appearing changes it.
   * Comparing two of these is the whole "has anything happened"
   * test, and it is a string rather than a deep compare so the
   * memory below can stay a plain value.
   */
  driveSignature: string
}

export const summariseBayActivity = (
  bays: readonly BayState[],
): ActivitySnapshot => ({
  activeRipCount: bays.filter((bay) =>
    ACTIVE_BAY_PHASES.has(bay.phase),
  ).length,

  driveCount: bays.length,

  driveSignature: bays
    .map(
      (bay) =>
        `${bay.driveId}:${bay.phase}:` +
        `${bay.sizeSectors ?? "-"}`,
    )
    .sort()
    .join("|"),
})

/**
 * What the publisher remembers between sweeps.
 *
 * Deliberately a value rather than a class: the whole
 * "has it been quiet long enough" question is then a pure
 * function of this plus one reading plus a clock, which is the
 * only way to test a two-hour idle window in a millisecond.
 */
export type ActivityMemory = {
  snapshot: ActivitySnapshot | null
  /** Epoch ms of the last rip or drive-set change. */
  lastActivityAtMs: number
  lastPublishedAtMs: number | null
}

export const createActivityMemory = (input: {
  nowMs: number
}): ActivityMemory => ({
  snapshot: null,
  // See the header: a fresh daemon claims the clock rather than
  // inheriting an idle window it was not present for.
  lastActivityAtMs: input.nowMs,
  lastPublishedAtMs: null,
})

export const foldActivity = (input: {
  memory: ActivityMemory
  snapshot: ActivitySnapshot
  nowMs: number
  heartbeatMs?: number
}): { memory: ActivityMemory; isPublishDue: boolean } => {
  const {
    memory,
    snapshot,
    nowMs,
    heartbeatMs = ACTIVITY_TUNING.heartbeatMs,
  } = input

  const hasChanged =
    memory.snapshot === null ||
    memory.snapshot.driveSignature !==
      snapshot.driveSignature

  // A long rip changes nothing in the signature for an hour at a
  // time, so "in progress" has to count as activity in its own
  // right. Without this, an hour into a nine-disc load the tower
  // would look idle and get powered off mid-copy.
  const isActive = snapshot.activeRipCount > 0

  const isPublishDue =
    hasChanged ||
    memory.lastPublishedAtMs === null ||
    nowMs - memory.lastPublishedAtMs >= heartbeatMs

  return {
    memory: {
      snapshot,
      lastActivityAtMs:
        hasChanged || isActive
          ? nowMs
          : memory.lastActivityAtMs,
      lastPublishedAtMs: isPublishDue
        ? nowMs
        : memory.lastPublishedAtMs,
    },
    isPublishDue,
  }
}

/**
 * The retained payload.
 *
 * snake_case to match `rip/event` and `drive/<slug>` — one house
 * style across every topic, so an automation author never has to
 * remember which one uses which.
 */
export type ActivityPayload = {
  active_rip_count: number
  drive_count: number
  is_idle: boolean
  /** Epoch ms of the last rip or drive-set change. */
  last_activity_at: number
  /** Epoch ms of this message, so a stale card is visibly stale. */
  updated_at: number
}

export const buildActivityPayload = (input: {
  snapshot: ActivitySnapshot
  memory: ActivityMemory
  nowMs: number
}): ActivityPayload => ({
  active_rip_count: input.snapshot.activeRipCount,
  drive_count: input.snapshot.driveCount,
  is_idle: input.snapshot.activeRipCount === 0,
  last_activity_at: input.memory.lastActivityAtMs,
  updated_at: input.nowMs,
})
