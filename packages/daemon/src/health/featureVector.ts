import {
  type EtaRisingRun,
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  type HealthSample,
  type JobFeatureOutcome,
  type JobFeatureVector,
  type StageFeature,
} from "@rip-deck/contracts"
import { percentile, trimToMiddle } from "./baseline.ts"

/**
 * Reduce a job's samples to the one row you actually query.
 *
 * `AGENTS.md`: "the full feature vector is persisted per job
 * precisely so tuning is a database query rather than a re-rip".
 * The samples are the raw evidence and are kept whole; this is
 * the summary you `GROUP BY` when asking a question of thirty
 * jobs at once.
 *
 * A pure fold again — no clock, no I/O — so a three-hour rip's
 * aggregate is asserted from a handful of literal samples.
 *
 * Two things it deliberately does NOT do:
 *
 *  1. **It does not judge.** Nothing here compares against a
 *     threshold or emits a verdict. Producing the evidence and
 *     acting on it are separate jobs, and mixing them is how a
 *     measurement quietly acquires the bias of the guess it was
 *     supposed to replace.
 *  2. **It does not average across a PRGT boundary** where doing
 *     so would be meaningless. Stage summaries are kept
 *     separately, because "Decrypting" and "Copying file" are
 *     different physical activities driving the same counter —
 *     the exact confusion that produced a false ETA alarm on a
 *     perfectly healthy rip.
 */

/** Multiple of the cadence past which an interval counts late. */
const LATE_INTERVAL_FACTOR = 1.5

type StageAccumulator = {
  label: string
  firstAtMs: number
  lastAtMs: number
  sampleCount: number
  firstFraction: number | null
  lastFraction: number | null
  throughputs: number[]
  ioErrorDelta: number
}

type RunAccumulator = {
  startAtMs: number
  endAtMs: number
  startFraction: number | null
  endFraction: number | null
  stageLabel: string | null
  sampleCount: number
  startThroughputBytesPerSec: number | null
  minThroughputBytesPerSec: number | null
  endThroughputBytesPerSec: number | null
  ioErrorDelta: number
}

export type FeatureAccumulator = {
  jobId: string | null
  driveId: string
  kernelName: string
  discBytes: number
  startedAtMs: number
  sampleIntervalMs: number

  sampleCount: number
  lastAtMs: number | null
  missedSampleCount: number
  maxSchedulingJitterMs: number
  timedOutReadCount: number
  missingCounterSampleCount: number
  emptyTraySentinelSampleCount: number

  driveThroughputs: number[]
  ripThroughputs: number[]
  avgMsPerReads: number[]
  readUtilisations: number[]

  ioErrorTotalDelta: number
  readErrorCount: number
  longestNoProgressMs: number
  longestSilenceMs: number

  etaSampleCount: number
  etaRisingSampleCount: number
  firstEtaRisingFraction: number | null
  lastEtaRisingFraction: number | null
  /** The run currently open, if the last sample was rising. */
  openRun: RunAccumulator | null
  closedRuns: EtaRisingRun[]

  stages: StageAccumulator[]
}

export const createFeatureAccumulator = (input: {
  jobId: string | null
  driveId: string
  kernelName: string
  discBytes: number
  startedAtMs: number
  /** Recorded so a later cadence change cannot mix two eras. */
  sampleIntervalMs?: number
}): FeatureAccumulator => ({
  jobId: input.jobId,
  driveId: input.driveId,
  kernelName: input.kernelName,
  discBytes: input.discBytes,
  startedAtMs: input.startedAtMs,
  sampleIntervalMs:
    input.sampleIntervalMs ??
    HEALTH_THRESHOLDS.sampleIntervalMs,

  sampleCount: 0,
  lastAtMs: null,
  missedSampleCount: 0,
  maxSchedulingJitterMs: 0,
  timedOutReadCount: 0,
  missingCounterSampleCount: 0,
  emptyTraySentinelSampleCount: 0,

  driveThroughputs: [],
  ripThroughputs: [],
  avgMsPerReads: [],
  readUtilisations: [],

  ioErrorTotalDelta: 0,
  readErrorCount: 0,
  longestNoProgressMs: 0,
  longestSilenceMs: 0,

  etaSampleCount: 0,
  etaRisingSampleCount: 0,
  firstEtaRisingFraction: null,
  lastEtaRisingFraction: null,
  openRun: null,
  closedRuns: [],

  stages: [],
})

