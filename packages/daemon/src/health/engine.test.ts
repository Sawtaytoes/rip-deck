import {
  HEALTH_THRESHOLDS,
  isAnnounceable,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  createBaseline,
  type DriveBaseline,
} from "./baseline.ts"
import {
  type DriveObservation,
  evaluateDrive,
  evaluateHealth,
} from "./engine.ts"

const MB = 1024 * 1024
const HEALTHY = 17 * MB

const baselineFor = (
  driveId: string,
  bytesPerSec: number | null = HEALTHY,
): Map<string, DriveBaseline> =>
  new Map([
    [
      driveId,
      {
        ...createBaseline(driveId),
        bytesPerSec,
        sampleCount: 5,
      },
    ],
  ])

const observation = (
  overrides: Partial<DriveObservation> = {},
): DriveObservation => ({
  driveId: "drive-a",
  hubChain: ["2-1", "2-1.1", "2-1.1.2"],
  recentThroughput: [HEALTHY, HEALTHY, HEALTHY],
  avgMsPerRead: 10,
  ioErrorDelta: 0,
  errorLbas: [],
  msSinceProgress: 0,
  enumerationEvents: 0,
  hasKeyExpired: false,
  hasSecondDriveAgreement: false,
  hasCrossDiscHistory: false,
  ...overrides,
})

