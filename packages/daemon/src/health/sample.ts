import {
  EMPTY_TRAY_SECTORS,
  type EtaTrend,
  HEALTH_FEATURE_SCHEMA_VERSION,
  type HealthSample,
  type LivenessKindLabel,
} from "@rip-deck/contracts"

/**
 * Turn two consecutive counter reads into one feature row.
 *
 * A pure fold, like `rip/progress.ts` and `rip/liveness.ts`: the
 * clock arrives as an argument, nothing is read from a device
 * here, and the whole of a three-hour rip's sampling behaviour is
 * therefore assertable in milliseconds. The device read itself is
 * a caller's problem — see `rip/sampler.ts`, which is the only
 * place that touches sysfs and which runs in the per-drive child.
 *
 * Everything here is delta arithmetic, and all of it is
 * defensive, because every one of these counters can and does
 * misbehave on real hardware:
 *
 *  - `ioerr_cnt` is HEX while its neighbours are decimal, so a
 *    naive read of `0x5c` yields 0 and the error counter looks
 *    flat forever. Decoding happens in `drives/sysfs.ts`; what
 *    matters here is that a null is a real reading meaning
 *    "unreadable", never a zero.
 *  - Counters RESET when a drive re-enumerates, which the tower
 *    does routinely. A negative delta is that reset, not negative
 *    error count, and recording it as a negative number would
 *    poison any later sum.
 *  - An empty tray reports a stable 1 GiB sentinel that looks
 *    exactly like a small disc, so it is flagged rather than
 *    silently averaged into a baseline.
 */

/**
 * MakeMKV's parallel view of the same instant.
 *
 * Passed in rather than read, so this module stays free of any
 * dependency on the rip machinery and can be replayed from a
 * capture. Every field is nullable because a sample can be taken
 * before the first progress line, or while no rip is attached at
 * all — an idle drive is the control group and is worth sampling.
 */
export type RipContext = {
  stageLabel: string | null
  progressFraction: number | null
  currentFraction: number | null
  bytesWritten: number | null
  ripThroughputBytesPerSec: number | null
  etaSeconds: number | null
  etaTrend: EtaTrend | null
  filesAdded: number | null
  readErrorCount: number | null
  msSinceProgress: number | null
  msSinceEvent: number | null
  livenessKind: LivenessKindLabel | null
}

/** Raw counters, exactly as `sampleDrive` returns them. */
export type DriveCounters = {
  ioErrorCount: number | null
  stat: {
    readsCompleted: number
    sectorsRead: number
    readTicksMs: number
  } | null
  sizeSectors: number | null
}

/** What the previous sample left behind for delta arithmetic. */
export type SampleState = {
  sequence: number
  previousAtMs: number | null
  /**
   * When the carried-forward counters were actually read.
   *
   * Distinct from `previousAtMs` on purpose: after a failed read
   * the next delta spans two intervals, and dividing it by the
   * sampling cadence would double the reported throughput.
   */
  previousCountersAtMs: number | null
  previousIoErrorCount: number | null
  previousReadsCompleted: number | null
  previousSectorsRead: number | null
  previousReadTicksMs: number | null
  /** First time the current PRGT stage was seen. */
  stageLabel: string | null
  stageStartedAtMs: number | null
}

export const createSampleState = (): SampleState => ({
  sequence: 0,
  previousAtMs: null,
  previousCountersAtMs: null,
  previousIoErrorCount: null,
  previousReadsCompleted: null,
  previousSectorsRead: null,
  previousReadTicksMs: null,
  stageLabel: null,
  stageStartedAtMs: null,
})

/** Bytes per 512-byte sysfs sector. */
const SECTOR_BYTES = 512

/**
 * A counter's increase since the previous read.
 *
 * Null when either end is unknown. Null — NOT zero — when the
 * counter went backwards: that is a device re-enumeration
 * resetting sysfs, and reporting it as a real decrease would let
 * one re-plug cancel out a job's worth of accumulated errors.
 */
export const counterDelta = (
  previous: number | null,
  current: number | null,
): number | null => {
  if (previous === null || current === null) return null

  const delta = current - previous
  return delta < 0 ? null : delta
}

const perSecond = (
  delta: number | null,
  intervalMs: number | null,
): number | null =>
  delta === null || intervalMs === null || intervalMs <= 0
    ? null
    : (delta / intervalMs) * 1_000

/**
 * Fold one counter read into a sample.
 *
 * Returns the row and the state the next read needs. Splitting
 * them keeps the caller from having to remember which fields are
 * carried forward, which is exactly the kind of bookkeeping that
 * quietly stops working when a field is added.
 */
