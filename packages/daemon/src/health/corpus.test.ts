import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  type JobFeatureVector,
  type Verdict,
} from "@rip-deck/contracts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  isTroubledJob,
  readCorpusReadiness,
} from "./corpus.ts"
import {
  HEALTH_TUNING_MIN_JOB_COUNT,
  hedged,
  isHealthVerdictPublished,
  readHealthGate,
  refreshHealthGate,
  resetHealthGate,
} from "./publish.ts"

/**
 * The gate that used to be a hand-written `false`.
 *
 * ⚠️ These tests prove the COUNTING and the LATCH — that the
 * gate opens on evidence rather than on somebody remembering to
 * flip it, and that what comes out the far side can never
 * announce. They prove nothing about whether the thresholds are
 * right; the corpus is what would answer that, and the whole
 * point of this module is that nobody has one yet.
 */

const MIN = 4

let stateDir = ""

beforeEach(async () => {
  stateDir = await mkdtemp(
    join(tmpdir(), "rip-deck-corpus-"),
  )

  resetHealthGate()
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })

  resetHealthGate()
})

const vector = (
  overrides: Partial<JobFeatureVector> = {},
): JobFeatureVector => ({
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
    verdictKind: null,
  },
  ...overrides,
})

const writeVector = async (
  name: string,
  overrides: Partial<JobFeatureVector> = {},
): Promise<void> => {
  await writeFile(
    join(stateDir, `${name}.features.json`),
    JSON.stringify(vector(overrides), null, 2),
    "utf8",
  )
}

describe("what counts as a job that went badly", () => {
  it("is false for a clean rip", () => {
    expect(isTroubledJob(vector())).toBe(false)
  })

  it.each([
    [
      "the rip failed",
      {
        outcome: {
          isSuccessful: false,
          failureReason: "read_errors",
          exitCode: 1,
          verdictKind: null,
        },
      },
    ],
    ["MakeMKV counted read errors", { readErrorCount: 4 }],
    [
      "the kernel counted I/O errors",
      { ioErrorTotalDelta: 2 },
    ],
  ] as const)("is true when %s", (_name, overrides) => {
    // ORed rather than ranked: a rip that succeeded while the
    // drive logged I/O errors is exactly as instructive to the
    // tuning corpus as one that failed outright.
    expect(isTroubledJob(vector(overrides))).toBe(true)
  })
})

describe("counting the corpus", () => {
  it("reports nothing for a directory that is not there", async () => {
    const reading = await readCorpusReadiness({
      stateDir: join(stateDir, "not-here"),
      minJobCount: MIN,
    })

    expect(reading).toEqual({
      jobCount: 0,
      troubledJobCount: -1,
      isReady: false,
    })
  })

  it("counts only the feature vectors", async () => {
    await writeVector("a")
    await writeVector("b")
    // The state directory is shared with samples, verdicts, the
    // bay ledger and the poster cache. Counting any of those
    // would open the gate on files that are not evidence.
    await writeFile(
      join(stateDir, "a.samples.jsonl"),
      "{}\n",
      "utf8",
    )
    await writeFile(
      join(stateDir, "a.verdict.json"),
      "{}",
      "utf8",
    )
    await writeFile(
      join(stateDir, "bays.json"),
      "{}",
      "utf8",
    )

    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    expect(reading.jobCount).toBe(2)
  })

  it("does not read the vectors below the minimum", async () => {
    await writeVector("a", { readErrorCount: 9 })

    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    // `-1`, not `1`. Below the minimum the answer is `false`
    // whatever the contents say, so opening the files would be
    // work with no reader — and `-1` says nobody looked rather
    // than claiming none had trouble.
    expect(reading.troubledJobCount).toBe(-1)
    expect(reading.isReady).toBe(false)
  })

  it("refuses a corpus of nothing but clean rips", async () => {
    await writeVector("a")
    await writeVector("b")
    await writeVector("c")
    await writeVector("d")

    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    // Four clean rips teach a detector nothing about the thing
    // it is built to detect.
    expect(reading.jobCount).toBe(MIN)
    expect(reading.troubledJobCount).toBe(0)
    expect(reading.isReady).toBe(false)
  })

  it("is ready once one of them went badly", async () => {
    await writeVector("a")
    await writeVector("b")
    await writeVector("c")
    await writeVector("d", { readErrorCount: 7 })

    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    expect(reading.troubledJobCount).toBe(1)
    expect(reading.isReady).toBe(true)
  })

  it("discards a file it cannot parse as a vector", async () => {
    await writeVector("a", { readErrorCount: 7 })
    await writeVector("b")
    await writeVector("c")
    await writeFile(
      join(stateDir, "d.features.json"),
      "{ this is not json",
      "utf8",
    )

    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    // A half-written file is not a rip. Counting it would open
    // the gate one job early, which is the one direction that
    // costs something.
    expect(reading.jobCount).toBe(3)
    expect(reading.isReady).toBe(false)
  })

  it("discards a document that is JSON but not a vector", async () => {
    await writeVector("a", { readErrorCount: 7 })
    await writeVector("b")
    await writeVector("c")
    await writeFile(
      join(stateDir, "d.features.json"),
      JSON.stringify({ schemaVersion: 1 }),
      "utf8",
    )

    // A vector written by a build that has since lost the
    // fields `isTroubledJob` reads would otherwise count as a
    // clean job — evidence that is not there.
    const reading = await readCorpusReadiness({
      stateDir,
      minJobCount: MIN,
    })

    expect(reading.jobCount).toBe(3)
  })
})

