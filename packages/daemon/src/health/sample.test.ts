import {
  EMPTY_TRAY_SECTORS,
  HEALTH_FEATURE_SCHEMA_VERSION,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  buildHealthSample,
  counterDelta,
  createSampleState,
  type DriveCounters,
  type RipContext,
  type SampleState,
} from "./sample.ts"

/**
 * The per-sample fold. Pure, so a rip's whole sampling timeline
 * is asserted here instantly and without a drive.
 *
 * These tests prove the arithmetic. They say NOTHING about
 * whether the resulting numbers describe a struggling disc
 * correctly — no struggling disc has ever been sampled.
 */

const counters = (
  overrides: Partial<{
    ioErrorCount: number | null
    readsCompleted: number
    sectorsRead: number
    readTicksMs: number
    sizeSectors: number | null
  }> = {},
): DriveCounters => ({
  ioErrorCount: overrides.ioErrorCount ?? 0,
  stat: {
    readsCompleted: overrides.readsCompleted ?? 0,
    sectorsRead: overrides.sectorsRead ?? 0,
    readTicksMs: overrides.readTicksMs ?? 0,
  },
  sizeSectors: overrides.sizeSectors ?? 25_000_000,
})

const take = (input: {
  state: SampleState
  atMs: number
  counters: DriveCounters | null
  context?: RipContext | null
  isReadTimedOut?: boolean
}) =>
  buildHealthSample({
    state: input.state,
    driveId: "bay-09",
    kernelName: "sr0",
    jobId: "job-1",
    startedAtMs: 0,
    atMs: input.atMs,
    counters: input.counters,
    context: input.context ?? null,
    isReadTimedOut: input.isReadTimedOut ?? false,
  })

const emptyContext: RipContext = {
  stageLabel: null,
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
}

describe("counterDelta", () => {
  it("is the plain increase", () => {
    expect(counterDelta(10, 42)).toBe(32)
  })

  it("is null when either end is unknown", () => {
    expect(counterDelta(null, 42)).toBeNull()
    expect(counterDelta(10, null)).toBeNull()
  })

  it("refuses a decrease rather than reporting it", () => {
    // A counter going backwards is the drive re-enumerating and
    // sysfs resetting. Reported as a negative it would let one
    // re-plug cancel out a job's accumulated errors.
    expect(counterDelta(90, 3)).toBeNull()
  })
})

describe("the first sample", () => {
  it("has no interval and therefore no rates", () => {
    const { sample } = take({
      state: createSampleState(),
      atMs: 2_000,
      counters: counters({ sectorsRead: 1_000 }),
    })

    expect(sample.intervalMs).toBeNull()
    expect(sample.counterIntervalMs).toBeNull()
    expect(sample.sectorsReadDelta).toBeNull()
    expect(sample.driveThroughputBytesPerSec).toBeNull()
    expect(sample.sequence).toBe(0)
    expect(sample.schemaVersion).toBe(
      HEALTH_FEATURE_SCHEMA_VERSION,
    )
  })

  it("still records the raw counters", () => {
    const { sample } = take({
      state: createSampleState(),
      atMs: 2_000,
      counters: counters({
        ioErrorCount: 92,
        sectorsRead: 1_000,
      }),
    })

    expect(sample.ioErrorCount).toBe(92)
    expect(sample.sectorsRead).toBe(1_000)
    expect(sample.hasCounters).toBe(true)
  })
})

describe("throughput", () => {
  it("is sectors x 512 over the interval", () => {
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({ sectorsRead: 0 }),
    })

    const { sample } = take({
      state: first.state,
      atMs: 2_000,
      // 2 s at 21 MB/s, the measured rate of the real rip.
      counters: counters({ sectorsRead: 84_000 }),
    })

    expect(sample.driveThroughputBytesPerSec).toBe(
      (84_000 * 512) / 2,
    )
  })

  it("spans the gap when a read failed in between", () => {
    // The trap: after a failed read the delta covers two
    // intervals. Divided by the cadence it would report double
    // the real rate — a fabricated doubling at exactly the
    // moment the drive misbehaved.
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({ sectorsRead: 0 }),
    })

    const missed = take({
      state: first.state,
      atMs: 2_000,
      counters: null,
      isReadTimedOut: true,
    })

    const { sample } = take({
      state: missed.state,
      atMs: 4_000,
      counters: counters({ sectorsRead: 84_000 }),
    })

    expect(sample.intervalMs).toBe(2_000)
    expect(sample.counterIntervalMs).toBe(4_000)
    expect(sample.driveThroughputBytesPerSec).toBe(
      (84_000 * 512) / 4,
    )
  })
})

