import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  type HealthSample,
  type JobFeatureVector,
  makeVerdict,
} from "@rip-deck/contracts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import type { ComputedJobVerdict } from "./jobVerdict.ts"
import {
  computedVerdictPath,
  createNullSampleStore,
  createSampleStore,
  featureVectorPath,
  sampleLogPath,
} from "./sampleStore.ts"

/**
 * The corpus on disk. JSONL because that is what imports into a
 * database in one statement and stays greppable until there is
 * one.
 */

let stateDir = ""

beforeEach(async () => {
  stateDir = await mkdtemp(
    join(tmpdir(), "rip-deck-samples-"),
  )
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

const sample = (
  overrides: Partial<HealthSample> = {},
): HealthSample => ({
  schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
  driveId: "bay-09",
  kernelName: "sr0",
  jobId: "job-1",
  sequence: 0,
  at: 1_000,
  elapsedMs: 1_000,
  intervalMs: null,
  counterIntervalMs: null,
  ioErrorCount: 92,
  readsCompleted: 10,
  sectorsRead: 84_000,
  readTicksMs: 500,
  sizeSectors: 50_000_000,
  ioErrorDelta: null,
  readsCompletedDelta: null,
  sectorsReadDelta: null,
  readTicksDeltaMs: null,
  driveThroughputBytesPerSec: null,
  avgMsPerRead: null,
  readUtilisation: null,
  stageLabel: "Copying file",
  stageElapsedMs: 0,
  progressFraction: 0.13,
  currentFraction: 0.4,
  bytesWritten: 4_000_000_000,
  ripThroughputBytesPerSec: 21_000_000,
  etaSeconds: 1_400,
  etaTrend: "rising",
  filesAdded: 3,
  readErrorCount: 0,
  msSinceProgress: 120,
  msSinceEvent: 40,
  livenessKind: "working",
  isEmptyTraySentinel: false,
  isReadTimedOut: false,
  hasCounters: true,
  ...overrides,
})

const features: JobFeatureVector = {
  schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
  jobId: "job-1",
  driveId: "bay-09",
  kernelName: "sr0",
  discBytes: 34_535_584_646,
  startedAtMs: 0,
  endedAtMs: 1_469_000,
  durationMs: 1_469_000,
  sampleIntervalMs: 2_000,
  sampleCount: 734,
  missedSampleCount: 0,
  maxSchedulingJitterMs: 4,
  timedOutReadCount: 0,
  missingCounterSampleCount: 0,
  emptyTraySentinelSampleCount: 0,
  driveThroughputP10BytesPerSec: 15_500_000,
  driveThroughputP50BytesPerSec: 21_000_000,
  driveThroughputP90BytesPerSec: 22_700_000,
  driveThroughputTrimmedP90BytesPerSec: 22_400_000,
  ripThroughputP50BytesPerSec: 21_000_000,
  avgMsPerReadP50: 12,
  avgMsPerReadP90: 30,
  avgMsPerReadMax: 55,
  readUtilisationP90: 0.9,
  ioErrorTotalDelta: 0,
  readErrorCount: 0,
  longestNoProgressMs: 900,
  longestSilenceMs: 200,
  etaSampleCount: 700,
  etaRisingSampleCount: 49,
  etaRisingShare: 0.07,
  longestEtaRisingRunMs: 26_000,
  maxEtaRisingRunFractionSpan: 0.043,
  firstEtaRisingFraction: 0.091,
  lastEtaRisingFraction: 0.134,
  etaRisingRuns: [],
  stages: [],
  outcome: {
    isSuccessful: true,
    failureReason: null,
    exitCode: 0,
    verdictKind: "ok",
  },
}

const computed: ComputedJobVerdict = {
  schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
  jobId: "job-1",
  driveId: "bay-09",
  computedAtMs: 1_469_000,
  isPublished: false,
  verdict: makeVerdict("disc_dirty", "suspected", [
    "No forward progress for 600s.",
  ]),
  observation: {
    driveId: "bay-09",
    hubChain: ["2-1", "2-1.1"],
    recentThroughput: [21_000_000],
    avgMsPerRead: 12,
    ioErrorDelta: 0,
    errorLbas: [],
    msSinceProgress: 600_000,
    enumerationEvents: 0,
    hasKeyExpired: false,
    hasSecondDriveAgreement: false,
    hasCrossDiscHistory: false,
  },
  thresholds: HEALTH_THRESHOLDS,
}

describe("the sample log", () => {
  it("writes one JSON object per line", async () => {
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    store.write(sample({ sequence: 0 }))
    store.write(sample({ sequence: 1, at: 3_000 }))
    await store.close()

    const lines = (
      await readFile(
        sampleLogPath(stateDir, "job-1"),
        "utf8",
      )
    )
      .trim()
      .split("\n")

    expect(lines).toHaveLength(2)

    const parsed = lines.map(
      (line) => JSON.parse(line) as HealthSample,
    )

    expect(parsed[0].sequence).toBe(0)
    expect(parsed[1].at).toBe(3_000)
  })

  it("round-trips nulls as nulls, never as zero", async () => {
    // A zero counter and an unreadable one are opposite
    // evidence. If persistence flattened them the whole corpus
    // would be untrustworthy at exactly the interesting moments.
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    store.write(
      sample({
        ioErrorCount: null,
        hasCounters: false,
        isReadTimedOut: true,
      }),
    )
    await store.close()

    const parsed = JSON.parse(
      (
        await readFile(
          sampleLogPath(stateDir, "job-1"),
          "utf8",
        )
      ).trim(),
    ) as HealthSample

    expect(parsed.ioErrorCount).toBeNull()
    expect(parsed.hasCounters).toBe(false)
    expect(parsed.isReadTimedOut).toBe(true)
  })

  it("appends rather than truncating an existing log", async () => {
    // An adopted or restarted job must extend its own corpus,
    // not throw away what the previous process measured.
    const first = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })
    first.write(sample({ sequence: 0 }))
    await first.close()

    const second = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })
    second.write(sample({ sequence: 1 }))
    await second.close()

    const lines = (
      await readFile(
        sampleLogPath(stateDir, "job-1"),
        "utf8",
      )
    )
      .trim()
      .split("\n")

    expect(lines).toHaveLength(2)
  })

  it("creates the state directory if it is missing", async () => {
    const nested = join(stateDir, "deep", "deeper")

    const store = await createSampleStore({
      stateDir: nested,
      jobUuid: "job-1",
    })
    store.write(sample())
    await store.close()

    await expect(
      readFile(sampleLogPath(nested, "job-1"), "utf8"),
    ).resolves.toContain("bay-09")
  })
})

