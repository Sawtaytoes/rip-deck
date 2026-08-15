import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  type HealthSample,
  type JobFeatureOutcome,
  type JobFeatureVector,
  makeVerdict,
  type VerdictConfidence,
  type VerdictKind,
} from "@rip-deck/contracts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { ComputedJobVerdict } from "../health/jobVerdict.ts"
import type { DriveCounters } from "../health/sample.ts"
import type { SampleStore } from "../health/sampleStore.ts"
import { createProgressTracker } from "./progress.ts"
import {
  buildRipContext,
  type JobJudge,
  SAMPLER_TUNING,
  type SamplerDeps,
  startSampler,
} from "./sampler.ts"

/**
 * The sampler loop.
 *
 * ⚠️ These tests prove the LOOP: that it ticks, that it never
 * overlaps, that a device read which never answers cannot wedge
 * it, and that a wedge still produces rows. They prove nothing
 * whatsoever about whether the numbers it collects describe a
 * struggling disc correctly — no struggling disc has ever been
 * sampled by this or any other part of rip-deck.
 */

const SAMPLE_MS = HEALTH_THRESHOLDS.sampleIntervalMs

const healthyCounters = (
  sectorsRead: number,
): DriveCounters => ({
  ioErrorCount: 0,
  stat: {
    readsCompleted: sectorsRead / 64,
    sectorsRead,
    readTicksMs: 100,
  },
  sizeSectors: 50_000_000,
})

const okOutcome: JobFeatureOutcome = {
  isSuccessful: true,
  failureReason: null,
  exitCode: 0,
  verdictKind: "ok",
}

const recordingStore = () => {
  const samples: HealthSample[] = []
  const written: JobFeatureVector[] = []
  const verdicts: ComputedJobVerdict[] = []
  let isClosed = false

  const store: SampleStore = {
    write: (sample) => {
      samples.push(sample)
    },
    writeFeatures: async (features) => {
      written.push(features)
    },
    writeComputedVerdict: async (computed) => {
      verdicts.push(computed)
    },
    close: async () => {
      isClosed = true
    },
  }

  return {
    store,
    samples,
    written,
    verdicts,
    isClosed: () => isClosed,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the loop", () => {
  it("samples on the interval without being asked", async () => {
    // The entire point of this unit: sampleDrive() existed and
    // nothing called it on a timer, so the health engine was
    // never fed during a rip.
    let sectorsRead = 0

    const deps: SamplerDeps = {
      readCounters: async () => {
        sectorsRead += 84_000
        return healthyCounters(sectorsRead)
      },
      now: () => Date.now(),
    }

    const { store, samples } = recordingStore()

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 34_535_584_646,
        startedAtMs: Date.now(),
        store,
      },
      deps,
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 3)
    await sampler.stop(okOutcome)

    expect(samples).toHaveLength(3)
    expect(samples[1].driveThroughputBytesPerSec).toBe(
      (84_000 * 512) / (SAMPLE_MS / 1_000),
    )
  })

  it("stops sampling once stopped", async () => {
    const { store, samples } = recordingStore()

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
        store,
      },
      {
        readCounters: async () => healthyCounters(1_000),
        now: () => Date.now(),
      },
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    await sampler.stop(okOutcome)
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 5)

    expect(samples).toHaveLength(1)
  })

  it("closes the store and returns the feature row", async () => {
    const { store, isClosed } = recordingStore()

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 34_535_584_646,
        startedAtMs: Date.now(),
        store,
      },
      {
        readCounters: async () => healthyCounters(1_000),
        now: () => Date.now(),
      },
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2)
    const features = await sampler.stop({
      isSuccessful: false,
      failureReason: "read_errors",
      exitCode: 0,
      verdictKind: "disc_dirty",
    })

    expect(isClosed()).toBe(true)
    expect(features.sampleCount).toBe(2)
    expect(features.outcome.failureReason).toBe(
      "read_errors",
    )
    expect(features.driveId).toBe("bay-09")
  })
})