describe("the invisible-retry signature", () => {
  it("reports ms/read and read utilisation", () => {
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({
        readsCompleted: 0,
        readTicksMs: 0,
      }),
    })

    const { sample } = take({
      state: first.state,
      atMs: 2_000,
      counters: counters({
        readsCompleted: 4,
        readTicksMs: 1_900,
      }),
    })

    expect(sample.avgMsPerRead).toBe(475)
    expect(sample.readUtilisation).toBe(0.95)
  })

  it("declines to divide by zero completed reads", () => {
    // A drive can spend a whole interval inside one command and
    // complete none of it. That is the most interesting case
    // there is, and it must not produce Infinity.
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({
        readsCompleted: 7,
        readTicksMs: 100,
      }),
    })

    const { sample } = take({
      state: first.state,
      atMs: 2_000,
      counters: counters({
        readsCompleted: 7,
        readTicksMs: 2_100,
      }),
    })

    expect(sample.avgMsPerRead).toBeNull()
    expect(sample.readUtilisation).toBe(1)
  })
})

describe("a failed read", () => {
  it("is a row of nulls, not a row of zeroes", () => {
    // A zero error counter and an unreadable one are opposite
    // evidence, and a health engine cannot tell them apart once
    // the difference has been flattened.
    const { sample } = take({
      state: createSampleState(),
      atMs: 2_000,
      counters: null,
      isReadTimedOut: true,
    })

    expect(sample.ioErrorCount).toBeNull()
    expect(sample.sectorsRead).toBeNull()
    expect(sample.hasCounters).toBe(false)
    expect(sample.isReadTimedOut).toBe(true)
  })

  it("does not become the baseline for the next delta", () => {
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({ ioErrorCount: 92 }),
    })

    const missed = take({
      state: first.state,
      atMs: 2_000,
      counters: null,
    })

    const { sample } = take({
      state: missed.state,
      atMs: 4_000,
      counters: counters({ ioErrorCount: 95 }),
    })

    expect(sample.ioErrorDelta).toBe(3)
  })
})

describe("the empty tray", () => {
  it("is flagged rather than treated as a small disc", () => {
    // 2097151 sectors is a stable 1 GiB sentinel that reaches
    // every check looking exactly like real media.
    const { sample } = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({
        sizeSectors: EMPTY_TRAY_SECTORS,
      }),
    })

    expect(sample.isEmptyTraySentinel).toBe(true)
  })

  it("is not flagged for a real Blu-ray", () => {
    const { sample } = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters({ sizeSectors: 50_000_000 }),
    })

    expect(sample.isEmptyTraySentinel).toBe(false)
  })
})

describe("the PRGT stage", () => {
  it("restarts its elapsed clock on a new stage", () => {
    // Every PRGT restarts PRGV from zero, so anything measured
    // across the boundary is two unrelated series added
    // together — the defect behind the false ETA alarm.
    const first = take({
      state: createSampleState(),
      atMs: 0,
      counters: counters(),
      context: {
        ...emptyContext,
        stageLabel: "Decrypting",
      },
    })

    const second = take({
      state: first.state,
      atMs: 20_000,
      counters: counters(),
      context: {
        ...emptyContext,
        stageLabel: "Decrypting",
      },
    })

    const third = take({
      state: second.state,
      atMs: 25_000,
      counters: counters(),
      context: {
        ...emptyContext,
        stageLabel: "Copying file",
      },
    })

    expect(second.sample.stageElapsedMs).toBe(20_000)
    expect(third.sample.stageElapsedMs).toBe(0)
    expect(third.sample.stageLabel).toBe("Copying file")
  })
})

describe("the MakeMKV context", () => {
  it("is copied through verbatim for later query", () => {
    const { sample } = take({
      state: createSampleState(),
      atMs: 1_000,
      counters: counters(),
      context: {
        stageLabel: "Copying file",
        progressFraction: 0.13,
        currentFraction: 0.5,
        bytesWritten: 4_000_000_000,
        ripThroughputBytesPerSec: 15_500_000,
        etaSeconds: 1_800,
        etaTrend: "rising",
        filesAdded: 12,
        readErrorCount: 0,
        msSinceProgress: 200,
        msSinceEvent: 40,
        livenessKind: "working",
      },
    })

    expect(sample.etaTrend).toBe("rising")
    expect(sample.progressFraction).toBe(0.13)
    expect(sample.ripThroughputBytesPerSec).toBe(15_500_000)
    expect(sample.livenessKind).toBe("working")
  })

  it("is all null when no rip is attached", () => {
    // Sampling an idle drive is the control group, not an error.
    const { sample } = take({
      state: createSampleState(),
      atMs: 1_000,
      counters: counters(),
      context: null,
    })

    expect(sample.etaTrend).toBeNull()
    expect(sample.stageLabel).toBeNull()
    expect(sample.hasCounters).toBe(true)
  })
})