describe("the feature row", () => {
  it("writes one readable JSON document", async () => {
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    await store.writeFeatures(features)
    await store.close()

    const parsed = JSON.parse(
      await readFile(
        featureVectorPath(stateDir, "job-1"),
        "utf8",
      ),
    ) as JobFeatureVector

    expect(parsed.schemaVersion).toBe(
      HEALTH_FEATURE_SCHEMA_VERSION,
    )
    expect(parsed.longestEtaRisingRunMs).toBe(26_000)
    expect(parsed.outcome.isSuccessful).toBe(true)
  })
})

describe("the computed verdict", () => {
  it("lands in its own file beside the evidence", async () => {
    // Separate from the feature row on purpose: the vector is
    // the MEASUREMENT, this is one build's judgement of it.
    // Re-judging a corpus later rewrites these and leaves the
    // evidence untouched.
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    await store.writeFeatures(features)
    await store.writeComputedVerdict(computed)
    await store.close()

    const parsed = JSON.parse(
      await readFile(
        computedVerdictPath(stateDir, "job-1"),
        "utf8",
      ),
    ) as ComputedJobVerdict

    expect(parsed.verdict.kind).toBe("disc_dirty")
    expect(parsed.jobId).toBe("job-1")
  })

  it("says on the record that nothing published it", async () => {
    // The field the tuning pass reads to know this verdict was
    // never shown to anyone.
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    await store.writeComputedVerdict(computed)
    await store.close()

    const parsed = JSON.parse(
      await readFile(
        computedVerdictPath(stateDir, "job-1"),
        "utf8",
      ),
    ) as ComputedJobVerdict

    expect(parsed.isPublished).toBe(false)
  })

  it("keeps the thresholds it was judged against", async () => {
    // Without them, "what would the engine have said" is
    // unanswerable months later — the numbers will have moved.
    const store = await createSampleStore({
      stateDir,
      jobUuid: "job-1",
    })

    await store.writeComputedVerdict(computed)
    await store.close()

    const parsed = JSON.parse(
      await readFile(
        computedVerdictPath(stateDir, "job-1"),
        "utf8",
      ),
    ) as ComputedJobVerdict

    expect(parsed.thresholds.stallTimeoutMs).toBe(
      HEALTH_THRESHOLDS.stallTimeoutMs,
    )
  })
})

describe("the null store", () => {
  it("accepts everything and writes nothing", async () => {
    const store = createNullSampleStore()

    store.write(sample())
    await store.writeFeatures(features)
    await store.writeComputedVerdict(computed)
    await expect(store.close()).resolves.toBeUndefined()
  })
})
