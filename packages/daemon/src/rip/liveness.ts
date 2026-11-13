import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"

/**
 * Is this rip working, struggling, or gone?
 *
 * Requirement D3: detect a stall on WALL CLOCK, independent of
 * error messages. This matters because the `sr` layer retries a
 * failing read long before MakeMKV's own error counter moves —
 * so a disc can occupy a drive for forty minutes emitting
 * nothing at all while every error-based check reports health.
 *
 * Three states that look identical from outside are separated
 * here by two timestamps:
 *
 *  - stdout silent            -> the process is wedged in the
 *                                kernel. *Dead.*
 *  - output, no forward PRGV  -> makemkvcon is alive and
 *                                retrying. *Hung.*
 *  - forward PRGV, low rate   -> *Slow but working*, which is a
 *                                normal thing for a pressing to
 *                                be and must not be killed.
 *
 * Pure, and takes the clock as an argument, so the whole
 * timeline is testable without waiting for it.
 */

export type LivenessKind =
  | "starting"
  | "working"
  | "hung"
  | "silent"

export type LivenessAction =
  | "continue"
  | "alert"
  | "abandon"

export type Liveness = {
  kind: LivenessKind
  action: LivenessAction
  msSinceProgress: number
  msSinceEvent: number
  /** Plain language, written to be read on a phone. */
  reason: string
}

export const assessLiveness = (input: {
  startedAtMs: number
  lastForwardProgressAtMs: number
  lastEventAtMs: number
  nowMs: number
  /**
   * The operator answered "keep trying" (D4).
   *
   * Suppresses abandonment only. The alert still fires, because
   * silencing the signal as well would leave a struggling bay
   * invisible for the rest of a three-hour rip.
   */
  isKeepTryingRequested: boolean
}): Liveness => {
  const {
    startedAtMs,
    lastForwardProgressAtMs,
    lastEventAtMs,
    nowMs,
    isKeepTryingRequested,
  } = input

  const msSinceProgress = nowMs - lastForwardProgressAtMs
  const msSinceEvent = nowMs - lastEventAtMs
  const msSinceStart = nowMs - startedAtMs

  const {
    stallGraceMs,
    stallTimeoutMs,
    stallKillMs,
    silenceTimeoutMs,
  } = HEALTH_THRESHOLDS

  const at = (
    kind: LivenessKind,
    action: LivenessAction,
    reason: string,
  ): Liveness => ({
    kind,
    action,
    msSinceProgress,
    msSinceEvent,
    reason,
  })

  // The head of a rip is the AACS handshake and the BD+ pass.
  // Both are slow and neither emits forward progress, so judging
  // liveness here would fail every rip in its first minutes.
  if (msSinceStart < stallGraceMs) {
    return at(
      "starting",
      "continue",
      "Starting up — handshaking with the disc.",
    )
  }

  // Total silence is not slowness. makemkvcon emits progress
  // several times a second while it is doing anything at all, so
  // a silent pipe means a thread blocked in the kernel on a
  // device that is not answering.
  if (msSinceEvent > silenceTimeoutMs) {
    return at(
      "silent",
      isKeepTryingRequested ? "alert" : "abandon",
      `No output at all for ${seconds(msSinceEvent)}. The ` +
        "process is stuck waiting on the drive, not reading " +
        "slowly.",
    )
  }

  if (msSinceProgress > stallTimeoutMs) {
    const isPastKill = msSinceProgress > stallKillMs

    return at(
      "hung",
      isPastKill && !isKeepTryingRequested
        ? "abandon"
        : "alert",
      `Still running but no forward progress for ` +
        `${seconds(msSinceProgress)}. The drive is retrying ` +
        "below the level where errors get reported — usually " +
        "surface contamination.",
    )
  }

  return at("working", "continue", "Reading normally.")
}

const seconds = (ms: number): string =>
  `${Math.round(ms / 1000)}s`

/** How often a running rip's liveness is re-assessed. */
export const LIVENESS_INTERVAL_MS = 5_000

/** The two timestamps `assessLiveness` judges a rip by. */
export type LivenessActivity = {
  lastForwardProgressAtMs: number
  lastEventAtMs: number
}

/**
 * The wall-clock watchdog every ripper runs under.
 *
 * Shared by the MakeMKV path (`runRipJob`) and the audio-CD path
 * (`runCyanripJob`), so a stalled drive is judged by the same
 * thresholds whichever tool is reading it. The ripper owns its
 * own parsing and supplies the two timestamps through
 * `readActivity`, a pull closure, so the watchdog never needs to
 * know what the tool prints.
 *
 * `onAbandon` is called on every tick that says "abandon". The
 * caller's stop function must therefore be idempotent, which both
 * rippers' already are.
 *
 * `assess` and `intervalMs` exist for tests only: the real
 * thresholds are minutes long, and a test that waited for them
 * would never be run.
 *
 * Returns the function that stops the watchdog.
 */
export const startLivenessWatchdog = (input: {
  startedAtMs: number
  readActivity: () => LivenessActivity
  isKeepTryingRequested?: () => boolean
  onLiveness?: (liveness: Liveness) => void
  onAbandon: (liveness: Liveness) => void
  assess?: typeof assessLiveness
  intervalMs?: number
}): (() => void) => {
  const assess = input.assess ?? assessLiveness

  const timer = setInterval(() => {
    const liveness = assess({
      startedAtMs: input.startedAtMs,
      ...input.readActivity(),
      nowMs: Date.now(),
      isKeepTryingRequested:
        input.isKeepTryingRequested?.() ?? false,
    })

    input.onLiveness?.(liveness)

    if (liveness.action === "abandon") {
      input.onAbandon(liveness)
    }
  }, input.intervalMs ?? LIVENESS_INTERVAL_MS)

  // Never the reason a finished CLI rip fails to exit.
  timer.unref()

  return () => clearInterval(timer)
}
