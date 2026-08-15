/**
 * Child-process supervision policy.
 *
 * One child process owns one drive. If it dies, the parent
 * restarts it — a crashed child is a bug in us, not a verdict
 * on the disc, and eight healthy drives must not be punished
 * for it.
 *
 * But an unbounded restart loop is worse than a dead drive: it
 * hides the fault, burns CPU, and can thrash a sick drive's
 * hardware. So restarts are bounded, and on exhaustion the
 * drive is QUARANTINED — taken out of service and left there
 * until a human explicitly clears it from the web UI.
 *
 * Quarantine is deliberately not self-healing. An automatic
 * un-quarantine after a cooling-off period would re-enter the
 * same crash loop later, at night, with nobody watching. The
 * owner clearing it is the signal that something was actually
 * looked at.
 */

export const SUPERVISION = {
  /** Restart attempts before quarantining the drive. */
  maxRestarts: 3,

  /**
   * A child that survives this long is considered healthy, and
   * its restart counter resets.
   *
   * Without this, a drive that crashes once a week would
   * quarantine itself after three weeks for no good reason.
   * The window has to exceed a plausible rip so that a crash
   * late in a long job still counts as "it was working".
   */
  healthyUptimeMs: 15 * 60 * 1000,

  /**
   * Backoff between restarts. Escalating, because an immediate
   * retry of a child that died on a wedged device just wedges
   * the replacement too.
   */
  restartBackoffMs: [2_000, 10_000, 30_000],
} as const

export type DriveSupervisionState = {
  driveId: string
  /** Restarts since the last healthy run. */
  restartCount: number
  /** Epoch ms the current child started, or null if none. */
  startedAt: number | null
  isQuarantined: boolean
  /** Why it was quarantined, for the UI. */
  quarantineReason: string | null
}

export const createSupervisionState = (
  driveId: string,
): DriveSupervisionState => ({
  driveId,
  restartCount: 0,
  startedAt: null,
  isQuarantined: false,
  quarantineReason: null,
})

export type SupervisionDecision =
  | { action: "restart"; delayMs: number; attempt: number }
  | { action: "quarantine"; reason: string }
  | { action: "ignore"; reason: string }

/**
 * Decide what to do about a child that just exited.
 *
 * `exitedAt` and `wasDeliberate` are passed in rather than
 * read from a clock or a global, so this stays a pure function
 * and the whole policy is testable without spawning anything.
 */
export const decideOnChildExit = (input: {
  state: DriveSupervisionState
  exitedAt: number
  /** True when WE killed it — a cancel, a shutdown, a reap. */
  wasDeliberate: boolean
}): SupervisionDecision => {
  const { state, exitedAt, wasDeliberate } = input

  if (wasDeliberate) {
    return {
      action: "ignore",
      reason: "child exited because we asked it to",
    }
  }

  if (state.isQuarantined) {
    return {
      action: "ignore",
      reason:
        "drive is quarantined pending manual clearance",
    }
  }

  // A child that ran long enough to be considered healthy earns
  // a clean slate, so unrelated crashes weeks apart never
  // accumulate into a quarantine.
  const uptimeMs =
    state.startedAt === null
      ? 0
      : exitedAt - state.startedAt

  const attempt =
    uptimeMs >= SUPERVISION.healthyUptimeMs
      ? 1
      : state.restartCount + 1

  if (attempt > SUPERVISION.maxRestarts) {
    return {
      action: "quarantine",
      reason:
        `Crashed ${SUPERVISION.maxRestarts} times without ` +
        "staying up. Taken out of service — clear it from the " +
        "UI once the drive has been looked at.",
    }
  }

  const backoff = SUPERVISION.restartBackoffMs
  const delayMs =
    backoff[Math.min(attempt - 1, backoff.length - 1)]

  return { action: "restart", delayMs, attempt }
}

/** Fold a decision back into the drive's supervision state. */
export const applySupervisionDecision = (
  state: DriveSupervisionState,
  decision: SupervisionDecision,
): DriveSupervisionState => {
  switch (decision.action) {
    case "restart":
      return {
        ...state,
        restartCount: decision.attempt,
        startedAt: null,
      }

    case "quarantine":
      return {
        ...state,
        isQuarantined: true,
        quarantineReason: decision.reason,
        startedAt: null,
      }

    case "ignore":
      return state
  }
}

/**
 * Manual clearance from the web UI (or MQTT `cmd/drive`).
 *
 * The only way out of quarantine, by design.
 */
export const clearQuarantine = (
  state: DriveSupervisionState,
): DriveSupervisionState => ({
  ...state,
  restartCount: 0,
  isQuarantined: false,
  quarantineReason: null,
})
