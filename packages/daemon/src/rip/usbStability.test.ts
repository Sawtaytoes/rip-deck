import { describe, expect, it } from "vitest"
import {
  detectTransitions,
  pruneTransitions,
  summariseUsbStability,
  type UsbTransition,
} from "./usbStability.ts"

const presence = (
  entries: Record<string, boolean>,
): Map<string, boolean> => new Map(Object.entries(entries))

describe("detecting presence flips between polls", () => {
  it("reports a drive that went absent", () => {
    expect(
      detectTransitions({
        previous: presence({ "2-2.3": true }),
        current: presence({ "2-2.3": false }),
        atMs: 1000,
      }),
    ).toEqual([{ driveId: "2-2.3", atMs: 1000 }])
  })

  it("reports a drive that came back", () => {
    expect(
      detectTransitions({
        previous: presence({ "2-2.3": false }),
        current: presence({ "2-2.3": true }),
        atMs: 2000,
      }),
    ).toEqual([{ driveId: "2-2.3", atMs: 2000 }])
  })

  it("says nothing when presence is unchanged", () => {
    expect(
      detectTransitions({
        previous: presence({
          "2-2.3": true,
          "2-2.4": true,
        }),
        current: presence({ "2-2.3": true, "2-2.4": true }),
        atMs: 3000,
      }),
    ).toEqual([])
  })

  it("does not count a first sighting as a flip", () => {
    // The first poll's `previous` is empty; every present drive is
    // being DISCOVERED, not flapping. Counting it would alarm on
    // every startup.
    expect(
      detectTransitions({
        previous: presence({}),
        current: presence({ "2-2.3": true, "2-2.4": true }),
        atMs: 4000,
      }),
    ).toEqual([])
  })
})

describe("pruning edges out of the window", () => {
  it("keeps edges inside the window and drops the rest", () => {
    const transitions: UsbTransition[] = [
      { driveId: "2-2.3", atMs: 100 },
      { driveId: "2-2.3", atMs: 900 },
    ]

    expect(
      pruneTransitions({
        transitions,
        nowMs: 1000,
        windowMs: 500,
      }),
    ).toEqual([{ driveId: "2-2.3", atMs: 900 }])
  })
})

describe("folding edges into a bus-wide answer", () => {
  const flap = (
    driveId: string,
    atMs: number,
  ): UsbTransition => ({
    driveId,
    atMs,
  })

  it("calls the bus stable when a drive only power-cycled", () => {
    // Off once, on once: two edges spread apart is a power cycle
    // (F3), not a flap. Under the threshold, so no alarm.
    const stability = summariseUsbStability({
      transitions: [
        flap("2-2.3", 100),
        flap("2-2.3", 5000),
      ],
      nowMs: 6000,
      windowMs: 300_000,
      flapMinEvents: 3,
    })

    expect(stability.isUnstable).toBe(false)
    expect(stability.flappingDriveIds).toEqual([])
  })

  it("flags a drive that crossed back and forth repeatedly", () => {
    const stability = summariseUsbStability({
      transitions: [
        flap("2-2.3", 100),
        flap("2-2.3", 200),
        flap("2-2.3", 300),
      ],
      nowMs: 1000,
      windowMs: 300_000,
      flapMinEvents: 3,
    })

    expect(stability.isUnstable).toBe(true)
    expect(stability.flappingDriveIds).toEqual(["2-2.3"])
    expect(stability.transitionCount).toBe(3)
  })

  it("ignores edges that have aged out of the window", () => {
    // Three edges, but the oldest two are older than the window,
    // so only one counts — below the threshold.
    const stability = summariseUsbStability({
      transitions: [
        flap("2-2.3", 100),
        flap("2-2.3", 200),
        flap("2-2.3", 400_000),
      ],
      nowMs: 400_000,
      windowMs: 300_000,
      flapMinEvents: 3,
    })

    expect(stability.isUnstable).toBe(false)
  })
})