const closeRun = (run: RunAccumulator): EtaRisingRun => ({
  startAtMs: run.startAtMs,
  endAtMs: run.endAtMs,
  durationMs: run.endAtMs - run.startAtMs,
  startFraction: run.startFraction,
  endFraction: run.endFraction,
  stageLabel: run.stageLabel,
  sampleCount: run.sampleCount,
  startThroughputBytesPerSec:
    run.startThroughputBytesPerSec,
  minThroughputBytesPerSec: run.minThroughputBytesPerSec,
  endThroughputBytesPerSec: run.endThroughputBytesPerSec,
  ioErrorDelta: run.ioErrorDelta,
})

const minOf = (
  left: number | null,
  right: number | null,
): number | null => {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

/**
 * Extend or open the current rising run.
 *
 * A run NEVER spans a PRGT boundary. `progress.ts` clears the
 * ETA window on a new stage, so a "rise" measured across one is
 * two unrelated series compared — precisely the bug that made a
 * healthy Blu-ray report RISING at its head. Splitting here means
 * a later query about run duration is asking about one stage's
 * read behaviour, which is the thing anyone actually wants to
 * know.
 */
const advanceRun = (
  accumulator: FeatureAccumulator,
  sample: HealthSample,
): {
  openRun: RunAccumulator | null
  closedRuns: EtaRisingRun[]
} => {
  const { openRun, closedRuns } = accumulator

  if (sample.etaTrend !== "rising") {
    return {
      openRun: null,
      closedRuns:
        openRun === null
          ? closedRuns
          : [...closedRuns, closeRun(openRun)],
    }
  }

  const isContinuation =
    openRun !== null &&
    openRun.stageLabel === sample.stageLabel

  if (!isContinuation) {
    return {
      openRun: {
        startAtMs: sample.at,
        endAtMs: sample.at,
        startFraction: sample.progressFraction,
        endFraction: sample.progressFraction,
        stageLabel: sample.stageLabel,
        sampleCount: 1,
        startThroughputBytesPerSec:
          sample.driveThroughputBytesPerSec,
        minThroughputBytesPerSec:
          sample.driveThroughputBytesPerSec,
        endThroughputBytesPerSec:
          sample.driveThroughputBytesPerSec,
        ioErrorDelta: sample.ioErrorDelta ?? 0,
      },
      closedRuns:
        openRun === null
          ? closedRuns
          : [...closedRuns, closeRun(openRun)],
    }
  }

  return {
    openRun: {
      ...openRun,
      endAtMs: sample.at,
      endFraction:
        sample.progressFraction ?? openRun.endFraction,
      sampleCount: openRun.sampleCount + 1,
      minThroughputBytesPerSec: minOf(
        openRun.minThroughputBytesPerSec,
        sample.driveThroughputBytesPerSec,
      ),
      endThroughputBytesPerSec:
        sample.driveThroughputBytesPerSec ??
        openRun.endThroughputBytesPerSec,
      ioErrorDelta:
        openRun.ioErrorDelta + (sample.ioErrorDelta ?? 0),
    },
    closedRuns,
  }
}

const advanceStages = (
  stages: StageAccumulator[],
  sample: HealthSample,
): StageAccumulator[] => {
  if (sample.stageLabel === null) return stages

  const label = sample.stageLabel
  const existing = stages.find(
    (stage) => stage.label === label,
  )

  if (existing === undefined) {
    return [
      ...stages,
      {
        label,
        firstAtMs: sample.at,
        lastAtMs: sample.at,
        sampleCount: 1,
        firstFraction: sample.progressFraction,
        lastFraction: sample.progressFraction,
        throughputs:
          sample.driveThroughputBytesPerSec === null
            ? []
            : [sample.driveThroughputBytesPerSec],
        ioErrorDelta: sample.ioErrorDelta ?? 0,
      },
    ]
  }

  return stages.map((stage) =>
    stage.label === label
      ? {
          ...stage,
          lastAtMs: sample.at,
          sampleCount: stage.sampleCount + 1,
          lastFraction:
            sample.progressFraction ?? stage.lastFraction,
          throughputs:
            sample.driveThroughputBytesPerSec === null
              ? stage.throughputs
              : [
                  ...stage.throughputs,
                  sample.driveThroughputBytesPerSec,
                ],
          ioErrorDelta:
            stage.ioErrorDelta + (sample.ioErrorDelta ?? 0),
        }
      : stage,
  )
}

/** Fold one sample into the job's accumulator. */
export const foldSampleIntoFeatures = (
  accumulator: FeatureAccumulator,
  sample: HealthSample,
): FeatureAccumulator => {
  // How late this sample was against the cadence it asked for.
  //
  // This is the empirical check on the rule the whole
  // child-per-drive architecture exists to enforce: a sampler
  // that cannot get the event loop back on time is a process that
  // blocked somewhere it promised not to. On a healthy job this
  // should be a handful of milliseconds.
  const jitterMs =
    sample.intervalMs === null
      ? 0
      : Math.max(
          0,
          sample.intervalMs - accumulator.sampleIntervalMs,
        )

  const isLate =
    sample.intervalMs !== null &&
    sample.intervalMs >
      accumulator.sampleIntervalMs * LATE_INTERVAL_FACTOR

  const { openRun, closedRuns } = advanceRun(
    accumulator,
    sample,
  )

  const isRising = sample.etaTrend === "rising"

  return {
    ...accumulator,
    sampleCount: accumulator.sampleCount + 1,
    lastAtMs: sample.at,
    missedSampleCount:
      accumulator.missedSampleCount + (isLate ? 1 : 0),
    maxSchedulingJitterMs: Math.max(
      accumulator.maxSchedulingJitterMs,
      jitterMs,
    ),
    timedOutReadCount:
      accumulator.timedOutReadCount +
      (sample.isReadTimedOut ? 1 : 0),
    missingCounterSampleCount:
      accumulator.missingCounterSampleCount +
      (sample.hasCounters ? 0 : 1),
    emptyTraySentinelSampleCount:
      accumulator.emptyTraySentinelSampleCount +
      (sample.isEmptyTraySentinel ? 1 : 0),

    driveThroughputs:
      sample.driveThroughputBytesPerSec === null
        ? accumulator.driveThroughputs
        : [
            ...accumulator.driveThroughputs,
            sample.driveThroughputBytesPerSec,
          ],
    ripThroughputs:
      sample.ripThroughputBytesPerSec === null
        ? accumulator.ripThroughputs
        : [
            ...accumulator.ripThroughputs,
            sample.ripThroughputBytesPerSec,
          ],
    avgMsPerReads:
      sample.avgMsPerRead === null
        ? accumulator.avgMsPerReads
        : [
            ...accumulator.avgMsPerReads,
            sample.avgMsPerRead,
          ],
    readUtilisations:
      sample.readUtilisation === null
        ? accumulator.readUtilisations
        : [
            ...accumulator.readUtilisations,
            sample.readUtilisation,
          ],

    ioErrorTotalDelta:
      accumulator.ioErrorTotalDelta +
      (sample.ioErrorDelta ?? 0),
    // MakeMKV's count is cumulative for the job, so the latest
    // reading is the answer — summing it would multiply every
    // error by the number of samples that saw it.
    readErrorCount:
      sample.readErrorCount ?? accumulator.readErrorCount,
    longestNoProgressMs: Math.max(
      accumulator.longestNoProgressMs,
      sample.msSinceProgress ?? 0,
    ),
    longestSilenceMs: Math.max(
      accumulator.longestSilenceMs,
      sample.msSinceEvent ?? 0,
    ),

    etaSampleCount:
      accumulator.etaSampleCount +
      (sample.etaTrend === null ? 0 : 1),
    etaRisingSampleCount:
      accumulator.etaRisingSampleCount + (isRising ? 1 : 0),
    firstEtaRisingFraction:
      isRising &&
      accumulator.firstEtaRisingFraction === null
        ? sample.progressFraction
        : accumulator.firstEtaRisingFraction,
    lastEtaRisingFraction: isRising
      ? (sample.progressFraction ??
        accumulator.lastEtaRisingFraction)
      : accumulator.lastEtaRisingFraction,
    openRun,
    closedRuns,

    stages: advanceStages(accumulator.stages, sample),
  }
}

const atPercentile = (
  values: number[],
  fraction: number,
): number | null =>
  values.length === 0 ? null : percentile(values, fraction)

const spanOf = (run: EtaRisingRun): number | null =>
  run.startFraction === null || run.endFraction === null
    ? null
    : run.endFraction - run.startFraction

const toStageFeature = (
  stage: StageAccumulator,
): StageFeature => ({
  label: stage.label,
  firstAtMs: stage.firstAtMs,
  lastAtMs: stage.lastAtMs,
  durationMs: stage.lastAtMs - stage.firstAtMs,
  sampleCount: stage.sampleCount,
  firstFraction: stage.firstFraction,
  lastFraction: stage.lastFraction,
  throughputP50BytesPerSec: atPercentile(
    stage.throughputs,
    0.5,
  ),
  ioErrorDelta: stage.ioErrorDelta,
})

/** Seal the accumulator into the row that gets persisted. */
export const buildJobFeatureVector = (input: {
  accumulator: FeatureAccumulator
  endedAtMs: number
  outcome: JobFeatureOutcome
}): JobFeatureVector => {
  const { accumulator, endedAtMs, outcome } = input

  // A run still open at the end is a real run — it simply ended
  // when the job did. Dropping it would systematically hide the
  // case where an ETA rose right up to a failure, which is the
  // single most interesting shape this data could contain.
  const etaRisingRuns =
    accumulator.openRun === null
      ? accumulator.closedRuns
      : [
          ...accumulator.closedRuns,
          closeRun(accumulator.openRun),
        ]

  const spans = etaRisingRuns
    .map(spanOf)
    .filter((span): span is number => span !== null)

  return {
    schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
    jobId: accumulator.jobId,
    driveId: accumulator.driveId,
    kernelName: accumulator.kernelName,
    discBytes: accumulator.discBytes,
    startedAtMs: accumulator.startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - accumulator.startedAtMs,

    sampleIntervalMs: accumulator.sampleIntervalMs,
    sampleCount: accumulator.sampleCount,
    missedSampleCount: accumulator.missedSampleCount,
    maxSchedulingJitterMs:
      accumulator.maxSchedulingJitterMs,
    timedOutReadCount: accumulator.timedOutReadCount,
    missingCounterSampleCount:
      accumulator.missingCounterSampleCount,
    emptyTraySentinelSampleCount:
      accumulator.emptyTraySentinelSampleCount,

    driveThroughputP10BytesPerSec: atPercentile(
      accumulator.driveThroughputs,
      0.1,
    ),
    driveThroughputP50BytesPerSec: atPercentile(
      accumulator.driveThroughputs,
      0.5,
    ),
    driveThroughputP90BytesPerSec: atPercentile(
      accumulator.driveThroughputs,
      0.9,
    ),
    // The same trim-then-p90 the baseline itself uses, so the
    // recorded figure is directly comparable with what
    // `foldJobIntoBaseline` would have taken from this job.
    driveThroughputTrimmedP90BytesPerSec: atPercentile(
      trimToMiddle(accumulator.driveThroughputs),
      0.9,
    ),
    ripThroughputP50BytesPerSec: atPercentile(
      accumulator.ripThroughputs,
      0.5,
    ),

    avgMsPerReadP50: atPercentile(
      accumulator.avgMsPerReads,
      0.5,
    ),
    avgMsPerReadP90: atPercentile(
      accumulator.avgMsPerReads,
      0.9,
    ),
    avgMsPerReadMax:
      accumulator.avgMsPerReads.length === 0
        ? null
        : Math.max(...accumulator.avgMsPerReads),
    readUtilisationP90: atPercentile(
      accumulator.readUtilisations,
      0.9,
    ),

    ioErrorTotalDelta: accumulator.ioErrorTotalDelta,
    readErrorCount: accumulator.readErrorCount,
    longestNoProgressMs: accumulator.longestNoProgressMs,
    longestSilenceMs: accumulator.longestSilenceMs,

    etaSampleCount: accumulator.etaSampleCount,
    etaRisingSampleCount: accumulator.etaRisingSampleCount,
    etaRisingShare:
      accumulator.etaSampleCount === 0
        ? 0
        : accumulator.etaRisingSampleCount /
          accumulator.etaSampleCount,
    longestEtaRisingRunMs: etaRisingRuns.reduce(
      (longest, run) => Math.max(longest, run.durationMs),
      0,
    ),
    maxEtaRisingRunFractionSpan:
      spans.length === 0 ? null : Math.max(...spans),
    firstEtaRisingFraction:
      accumulator.firstEtaRisingFraction,
    lastEtaRisingFraction:
      accumulator.lastEtaRisingFraction,
    etaRisingRuns,

    stages: accumulator.stages.map(toStageFeature),
    outcome,
  }
}
