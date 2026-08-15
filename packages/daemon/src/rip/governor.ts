import { resolveRipIsolation } from "./ripCommand.ts"

/**
 * How many rips are allowed to run at once.
 *
 * The owner's requirement is the ceiling, not a target: *"I want
 * it to rip as many discs as I insert. If I insert 9 discs, start
 * 9 rips of the correct type."*
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md))
 *
 * So why a governor at all, if the answer is "all of them"?
 *
 *  - **The natural bound is one rip per drive**, and that bound
 *    has to be enforced somewhere rather than assumed. A bay whose
 *    state machine mis-steps must not be able to start a second
 *    `makemkvcon` against a device the first one is still reading;
 *    two writers on one drive is not a slow rip, it is two corrupt
 *    ones. `tryAcquire` therefore refuses a second lease for a
 *    driveId even when the global cap has room.
 *  - **The number has to be expressible without a code change.**
 *    Nine concurrent rips is nine `--cache=128` allocations plus
 *    nine containers on a host that is also a NAS (E4). If that
 *    turns out to be too much, the fix must be an environment
 *    variable on a running deployment, not a rebuild.
 *
 * ## The isolation clamp, which is NOT negotiable by config
 *
 * `makemkvcon backup` ignores `--noscan` and re-enumerates the
 * whole USB bus before every rip, because a `disc:` source is
 * *defined* in terms of that enumeration (measured on hardware
 * 2026-07-25). Nine concurrent unisolated rips are therefore
 * eighty-one device probes contending over one 10-port hub behind
 * one long extension cable — the exact hardware that produced the
 * original 17-minute "Scanning CD-ROM devices" hang at 0% CPU.
 *
 * `AGENTS.md` states the consequence as a hard constraint: per-rip
 * device isolation "is the prerequisite that closes that, and it
 * is not optional before nine-way operation". So when
 * `RIP_DECK_RIP_ISOLATION_IMAGE` is unset, the cap is clamped to
 * one **regardless of what the environment asks for**. A hard
 * constraint that an environment variable can switch off is not a
 * constraint.
 *
 * The clamp is deliberately not a refusal to run: absence of
 * isolation config means "no isolation", never "misconfigured",
 * and a deployment that cannot reach a container runtime must keep
 * ripping the way Stage 3 did.
 */

export const GOVERNOR_TUNING = {
  /**
   * Nine, because the tower has nine bays and a bay runs at most
   * one rip. This is the owner's stated number and also the only
   * number that cannot be a bottleneck.
   */
  defaultMaxConcurrentRips: 9,

  /**
   * What the cap becomes when rips are not device-isolated.
   *
   * One, not two: the whole reason for the clamp is that every
   * unisolated rip scans the whole bus, and two simultaneous scans
   * is already the failure mode, just smaller.
   */
  unisolatedMaxConcurrentRips: 1,
} as const

/**
 * Parse the operator's cap.
 *
 * A typo must not silently become zero — a cap of zero is a
 * daemon that watches nine discs and rips none of them, forever,
 * with no error anywhere. Same reasoning as `parseId` in
 * `destination.ts`, where the same class of typo would have meant
 * chowning output to root.
 */
export const parseMaxConcurrentRips = (
  raw: string | undefined,
): number | null => {
  if (raw === undefined || raw.trim() === "") return null

  const parsed = Number.parseInt(raw, 10)

  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : null
}

export type RipConcurrency = {
  maxConcurrentRips: number
  /** What the environment asked for, before any clamp. */
  requestedMaxConcurrentRips: number
  isIsolationConfigured: boolean
  /**
   * Why the requested number was not honoured, in words meant for
   * the console — or null when it was.
   */
  clampReason: string | null
}

/**
 * Decide this deployment's concurrency, and say why.
 *
 * Returns the reason rather than logging it, because a silent
 * clamp is the worst of the three outcomes available here: the
 * owner asks for nine, gets one, and has nothing to read that
 * explains the difference.
 */
export const resolveRipConcurrency = (
  env: Record<string, string | undefined>,
): RipConcurrency => {
  const requestedMaxConcurrentRips =
    parseMaxConcurrentRips(
      env.RIP_DECK_MAX_CONCURRENT_RIPS,
    ) ?? GOVERNOR_TUNING.defaultMaxConcurrentRips

  const isIsolationConfigured =
    resolveRipIsolation(env) !== null

  if (isIsolationConfigured) {
    return {
      maxConcurrentRips: requestedMaxConcurrentRips,
      requestedMaxConcurrentRips,
      isIsolationConfigured,
      clampReason: null,
    }
  }

  const clamped = Math.min(
    requestedMaxConcurrentRips,
    GOVERNOR_TUNING.unisolatedMaxConcurrentRips,
  )

  return {
    maxConcurrentRips: clamped,
    requestedMaxConcurrentRips,
    isIsolationConfigured,
    clampReason:
      clamped === requestedMaxConcurrentRips
        ? null
        : `Rips are not device-isolated ` +
          `(RIP_DECK_RIP_ISOLATION_IMAGE is unset), so the ` +
          `concurrency cap is held at ${clamped} instead of ` +
          `${requestedMaxConcurrentRips}. Every unisolated rip ` +
          `re-scans the whole USB bus before it reads a byte, ` +
          `and concurrent scans of this tower are what produced ` +
          `the 17-minute hang at 0% CPU. Set the isolation ` +
          `image to get the full cap back.`,
  }
}

export type Governor = {
  /**
   * Claim the one lease this drive is allowed, if there is room.
   *
   * False means "not now" and never "not ever" — the caller holds
   * its disc and asks again on the next poll.
   */
  tryAcquire: (input: { driveId: string }) => boolean
  /** Idempotent: releasing a lease nobody holds is a no-op. */
  release: (input: { driveId: string }) => void
  hasCapacity: () => boolean
  getActiveCount: () => number
  /** Stable order, for a status line that does not jitter. */
  getActiveDriveIds: () => string[]
  maxConcurrentRips: number
}

/**
 * Leases, keyed on stable drive identity.
 *
 * **Never on `/dev/srN`.** It reshuffles on every USB
 * re-enumeration, so a lease keyed on it would be released
 * against a different bay than the one that took it — and a
 * misattributed lease means two rips on one drive, which is the
 * exact thing this exists to make impossible.
 */
export const createGovernor = (input: {
  maxConcurrentRips: number
}): Governor => {
  const activeDriveIds = new Set<string>()

  // Clamped rather than trusted: a cap below one is a daemon that
  // never rips anything, and the caller that produced it is
  // already wrong somewhere upstream.
  const maxConcurrentRips = Math.max(
    1,
    Math.floor(input.maxConcurrentRips),
  )

  return {
    maxConcurrentRips,

    tryAcquire: ({ driveId }) => {
      if (activeDriveIds.has(driveId)) return false
      if (activeDriveIds.size >= maxConcurrentRips) {
        return false
      }

      activeDriveIds.add(driveId)
      return true
    },

    release: ({ driveId }) => {
      activeDriveIds.delete(driveId)
    },

    hasCapacity: () =>
      activeDriveIds.size < maxConcurrentRips,

    getActiveCount: () => activeDriveIds.size,

    getActiveDriveIds: () => [...activeDriveIds].sort(),
  }
}
