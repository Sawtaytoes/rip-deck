import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  createProgressTracker,
  observeEvent,
  PROGRESS_TUNING,
  type ProgressTracker,
} from "./progress.ts"

const GB = 1024 ** 3
const DISC_BYTES = 25 * GB
const START = 1_000_000

const tracker = (): ProgressTracker =>
  createProgressTracker({
    discBytes: DISC_BYTES,
    startedAtMs: START,
  })

const feed = (
  initial: ProgressTracker,
  lines: [line: string, atMs: number][],
): ProgressTracker =>
  lines.reduce(
    (current, [line, atMs]) =>
      observeEvent({
        tracker: current,
        event: parseMakemkvLine(line),
        atMs,
      }),
    initial,
  )

/** PRGV against a max of 65536, the common but NOT assumed case. */
const prgv = (
  current: number,
  total: number,
  max = 65536,
) => `PRGV:${current},${total},${max}`

describe("two-level progress (C5)", () => {
  it("tracks current and total separately", () => {
    const result = feed(tracker(), [
      ['PRGT:5005,0,"Saving all titles to MKV"', START],
      ['PRGC:5006,0,"Saving title 3"', START],
      [prgv(32768, 16384), START],
    ])

    expect(result.progress.totalFraction).toBeCloseTo(0.25)
    expect(result.progress.currentFraction).toBeCloseTo(0.5)
    expect(result.progress.totalLabel).toBe(
      "Saving all titles to MKV",
    )
    expect(result.progress.currentLabel).toBe(
      "Saving title 3",
    )
  })

  it("scales against max, which is not always 65536", () => {
    const result = feed(tracker(), [
      [prgv(50, 25, 100), START],
    ])

    expect(result.progress.totalFraction).toBeCloseTo(0.25)
    expect(result.progress.currentFraction).toBeCloseTo(0.5)
  })

  it("ignores a zero max instead of producing Infinity", () => {
    // Seen before the first real value. Dividing by it unguarded
    // poisons every derived figure downstream.
    const result = feed(tracker(), [[prgv(1, 1, 0), START]])

    expect(result.progress.totalFraction).toBe(0)
    expect(result.progress.etaSeconds).toBeNull()
  })
})

describe("throughput and ETA", () => {
  it("reports null until two samples exist", () => {
    const result = feed(tracker(), [[prgv(0, 6553), START]])

    // A fabricated rate would render as a confident lie and
    // would feed the health baseline.
    expect(result.progress.throughputBytesPerSec).toBeNull()
    expect(result.progress.etaSeconds).toBeNull()
  })

  it("derives bytes/sec from progress over wall clock", () => {
    // 10% of 25 GB in 10 seconds = 256 MB/s.
    const result = feed(tracker(), [
      [prgv(0, 0), START],
      [prgv(0, 6554), START + 10_000],
    ])

    const rate = result.progress.throughputBytesPerSec
    expect(rate).not.toBeNull()
    expect(rate as number).toBeGreaterThan(250 * 1024 ** 2)
    expect(rate as number).toBeLessThan(270 * 1024 ** 2)
  })

  it("estimates remaining time from the measured rate", () => {
    const result = feed(tracker(), [
      [prgv(0, 0), START],
      [prgv(0, 32768), START + 100_000],
    ])

    // Half the disc in 100 s, so about 100 s left.
    expect(result.progress.etaSeconds).toBeGreaterThan(90)
    expect(result.progress.etaSeconds).toBeLessThan(110)
  })
})

describe("a rising ETA is an alarm, not decoration (C6)", () => {
  it("reports falling while the rip accelerates away", () => {
    const result = feed(tracker(), [
      [prgv(0, 0), START],
      [prgv(0, 6554), START + 10_000],
      [prgv(0, 26214), START + 20_000],
      [prgv(0, 45875), START + 30_000],
    ])

    expect(result.progress.etaTrend).toBe("falling")
  })

  it("reports rising when throughput collapses", () => {
    // Fast for ten seconds, then a crawl: the remaining work is
    // suddenly going to take far longer than it did a moment ago.
    const result = feed(tracker(), [
      [prgv(0, 0), START],
      [prgv(0, 13107), START + 10_000],
      [prgv(0, 13110), START + 40_000],
      [prgv(0, 13113), START + 55_000],
    ])

    expect(result.progress.etaTrend).toBe("rising")
  })

  it("ages samples out of the trend window", () => {
    const result = feed(tracker(), [
      [prgv(0, 0), START],
      [prgv(0, 6554), START + 10_000],
      [prgv(0, 13107), START + 20_000],
      [
        prgv(0, 26214),
        START + PROGRESS_TUNING.etaTrendWindowMs + 60_000,
      ],
    ])

    // Stale samples are dropped, but never below the two needed
    // to still say something — a struggling drive emits PRGV
    // sparsely, and going silent about the rate exactly when it
    // collapses would be the wrong way round.
    expect(result.etaSamples.length).toBe(2)
    expect(result.progress.etaTrend).not.toBeNull()
  })
})

