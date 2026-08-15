import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { assessLiveness } from "../rip/liveness.ts"
import {
  buildLivenessAlertPayload,
  isLivenessAlertable,
} from "./livenessAlert.ts"

/**
 * These build on the REAL `assessLiveness`, not a hand-written
 * `Liveness` literal — H3's whole claim is that the liveness
 * engine already produces what the alert topic needs, and a
 * fabricated input would not test that.
 */

const {
  stallGraceMs,
  stallTimeoutMs,
  stallKillMs,
  silenceTimeoutMs,
} = HEALTH_THRESHOLDS

const startedAtMs = 0
const pastGraceMs = stallGraceMs + 60_000

const working = () =>
  assessLiveness({
    startedAtMs,
    lastForwardProgressAtMs: pastGraceMs,
    lastEventAtMs: pastGraceMs,
    nowMs: pastGraceMs,
    isKeepTryingRequested: false,
  })

const hung = () =>
  assessLiveness({
    startedAtMs,
    lastForwardProgressAtMs: pastGraceMs,
    lastEventAtMs: pastGraceMs + stallTimeoutMs,
    nowMs: pastGraceMs + stallTimeoutMs + 1_000,
    isKeepTryingRequested: false,
  })

const silent = () =>
  assessLiveness({
    startedAtMs,
    lastForwardProgressAtMs: pastGraceMs,
    lastEventAtMs: pastGraceMs,
    nowMs: pastGraceMs + silenceTimeoutMs + 1_000,
    isKeepTryingRequested: false,
  })

describe("isLivenessAlertable", () => {
  it("stays quiet while the rip is working", () => {
    expect(isLivenessAlertable(working())).toBe(false)
  })

  it("stays quiet during the startup grace window", () => {
    // The AACS handshake and BD+ pass emit no forward progress.
    // Alerting here would cry wolf on every single rip.
    const starting = assessLiveness({
      startedAtMs,
      lastForwardProgressAtMs: 0,
      lastEventAtMs: 0,
      nowMs: stallGraceMs - 1,
      isKeepTryingRequested: false,
    })

    expect(isLivenessAlertable(starting)).toBe(false)
  })

  it("alerts on a hang", () => {
    expect(isLivenessAlertable(hung())).toBe(true)
  })

  it("alerts on silence", () => {
    expect(isLivenessAlertable(silent())).toBe(true)
  })

  it("still alerts once the job is being abandoned", () => {
    const abandoning = assessLiveness({
      startedAtMs,
      lastForwardProgressAtMs: pastGraceMs,
      lastEventAtMs: pastGraceMs + stallKillMs,
      nowMs: pastGraceMs + stallKillMs + 1_000,
      isKeepTryingRequested: false,
    })

    expect(abandoning.action).toBe("abandon")
    expect(isLivenessAlertable(abandoning)).toBe(true)
  })
})

describe("buildLivenessAlertPayload", () => {
  it("carries the plain-language reason to the phone", () => {
    const liveness = hung()

    const payload = buildLivenessAlertPayload({
      liveness,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(payload.message).toBe(liveness.reason)
    expect(payload.drive).toBe("07 - Pioneer BDR-211M")
    expect(payload.slot).toBe(7)
  })

  it("never blames the disc from a clock alone", () => {
    // Timing tells us the rip stopped moving; it does not tell
    // us why. Naming a cause needs the health engine's error
    // pattern, and even then only a `confirmed` verdict may
    // announce.
    const payload = buildLivenessAlertPayload({
      liveness: hung(),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(payload.verdict).toBe("unknown")
    expect(payload.action).toBe("none")
  })

  it("points at the drive when nothing comes back at all", () => {
    const payload = buildLivenessAlertPayload({
      liveness: silent(),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
    })

    expect(payload.action).toBe("check_drive")
  })

  it("says keep-trying is sensible for a retrying drive", () => {
    expect(
      buildLivenessAlertPayload({
        liveness: hung(),
        driveLabel: "07",
        slot: 7,
      }).is_keep_trying_sensible,
    ).toBe(true)
  })

  it("says it is not, for a wedged one", () => {
    expect(
      buildLivenessAlertPayload({
        liveness: silent(),
        driveLabel: "07",
        slot: 7,
      }).is_keep_trying_sensible,
    ).toBe(false)
  })

  it("shows its working", () => {
    const payload = buildLivenessAlertPayload({
      liveness: silent(),
      driveLabel: "07",
      slot: 7,
    })

    expect(payload.evidence).toContain("Liveness: silent")
    expect(payload.evidence).toHaveLength(3)
  })
})