describe("a drive that stops answering", () => {
  it("abandons the read rather than wedging the loop", async () => {
    // The hard constraint this whole architecture exists for. A
    // read that never returns must cost one row, not the loop.
    const { store, samples } = recordingStore()

    const deps: SamplerDeps = {
      readCounters: () => new Promise(() => {}),
      now: () => Date.now(),
    }

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
        store,
      },
      deps,
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 3)
    const features = await sampler.stop(okOutcome)

    // Rows keep coming: "how long was this drive unreadable" is
    // exactly the measurement, and a hole in the timeline would
    // destroy it.
    expect(samples.length).toBeGreaterThanOrEqual(2)
    expect(
      samples.every((sample) => sample.isReadTimedOut),
    ).toBe(true)
    expect(features.timedOutReadCount).toBe(samples.length)
    expect(features.missingCounterSampleCount).toBe(
      samples.length,
    )
  })

  it("never queues a second read behind a stuck one", async () => {
    // Otherwise a wedged drive accumulates one dangling file
    // read every two seconds for the length of a three-hour rip.
    let readCount = 0

    const deps: SamplerDeps = {
      readCounters: () => {
        readCount += 1
        return new Promise(() => {})
      },
      now: () => Date.now(),
    }

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
      },
      deps,
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 10)
    await sampler.stop(okOutcome)

    expect(readCount).toBe(1)
  })

  it("times out well inside the sampling interval", () => {
    // A read still running when the next tick fires would let
    // ticks interleave, and every derived rate depends on the
    // intervals not overlapping.
    expect(SAMPLER_TUNING.readTimeoutMs).toBeLessThan(
      HEALTH_THRESHOLDS.sampleIntervalMs,
    )
  })

  it("records a rejected read as nulls, not as zeroes", async () => {
    const { store, samples } = recordingStore()

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
        store,
      },
      {
        readCounters: () =>
          Promise.reject(new Error("EIO")),
        now: () => Date.now(),
      },
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    await sampler.stop(okOutcome)

    expect(samples[0].ioErrorCount).toBeNull()
    expect(samples[0].hasCounters).toBe(false)
    // A rejection is not a timeout: the drive answered, with an
    // error. Conflating them would hide the distinction between
    // a dead node and a wedged one.
    expect(samples[0].isReadTimedOut).toBe(false)
  })
})

describe("a slow but answering drive", () => {
  it("skips a tick rather than overlapping two", async () => {
    let inFlight = 0
    let maxInFlight = 0

    const deps: SamplerDeps = {
      readCounters: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            SAMPLER_TUNING.readTimeoutMs - 100,
          ),
        )
        inFlight -= 1
        return healthyCounters(1_000)
      },
      now: () => Date.now(),
    }

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
      },
      deps,
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 5)
    await sampler.stop(okOutcome)

    expect(maxInFlight).toBe(1)
  })
})

describe("nine concurrent drives", () => {
  it("gives each its own loop, so one wedge costs one bay", async () => {
    // The owner has asked for nine concurrent rips. A single
    // shared loop iterating nine drives would have exactly the
    // failure mode the child-per-drive architecture forbids.
    const readCounts = new Map<string, number>()

    const deps = (isWedged: boolean): SamplerDeps => ({
      readCounters: async (kernelName) => {
        readCounts.set(
          kernelName,
          (readCounts.get(kernelName) ?? 0) + 1,
        )
        if (isWedged) return new Promise(() => {})
        return healthyCounters(1_000)
      },
      now: () => Date.now(),
    })

    const samplers = Array.from(
      { length: 9 },
      (_unused, index) =>
        startSampler(
          {
            driveId: `bay-0${index + 1}`,
            kernelName: `sr${index}`,
            jobId: `job-${index}`,
            discBytes: 1,
            startedAtMs: Date.now(),
          },
          deps(index === 2),
        ),
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 4)

    const features = await Promise.all(
      samplers.map((sampler) => sampler.stop(okOutcome)),
    )

    // The wedged bay stops reading but keeps producing rows.
    expect(readCounts.get("sr2")).toBe(1)
    expect(features[2].timedOutReadCount).toBeGreaterThan(0)

    // Every other bay is untouched by it.
    for (const index of [0, 1, 3, 4, 5, 6, 7, 8]) {
      expect(features[index].timedOutReadCount).toBe(0)
      expect(features[index].sampleCount).toBe(4)
    }
  })
})