describe("evaluateDrive — ok is the default", () => {
  it("returns ok for a healthy drive", () => {
    const verdict = evaluateDrive(
      observation(),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("ok")
    expect(verdict.action).toBe("none")
  })

  it("does not announce an ok verdict", () => {
    const verdict = evaluateDrive(
      observation(),
      baselineFor("drive-a"),
    )

    expect(isAnnounceable(verdict)).toBe(false)
  })

  it("stays ok when slow but within tolerance", () => {
    // Half speed is not a collapse. Being relaxed here is what
    // keeps the alerts trustworthy.
    const verdict = evaluateDrive(
      observation({
        recentThroughput: [HEALTHY * 0.5, HEALTHY * 0.5],
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("ok")
  })
})

describe("evaluateDrive — dirt vs scratch", () => {
  it("calls a contiguous error band a scratch", () => {
    const verdict = evaluateDrive(
      observation({
        errorLbas: [
          500_000, 510_000, 520_000, 530_000, 540_000,
        ],
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_scratched")
    expect(verdict.action).toBe("replace_disc")
    expect(verdict.message).toContain("Scratched")
  })

  it("calls errors spread across the disc dirt", () => {
    const verdict = evaluateDrive(
      observation({
        errorLbas: [
          10_000, 4_000_000, 9_000_000, 15_000_000,
          22_000_000,
        ],
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_dirty")
    expect(verdict.action).toBe("clean_disc")
  })

  it("reports one stray error without inventing a surface pattern", () => {
    const verdict = evaluateDrive(
      observation({ errorLbas: [123_456] }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_read_error")
    expect(verdict.message).toContain("another drive")
    expect(verdict.evidence[0]).toContain("1 read error")
  })

  it("never calls a slow run with a read error clean", () => {
    const verdict = evaluateDrive(
      observation({
        errorLbas: [403_584],
        recentThroughput: [0],
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_read_error")
    expect(verdict.message).not.toContain("cleanly")
  })
})

describe("evaluateDrive — confidence gating", () => {
  it("keeps a single-drive disc verdict unannounceable", () => {
    const verdict = evaluateDrive(
      observation({
        errorLbas: [500_000, 510_000, 520_000, 530_000],
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.confidence).toBe("suspected")
    expect(isAnnounceable(verdict)).toBe(false)
  })

  it("announces once a second drive agrees", () => {
    const verdict = evaluateDrive(
      observation({
        errorLbas: [500_000, 510_000, 520_000, 530_000],
        hasSecondDriveAgreement: true,
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.confidence).toBe("confirmed")
    expect(isAnnounceable(verdict)).toBe(true)
  })
})

describe("evaluateDrive — the kernel-invisible retry", () => {
  it("detects a stall with no reported errors at all", () => {
    // The 47-minutes-at-0-bytes case. MakeMKV's retry counter
    // never moves because the sr layer retries first, so
    // wall-clock is the only signal.
    const verdict = evaluateDrive(
      observation({
        recentThroughput: [0, 0, 0],
        msSinceProgress:
          HEALTH_THRESHOLDS.stallTimeoutMs + 1_000,
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_dirty")
    expect(verdict.evidence.join(" ")).toContain(
      "No forward progress",
    )
  })

  it("reports slow-but-clean as exactly that", () => {
    // Collapsed throughput, normal read latency, no errors.
    // Telling the owner this is fine is as useful as an alarm.
    const verdict = evaluateDrive(
      observation({
        recentThroughput: [HEALTHY * 0.1],
        avgMsPerRead: 12,
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("disc_marginal_slow")
    expect(verdict.action).toBe("none")
    expect(verdict.isKeepTryingSensible).toBe(true)
  })
})

describe("evaluateDrive — blaming the hardware", () => {
  it("flags a flapping drive", () => {
    const verdict = evaluateDrive(
      observation({
        enumerationEvents: HEALTH_THRESHOLDS.flapMinEvents,
      }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("enumeration_flap")
    expect(verdict.action).toBe("check_drive")
  })

  it("blames the drive only with cross-disc history", () => {
    const verdict = evaluateDrive(
      observation({ hasCrossDiscHistory: true }),
      baselineFor("drive-a"),
    )

    expect(verdict.kind).toBe("drive_failing")
    expect(verdict.subject).toBe("drive")
  })
})

describe("evaluateHealth — correlation across drives", () => {
  const towerRootPortPath = "2-1.1.2"

  const towerDrive = (
    driveId: string,
    portPath: string,
    overrides: Partial<DriveObservation> = {},
  ): DriveObservation =>
    observation({
      driveId,
      hubChain: portPath
        .split(".")
        .slice(0, -1)
        .map((_, index, parts) =>
          parts.slice(0, index + 1).join("."),
        ),
      ...overrides,
    })

  it("blames the hub, not nine discs, when a bank drops", () => {
    // The failure that actually happens on this rig. Without
    // this rule the owner is told to clean every disc he owns.
    const result = evaluateHealth({
      towerRootPortPath,
      baselines: new Map(),
      observations: [
        towerDrive("d1", "2-1.1.2.1", {
          recentThroughput: [0],
        }),
        towerDrive("d2", "2-1.1.2.2", {
          recentThroughput: [0],
        }),
        towerDrive("d3", "2-1.1.2.3", {
          recentThroughput: [0],
        }),
      ],
    })

    expect(result.hubFault).not.toBeNull()

    for (const driveId of ["d1", "d2", "d3"]) {
      expect(
        result.verdictsByDriveId.get(driveId)?.kind,
      ).toBe("hub_fault")
    }
  })

  it("points at the aux power when the fault is tower-wide", () => {
    const result = evaluateHealth({
      towerRootPortPath,
      baselines: new Map(),
      observations: [
        towerDrive("d1", "2-1.1.2.1", {
          recentThroughput: [0],
        }),
        towerDrive("d2", "2-1.1.2.2", {
          recentThroughput: [0],
        }),
      ],
    })

    const evidence =
      result.verdictsByDriveId
        .get("d1")
        ?.evidence.join(" ") ?? ""

    expect(evidence).toContain("aux power")
  })

  it("does not blame a hub for a single sick drive", () => {
    const result = evaluateHealth({
      towerRootPortPath,
      baselines: baselineFor("d1"),
      observations: [
        towerDrive("d1", "2-1.1.2.1", {
          recentThroughput: [0],
          errorLbas: [
            10_000, 4_000_000, 9_000_000, 15_000_000,
          ],
        }),
        towerDrive("d2", "2-1.1.2.2"),
      ],
    })

    expect(result.hubFault).toBeNull()
    expect(result.verdictsByDriveId.get("d1")?.kind).toBe(
      "disc_dirty",
    )
    expect(result.verdictsByDriveId.get("d2")?.kind).toBe(
      "ok",
    )
  })

  it("lets key expiry outrank every other signal", () => {
    // Mass rip failure from an expired key must never be
    // reported as a shelf full of bad discs.
    const result = evaluateHealth({
      towerRootPortPath,
      baselines: new Map(),
      observations: [
        towerDrive("d1", "2-1.1.2.1", {
          hasKeyExpired: true,
          recentThroughput: [0],
        }),
        towerDrive("d2", "2-1.1.2.2", {
          recentThroughput: [0],
        }),
      ],
    })

    expect(result.verdictsByDriveId.get("d1")?.kind).toBe(
      "key_expired",
    )
    expect(result.verdictsByDriveId.get("d2")?.kind).toBe(
      "key_expired",
    )
    expect(result.verdictsByDriveId.get("d1")?.action).toBe(
      "refresh_key",
    )
  })
})
