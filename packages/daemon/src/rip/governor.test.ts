import { describe, expect, it } from "vitest"
import {
  createGovernor,
  GOVERNOR_TUNING,
  parseMaxConcurrentRips,
  resolveRipConcurrency,
} from "./governor.ts"

/**
 * The concurrency cap.
 *
 * ⚠️ These tests prove the ARITHMETIC and the refusals. Nine
 * concurrent rips have never happened on this rig — not once, on
 * any branch — so nothing here says anything about whether nine
 * `makemkvcon` children, nine containers and nine `--cache=128`
 * allocations are actually survivable on a host that is also a
 * NAS (E4). That question needs the tower on.
 */

const isolatedEnv = {
  RIP_DECK_RIP_ISOLATION_IMAGE: "rip-deck:0.1.0",
}

describe("parseMaxConcurrentRips", () => {
  it("reads a plain number", () => {
    expect(parseMaxConcurrentRips("3")).toBe(3)
  })

  it("refuses zero rather than silently never ripping", () => {
    // A cap of zero is a daemon that watches nine discs, rips
    // none of them, and reports nothing wrong. Same class of typo
    // as `parseId` guards against in destination.ts.
    expect(parseMaxConcurrentRips("0")).toBeNull()
    expect(parseMaxConcurrentRips("-1")).toBeNull()
  })

  it("refuses nonsense and absence alike", () => {
    expect(parseMaxConcurrentRips("nine")).toBeNull()
    expect(parseMaxConcurrentRips("")).toBeNull()
    expect(parseMaxConcurrentRips(undefined)).toBeNull()
  })
})

describe("resolveRipConcurrency", () => {
  it("defaults to nine — one per bay — when isolated", () => {
    const resolved = resolveRipConcurrency(isolatedEnv)

    expect(resolved.maxConcurrentRips).toBe(
      GOVERNOR_TUNING.defaultMaxConcurrentRips,
    )
    expect(resolved.maxConcurrentRips).toBe(9)
    expect(resolved.clampReason).toBeNull()
  })

  it("takes a smaller cap without a code change", () => {
    // The owner wants nine; E4 says nine caches on a NAS is
    // bounded but no longer a rounding error. Turning that down
    // must be an env var on a running deployment.
    const resolved = resolveRipConcurrency({
      ...isolatedEnv,
      RIP_DECK_MAX_CONCURRENT_RIPS: "3",
    })

    expect(resolved.maxConcurrentRips).toBe(3)
    expect(resolved.clampReason).toBeNull()
  })

  it("clamps to one when rips are not device-isolated", () => {
    // AGENTS.md: per-rip device isolation "is not optional before
    // nine-way operation", because `backup` re-scans the whole bus
    // and concurrent scans of this tower are what produced the
    // 17-minute hang at 0% CPU.
    const resolved = resolveRipConcurrency({})

    expect(resolved.maxConcurrentRips).toBe(1)
    expect(resolved.requestedMaxConcurrentRips).toBe(9)
    expect(resolved.isIsolationConfigured).toBe(false)
    expect(resolved.clampReason).toContain("isolated")
  })

  it("does not let the env argue its way out of the clamp", () => {
    const resolved = resolveRipConcurrency({
      RIP_DECK_MAX_CONCURRENT_RIPS: "9",
    })

    expect(resolved.maxConcurrentRips).toBe(1)
    expect(resolved.clampReason).not.toBeNull()
  })

  it("says nothing when the clamp changes nothing", () => {
    const resolved = resolveRipConcurrency({
      RIP_DECK_MAX_CONCURRENT_RIPS: "1",
    })

    expect(resolved.maxConcurrentRips).toBe(1)
    expect(resolved.clampReason).toBeNull()
  })
})

describe("createGovernor", () => {
  it("hands out nine leases and no more", () => {
    const governor = createGovernor({
      maxConcurrentRips: 9,
    })

    for (let index = 0; index < 9; index += 1) {
      expect(
        governor.tryAcquire({ driveId: `port-${index}` }),
      ).toBe(true)
    }

    expect(governor.getActiveCount()).toBe(9)
    expect(governor.hasCapacity()).toBe(false)
    expect(
      governor.tryAcquire({ driveId: "port-10" }),
    ).toBe(false)
  })

  it("never gives one drive two leases", () => {
    // The natural bound is one rip per drive, and it has to be
    // enforced rather than assumed: two writers on one device is
    // not a slow rip, it is two corrupt ones.
    const governor = createGovernor({
      maxConcurrentRips: 9,
    })

    expect(
      governor.tryAcquire({ driveId: "1-4.3.2" }),
    ).toBe(true)
    expect(
      governor.tryAcquire({ driveId: "1-4.3.2" }),
    ).toBe(false)
    expect(governor.getActiveCount()).toBe(1)
  })

  it("frees a slot on release, and release is idempotent", () => {
    const governor = createGovernor({
      maxConcurrentRips: 1,
    })

    expect(governor.tryAcquire({ driveId: "a" })).toBe(true)
    expect(governor.tryAcquire({ driveId: "b" })).toBe(
      false,
    )

    governor.release({ driveId: "a" })
    governor.release({ driveId: "a" })

    expect(governor.getActiveCount()).toBe(0)
    expect(governor.tryAcquire({ driveId: "b" })).toBe(true)
  })

  it("refuses to be configured into never ripping", () => {
    const governor = createGovernor({
      maxConcurrentRips: 0,
    })

    expect(governor.maxConcurrentRips).toBe(1)
    expect(governor.tryAcquire({ driveId: "a" })).toBe(true)
  })

  it("reports its active bays in a stable order", () => {
    const governor = createGovernor({
      maxConcurrentRips: 9,
    })

    governor.tryAcquire({ driveId: "1-4.4" })
    governor.tryAcquire({ driveId: "1-4.1" })

    expect(governor.getActiveDriveIds()).toEqual([
      "1-4.1",
      "1-4.4",
    ])
  })
})
