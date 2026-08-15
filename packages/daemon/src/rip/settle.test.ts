import { EMPTY_TRAY_SECTORS } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  SETTLE_TUNING,
  type SettleDeps,
  waitForSettledMedia,
} from "./settle.ts"

/**
 * The three-layer settle (E8). Layer 1 is the udev rule and
 * lives outside this process; layers 2 and 3 are here.
 *
 * A virtual clock is used rather than real timers, so the
 * six-second debounce and the two-second stability window are
 * asserted exactly and instantly.
 */

const harness = (sizesInOrder: (number | null)[]) => {
  let nowMs = 0
  let readCount = 0

  const deps: SettleDeps = {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms
    },
    readSizeSectors: async () => {
      const value =
        sizesInOrder[
          Math.min(readCount, sizesInOrder.length - 1)
        ]
      readCount += 1
      return value
    },
  }

  return {
    deps,
    run: () =>
      waitForSettledMedia({ kernelName: "sr0" }, deps),
    elapsed: () => nowMs,
    readCount: () => readCount,
  }
}

const BLURAY_SECTORS = 25 * 1024 * 1024 * 2

describe("layer 2 — the debounce", () => {
  it("waits before reading anything at all", async () => {
    const { deps, readCount } = harness([BLURAY_SECTORS])
    let hasReadEarly = false

    const wrapped: SettleDeps = {
      ...deps,
      sleep: async (ms) => {
        if (ms === SETTLE_TUNING.debounceMs) {
          hasReadEarly = readCount() > 0
        }
        await deps.sleep(ms)
      },
    }

    await waitForSettledMedia(
      { kernelName: "sr0" },
      wrapped,
    )

    // One insertion raises several events as the drive spins up
    // and the kernel re-reads the TOC. Acting on the first reads
    // a size that is not finished changing.
    expect(hasReadEarly).toBe(false)
  })
})

describe("layer 3 — size stable across a window", () => {
  it("reports ready once the size holds", async () => {
    const { run } = harness([BLURAY_SECTORS])
    const result = await run()

    expect(result.kind).toBe("ready")
    if (result.kind === "ready") {
      expect(result.discType).toBe("bluray")
      expect(result.capacityBytes).toBe(
        BLURAY_SECTORS * 512,
      )
    }
  })

  it("keeps waiting while the size is still moving", async () => {
    const { run, elapsed } = harness([
      1000,
      2000,
      3000,
      BLURAY_SECTORS,
    ])

    const result = await run()

    expect(result.kind).toBe("ready")
    // It cannot have settled before the debounce plus at least
    // one full stability window.
    expect(elapsed()).toBeGreaterThanOrEqual(
      SETTLE_TUNING.debounceMs + SETTLE_TUNING.sizeStableMs,
    )
  })
})

describe("an empty tray is not a tiny disc", () => {
  it("treats the 1 GiB sentinel as no media", async () => {
    // The kernel reports 2097151 sectors for an empty or
    // unreadable tray. It is a STABLE value, so it arrives at
    // layer 3 looking exactly like a settled disc.
    const { run } = harness([EMPTY_TRAY_SECTORS])

    expect((await run()).kind).toBe("no_media")
  })

  it("treats an unreadable size as no media", async () => {
    const { run } = harness([null])

    expect((await run()).kind).toBe("no_media")
  })
})

describe("giving up", () => {
  it("times out rather than spinning forever", async () => {
    let counter = 0
    const deps: SettleDeps = {
      now: () => counter * 100,
      sleep: async () => {
        counter += 5
      },
      // Never stops changing — a drive that cannot read the TOC.
      readSizeSectors: async () => counter * 7,
    }

    const result = await waitForSettledMedia(
      { kernelName: "sr0" },
      deps,
    )

    // B3: fail closed. The disc stays in the drive and is
    // flagged; it is emphatically NOT ejected, because the eject
    // loop is what caused the flap-storm.
    expect(result.kind).toBe("timed_out")
  })
})
