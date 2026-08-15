import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { assessLiveness } from "./liveness.ts"

/**
 * Requirement D3: detect a stall on wall clock, independent of
 * error messages — because the `sr` layer retries long before
 * MakeMKV's error counter ever moves.
 *
 * The behaviour that matters most here is the SEPARATION of
 * warning from abandoning. Warning early is cheap; abandoning
 * early throws away hours of reading that was about to recover.
 */

const {
  stallGraceMs,
  stallTimeoutMs,
  stallKillMs,
  silenceTimeoutMs,
} = HEALTH_THRESHOLDS

const START = 1_000_000

const assess = (input: {
  sinceProgressMs: number
  sinceEventMs?: number
  sinceStartMs?: number
  isKeepTryingRequested?: boolean
}) => {
  const sinceStartMs =
    input.sinceStartMs ??
    stallGraceMs + input.sinceProgressMs
  const nowMs = START + sinceStartMs

  return assessLiveness({
    startedAtMs: START,
    lastForwardProgressAtMs: nowMs - input.sinceProgressMs,
    lastEventAtMs: nowMs - (input.sinceEventMs ?? 0),
    nowMs,
    isKeepTryingRequested:
      input.isKeepTryingRequested ?? false,
  })
}

describe("the startup grace period", () => {
  it("does not judge a rip during the AACS handshake", () => {
    // Every rip's first minutes are the handshake and the BD+
    // pass, which emit no forward progress. Without the grace
    // period this would fail literally every rip.
    const liveness = assess({
      sinceProgressMs: stallTimeoutMs + 1,
      sinceStartMs: stallGraceMs - 1,
    })

    expect(liveness.kind).toBe("starting")
    expect(liveness.action).toBe("continue")
  })
})

describe("slow but working is not a failure", () => {
  it("continues while PRGV is still advancing", () => {
    const liveness = assess({ sinceProgressMs: 1_000 })

    expect(liveness.kind).toBe("working")
    expect(liveness.action).toBe("continue")
  })
})

describe("hung — output, but no forward progress", () => {
  it("alerts, and does NOT abandon, at the stall timeout", () => {
    const liveness = assess({
      sinceProgressMs: stallTimeoutMs + 1,
    })

    expect(liveness.kind).toBe("hung")
    // The whole point: tell the owner mid-rip (H3) without
    // throwing the rip away.
    expect(liveness.action).toBe("alert")
  })

  it("abandons only after the much longer kill timeout", () => {
    const liveness = assess({
      sinceProgressMs: stallKillMs + 1,
    })

    expect(liveness.action).toBe("abandon")
  })

  it("never abandons once the operator says keep trying", () => {
    const liveness = assess({
      sinceProgressMs: stallKillMs * 10,
      isKeepTryingRequested: true,
    })

    // D4: offer "keep trying", and then actually honour it.
    expect(liveness.action).toBe("alert")
  })

  it("keeps alerting even while keep-trying is set", () => {
    // Silencing the signal as well would leave a struggling bay
    // invisible for the rest of a three-hour rip.
    const liveness = assess({
      sinceProgressMs: stallTimeoutMs + 1,
      isKeepTryingRequested: true,
    })

    expect(liveness.action).toBe("alert")
  })
})

describe("silent — the process is wedged, not slow", () => {
  it("is distinguished from merely hung", () => {
    const liveness = assess({
      sinceProgressMs: silenceTimeoutMs + 1,
      sinceEventMs: silenceTimeoutMs + 1,
    })

    expect(liveness.kind).toBe("silent")
    expect(liveness.reason).toContain("stuck")
  })

  it("abandons faster than a hang does", () => {
    // Total silence well short of stallKillMs still abandons,
    // because a silent pipe is a thread blocked in the kernel
    // rather than a drive retrying.
    expect(silenceTimeoutMs).toBeLessThan(stallKillMs)

    const liveness = assess({
      sinceProgressMs: silenceTimeoutMs + 1,
      sinceEventMs: silenceTimeoutMs + 1,
    })

    expect(liveness.action).toBe("abandon")
  })

  it("reports hung, not silent, when output continues", () => {
    // makemkvcon chattering away while making no progress is a
    // different physical situation from a dead pipe, and the two
    // must not be conflated.
    const liveness = assess({
      sinceProgressMs: stallKillMs + 1,
      sinceEventMs: 1_000,
    })

    expect(liveness.kind).toBe("hung")
  })
})
