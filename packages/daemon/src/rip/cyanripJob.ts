import { spawn } from "node:child_process"
import {
  EMPTY_PROGRESS,
  type JobProgress,
} from "@rip-deck/contracts"
import {
  buildCyanripKillArgs,
  type CyanripCommand,
} from "./cyanripCommand.ts"
import {
  countLine,
  createHeartbeat,
  ensureStateDir,
  flushHeartbeat,
} from "./heartbeat.ts"
import {
  type assessLiveness,
  type Liveness,
  startLivenessWatchdog,
} from "./liveness.ts"
import { TERMINATION_GRACE_MS } from "./ripJob.ts"

/**
 * One cyanrip run, supervised the way a MakeMKV rip is.
 *
 * The audio-CD twin of `runRipJob`. Until this existed the CD
 * path was a bare spawn: no progress, no heartbeat, and no
 * watchdog, so a drive wedged on a scratched CD held its bay
 * until somebody noticed and pressed Cancel. It now gets the
 * same three things the video path has:
 *
 *  - **Progress** parsed from cyanrip's own status line (see
 *    `parseCyanripProgress`), handed to the bay as a
 *    `JobProgress` so the card shows a real bar.
 *  - **A heartbeat file** in the state directory, through the
 *    same `countLine`/`flushHeartbeat` pair the video path uses.
 *  - **The liveness watchdog** from `liveness.ts`, with the same
 *    thresholds. Abandoning stops cyanrip with SIGTERM, then
 *    SIGKILL after `TERMINATION_GRACE_MS`, through the wrapper
 *    as well when there is one.
 *
 * ## Why "silence" is measured on chunks, and what that costs
 *
 * cyanrip writes its status with `printf` to a pipe, so libc
 * buffers it in 4 KiB blocks. A status segment is about 75
 * bytes and cyanrip writes one per CD frame, so a block arrives
 * every ~55 frames. A drive reading at even 1 frame per second
 * still delivers a block inside a minute, under the 90-second
 * silence threshold. A drive slower than that is the case the
 * threshold exists for, and "Keep trying" still suppresses the
 * abandon exactly as it does for MakeMKV.
 */

export type CyanripTermination =
  | "exited"
  | "cancelled_by_operator"
  | "stall_timeout"

export type CyanripProcessResult = {
  exitCode: number | null
  outputTail: string
  /**
   * Who ended the run. `exited` means cyanrip stopped by itself,
   * whatever its exit code says.
   */
  termination: CyanripTermination
  /** The watchdog's sentence, when it abandoned the rip. */
  stallReason: string | null
  /** The last progress the run reported. */
  progress: JobProgress
}

/** One parsed cyanrip status segment. */
export type CyanripProgressLine = {
  trackNumber: number
  /** 0..1 for this track. */
  trackFraction: number
  /** cyanrip's whole-disc ETA, or null when it gave none. */
  etaSeconds: number | null
}

/**
 * cyanrip 0.9.3's status segment, from `cyanrip_main.c`:
 *
 *     Ripping and encoding track 3, progress - 45.23%, ETA - 4m
 *
 * "and encoding" is absent in its multi-pass mode, which Rip
 * Deck does not use but which costs nothing to accept. The ETA
 * is `%ih %im`, `%im`, or `%llds`, and covers the whole disc.
 * An `, errors - N` suffix follows when the track has had read
 * errors.
 */
const PROGRESS_PATTERN =
  /Ripping (?:and encoding )?track (\d+), progress - (\d+(?:\.\d+)?)%(?:, ETA - (?:(\d+)h )?(?:(\d+)m|(\d+)s))?/

/** cyanrip prints this once, before any audio is read. */
const TRACK_COUNT_PATTERN = /^Disc tracks:\s+(\d+)/

export const parseCyanripProgress = (
  segment: string,
): CyanripProgressLine | null => {
  const match = PROGRESS_PATTERN.exec(segment)

  if (match === null) return null

  const [, track, percent, hours, minutes, seconds] = match

  const etaSeconds =
    seconds !== undefined
      ? Number(seconds)
      : minutes !== undefined
        ? Number(hours ?? 0) * 3600 + Number(minutes) * 60
        : null

  return {
    trackNumber: Number(track),
    trackFraction: Math.min(
      Math.max(Number(percent) / 100, 0),
      1,
    ),
    etaSeconds,
  }
}

export const parseCyanripTrackCount = (
  segment: string,
): number | null => {
  const match = TRACK_COUNT_PATTERN.exec(segment.trim())

  return match === null ? null : Number(match[1])
}

/**
 * The progress fold for one cyanrip run. Pure, and takes the
 * clock as an argument, like `progress.ts`.
 */
