import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  type HealthSample,
  type JobFeatureOutcome,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  buildJobFeatureVector,
  createFeatureAccumulator,
  type FeatureAccumulator,
  foldSampleIntoFeatures,
} from "./featureVector.ts"

/**
 * The per-job row. Pure, so a 25-minute rip's aggregate is
 * asserted from a handful of literal samples.
 *
 * Every number here is EVIDENCE, not a judgement — nothing in
 * this module compares against a threshold, and these tests
 * therefore prove arithmetic and grouping, not that the health
 * engine is right about anything.
 */

const SAMPLE_MS = HEALTH_THRESHOLDS.sampleIntervalMs

const sampleAt = (
  overrides: Partial<HealthSample> & { at: number },
): HealthSample => ({
  schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
  driveId: "bay-09",
  kernelName: "sr0",
  jobId: "job-1",
  sequence: 0,
  elapsedMs: overrides.at,
  intervalMs: SAMPLE_MS,
  counterIntervalMs: SAMPLE_MS,
  ioErrorCount: 0,
  readsCompleted: 0,
  sectorsRead: 0,
  readTicksMs: 0,
  sizeSectors: 50_000_000,
  ioErrorDelta: 0,
  readsCompletedDelta: 0,
  sectorsReadDelta: 0,
  readTicksDeltaMs: 0,
  driveThroughputBytesPerSec: null,
  avgMsPerRead: null,
  readUtilisation: null,
  stageLabel: null,
  stageElapsedMs: null,
  progressFraction: null,
  currentFraction: null,
  bytesWritten: null,
  ripThroughputBytesPerSec: null,
  etaSeconds: null,
  etaTrend: null,
  filesAdded: null,
  readErrorCount: null,
  msSinceProgress: null,
  msSinceEvent: null,
  livenessKind: null,
  isEmptyTraySentinel: false,
  isReadTimedOut: false,
  hasCounters: true,
  ...overrides,
})

const accumulate = (
  samples: HealthSample[],
): FeatureAccumulator =>
  samples.reduce(
    foldSampleIntoFeatures,
    createFeatureAccumulator({
      jobId: "job-1",
      driveId: "bay-09",
      kernelName: "sr0",
      discBytes: 34_535_584_646,
      startedAtMs: 0,
    }),
  )

const okOutcome: JobFeatureOutcome = {
  isSuccessful: true,
  failureReason: null,
  exitCode: 0,
  verdictKind: "ok",
}

const build = (samples: HealthSample[]) =>
  buildJobFeatureVector({
    accumulator: accumulate(samples),
    endedAtMs:
      samples.length === 0
        ? 0
        : samples[samples.length - 1].at,
    outcome: okOutcome,
  })

describe("throughput percentiles", () => {
  it("summarises the drive-side rate", () => {
    const rates = [10, 20, 30, 40, 50].map(
      (mb) => mb * 1_000_000,
    )

    const features = build(
      rates.map((rate, index) =>
        sampleAt({
          at: index * SAMPLE_MS,
          driveThroughputBytesPerSec: rate,
        }),
      ),
    )

    expect(features.driveThroughputP10BytesPerSec).toBe(
      10_000_000,
    )
    expect(features.driveThroughputP50BytesPerSec).toBe(
      30_000_000,
    )
    expect(features.driveThroughputP90BytesPerSec).toBe(
      50_000_000,
    )
  })

  it("keeps rip-side and drive-side rates apart", () => {
    // They are different physical quantities: what the hardware
    // delivered versus what MakeMKV managed to write. A
    // divergence is decrypt or retry overhead and is invisible
    // if only one is stored.
    const features = build([
      sampleAt({
        at: 0,
        driveThroughputBytesPerSec: 25_000_000,
        ripThroughputBytesPerSec: 21_000_000,
      }),
    ])

    expect(features.driveThroughputP50BytesPerSec).toBe(
      25_000_000,
    )
    expect(features.ripThroughputP50BytesPerSec).toBe(
      21_000_000,
    )
  })

  it("is null rather than zero with no readings", () => {
    const features = build([sampleAt({ at: 0 })])

    expect(
      features.driveThroughputP50BytesPerSec,
    ).toBeNull()
    expect(features.avgMsPerReadMax).toBeNull()
  })
})