describe("buildRipContext", () => {
  it("reads MakeMKV's view out of the live tracker", () => {
    const tracker = createProgressTracker({
      discBytes: 34_535_584_646,
      startedAtMs: 0,
    })

    const context = buildRipContext({
      tracker: {
        ...tracker,
        filesAdded: 12,
        lastForwardProgressAtMs: 1_000,
        lastEventAtMs: 4_000,
        progress: {
          ...tracker.progress,
          totalLabel: "Copying file",
          totalFraction: 0.13,
          throughputBytesPerSec: 21_000_000,
          etaSeconds: 1_400,
          etaTrend: "rising",
        },
      },
      nowMs: 5_000,
      readErrorCount: 0,
      livenessKind: "working",
    })

    expect(context.stageLabel).toBe("Copying file")
    expect(context.etaTrend).toBe("rising")
    expect(context.msSinceProgress).toBe(4_000)
    expect(context.msSinceEvent).toBe(1_000)
    expect(context.filesAdded).toBe(12)
  })

  it("stamps the stage on every row it feeds", async () => {
    // Load-bearing: every PRGT restarts PRGV from zero, so a row
    // without its stage cannot be grouped correctly later — and
    // grouping it wrongly is what produced a false ETA alarm on
    // a perfectly healthy rip.
    const { store, samples } = recordingStore()

    const tracker = createProgressTracker({
      discBytes: 1,
      startedAtMs: 0,
    })

    let stageLabel = "Decrypting"

    const sampler = startSampler(
      {
        driveId: "bay-09",
        kernelName: "sr0",
        jobId: "job-1",
        discBytes: 1,
        startedAtMs: Date.now(),
        store,
        readRipContext: () =>
          buildRipContext({
            tracker: {
              ...tracker,
              progress: {
                ...tracker.progress,
                totalLabel: stageLabel,
              },
            },
            nowMs: Date.now(),
            readErrorCount: 0,
          }),
      },
      {
        readCounters: async () => healthyCounters(1_000),
        now: () => Date.now(),
      },
    )

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    stageLabel = "Copying file"
    await vi.advanceTimersByTimeAsync(SAMPLE_MS)

    const features = await sampler.stop(okOutcome)

    expect(samples[0].stageLabel).toBe("Decrypting")
    expect(samples[1].stageLabel).toBe("Copying file")
    expect(
      features.stages.map((stage) => stage.label),
    ).toEqual(["Decrypting", "Copying file"])
  })
})

/**
 * The gate between a computed verdict and a reported one.
 *
 * The judge is a STUB here on purpose. `health/jobVerdict.test.ts`
 * proves the engine reaches sensible answers from real job rows;
 * these prove that it does not matter WHAT the engine answers —
 * while the gate is shut, nothing it says is stamped on the job.
 * That includes the two answers a reader would most want to
 * believe: `ok` on a rip that had read errors, and
 * `drive_failing`, which is `confirmed` and would therefore be
 * announceable if anything ever handed it to MQTT.
 */

/** A judge that always answers `kind`, published or not. */
const judgeSaying = (input: {
  kind: VerdictKind
  isPublished: boolean
  confidence?: VerdictConfidence
}): JobJudge => {
  return (
    vector: JobFeatureVector,
  ): ComputedJobVerdict => ({
    schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
    jobId: vector.jobId,
    driveId: vector.driveId,
    computedAtMs: vector.endedAtMs,
    isPublished: input.isPublished,
    verdict: makeVerdict(
      input.kind,
      input.confidence ?? "confirmed",
      ["stub"],
    ),
    observation: {
      driveId: vector.driveId,
      hubChain: [],
      recentThroughput: [],
      avgMsPerRead: null,
      ioErrorDelta: 0,
      errorLbas: [],
      msSinceProgress: 0,
      enumerationEvents: 0,
      hasKeyExpired: false,
      hasSecondDriveAgreement: false,
      hasCrossDiscHistory: false,
    },
    thresholds: HEALTH_THRESHOLDS,
  })
}

const samplerWith = (store: SampleStore) =>
  startSampler(
    {
      driveId: "2-1.1.2.3",
      kernelName: "sr2",
      jobId: "job-1",
      discBytes: 46_659_338_240,
      startedAtMs: Date.now(),
      store,
    },
    {
      readCounters: async () => healthyCounters(84_000),
      now: () => Date.now(),
    },
  )

const ALL_KINDS: VerdictKind[] = [
  "ok",
  "hub_fault",
  "key_expired",
  "drive_failing",
  "enumeration_flap",
  "disc_scratched",
  "disc_dirty",
  "disc_marginal_slow",
  "unknown",
]

