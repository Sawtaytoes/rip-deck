import {
  EMPTY_PROGRESS,
  type JobProgress,
  type MakemkvEvent,
  MakemkvMsgCode,
} from "@rip-deck/contracts"

/**
 * Two-level progress, derived structurally from robot-mode
 * events rather than scraped from a log after the fact (C3).
 *
 * MakeMKV gives us both levels and the current viewer shows only
 * one, which is why it feels opaque: PRGC is the operation
 * running right now, PRGT is the whole backup, and PRGV carries
 * a value for each against a shared `max` (C5).
 *
 * The tracker is a pure fold — every function takes the clock as
 * an argument and returns new state. That is what lets a three
 * hour rip's worth of behaviour be tested in milliseconds, and
 * it keeps the parent process free of timers it would otherwise
 * have to own.
 */

/**
 * Tuning for the derived rate figures. These are guesses, like
 * everything else numeric in this project — but unlike the
 * health thresholds they only affect what a number looks like on
 * screen, never whether a job passes or fails.
 */
export const PROGRESS_TUNING = {
  /** Sliding window over which throughput is averaged. */
  throughputWindowMs: 30_000,
  /** How far back to look when judging the ETA trend. */
  etaTrendWindowMs: 60_000,
  /** ETA jitter below this is "steady", not a trend. */
  etaTrendToleranceSec: 15,
} as const

type RateSample = {
  atMs: number
  bytes: number
}

type EtaSample = {
  atMs: number
  etaSeconds: number
}

export type ProgressTracker = {
  progress: JobProgress
  /** Disc capacity, for turning fractions into bytes. */
  discBytes: number
  rateSamples: RateSample[]
  etaSamples: EtaSample[]
  /** Raw PRGV values, kept to detect forward motion exactly. */
  lastPrgvCurrent: number
  lastPrgvTotal: number
  /**
   * When PRGV last actually ADVANCED.
   *
   * Not "when we last saw a PRGV" — makemkvcon happily re-emits
   * the same value forever while the `sr` layer retries beneath
   * it, and treating that as liveness is exactly how a stall
   * goes unnoticed for 40 minutes (D3).
   */
  lastForwardProgressAtMs: number
  /**
   * When we last parsed ANY line.
   *
   * The pair of timestamps is what separates the three cases
   * that look identical from outside: silent stdout is dead,
   * events without forward progress is hung, and forward
   * progress below baseline is slow-but-working.
   */
  lastEventAtMs: number
  /** Titles completed, from MSG:3307 FILE_ADDED. */
  filesAdded: number
  /** Titles on the disc, from TCOUNT when it appears. */
  titleCount: number | null
}

export const createProgressTracker = (input: {
  discBytes: number
  startedAtMs: number
}): ProgressTracker => ({
  progress: EMPTY_PROGRESS,
  discBytes: input.discBytes,
  rateSamples: [],
  etaSamples: [],
  lastPrgvCurrent: 0,
  lastPrgvTotal: 0,
  lastForwardProgressAtMs: input.startedAtMs,
  lastEventAtMs: input.startedAtMs,
  filesAdded: 0,
  titleCount: null,
})

/**
 * Drop samples that have aged out of a window, but never drop
 * below two.
 *
 * The floor is load-bearing. PRGV arrives many times a second on
 * a healthy rip, so the window is normally full — but a
 * STRUGGLING drive emits it sparsely, and a plain window filter
 * would leave a single sample and report the rate as "unknown"
 * at exactly the moment the number matters most. Retaining the
 * previous sample means a crawl reads as a crawl rather than as
 * an absence of information.
 */
const withinWindow = <T extends { atMs: number }>(
  samples: T[],
  nowMs: number,
  windowMs: number,
): T[] => {
  const recent = samples.filter(
    (sample) => nowMs - sample.atMs <= windowMs,
  )

  return recent.length >= 2 ? recent : samples.slice(-2)
}

/**
 * Is this PRGT the same operation we were already tracking?
 *
 * MakeMKV re-emits the current PRGT periodically rather than
 * only on change, so treating every PRGT as a new operation
 * would clear the throughput window constantly and leave the
 * rate permanently "measuring…". The name is the only identity
 * a PRGT carries.
 */
const isSameOperation = (
  previousLabel: string | null,
  name: string,
): boolean => previousLabel === name

/**
 * Bytes/sec across the sliding window.
 *
 * Needs two samples genuinely separated in time; returning null
 * rather than a fabricated number matters, because a null
 * throughput renders as "measuring…" while a wrong one renders
 * as a confident lie and feeds the health baseline.
 */
const throughputFrom = (
  samples: RateSample[],
): number | null => {
  if (samples.length < 2) return null

  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsedMs = last.atMs - first.atMs

  if (elapsedMs <= 0) return null

  const deltaBytes = last.bytes - first.bytes
  if (deltaBytes <= 0) return null

  return (deltaBytes / elapsedMs) * 1000
}

/**
 * Judge the ETA trend (requirement C6).
 *
 * A rising ETA is an alarm, not a cosmetic annoyance: it is the
 * same d(progress)/dt collapse the health engine watches, seen
 * from the other end. Note what "steady" means here — during a
 * healthy rip the ETA should fall roughly one second per second,
 * so an ETA that merely holds still is already a slowdown, and
 * only a genuinely rising one is called out.
 */