describe("the ETA-rising runs", () => {
  it("groups consecutive rising samples into one run", () => {
    // The open question this data exists to settle: 49 of 722
    // progress lines on a HEALTHY disc said RISING, all in the
    // first 13%. The question is whether a rise sustained beyond
    // some duration is the real signal — which needs runs, not a
    // count of samples.
    const features = build([
      sampleAt({
        at: 0,
        etaTrend: "falling",
        progressFraction: 0.05,
      }),
      sampleAt({
        at: SAMPLE_MS,
        etaTrend: "rising",
        progressFraction: 0.09,
        driveThroughputBytesPerSec: 22_700_000,
      }),
      sampleAt({
        at: 2 * SAMPLE_MS,
        etaTrend: "rising",
        progressFraction: 0.11,
        driveThroughputBytesPerSec: 18_000_000,
      }),
      sampleAt({
        at: 3 * SAMPLE_MS,
        etaTrend: "rising",
        progressFraction: 0.134,
        driveThroughputBytesPerSec: 15_500_000,
      }),
      sampleAt({
        at: 4 * SAMPLE_MS,
        etaTrend: "steady",
        progressFraction: 0.15,
      }),
    ])

    expect(features.etaRisingRuns).toHaveLength(1)
    expect(features.etaRisingSampleCount).toBe(3)
    expect(features.longestEtaRisingRunMs).toBe(
      2 * SAMPLE_MS,
    )

    const run = features.etaRisingRuns[0]
    expect(run.startFraction).toBe(0.09)
    expect(run.endFraction).toBe(0.134)
    expect(run.startThroughputBytesPerSec).toBe(22_700_000)
    expect(run.minThroughputBytesPerSec).toBe(15_500_000)
    expect(run.endThroughputBytesPerSec).toBe(15_500_000)
  })

  it("never lets a run span a PRGT boundary", () => {
    // Every PRGT restarts PRGV from zero, so a rise measured
    // across one compares two unrelated series — exactly the
    // defect that made a healthy Blu-ray report RISING at its
    // head. A run that spanned the boundary would encode that
    // same mistake into the tuning data.
    const features = build([
      sampleAt({
        at: 0,
        etaTrend: "rising",
        stageLabel: "Decrypting",
      }),
      sampleAt({
        at: SAMPLE_MS,
        etaTrend: "rising",
        stageLabel: "Copying file",
      }),
    ])

    expect(features.etaRisingRuns).toHaveLength(2)
    expect(features.etaRisingRuns[0].stageLabel).toBe(
      "Decrypting",
    )
    expect(features.etaRisingRuns[1].stageLabel).toBe(
      "Copying file",
    )
    expect(features.longestEtaRisingRunMs).toBe(0)
  })

  it("keeps a run that was still open at the end", () => {
    // An ETA rising right up to a failure is the single most
    // interesting shape this data could hold; dropping the open
    // run would systematically hide it.
    const features = build([
      sampleAt({ at: 0, etaTrend: "steady" }),
      sampleAt({ at: SAMPLE_MS, etaTrend: "rising" }),
      sampleAt({ at: 2 * SAMPLE_MS, etaTrend: "rising" }),
    ])

    expect(features.etaRisingRuns).toHaveLength(1)
    expect(features.etaRisingRuns[0].sampleCount).toBe(2)
  })

  it("reports the rising share against ETA samples only", () => {
    // Samples taken before the first rate exists have no trend
    // at all, and counting them as "not rising" would quietly
    // deflate the share the tuning query reads.
    const features = build([
      sampleAt({ at: 0 }),
      sampleAt({ at: SAMPLE_MS, etaTrend: "rising" }),
      sampleAt({ at: 2 * SAMPLE_MS, etaTrend: "falling" }),
    ])

    expect(features.etaSampleCount).toBe(2)
    expect(features.etaRisingShare).toBe(0.5)
  })

  it("records where in the rip the rises happened", () => {
    const features = build([
      sampleAt({
        at: 0,
        etaTrend: "rising",
        progressFraction: 0.02,
      }),
      sampleAt({
        at: SAMPLE_MS,
        etaTrend: "steady",
        progressFraction: 0.05,
      }),
      sampleAt({
        at: 2 * SAMPLE_MS,
        etaTrend: "rising",
        progressFraction: 0.13,
      }),
    ])

    expect(features.firstEtaRisingFraction).toBe(0.02)
    expect(features.lastEtaRisingFraction).toBe(0.13)
  })
})