describe("the health engine wire", () => {
  it("runs the judge against the sealed vector", async () => {
    // The whole unit: the engine is now called on the real path
    // for every job, with the row the sampler just sealed.
    const { store } = recordingStore()
    const seen: JobFeatureVector[] = []
    const sampler = samplerWith(store)

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2)
    await sampler.stop(
      { ...okOutcome, verdictKind: null },
      (vector) => {
        seen.push(vector)
        return judgeSaying({
          kind: "ok",
          isPublished: false,
        })(vector)
      },
    )

    expect(seen).toHaveLength(1)
    expect(seen[0].sampleCount).toBe(2)
    expect(seen[0].driveId).toBe("2-1.1.2.3")
    // The judge sees the measurement, never its own answer.
    expect(seen[0].outcome.verdictKind).toBeNull()
  })

  it("records the verdict beside the evidence", async () => {
    const { store, verdicts, written } = recordingStore()
    const sampler = samplerWith(store)

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    await sampler.stop(
      okOutcome,
      judgeSaying({
        kind: "disc_dirty",
        isPublished: false,
      }),
    )

    // Persisted, so the eventual tuning pass can ask "what would
    // the engine have said" across every historical job.
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].verdict.kind).toBe("disc_dirty")
    expect(verdicts[0].isPublished).toBe(false)
    expect(written).toHaveLength(1)
  })

  it.each(ALL_KINDS)(
    "does not let a computed %s reach the job's outcome",
    async (kind) => {
      // ⚠️ THE test. Whatever the engine says — including `ok`
      // and every `confirmed` failure kind — a shut gate means
      // the job's persisted verdict stays null. Nothing
      // downstream can read a verdict that was never written,
      // and nothing can announce one.
      const { store, written } = recordingStore()
      const sampler = samplerWith(store)

      await vi.advanceTimersByTimeAsync(SAMPLE_MS)
      const features = await sampler.stop(
        { ...okOutcome, verdictKind: null },
        judgeSaying({ kind, isPublished: false }),
      )

      expect(features.outcome.verdictKind).toBeNull()
      expect(written[0].outcome.verdictKind).toBeNull()
    },
  )

  it.each(ALL_KINDS)(
    "carries a published %s through once the gate opens",
    async (kind) => {
      // The switch is proved before it is ever thrown: flipping
      // `IS_HEALTH_VERDICT_PUBLISHED` genuinely makes the wire
      // carry the engine's answer, so nobody has to write this
      // path for the first time against live data.
      const { store, written } = recordingStore()
      const sampler = samplerWith(store)

      await vi.advanceTimersByTimeAsync(SAMPLE_MS)
      const features = await sampler.stop(
        { ...okOutcome, verdictKind: null },
        judgeSaying({ kind, isPublished: true }),
      )

      expect(features.outcome.verdictKind).toBe(kind)
      expect(written[0].outcome.verdictKind).toBe(kind)
    },
  )

  it("cannot upgrade a rip that already failed", async () => {
    // `AGENTS.md`, the rule that overrides everything: never
    // report success on a rip that had read errors.
    // `isRipSuccessful` has already spoken by the time the engine
    // runs, and a verdict — even a published `ok` — travels
    // alongside that answer, never over it.
    const { store, written } = recordingStore()
    const sampler = samplerWith(store)

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    const features = await sampler.stop(
      {
        isSuccessful: false,
        failureReason: "read_errors",
        exitCode: 0,
        verdictKind: null,
      },
      judgeSaying({ kind: "ok", isPublished: true }),
    )

    expect(features.outcome.isSuccessful).toBe(false)
    expect(features.outcome.failureReason).toBe(
      "read_errors",
    )
    expect(written[0].outcome.isSuccessful).toBe(false)
  })

  it("costs the verdict, not the corpus, when it throws", async () => {
    // Same rule as every other write on this path: losing a
    // three-hour rip to a diagnostic is far worse than losing one
    // row of a tuning corpus.
    const { store, written, verdicts, isClosed } =
      recordingStore()
    const sampler = samplerWith(store)

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    const features = await sampler.stop(
      { ...okOutcome, verdictKind: null },
      () => {
        throw new Error("engine blew up")
      },
    )

    expect(written).toHaveLength(1)
    expect(features.sampleCount).toBe(1)
    expect(features.outcome.verdictKind).toBeNull()
    expect(verdicts).toHaveLength(0)
    expect(isClosed()).toBe(true)
  })

  it("judges nothing when nobody asked", async () => {
    // A sampler stopped without a judge behaves exactly as it
    // did before the engine was wired.
    const { store, verdicts, written } = recordingStore()
    const sampler = samplerWith(store)

    await vi.advanceTimersByTimeAsync(SAMPLE_MS)
    await sampler.stop(okOutcome)

    expect(verdicts).toHaveLength(0)
    expect(written[0].outcome.verdictKind).toBe("ok")
  })
})
