import {
  HEALTH_THRESHOLDS,
  makeVerdict,
  type Verdict,
  type VerdictConfidence,
} from "@rip-deck/contracts"
import {
  type DriveBaseline,
  effectiveBaseline,
} from "./baseline.ts"
import { classifyErrorPattern } from "./errorPattern.ts"

/**
 * The verdict engine.
 *
 * A pure function of accumulated observations, so it can be
 * tested exhaustively without a disc, a drive, or a kernel.
 * Every threshold it reads lives in `HEALTH_THRESHOLDS`.
 *
 * Two rules make the difference between a feature the owner
 * trusts and one he learns to ignore:
 *
 *   1. `ok` is the default. Every other verdict requires
 *      positive evidence.
 *   2. Only `confirmed` announces. A disc verdict from a single
 *      drive shows in the UI and offers "retry in another
 *      drive"; two drives agreeing upgrades it. That makes
 *      "always re-test before blaming the disc" mechanical.
 *
 * Every threshold here is currently a GUESS. The samples are
 * persisted in full precisely so that tuning is a query rather
 * than a re-rip — do not tune before ~30 real jobs.
 */

export type DriveObservation = {
  driveId: string
  /** Every hub between this drive and the root, root-first. */
  hubChain: string[]
  /** Recent throughput readings, oldest first, bytes/sec. */
  recentThroughput: number[]
  /** Mean ms per read over the recent window. */
  avgMsPerRead: number | null
  /** Increase in ioerr_cnt over the recent window. */
  ioErrorDelta: number
  /** Read-error LBAs seen this job, from MakeMKV and kmsg. */
  errorLbas: number[]
  /** Milliseconds since the last observed forward progress. */
  msSinceProgress: number
  /** Enumeration events (connect/disconnect) in the window. */
  enumerationEvents: number
  /** MakeMKV reported a key problem (MSG 5021/5052/5055). */
  hasKeyExpired: boolean
  /** This exact disc already failed on a different drive. */
  hasSecondDriveAgreement: boolean
  /** This drive has struggled across multiple distinct discs. */
  hasCrossDiscHistory: boolean
}

export type EngineInput = {
  observations: DriveObservation[]
  baselines: Map<string, DriveBaseline>
  /** Common ancestor of every drive — the tower's own root. */
  towerRootPortPath: string
}

/** True when throughput has collapsed against the baseline. */
const isCollapsed = (
  observation: DriveObservation,
  baselines: Map<string, DriveBaseline>,
): boolean => {
  if (observation.recentThroughput.length === 0)
    return false

  const baseline = baselines.get(observation.driveId)
  const expected =
    baseline === undefined
      ? HEALTH_THRESHOLDS.seedThroughputBytesPerSec
      : effectiveBaseline(baseline)

  const recent = observation.recentThroughput
  const mean =
    recent.reduce((sum, value) => sum + value, 0) /
    recent.length

  return (
    mean <
    expected * HEALTH_THRESHOLDS.collapseFractionOfBaseline
  )
}

/**
 * Find the hub that best explains a set of collapsed drives.
 *
 * Walks each collapsed drive's hub chain and counts how many
 * collapsed drives sit under every candidate hub, then picks
 * the DEEPEST hub that still explains enough of them. Deepest
 * wins because blaming the root when one internal chip failed
 * would send the owner to check the wrong thing.
 */
const findFaultyHub = (
  collapsed: DriveObservation[],
): { hubPath: string; driveCount: number } | null => {
  const countsByHub = new Map<string, number>()

  for (const observation of collapsed) {
    for (const hub of observation.hubChain) {
      countsByHub.set(hub, (countsByHub.get(hub) ?? 0) + 1)
    }
  }

  let best: { hubPath: string; driveCount: number } | null =
    null

  for (const [hubPath, driveCount] of countsByHub) {
    if (
      driveCount < HEALTH_THRESHOLDS.hubCorrelationMinDrives
    ) {
      continue
    }

    // Deeper = more path segments = more specific.
    const isDeeper =
      best === null ||
      hubPath.split(".").length >
        best.hubPath.split(".").length

    if (isDeeper) best = { hubPath, driveCount }
  }

  return best
}

export type EngineResult = {
  verdictsByDriveId: Map<string, Verdict>
  /** Set when a hub fault is suppressing per-disc verdicts. */
  hubFault: { hubPath: string; driveCount: number } | null
}

