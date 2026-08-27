import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  isAnnounceable,
  type JobFeatureVector,
  type VerdictKind,
} from "@rip-deck/contracts"
import { beforeEach, describe, expect, it } from "vitest"
import { createBaseline } from "./baseline.ts"
import {
  buildDriveObservation,
  evaluateJobHealth,
} from "./jobVerdict.ts"
import {
  HEALTH_TUNING_MIN_JOB_COUNT,
  isHealthVerdictPublished,
  resetHealthGate,
} from "./publish.ts"

/**
 * The wire from a sealed job row to the health engine.
 *
 * ⚠️ These tests prove the WIRE — that the engine runs on real
 * job data, that its answer is recorded, and that the answer
 * cannot become a reported verdict while the gate is shut. They
 * prove nothing about whether the answer is CORRECT: every
 * threshold it is reached with is still invented, which is the
 * entire reason the gate exists.
 */

const MB = 1024 * 1024

/**
 * A job row shaped like the real ones on the tower.
 *
 * The numbers are lifted from
 * `be13fa7e-….features.json` — a genuine 46 GB Blu-ray that
 * finished cleanly in ~33 minutes — so the "healthy" case here
 * is a disc that actually was.
 */
const vector = (
  overrides: Partial<JobFeatureVector> = {},
): JobFeatureVector => ({
  schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
  jobId: "be13fa7e-47d8-453f-ae2b-d8aff454a020",
  driveId: "2-1.1.2.3",
  kernelName: "sr2",
  discBytes: 46_659_338_240,
  startedAtMs: 1_785_100_222_625,
  endedAtMs: 1_785_102_219_252,
  durationMs: 1_996_627,

  sampleIntervalMs: HEALTH_THRESHOLDS.sampleIntervalMs,
  sampleCount: 998,
  missedSampleCount: 0,
  maxSchedulingJitterMs: 3,
  timedOutReadCount: 0,
  missingCounterSampleCount: 0,
  emptyTraySentinelSampleCount: 0,

  driveThroughputP10BytesPerSec: 15_138_816,
  driveThroughputP50BytesPerSec: 23_801_468,
  driveThroughputP90BytesPerSec: 32_849_960,
  driveThroughputTrimmedP90BytesPerSec: 32_636_928,
  ripThroughputP50BytesPerSec: 23_569_969,

  avgMsPerReadP50: 15.944,
  avgMsPerReadP90: 24.18,
  avgMsPerReadMax: 81.57,
  readUtilisationP90: 1.0025,

  ioErrorTotalDelta: 4,
  readErrorCount: 0,
  longestNoProgressMs: 5_375,
  longestSilenceMs: 5_207,

  etaSampleCount: 993,
  etaRisingSampleCount: 128,
  etaRisingShare: 0.1289,
  longestEtaRisingRunMs: 84_007,
  maxEtaRisingRunFractionSpan: 0.0265,
  firstEtaRisingFraction: 0.0000152,
  lastEtaRisingFraction: 0.2657,
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

describe("the publish gate", () => {
  // The gate is process state, latched by `refreshHealthGate`.
  // A test that left it open would open it for every test file
  // sharing the worker.
  beforeEach(() => {
    resetHealthGate()
  })

  it("is shut until something counts the corpus", () => {
    // ⚠️ Not a tautology. A cold process has looked at no state
    // directory, so it knows of no corpus, so no verdict may be
    // reported. Anything that made this true by default would
    // publish guessed thresholds on a tower with three rips on
    // it.
    expect(isHealthVerdictPublished()).toBe(false)
    expect(HEALTH_TUNING_MIN_JOB_COUNT).toBe(30)
  })

  it("defaults every evaluation to unpublished", () => {
    const computed = evaluateJobHealth({ vector: vector() })

    expect(computed.isPublished).toBe(false)
  })

  it.each<VerdictKind>([
    "ok",
    "key_expired",
    "disc_scratched",
    "disc_dirty",
    "disc_marginal_slow",
  ])("records %s without publishing it", (kind) => {
    // Every engine output the single-job path can reach,
    // including the two that would be worst to get wrong: `ok`
    // over a struggling disc, and `key_expired` — which is
    // `confirmed`, and so would be ANNOUNCEABLE if anything ever
    // handed it to the MQTT bridge.
    //
    // The three it cannot reach (`hub_fault`, `drive_failing`,
    // `enumeration_flap`) need cross-drive or cross-disc memory
    // that does not exist; the gate is proved to hold for those
    // too in `rip/sampler.test.ts`, where the judge is a stub
    // that can return any kind at all.
    const computed = evaluateJobHealth({
      vector: forKind(kind),
      evidence: evidenceFor(kind),
    })

    expect(computed.verdict.kind).toBe(kind)
    expect(computed.isPublished).toBe(false)
  })
})

/** A job row that drives the engine to a particular answer. */
const forKind = (kind: VerdictKind): JobFeatureVector => {
  if (kind === "disc_marginal_slow") {
    // Reading at a fifth of baseline, but cleanly.
    return vector({ driveThroughputP50BytesPerSec: 3 * MB })
  }

  if (kind === "disc_dirty") {
    // Stalled far past `stallTimeoutMs`.
    return vector({ longestNoProgressMs: 600_000 })
  }

  return vector()
}

const evidenceFor = (kind: VerdictKind) => {
  if (kind === "key_expired") return { hasKeyExpired: true }

  if (kind === "disc_scratched") {
    // Errors bunched into one band — a continuous scratch.
    return {
      errorLbas: [900_000, 902_000, 904_000, 906_000],
      // Only reached once the drive also looks unwell.
      hasKeyExpired: false,
    }
  }

  return {}
}

describe("the observation built from a sealed job", () => {
  it("reads the median rate as the job's throughput", () => {
    // A finished job has no "recent". p50 is the honest
    // whole-job stand-in, and it is named as such.
    const observation = buildDriveObservation({
      vector: vector(),
    })

    expect(observation.recentThroughput).toEqual([
      23_801_468,
    ])
  })

  it("has no throughput at all when nothing was sampled", () => {
    // Must read as "no evidence of collapse", never as a
    // collapse — a rip nobody measured is not a rip that failed.
    const observation = buildDriveObservation({
      vector: vector({
        driveThroughputP50BytesPerSec: null,
      }),
    })

    expect(observation.recentThroughput).toEqual([])
    expect(
      evaluateJobHealth({
        vector: vector({
          driveThroughputP50BytesPerSec: null,
        }),
      }).verdict.kind,
    ).toBe("ok")
  })

  it("reads the longest stall as the stall", () => {
    const observation = buildDriveObservation({
      vector: vector({ longestNoProgressMs: 600_000 }),
    })

    expect(observation.msSinceProgress).toBe(600_000)
  })

  it("derives the hub chain from the bay's port path", () => {
    // `driveId` IS the USB port path — the watcher keys every
    // bay by `drive.identity.usbPortPath`. Root-first, and the
    // drive's own leaf is not a hub.
    const observation = buildDriveObservation({
      vector: vector({ driveId: "2-1.1.2.3" }),
    })

    expect(observation.hubChain).toEqual([
      "2-1",
      "2-1.1",
      "2-1.1.2",
    ])
  })

  it("degrades to no hub chain when the id is not a path", () => {
    // A corpus recorded under a different keying must yield NO
    // hub correlation rather than a wrong one.
    const observation = buildDriveObservation({
      vector: vector({ driveId: "KE1234567890" }),
    })

    expect(observation.hubChain).toEqual([])
  })

  it("claims no cross-drive or cross-disc knowledge", () => {
    // None of the three is recorded anywhere yet. Passing a
    // fabricated value would let one bay's bad afternoon
    // quarantine a drive.
    const observation = buildDriveObservation({
      vector: vector(),
    })

    expect(observation.enumerationEvents).toBe(0)
    expect(observation.hasSecondDriveAgreement).toBe(false)
    expect(observation.hasCrossDiscHistory).toBe(false)
  })
})

describe("what one job's evaluation can conclude", () => {
  it("calls a clean 46 GB Blu-ray ok", () => {
    const computed = evaluateJobHealth({ vector: vector() })

    expect(computed.verdict.kind).toBe("ok")
    expect(isAnnounceable(computed.verdict)).toBe(false)
  })

  it("never confirms a disc verdict on one drive", () => {
    // `AGENTS.md`: only `confirmed` may announce, and a disc is
    // only confirmed once a second drive agrees. Nothing tracks
    // that yet, so this path cannot produce an announceable disc
    // verdict even with the gate open.
    const computed = evaluateJobHealth({
      vector: vector({ longestNoProgressMs: 600_000 }),
      isPublished: true,
    })

    expect(computed.verdict.kind).toBe("disc_dirty")
    expect(computed.verdict.confidence).toBe("suspected")
    expect(isAnnounceable(computed.verdict)).toBe(false)
  })

  it("cannot reach hub_fault from a single bay", () => {
    // `hubCorrelationMinDrives` is 2. Blaming a hub for one
    // bay's collapse would send the owner to check the wrong
    // thing, so the engine structurally cannot.
    const computed = evaluateJobHealth({
      vector: vector({
        driveThroughputP50BytesPerSec: 1 * MB,
        longestNoProgressMs: 600_000,
      }),
    })

    expect(computed.verdict.kind).not.toBe("hub_fault")
  })

  it("judges against the drive's own baseline when it has one", () => {
    // 23.8 MB/s is healthy against the 17 MB/s seed and a
    // collapse against a drive that normally does 90.
    const computed = evaluateJobHealth({
      vector: vector(),
      evidence: {
        baseline: {
          ...createBaseline("2-1.1.2.3"),
          bytesPerSec: 90 * MB,
          sampleCount: 30,
        },
      },
    })

    expect(computed.verdict.kind).toBe("disc_marginal_slow")
  })
})

describe("the record it writes", () => {
  it("carries the thresholds it judged against", () => {
    // "What would the engine have said" is unanswerable months
    // later without knowing which numbers it said it with.
    const computed = evaluateJobHealth({ vector: vector() })

    expect(computed.thresholds.stallTimeoutMs).toBe(
      HEALTH_THRESHOLDS.stallTimeoutMs,
    )
    expect(
      computed.thresholds.collapseFractionOfBaseline,
    ).toBe(HEALTH_THRESHOLDS.collapseFractionOfBaseline)
  })

  it("carries the observation the engine was shown", () => {
    const computed = evaluateJobHealth({
      vector: vector(),
      evidence: { errorLbas: [1, 2, 3] },
    })

    expect(computed.observation.errorLbas).toEqual([
      1, 2, 3,
    ])
    expect(computed.observation.driveId).toBe("2-1.1.2.3")
  })

  it("is stamped with the job and the instant it ended", () => {
    const computed = evaluateJobHealth({ vector: vector() })

    expect(computed.jobId).toBe(
      "be13fa7e-47d8-453f-ae2b-d8aff454a020",
    )
    expect(computed.computedAtMs).toBe(1_785_102_219_252)
    expect(computed.schemaVersion).toBe(
      HEALTH_FEATURE_SCHEMA_VERSION,
    )
  })

  it("replays a stored vector to the same answer", () => {
    // The property the whole unit exists for: tuning is a query
    // over persisted rows, not a re-rip. A judgement that
    // depended on anything but the row could not be replayed.
    const stored = vector({ longestNoProgressMs: 600_000 })

    expect(
      evaluateJobHealth({ vector: stored }).verdict,
    ).toEqual(evaluateJobHealth({ vector: stored }).verdict)
  })

  it("says nothing about whether the rip worked", () => {
    // `isRipSuccessful` is the sole authority, and it has
    // already run. A verdict of `ok` over a failed rip changes
    // nothing about the failure — the rule in `AGENTS.md` that
    // overrides everything.
    const failed = vector({
      outcome: {
        isSuccessful: false,
        failureReason: "read_errors",
        exitCode: 0,
        verdictKind: null,
      },
    })

    const computed = evaluateJobHealth({ vector: failed })

    expect(computed.verdict.kind).toBe("ok")
    expect(failed.outcome.isSuccessful).toBe(false)
    expect(failed.outcome.failureReason).toBe("read_errors")
  })
})
