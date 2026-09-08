import { describe, expect, it } from "vitest"
import { sortRips } from "./ripSort"
import { buildRip } from "./testing/buildRip"
import type { Rip } from "./types"

const rip = (id: string, overrides: Partial<Rip>): Rip =>
  buildRip({
    job_uuid: id,
    drive_id: `drive-${id}`,
    ...overrides,
  })

const ids = (rips: Rip[]): string[] =>
  rips.map((item) => item.job_uuid)

describe("slot-number order", () => {
  it("sorts numbered slots ascending and leaves unknown slots last", () => {
    const input = [
      rip("slot-8", { slot: 8 }),
      rip("unknown", { slot: null }),
      rip("slot-2-a", { slot: 2 }),
      rip("slot-2-b", { slot: 2 }),
    ]

    expect(ids(sortRips(input, "slot"))).toEqual([
      "slot-2-a",
      "slot-2-b",
      "slot-8",
      "unknown",
    ])
    expect(ids(input)).toEqual([
      "slot-8",
      "unknown",
      "slot-2-a",
      "slot-2-b",
    ])
  })
})

describe("finishing-soonest order", () => {
  it("leads with valid active ETAs and breaks equal ETAs by slot", () => {
    const input = [
      rip("unknown-active", {
        slot: 1,
        active: true,
        eta_seconds: null,
      }),
      rip("two-minutes-slot-9", {
        slot: 9,
        active: true,
        eta_seconds: 120,
      }),
      // A completed rip can retain its last ETA. It cannot finish
      // soon because it is already finished, so it is a fallback.
      rip("inactive-stale-eta", {
        slot: 2,
        active: false,
        eta_seconds: 1,
      }),
      rip("two-minutes-slot-7", {
        slot: 7,
        active: true,
        eta_seconds: 120,
      }),
      rip("invalid-eta", {
        slot: 3,
        active: true,
        eta_seconds: Number.POSITIVE_INFINITY,
      }),
      rip("one-minute", {
        slot: 8,
        active: true,
        eta_seconds: 60,
      }),
    ]

    expect(
      ids(sortRips(input, "finishing-soonest")),
    ).toEqual([
      "one-minute",
      "two-minutes-slot-7",
      "two-minutes-slot-9",
      "unknown-active",
      "inactive-stale-eta",
      "invalid-eta",
    ])
  })

  it("keeps fallback items stable when their slot cannot break the tie", () => {
    const input = [
      rip("unknown-a", {
        slot: null,
        active: true,
        eta_seconds: null,
      }),
      rip("inactive-b", {
        slot: null,
        active: false,
        eta_seconds: 30,
      }),
      rip("zero-c", {
        slot: null,
        active: true,
        eta_seconds: 0,
      }),
    ]

    expect(
      ids(sortRips(input, "finishing-soonest")),
    ).toEqual(["unknown-a", "inactive-b", "zero-c"])
  })
})