describe("the gate", () => {
  it("is shut before anything has counted", () => {
    expect(isHealthVerdictPublished()).toBe(false)
    expect(readHealthGate().jobCount).toBe(0)
  })

  it("stays shut on a corpus that has not earned it", async () => {
    await writeVector("a", { readErrorCount: 7 })

    await refreshHealthGate({ stateDir, minJobCount: MIN })

    expect(isHealthVerdictPublished()).toBe(false)
  })

  it("opens itself with no flag flipped by hand", async () => {
    await writeVector("a")
    await writeVector("b")
    await writeVector("c")
    await writeVector("d", { readErrorCount: 7 })

    await refreshHealthGate({ stateDir, minJobCount: MIN })

    expect(isHealthVerdictPublished()).toBe(true)
  })

  it("holds the real minimum at 30", () => {
    // The number `contracts/health.ts` names, and the one the
    // production refresh uses when nobody passes one.
    expect(HEALTH_TUNING_MIN_JOB_COUNT).toBe(30)
  })

  it("stays open when the corpus is taken away", async () => {
    await writeVector("a")
    await writeVector("b")
    await writeVector("c")
    await writeVector("d", { readErrorCount: 7 })

    await refreshHealthGate({ stateDir, minJobCount: MIN })
    await rm(join(stateDir, "d.features.json"))

    const reading = await refreshHealthGate({
      stateDir,
      minJobCount: MIN,
    })

    // The count is honest about what is there now; the gate is
    // latched. A corpus cannot un-earn itself, and a verdict
    // that appeared and vanished because somebody tidied the
    // state directory would be unexplainable from the card.
    expect(reading.jobCount).toBe(3)
    expect(reading.isReady).toBe(true)
    expect(isHealthVerdictPublished()).toBe(true)
  })
})

describe("hedging a published verdict", () => {
  it("forces a confirmed verdict down to suspected", () => {
    // The gate opens on file counts, so the thresholds behind
    // this verdict are still guesses at the instant it opens.
    // `isAnnounceable` asks for exactly one property, and this
    // is what takes it away.
    const verdict = hedged({
      kind: "key_expired",
      action: "refresh_key",
      confidence: "confirmed",
      subject: "system",
      message: "MakeMKV's key has expired.",
      evidence: [],
      isKeepTryingSensible: false,
    })

    expect(verdict.confidence).toBe("suspected")
  })

  it("returns a suspected verdict untouched", () => {
    const verdict: Verdict = {
      kind: "disc_dirty",
      action: "clean_disc",
      confidence: "suspected",
      subject: "disc",
      message: "Dirty.",
      evidence: ["Errors scattered."],
      isKeepTryingSensible: true,
    }

    expect(hedged(verdict)).toBe(verdict)
  })
})
