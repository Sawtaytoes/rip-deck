import { describe, expect, it } from "vitest"
import {
  applySupervisionDecision,
  clearQuarantine,
  createSupervisionState,
  decideOnChildExit,
  SUPERVISION,
} from "./supervision.ts"

const MINUTE = 60_000

describe("decideOnChildExit", () => {
  it("restarts a child that crashed", () => {
    const decision = decideOnChildExit({
      state: {
        ...createSupervisionState("d1"),
        startedAt: 0,
      },
      exitedAt: 5_000,
      wasDeliberate: false,
    })

    expect(decision.action).toBe("restart")
  })

  it("ignores a child we killed on purpose", () => {
    // Cancels, shutdowns and reaps must not count as crashes,
    // or cancelling three jobs would quarantine the drive.
    const decision = decideOnChildExit({
      state: {
        ...createSupervisionState("d1"),
        startedAt: 0,
      },
      exitedAt: 5_000,
      wasDeliberate: true,
    })

    expect(decision.action).toBe("ignore")
  })

  it("backs off further on each successive crash", () => {
    let state = {
      ...createSupervisionState("d1"),
      startedAt: 0,
    }
    const delays: number[] = []

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = decideOnChildExit({
        state,
        exitedAt: 1_000,
        wasDeliberate: false,
      })

      if (decision.action !== "restart") break

      delays.push(decision.delayMs)
      state = {
        ...applySupervisionDecision(state, decision),
        startedAt: 0,
      }
    }

    expect(delays).toEqual([2_000, 10_000, 30_000])
  })

  it("quarantines after the restart budget is spent", () => {
    let state = {
      ...createSupervisionState("d1"),
      startedAt: 0,
    }

    for (
      let attempt = 0;
      attempt < SUPERVISION.maxRestarts;
      attempt += 1
    ) {
      const decision = decideOnChildExit({
        state,
        exitedAt: 1_000,
        wasDeliberate: false,
      })
      state = {
        ...applySupervisionDecision(state, decision),
        startedAt: 0,
      }
    }

    const final = decideOnChildExit({
      state,
      exitedAt: 1_000,
      wasDeliberate: false,
    })

    expect(final.action).toBe("quarantine")
  })

  it("resets the counter after a healthy run", () => {
    // A drive that crashes once a fortnight must never
    // accumulate its way into quarantine.
    const state = {
      ...createSupervisionState("d1"),
      restartCount: 2,
      startedAt: 0,
    }

    const decision = decideOnChildExit({
      state,
      exitedAt: SUPERVISION.healthyUptimeMs + MINUTE,
      wasDeliberate: false,
    })

    expect(decision).toMatchObject({
      action: "restart",
      attempt: 1,
    })
  })

  it("stops restarting once quarantined", () => {
    const decision = decideOnChildExit({
      state: {
        ...createSupervisionState("d1"),
        isQuarantined: true,
        startedAt: 0,
      },
      exitedAt: 1_000,
      wasDeliberate: false,
    })

    expect(decision.action).toBe("ignore")
  })
})

describe("clearQuarantine", () => {
  it("is the only way out, and resets the budget", () => {
    // Deliberately not self-healing: an automatic un-quarantine
    // would re-enter the same crash loop at 3am with nobody
    // watching.
    const quarantined = {
      ...createSupervisionState("d1"),
      restartCount: 3,
      isQuarantined: true,
      quarantineReason: "crashed repeatedly",
    }

    const cleared = clearQuarantine(quarantined)

    expect(cleared.isQuarantined).toBe(false)
    expect(cleared.restartCount).toBe(0)
    expect(cleared.quarantineReason).toBeNull()
  })
})
