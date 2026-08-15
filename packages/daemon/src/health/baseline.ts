import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"

/**
 * Per-drive throughput baseline.
 *
 * Per DRIVE, not global, because the nine units are three
 * different models with genuinely different sustained rates.
 * A global baseline would permanently flag the slowest model as
 * unhealthy and mask a real collapse on the fastest.
 *
 * Measured baseline on this tower is ~17-18 MB/s per streaming
 * drive, disc-read and AACS-decrypt bound rather than CPU or
 * USB bound. That is the seed until a drive earns its own.
 */

export type DriveBaseline = {
  driveId: string
  /** Bytes/sec. Null until the drive has completed a job. */
  bytesPerSec: number | null
  /** How many jobs have contributed. Confidence proxy. */
  sampleCount: number
}

export const createBaseline = (
  driveId: string,
): DriveBaseline => ({
  driveId,
  bytesPerSec: null,
  sampleCount: 0,
})

/** The baseline to compare against, seeded when unknown. */
export const effectiveBaseline = (
  baseline: DriveBaseline,
): number =>
  baseline.bytesPerSec ??
  HEALTH_THRESHOLDS.seedThroughputBytesPerSec

/**
 * Fold one completed job's throughput samples into the drive's
 * baseline.
 *
 * Only the middle 60% of a job contributes. The head of a rip
 * includes disc spin-up, the AACS handshake and the BD+ pass;
 * the tail includes the flush and small trailing files. Both
 * are genuinely slow and neither says anything about whether
 * the disc reads well, so including them would drag the
 * baseline down and desensitise the collapse detector.
 *
 * p90 of the trimmed window, then EWMA across jobs: p90 rather
 * than the mean so a brief mid-job stall doesn't lower the bar
 * that later stalls are judged against.
 */
export const foldJobIntoBaseline = (
  baseline: DriveBaseline,
  jobSamples: number[],
): DriveBaseline => {
  const trimmed = trimToMiddle(jobSamples)
  if (trimmed.length === 0) return baseline

  const jobRate = percentile(trimmed, 0.9)
  const { baselineEwmaAlpha } = HEALTH_THRESHOLDS

  return {
    driveId: baseline.driveId,
    bytesPerSec:
      baseline.bytesPerSec === null
        ? jobRate
        : baseline.bytesPerSec * (1 - baselineEwmaAlpha) +
          jobRate * baselineEwmaAlpha,
    sampleCount: baseline.sampleCount + 1,
  }
}

/** Drop the first and last `baselineTrimFraction` of a series. */
export const trimToMiddle = (
  values: number[],
): number[] => {
  if (values.length < 5) return values

  const cut = Math.floor(
    values.length * HEALTH_THRESHOLDS.baselineTrimFraction,
  )

  return values.slice(cut, values.length - cut)
}

/** Nearest-rank percentile. */
export const percentile = (
  values: number[],
  fraction: number,
): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  )

  return sorted[index]
}
