import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"

/**
 * Is the USB bus flapping? — measured from drive presence alone.
 *
 * The Tower tower hangs nine drives off one long active USB
 * extension into a single 10-port hub. Its known single point of
 * failure is that extension's aux power: run undervolted (a
 * passive extension, or two cables joined) the whole bank
 * re-enumerates in bursts — `dmesg` shows `error -71` "device not
 * accepting address" and a cascade of disconnect/reconnect. While
 * that is happening a drive cannot be read reliably: `identifyDisc`
 * misses the label, a rip loses its device mid-stream, and
 * `/dev/srN` reshuffles under everything.
 *
 * The watcher already reads drive PRESENCE every poll — a drive is
 * either in the probe or it is not — so a flap is visible here
 * without touching a device: a drive whose presence keeps flipping
 * present↔absent is a drive on a bus that keeps dropping. This
 * turns that raw signal into one bus-wide yes/no the dashboard can
 * warn on, so the owner is told "change your USB connection"
 * instead of chasing nine phantom "could not read a name" holds.
 *
 * ## Why a flap is not a power cycle
 *
 * The owner powers the tower independently of this service (F3), so
 * a clean power-off then power-on is normal and must NOT alarm.
 * That looks like ONE present→absent edge per drive, then ONE
 * absent→present edge later — two edges, spread apart. Flapping is
 * the SAME drive crossing back and forth repeatedly, so the
 * threshold is a per-drive edge COUNT within a window
 * (`flapMinEvents`, the same number the health engine uses for a
 * single drive's re-enumeration): a power cycle stays under it, a
 * bus that keeps dropping runs straight past it.
 *
 * Pure over its inputs on purpose — the transient it exists for is
 * un-reproducible hardware, so the whole policy is unit-testable
 * without a drive, the same bargain `decideBayAction` makes.
 */

/** One present↔absent flip of one drive, stamped when it was seen. */
export type UsbTransition = {
  driveId: string
  atMs: number
}

export type UsbStability = {
  /** At least one drive has flapped past the threshold. */
  isUnstable: boolean
  /** The drives seen flapping in the window. */
  flappingDriveIds: string[]
  /** Every present↔absent edge still inside the window. */
  transitionCount: number
}

export const USB_STABILITY_TUNING = {
  /**
   * How far back edges are counted. Shared with the health
   * engine's `flapWindowMs` so "flapping" means the same span
   * whether it is measured per drive during a rip or bus-wide from
   * presence here.
   */
  windowMs: HEALTH_THRESHOLDS.flapWindowMs,
  /**
   * Edges by ONE drive in the window before it counts as flapping.
   * The health engine's `flapMinEvents`, for the same reason: two
   * edges are a power cycle, three or more are a drive that will
   * not stay on the bus.
   */
  flapMinEvents: HEALTH_THRESHOLDS.flapMinEvents,
} as const

export const STABLE_USB: UsbStability = {
  isUnstable: false,
  flappingDriveIds: [],
  transitionCount: 0,
}

/**
 * The present↔absent flips between two polls.
 *
 * Only a drive KNOWN to the previous poll can have transitioned:
 * a drive appearing for the first time (absent from `previous`) is
 * not a flap, it is a drive being discovered — which is why the
 * first poll, whose `previous` is empty, yields nothing and never
 * false-alarms on startup.
 */
export const detectTransitions = (input: {
  previous: Map<string, boolean>
  current: Map<string, boolean>
  atMs: number
}): UsbTransition[] => {
  const transitions: UsbTransition[] = []

  for (const [driveId, isPresent] of input.current) {
    const was = input.previous.get(driveId)
    if (was !== undefined && was !== isPresent) {
      transitions.push({ driveId, atMs: input.atMs })
    }
  }

  return transitions
}

/** Drop edges older than the window, so the buffer cannot grow forever. */
export const pruneTransitions = (input: {
  transitions: UsbTransition[]
  nowMs: number
  windowMs?: number
}): UsbTransition[] => {
  const cutoff =
    input.nowMs -
    (input.windowMs ?? USB_STABILITY_TUNING.windowMs)

  return input.transitions.filter(
    (transition) => transition.atMs >= cutoff,
  )
}

/**
 * Fold a window of edges into one bus-wide answer.
 *
 * A drive is flapping when it has `flapMinEvents` or more edges
 * inside the window; the bus is unstable when any drive is. The
 * count is reported too, so a card can say how bad it is without
 * re-deriving it.
 */
export const summariseUsbStability = (input: {
  transitions: UsbTransition[]
  nowMs: number
  windowMs?: number
  flapMinEvents?: number
}): UsbStability => {
  const windowMs =
    input.windowMs ?? USB_STABILITY_TUNING.windowMs
  const flapMinEvents =
    input.flapMinEvents ??
    USB_STABILITY_TUNING.flapMinEvents

  const recent = input.transitions.filter(
    (transition) =>
      transition.atMs >= input.nowMs - windowMs,
  )

  const countByDrive = new Map<string, number>()
  for (const transition of recent) {
    countByDrive.set(
      transition.driveId,
      (countByDrive.get(transition.driveId) ?? 0) + 1,
    )
  }

  const flappingDriveIds = [...countByDrive.entries()]
    .filter(([, count]) => count >= flapMinEvents)
    .map(([driveId]) => driveId)

  return {
    isUnstable: flappingDriveIds.length > 0,
    flappingDriveIds,
    transitionCount: recent.length,
  }
}