describe("forward progress vs mere output", () => {
  it("advances the progress clock only on a real increase", () => {
    const result = feed(tracker(), [
      [prgv(0, 16384), START],
      // makemkvcon happily re-emits the same value forever while
      // the sr layer retries beneath it. Treating that as
      // liveness is how a stall goes unnoticed for 40 minutes.
      [prgv(0, 16384), START + 30_000],
      [prgv(0, 16384), START + 60_000],
    ])

    expect(result.lastForwardProgressAtMs).toBe(START)
    // But we did still hear from it — that is what separates
    // hung from dead.
    expect(result.lastEventAtMs).toBe(START + 60_000)
  })

  it("counts a current-only advance as forward progress", () => {
    // Between titles the total can sit still while the current
    // file advances. That is genuinely working.
    const result = feed(tracker(), [
      [prgv(1000, 16384), START],
      [prgv(2000, 16384), START + 5_000],
    ])

    expect(result.lastForwardProgressAtMs).toBe(
      START + 5_000,
    )
  })

  it("updates lastEventAtMs for non-progress lines too", () => {
    const result = feed(tracker(), [
      ['MSG:1005,0,0,"Hello","%1","x"', START + 3_000],
    ])

    expect(result.lastEventAtMs).toBe(START + 3_000)
  })
})

describe("per-title completion", () => {
  it("counts FILE_ADDED against TCOUNT", () => {
    const fileAdded =
      'MSG:3307,0,2,"Title saved","%1 saved","title.mkv"'

    const result = feed(tracker(), [
      ["TCOUNT:5", START],
      [fileAdded, START + 1_000],
      [fileAdded, START + 2_000],
    ])

    expect(result.progress.fileIndex).toBe(2)
    expect(result.progress.fileCount).toBe(5)
  })
})

describe("crossing a stage boundary", () => {
  // Every assertion here is a replay of what the first real
  // Blu-ray rip actually emitted, 2026-07-25. A BD runs several
  // preliminary operations before the copy, and each drives PRGV
  // a full 0 -> max against the SAME counter the copy later
  // uses.
  const throughPreamble = (): ProgressTracker =>
    feed(tracker(), [
      ['PRGT:5018,0,"Scanning CD-ROM devices"', START],
      [prgv(0, 0), START + 100],
      [prgv(65536, 65536), START + 2_000],
      [
        'PRGT:5019,0,"Saving all titles to hard drive"',
        START + 3_000,
      ],
    ])

  it("does not carry the old ETA across the boundary", () => {
    // The preamble ran the counter to 100%, so "remaining bytes"
    // was near zero and the ETA with it. Keeping those samples
    // makes the copy stage's real ETA look like a vertical climb.
    const after = throughPreamble()

    expect(after.progress.etaSeconds).toBeNull()
    expect(after.progress.etaTrend).toBeNull()
    expect(after.etaSamples).toHaveLength(0)
  })

  it("does not report a rising ETA on a healthy rip", () => {
    // The false alarm as it actually appeared: every printed line
    // for a full etaTrendWindowMs carried "(ETA RISING)" while
    // the drive was doing 18 MB/s and the ETA was falling.
    // C6's value is that a rising ETA means something is wrong,
    // so an alarm at the head of every rip is worse than none.
    const after = feed(throughPreamble(), [
      [prgv(0, 655), START + 4_000],
      [prgv(0, 1_310), START + 6_000],
      [prgv(0, 1_965), START + 8_000],
      [prgv(0, 2_620), START + 10_000],
    ])

    expect(after.progress.etaTrend).not.toBe("rising")
  })

  it("restarts the byte count from the new operation", () => {
    const after = feed(throughPreamble(), [
      [prgv(0, 6_553), START + 4_000],
    ])

    // ~10% of the disc, not 110% of it.
    expect(after.progress.bytesWritten).toBe(
      Math.round((6_553 / 65_536) * DISC_BYTES),
    )
  })

  it("keeps the window when PRGT merely repeats", () => {
    // MakeMKV re-emits the current PRGT rather than only sending
    // it on change. Treating each repeat as a new operation
    // would clear the throughput window continuously and leave
    // the rate permanently unknown.
    const after = feed(tracker(), [
      [
        'PRGT:5019,0,"Saving all titles to hard drive"',
        START,
      ],
      [prgv(0, 655), START + 2_000],
      [prgv(0, 1_310), START + 4_000],
      [
        'PRGT:5019,0,"Saving all titles to hard drive"',
        START + 5_000,
      ],
      [prgv(0, 1_965), START + 6_000],
    ])

    expect(
      after.progress.throughputBytesPerSec,
    ).not.toBeNull()
  })
})