export type CyanripProgressState = {
  progress: JobProgress
  trackCount: number | null
  /** Distinct tracks seen before the current one. */
  finishedTrackCount: number
  currentTrackNumber: number | null
  currentTrackFraction: number
  /**
   * When the position last ADVANCED. A repeated status segment
   * is not progress, for the same reason a repeated PRGV is not.
   */
  lastForwardProgressAtMs: number
  /** When any output last arrived. */
  lastEventAtMs: number
}

export const createCyanripProgressState = (
  startedAtMs: number,
): CyanripProgressState => ({
  progress: {
    ...EMPTY_PROGRESS,
    totalLabel: "Ripping the audio CD",
  },
  trackCount: null,
  finishedTrackCount: 0,
  currentTrackNumber: null,
  currentTrackFraction: 0,
  lastForwardProgressAtMs: startedAtMs,
  lastEventAtMs: startedAtMs,
})

/** Record that output arrived, whether or not it parsed. */
export const observeCyanripOutput = (
  state: CyanripProgressState,
  atMs: number,
): CyanripProgressState => ({
  ...state,
  lastEventAtMs: atMs,
})

export const observeCyanripSegment = (input: {
  state: CyanripProgressState
  segment: string
  atMs: number
}): CyanripProgressState => {
  const { state, segment, atMs } = input

  const trackCount = parseCyanripTrackCount(segment)

  if (trackCount !== null) {
    return {
      ...state,
      trackCount,
      progress: {
        ...state.progress,
        fileCount: trackCount,
      },
    }
  }

  const line = parseCyanripProgress(segment)

  if (line === null) return state

  const isNewTrack =
    state.currentTrackNumber !== null &&
    line.trackNumber !== state.currentTrackNumber

  const finishedTrackCount =
    state.finishedTrackCount + (isNewTrack ? 1 : 0)

  const isForward =
    state.currentTrackNumber === null ||
    isNewTrack ||
    line.trackFraction > state.currentTrackFraction

  const totalFraction =
    state.trackCount === null || state.trackCount <= 0
      ? line.trackFraction
      : Math.min(
          (finishedTrackCount + line.trackFraction) /
            state.trackCount,
          1,
        )

  return {
    ...state,
    finishedTrackCount,
    currentTrackNumber: line.trackNumber,
    currentTrackFraction: line.trackFraction,
    lastForwardProgressAtMs: isForward
      ? atMs
      : state.lastForwardProgressAtMs,
    progress: {
      ...state.progress,
      totalFraction,
      currentFraction: line.trackFraction,
      currentLabel: `Ripping track ${String(line.trackNumber)}`,
      fileIndex: finishedTrackCount + 1,
      etaSeconds: line.etaSeconds,
    },
  }
}

/**
 * Split cyanrip output into status segments.
 *
 * cyanrip redraws its status line with a bare `\r`, so a
 * newline-only split would see one enormous line per track.
 * Returns the complete segments and the unfinished remainder.
 */
export const splitCyanripSegments = (
  text: string,
): { segments: string[]; rest: string } => {
  const parts = text.split(/\r\n|\r|\n/)
  const rest = parts.pop() ?? ""

  return {
    segments: parts.filter((part) => part.trim() !== ""),
    rest,
  }
}

/** Bounded, so a runaway status line cannot grow without end. */
const MAX_PENDING_SEGMENT_CHARS = 4096

const OUTPUT_TAIL_CHARS = 16384

