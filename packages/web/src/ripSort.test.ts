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

describe("bay-number order", () => {
  it("sorts numbered bays ascending and leaves unknown bays last", () => {
    const input = [
      rip("bay-8", { bay: 8 }),
      rip("unknown", { bay: null }),
      rip("bay-2-a", { bay: 2 }),
      rip("bay-2-b", { bay: 2 }),
    ]

    expect(ids(sortRips(input, "bay"))).toEqual([
      "bay-2-a",
      "bay-2-b",
      "bay-8",
      "unknown",
    ])
    expect(ids(input)).toEqual([
      "bay-8",
      "unknown",
      "bay-2-a",
      "bay-2-b",
    ])
  })
})

describe("finishing-soonest order", () => {
  it("leads with valid active ETAs and breaks equal ETAs by bay", () => {
    const input = [
      rip("unknown-active", {
        bay: 1,
        active: true,
        eta_seconds: null,
      }),
      rip("two-minutes-bay-9", {
        bay: 9,
        active: true,
        eta_seconds: 120,
      }),
      // A completed rip can retain its last ETA. It cannot finish
      // soon because it is already finished, so it is a fallback.
      rip("inactive-stale-eta", {
        bay: 2,
        active: false,
        eta_seconds: 1,
      }),
      rip("two-minutes-bay-7", {
        bay: 7,
        active: true,
        eta_seconds: 120,
      }),
      rip("invalid-eta", {
        bay: 3,
        active: true,
        eta_seconds: Number.POSITIVE_INFINITY,
      }),
      rip("one-minute", {
        bay: 8,
        active: true,
        eta_seconds: 60,
      }),
    ]

    expect(
      ids(sortRips(input, "finishing-soonest")),
    ).toEqual([
      "one-minute",
      "two-minutes-bay-7",
      "two-minutes-bay-9",
      "unknown-active",
      "inactive-stale-eta",
      "invalid-eta",
    ])
  })

  it("keeps fallback items stable when their bay cannot break the tie", () => {
    const input = [
      rip("unknown-a", {
        bay: null,
        active: true,
        eta_seconds: null,
      }),
      rip("inactive-b", {
        bay: null,
        active: false,
        eta_seconds: 30,
      }),
      rip("zero-c", {
        bay: null,
        active: true,
        eta_seconds: 0,
      }),
    ]

    expect(
      ids(sortRips(input, "finishing-soonest")),
    ).toEqual(["unknown-a", "inactive-b", "zero-c"])
  })
})