describe("stage summaries", () => {
  it("splits the rates by PRGT stage", () => {
    const features = build([
      sampleAt({
        at: 0,
        stageLabel: "Decrypting",
        driveThroughputBytesPerSec: 2_000_000,
        progressFraction: 0,
      }),
      sampleAt({
        at: SAMPLE_MS,
        stageLabel: "Decrypting",
        driveThroughputBytesPerSec: 2_000_000,
        ioErrorDelta: 1,
      }),
      sampleAt({
        at: 2 * SAMPLE_MS,
        stageLabel: "Copying file",
        driveThroughputBytesPerSec: 21_000_000,
        progressFraction: 0.4,
      }),
    ])

    expect(features.stages).toHaveLength(2)

    const [decrypting, copying] = features.stages
    expect(decrypting.sampleCount).toBe(2)
    expect(decrypting.throughputP50BytesPerSec).toBe(
      2_000_000,
    )
    expect(decrypting.ioErrorDelta).toBe(1)
    expect(decrypting.durationMs).toBe(SAMPLE_MS)
    expect(copying.throughputP50BytesPerSec).toBe(
      21_000_000,
    )
  })
})

describe("counters", () => {
  it("sums ioerr deltas but takes the latest read count", () => {
    // MakeMKV's read-error count is cumulative for the job, so
    // summing it would multiply every error by the number of
    // samples that happened to see it.
    const features = build([
      sampleAt({
        at: 0,
        ioErrorDelta: 2,
        readErrorCount: 1,
      }),
      sampleAt({
        at: SAMPLE_MS,
        ioErrorDelta: 3,
        readErrorCount: 4,
      }),
    ])

    expect(features.ioErrorTotalDelta).toBe(5)
    expect(features.readErrorCount).toBe(4)
  })

  it("keeps the worst stall and silence seen", () => {
    // The number nobody has: how long a HEALTHY rip goes quiet.
    // It is what `stallTimeoutMs` and `stallGraceMs` should
    // eventually be set from.
    const features = build([
      sampleAt({
        at: 0,
        msSinceProgress: 400,
        msSinceEvent: 50,
      }),
      sampleAt({
        at: SAMPLE_MS,
        msSinceProgress: 26_000,
        msSinceEvent: 900,
      }),
      sampleAt({
        at: 2 * SAMPLE_MS,
        msSinceProgress: 100,
        msSinceEvent: 20,
      }),
    ])

    expect(features.longestNoProgressMs).toBe(26_000)
    expect(features.longestSilenceMs).toBe(900)
  })

  it("counts failed and sentinel samples separately", () => {
    const features = build([
      sampleAt({
        at: 0,
        isReadTimedOut: true,
        hasCounters: false,
      }),
      sampleAt({
        at: SAMPLE_MS,
        isEmptyTraySentinel: true,
      }),
    ])

    expect(features.timedOutReadCount).toBe(1)
    expect(features.missingCounterSampleCount).toBe(1)
    expect(features.emptyTraySentinelSampleCount).toBe(1)
  })
})

describe("the loop's own scheduling", () => {
  it("records jitter, which is the never-block check", () => {
    // A sampler that cannot get the event loop back on time is
    // a process that blocked somewhere it promised not to. If
    // this is non-zero on a healthy job, something synchronous
    // got into the loop.
    const features = build([
      sampleAt({ at: 0, intervalMs: null }),
      sampleAt({
        at: SAMPLE_MS,
        intervalMs: SAMPLE_MS + 12,
      }),
      sampleAt({
        at: 2 * SAMPLE_MS,
        intervalMs: SAMPLE_MS * 4,
      }),
    ])

    expect(features.maxSchedulingJitterMs).toBe(
      SAMPLE_MS * 3,
    )
    expect(features.missedSampleCount).toBe(1)
  })
})

describe("provenance", () => {
  it("stamps the schema version and the cadence used", () => {
    // A later cadence change must not silently mix two eras of
    // measurement into one query.
    const features = build([sampleAt({ at: 0 })])

    expect(features.schemaVersion).toBe(
      HEALTH_FEATURE_SCHEMA_VERSION,
    )
    expect(features.sampleIntervalMs).toBe(SAMPLE_MS)
    expect(features.outcome.isSuccessful).toBe(true)
  })

  it("survives a job that produced no samples at all", () => {
    const features = build([])

    expect(features.sampleCount).toBe(0)
    expect(features.etaRisingRuns).toEqual([])
    expect(features.etaRisingShare).toBe(0)
  })
})