export const evaluateHealth = (
  input: EngineInput,
): EngineResult => {
  const { observations, baselines, towerRootPortPath } =
    input
  const verdictsByDriveId = new Map<string, Verdict>()

  // --- Key expiry outranks everything. -------------------
  // It is not a disc problem and not a drive problem; it makes
  // every rip fail, and discovering it as mass rip failure is
  // exactly what we are trying to avoid.
  const keyExpired = observations.filter(
    (observation) => observation.hasKeyExpired,
  )

  if (keyExpired.length > 0) {
    for (const observation of observations) {
      verdictsByDriveId.set(
        observation.driveId,
        makeVerdict("key_expired", "confirmed", [
          "MakeMKV reported an expired or invalid key.",
        ]),
      )
    }

    return { verdictsByDriveId, hubFault: null }
  }

  // --- Hub correlation, before any per-disc judgement. ----
  // Several drives failing together is one hardware fault, not
  // several bad discs. Getting this backwards is how a health
  // feature tells you to clean nine perfectly good discs.
  const collapsed = observations.filter(
    (observation) =>
      isCollapsed(observation, baselines) ||
      observation.msSinceProgress >
        HEALTH_THRESHOLDS.stallTimeoutMs,
  )

  const hubFault = findFaultyHub(collapsed)

  if (hubFault !== null) {
    const isTowerWide =
      hubFault.hubPath === towerRootPortPath ||
      towerRootPortPath.startsWith(
        `${hubFault.hubPath}.`,
      ) ||
      hubFault.hubPath.split(".").length <=
        towerRootPortPath.split(".").length

    const evidence = [
      `${hubFault.driveCount} drives under ${hubFault.hubPath}` +
        ` collapsed together.`,
      isTowerWide
        ? "That node is the tower's shared USB extension and " +
          "hub. Check the extension cable's aux power first — " +
          "run passively its repeater is undervolted and the " +
          "whole bank drops."
        : "That node is one internal hub chip, so the fault is " +
          "below the shared cable.",
    ]

    const affected = new Set(
      collapsed
        .filter((observation) =>
          observation.hubChain.includes(hubFault.hubPath),
        )
        .map((observation) => observation.driveId),
    )

    for (const observation of observations) {
      if (!affected.has(observation.driveId)) continue

      verdictsByDriveId.set(
        observation.driveId,
        makeVerdict("hub_fault", "confirmed", evidence),
      )
    }
  }

  // --- Per-drive judgement for everyone still unexplained.
  for (const observation of observations) {
    if (verdictsByDriveId.has(observation.driveId)) continue

    verdictsByDriveId.set(
      observation.driveId,
      evaluateDrive(observation, baselines),
    )
  }

  return { verdictsByDriveId, hubFault }
}

/** Judge one drive in isolation. Exported for testing. */
export const evaluateDrive = (
  observation: DriveObservation,
  baselines: Map<string, DriveBaseline>,
): Verdict => {
  // A drive that keeps vanishing and reappearing invalidates
  // everything else we might say about it, including any rip
  // it claims to have completed.
  if (
    observation.enumerationEvents >=
    HEALTH_THRESHOLDS.flapMinEvents
  ) {
    return makeVerdict("enumeration_flap", "confirmed", [
      `${observation.enumerationEvents} connect/disconnect ` +
        "events in the last few minutes.",
    ])
  }

  // A drive that struggles with discs that read fine elsewhere
  // is a drive problem. Requires cross-disc history, so that
  // one bad disc can never get a drive quarantined.
  if (observation.hasCrossDiscHistory) {
    return makeVerdict("drive_failing", "confirmed", [
      "This drive has had read errors on multiple different " +
        "discs that read cleanly in other drives.",
    ])
  }

  const collapsed = isCollapsed(observation, baselines)
  const isStalled =
    observation.msSinceProgress >
    HEALTH_THRESHOLDS.stallTimeoutMs

  // Disc verdicts are only `confirmed` once a second drive
  // agrees. Until then they are shown, and offer a retry, but
  // they do not announce.
  const confidence: VerdictConfidence =
    observation.hasSecondDriveAgreement
      ? "confirmed"
      : "suspected"

  const pattern = classifyErrorPattern(
    observation.errorLbas,
  )

  if (pattern.pattern === "band") {
    return makeVerdict("disc_scratched", confidence, [
      `${pattern.errorCount} read errors, ` +
        `${Math.round(pattern.bandShare * 100)}% of them ` +
        `inside a single ${pattern.bandSpanSectors}-sector band.`,
      "Continuous damage — cleaning will not help.",
    ])
  }

  if (pattern.pattern === "scattered") {
    return makeVerdict("disc_dirty", confidence, [
      `${pattern.errorCount} read errors spread across the ` +
        "disc rather than clustered.",
      "Scattered damage is what fingerprints and dust look " +
        "like.",
    ])
  }

  // No usable error pattern, but the drive is clearly unwell.
  //
  // The kernel-invisible-retry case: MakeMKV's own retry
  // counter only moves AFTER the OS reports an error, but the
  // `sr` layer retries first. So a disc can hang for minutes
  // emitting nothing at all while reads quietly take an order
  // of magnitude longer. Throughput collapse plus a rising
  // avg-ms-per-read plus NO reported errors is that signature.
  const hasInvisibleRetries =
    observation.avgMsPerRead !== null &&
    observation.avgMsPerRead >
      HEALTH_THRESHOLDS.invisibleRetryAvgMsPerRead

  if (isStalled || (collapsed && hasInvisibleRetries)) {
    if (observation.ioErrorDelta > 0 || isStalled) {
      return makeVerdict("disc_dirty", confidence, [
        isStalled
          ? `No forward progress for ` +
            `${Math.round(observation.msSinceProgress / 1000)}s.`
          : "Throughput collapsed with reads taking far " +
            "longer than normal.",
        "The drive is retrying below the point where errors " +
          "get reported, which usually means surface " +
          "contamination.",
      ])
    }
  }

  if (collapsed) {
    // Slow, but reading cleanly. Some pressings just are, and
    // saying so is as valuable as raising an alarm — it is what
    // stops the owner cleaning a disc that is fine.
    return makeVerdict("disc_marginal_slow", confidence, [
      "Reading well below this drive's usual rate, but with " +
        "no read errors.",
    ])
  }

  return makeVerdict("ok", "confirmed", [])
}