const etaTrendFrom = (
  samples: EtaSample[],
): JobProgress["etaTrend"] => {
  if (samples.length < 2) return null

  const first = samples[0]
  const last = samples[samples.length - 1]
  const { etaTrendToleranceSec } = PROGRESS_TUNING

  if (
    last.etaSeconds >
    first.etaSeconds + etaTrendToleranceSec
  ) {
    return "rising"
  }

  if (
    last.etaSeconds <
    first.etaSeconds - etaTrendToleranceSec
  ) {
    return "falling"
  }

  return "steady"
}

/**
 * Fold one parsed event into the tracker.
 *
 * `atMs` is passed in rather than read from a clock so the whole
 * thing stays pure and a rip's timeline can be replayed exactly.
 */
export const observeEvent = (input: {
  tracker: ProgressTracker
  event: MakemkvEvent
  atMs: number
}): ProgressTracker => {
  const { tracker, event, atMs } = input
  const base = { ...tracker, lastEventAtMs: atMs }

  switch (event.type) {
    case "PRGT":
      // A new PRGT is a new operation, and its PRGV counter
      // restarts from zero. Everything derived from the old one
      // is now about a different thing entirely, so carrying it
      // across the boundary is not a smoothing choice — it is
      // comparing two unrelated series.
      //
      // Measured on the first real rip, 2026-07-25: a Blu-ray
      // runs "Scanning CD-ROM devices", "Decrypting" and
      // "Processing BD+ code" BEFORE "Copying file", and each of
      // those drives PRGV a full 0 -> max. So bytesWritten
      // climbed to the whole disc capacity, remaining bytes fell
      // to nearly zero, and the ETA with it — then the copy
      // stage reset PRGV and the ETA leapt from seconds to
      // hours. That is a genuine rise, and `etaTrend` correctly
      // reported "rising" for a full etaTrendWindowMs on a rip
      // that was perfectly healthy.
      //
      // Which makes it a false alarm on C6, and C6's whole value
      // is that a rising ETA means something is wrong. An alarm
      // that fires at the head of every single rip is one the
      // owner learns to ignore.
      return isSameOperation(
        base.progress.totalLabel,
        event.name,
      )
        ? {
            ...base,
            progress: {
              ...base.progress,
              totalLabel: event.name,
            },
          }
        : {
            ...base,
            rateSamples: [],
            etaSamples: [],
            lastPrgvCurrent: 0,
            lastPrgvTotal: 0,
            progress: {
              ...base.progress,
              totalLabel: event.name,
              throughputBytesPerSec: null,
              etaSeconds: null,
              etaTrend: null,
            },
          }

    case "PRGC":
      return {
        ...base,
        progress: {
          ...base.progress,
          currentLabel: event.name,
        },
      }

    case "TCOUNT":
      return { ...base, titleCount: event.count }

    case "PRGV":
      return observePrgv({ tracker: base, event, atMs })

    case "MSG":
      // FILE_ADDED is the only per-title completion signal robot
      // mode gives us in backup mode, so it is what drives the
      // "file N of M" readout.
      return event.code === MakemkvMsgCode.FILE_ADDED
        ? {
            ...base,
            filesAdded: base.filesAdded + 1,
            progress: {
              ...base.progress,
              fileIndex: base.filesAdded + 1,
              fileCount: base.titleCount,
            },
          }
        : base

    default:
      return base
  }
}

const observePrgv = (input: {
  tracker: ProgressTracker
  event: Extract<MakemkvEvent, { type: "PRGV" }>
  atMs: number
}): ProgressTracker => {
  const { tracker, event, atMs } = input

  // `max` is not always 65536 and MakeMKV has been seen emitting
  // zero before the first real value. Dividing by it unguarded
  // yields Infinity, which then poisons every derived figure.
  if (event.max <= 0) return tracker

  const totalFraction = clampFraction(
    event.total / event.max,
  )
  const currentFraction = clampFraction(
    event.current / event.max,
  )

  const hasAdvanced =
    event.total > tracker.lastPrgvTotal ||
    event.current > tracker.lastPrgvCurrent

  const bytesWritten = Math.round(
    totalFraction * tracker.discBytes,
  )

  const rateSamples = withinWindow(
    [...tracker.rateSamples, { atMs, bytes: bytesWritten }],
    atMs,
    PROGRESS_TUNING.throughputWindowMs,
  )

  const throughputBytesPerSec = throughputFrom(rateSamples)

  const etaSeconds =
    throughputBytesPerSec === null || tracker.discBytes <= 0
      ? null
      : Math.max(
          0,
          Math.round(
            (tracker.discBytes - bytesWritten) /
              throughputBytesPerSec,
          ),
        )

  const etaSamples =
    etaSeconds === null
      ? tracker.etaSamples
      : withinWindow(
          [...tracker.etaSamples, { atMs, etaSeconds }],
          atMs,
          PROGRESS_TUNING.etaTrendWindowMs,
        )

  return {
    ...tracker,
    lastPrgvCurrent: event.current,
    lastPrgvTotal: event.total,
    lastForwardProgressAtMs: hasAdvanced
      ? atMs
      : tracker.lastForwardProgressAtMs,
    rateSamples,
    etaSamples,
    progress: {
      ...tracker.progress,
      totalFraction,
      currentFraction,
      bytesWritten,
      throughputBytesPerSec,
      etaSeconds,
      etaTrend: etaTrendFrom(etaSamples),
    },
  }
}

const clampFraction = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0