export const buildHealthSample = (input: {
  state: SampleState
  driveId: string
  kernelName: string
  jobId: string | null
  startedAtMs: number
  atMs: number
  counters: DriveCounters | null
  context: RipContext | null
  isReadTimedOut: boolean
}): { sample: HealthSample; state: SampleState } => {
  const { state, counters, context, atMs, isReadTimedOut } =
    input

  const stat = counters?.stat ?? null
  const ioErrorCount = counters?.ioErrorCount ?? null
  const sizeSectors = counters?.sizeSectors ?? null

  const readsCompleted = stat?.readsCompleted ?? null
  const sectorsRead = stat?.sectorsRead ?? null
  const readTicksMs = stat?.readTicksMs ?? null

  const intervalMs =
    state.previousAtMs === null
      ? null
      : atMs - state.previousAtMs

  const hasCounters =
    ioErrorCount !== null ||
    stat !== null ||
    sizeSectors !== null

  const counterIntervalMs =
    state.previousCountersAtMs === null || !hasCounters
      ? null
      : atMs - state.previousCountersAtMs

  const ioErrorDelta = counterDelta(
    state.previousIoErrorCount,
    ioErrorCount,
  )
  const readsCompletedDelta = counterDelta(
    state.previousReadsCompleted,
    readsCompleted,
  )
  const sectorsReadDelta = counterDelta(
    state.previousSectorsRead,
    sectorsRead,
  )
  const readTicksDeltaMs = counterDelta(
    state.previousReadTicksMs,
    readTicksMs,
  )

  const driveThroughputBytesPerSec = perSecond(
    sectorsReadDelta === null
      ? null
      : sectorsReadDelta * SECTOR_BYTES,
    counterIntervalMs,
  )

  // Guarded against a zero denominator rather than trusting the
  // interval to imply reads happened: a drive can spend a whole
  // sampling interval inside a single command, completing none.
  const avgMsPerRead =
    readTicksDeltaMs === null ||
    readsCompletedDelta === null ||
    readsCompletedDelta <= 0
      ? null
      : readTicksDeltaMs / readsCompletedDelta

  const readUtilisation =
    readTicksDeltaMs === null ||
    counterIntervalMs === null ||
    counterIntervalMs <= 0
      ? null
      : readTicksDeltaMs / counterIntervalMs

  const stageLabel = context?.stageLabel ?? null
  const isSameStage =
    stageLabel !== null && stageLabel === state.stageLabel

  const stageStartedAtMs = isSameStage
    ? state.stageStartedAtMs
    : atMs

  const sample: HealthSample = {
    schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
    driveId: input.driveId,
    kernelName: input.kernelName,
    jobId: input.jobId,
    sequence: state.sequence,
    at: atMs,
    elapsedMs: atMs - input.startedAtMs,
    intervalMs,
    counterIntervalMs,

    ioErrorCount,
    readsCompleted,
    sectorsRead,
    readTicksMs,
    sizeSectors,

    ioErrorDelta,
    readsCompletedDelta,
    sectorsReadDelta,
    readTicksDeltaMs,

    driveThroughputBytesPerSec,
    avgMsPerRead,
    readUtilisation,

    stageLabel,
    stageElapsedMs:
      stageStartedAtMs === null
        ? null
        : atMs - stageStartedAtMs,
    progressFraction: context?.progressFraction ?? null,
    currentFraction: context?.currentFraction ?? null,
    bytesWritten: context?.bytesWritten ?? null,
    ripThroughputBytesPerSec:
      context?.ripThroughputBytesPerSec ?? null,
    etaSeconds: context?.etaSeconds ?? null,
    etaTrend: context?.etaTrend ?? null,
    filesAdded: context?.filesAdded ?? null,
    readErrorCount: context?.readErrorCount ?? null,

    msSinceProgress: context?.msSinceProgress ?? null,
    msSinceEvent: context?.msSinceEvent ?? null,
    livenessKind: context?.livenessKind ?? null,

    isEmptyTraySentinel: sizeSectors === EMPTY_TRAY_SECTORS,
    isReadTimedOut,
    hasCounters,
  }

  return {
    sample,
    state: {
      sequence: state.sequence + 1,
      previousAtMs: atMs,
      previousCountersAtMs: hasCounters
        ? atMs
        : state.previousCountersAtMs,
      // A failed read must not become the baseline the NEXT
      // delta is measured from — carry the last good value
      // forward so one unreadable sample costs one row rather
      // than corrupting the two either side of it.
      previousIoErrorCount:
        ioErrorCount ?? state.previousIoErrorCount,
      previousReadsCompleted:
        readsCompleted ?? state.previousReadsCompleted,
      previousSectorsRead:
        sectorsRead ?? state.previousSectorsRead,
      previousReadTicksMs:
        readTicksMs ?? state.previousReadTicksMs,
      stageLabel: stageLabel ?? state.stageLabel,
      stageStartedAtMs,
    },
  }
}