export const runCyanripJob = async (input: {
  invocation: {
    command: string
    args: string[]
    cwd: string
  }
  cyanrip: CyanripCommand
  devPath: string
  jobUuid: string
  stateDir: string
  signal: AbortSignal
  log: { write: (line: string) => void }
  isKeepTryingRequested?: () => boolean
  onProgress?: (progress: JobProgress) => void
  onLiveness?: (liveness: Liveness) => void
  /** Tests only. See `startLivenessWatchdog`. */
  watchdog?: {
    assess?: typeof assessLiveness
    intervalMs?: number
  }
}): Promise<CyanripProcessResult> => {
  // BEFORE the abort check, not after it: an abort that arrives
  // during this await would otherwise be missed, because the
  // listener below is not attached yet, and cyanrip would start
  // against a signal that has already fired.
  await ensureStateDir(input.stateDir)

  const startedAtMs = Date.now()
  let state = createCyanripProgressState(startedAtMs)

  if (input.signal.aborted) {
    return {
      exitCode: null,
      outputTail: "Cancelled before start",
      termination: "cancelled_by_operator",
      stallReason: null,
      progress: state.progress,
    }
  }

  let heartbeat = createHeartbeat({
    stateDir: input.stateDir,
    jobUuid: input.jobUuid,
  })
  let outputTail = ""
  let pending = ""
  let termination: CyanripTermination = "exited"
  let stallReason: string | null = null

  const child = spawn(
    input.invocation.command,
    input.invocation.args,
    {
      cwd: input.invocation.cwd,
      // stdin CLOSED, matching `ripJob`: a ripper that decides to
      // ask a question must fail fast rather than sit holding the
      // drive forever.
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const capture = (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    const atMs = Date.now()

    input.log.write(text)
    outputTail = (outputTail + text).slice(
      -OUTPUT_TAIL_CHARS,
    )

    state = observeCyanripOutput(state, atMs)

    const split = splitCyanripSegments(pending + text)
    pending = split.rest.slice(-MAX_PENDING_SEGMENT_CHARS)

    const previousProgress = state.progress

    for (const segment of split.segments) {
      state = observeCyanripSegment({
        state,
        segment,
        atMs,
      })

      const counted = countLine({ heartbeat, atMs })
      heartbeat = counted.heartbeat

      if (counted.isFlushDue) {
        // Never let a diagnostic write abort a running rip.
        void flushHeartbeat(heartbeat, atMs).catch(() => {})
      }
    }

    if (state.progress !== previousProgress) {
      input.onProgress?.(state.progress)
    }
  }

  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)

  let isStopping = false

  const signalCyanrip = (signal: "TERM" | "KILL") => {
    child.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL")

    // A wrapper (`docker exec …`, `ssh … cyanrip`) does not
    // forward signals, so killing our handle would leave a
    // cyanrip inside the container still holding the drive.
    // Measured for the makemkvcon twin on Tower 2026-07-25.
    if (input.cyanrip.wrapperArgs === null) return

    try {
      spawn(
        input.cyanrip.command,
        buildCyanripKillArgs({
          wrapperArgs: input.cyanrip.wrapperArgs,
          devPath: input.devPath,
          signal,
        }),
        { stdio: "ignore" },
      ).on("error", () => {})
    } catch {
      // The outer signal has already gone; nothing else to do.
    }
  }

  /** Stop cyanrip once, attributing the real cause. */
  const stop = (reason: CyanripTermination) => {
    if (isStopping) return
    isStopping = true
    termination = reason

    signalCyanrip("TERM")

    // A cyanrip blocked in a device read will not answer
    // SIGTERM, and a cancel that does not land leaves the drive
    // held — so the escalation is not optional.
    const killTimer = setTimeout(() => {
      signalCyanrip("KILL")
      resolveEscalation()
    }, TERMINATION_GRACE_MS)
    killTimer.unref()

    // Without a wrapper, the child closing IS cyanrip exiting, so
    // there is nothing left to escalate. With one, the client can
    // exit on SIGTERM while cyanrip inside the container keeps
    // the drive, so the inner SIGKILL still has to be sent.
    if (input.cyanrip.wrapperArgs === null) {
      child.once("close", () => {
        clearTimeout(killTimer)
        resolveEscalation()
      })
    }
  }

  // Settled once a stop has done everything it can to the drive:
  // at once for a direct child, after the inner SIGKILL for a
  // wrapped one. A run nobody stopped never waits on it.
  let resolveEscalation = (): void => {}
  const escalation = new Promise<void>((resolve) => {
    resolveEscalation = resolve
  })

  const onAbort = () => stop("cancelled_by_operator")

  input.signal.addEventListener("abort", onAbort, {
    once: true,
  })

  const stopWatchdog = startLivenessWatchdog({
    startedAtMs,
    readActivity: () => ({
      lastForwardProgressAtMs:
        state.lastForwardProgressAtMs,
      lastEventAtMs: state.lastEventAtMs,
    }),
    isKeepTryingRequested: input.isKeepTryingRequested,
    onLiveness: input.onLiveness,
    onAbandon: (liveness) => {
      if (isStopping) return
      stallReason = liveness.reason
      stop("stall_timeout")
    },
    assess: input.watchdog?.assess,
    intervalMs: input.watchdog?.intervalMs,
  })

  try {
    const exitCode = await new Promise<number | null>(
      (resolve) => {
        child.once("error", (error) => {
          outputTail = error.message
          resolve(null)
        })
        child.once("close", (code) => resolve(code))
      },
    )

    // A stopped wrapped run is not over until the inner cyanrip
    // has been sent SIGKILL. Returning earlier would release the
    // bay, and a cancel would open the tray, while cyanrip could
    // still hold the drive.
    if (isStopping && input.cyanrip.wrapperArgs !== null) {
      await escalation
    }

    return {
      exitCode,
      outputTail,
      termination,
      stallReason,
      progress: state.progress,
    }
  } finally {
    stopWatchdog()
    input.signal.removeEventListener("abort", onAbort)
    await flushHeartbeat(heartbeat, Date.now()).catch(
      () => {},
    )
  }
}
