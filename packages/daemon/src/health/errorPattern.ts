import { HEALTH_THRESHOLDS } from "@rip-deck/contracts"

/**
 * Dirt vs scratch, from where on the disc the errors are.
 *
 * The physical intuition, and the reason this is worth doing at
 * all: a scratch is a continuous track of damage, so its read
 * errors cluster into one contiguous band of logical blocks.
 * Fingerprints, smudges and dust are scattered over the surface,
 * so their errors are spread across the whole disc.
 *
 * That distinction is exactly the difference between "clean it
 * and try again" and "source another copy" — which is the whole
 * point of the health engine. Getting it from data we already
 * have costs nothing.
 */

export type ErrorPattern =
  | "band"
  | "scattered"
  | "insufficient_data"

/** Below this we are reading tea leaves, so we refuse to judge. */
const MIN_ERRORS_TO_CLASSIFY = 3

export type PatternResult = {
  pattern: ErrorPattern
  errorCount: number
  /** Share of errors inside the densest band, 0..1. */
  bandShare: number
  /** Sector span covered by the densest band. */
  bandSpanSectors: number
}

/**
 * Classify a set of error LBAs.
 *
 * Uses a sliding window over the sorted LBAs to find the
 * densest band of `scratchBandSpanSectors`, then asks what
 * share of all errors fall inside it.
 */
export const classifyErrorPattern = (
  lbas: number[],
): PatternResult => {
  const usable = lbas.filter((lba) => Number.isFinite(lba))

  if (usable.length < MIN_ERRORS_TO_CLASSIFY) {
    return {
      pattern: "insufficient_data",
      errorCount: usable.length,
      bandShare: 0,
      bandSpanSectors: 0,
    }
  }

  const sorted = [...usable].sort((a, b) => a - b)
  const { scratchBandSpanSectors, scratchBandMinShare } =
    HEALTH_THRESHOLDS

  let bestCount = 0
  let bestSpan = 0
  let windowStart = 0

  for (
    let windowEnd = 0;
    windowEnd < sorted.length;
    windowEnd += 1
  ) {
    while (
      sorted[windowEnd] - sorted[windowStart] >
      scratchBandSpanSectors
    ) {
      windowStart += 1
    }

    const count = windowEnd - windowStart + 1

    if (count > bestCount) {
      bestCount = count
      bestSpan = sorted[windowEnd] - sorted[windowStart]
    }
  }

  const bandShare = bestCount / sorted.length

  return {
    pattern:
      bandShare >= scratchBandMinShare
        ? "band"
        : "scattered",
    errorCount: sorted.length,
    bandShare,
    bandSpanSectors: bestSpan,
  }
}

/**
 * Pull the read offset out of a MakeMKV MSG:2003 message.
 *
 * Format: `Error '%1' occurred while reading '%2' at offset
 * '%3'`, so the offset is the third parameter. Reading it from
 * `params` rather than the rendered message keeps this working
 * if the message text is ever localised.
 */
export const offsetFromReadError = (
  params: string[],
): number | null => {
  if (params.length < 3) return null

  const parsed = Number.parseInt(params[2], 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Pull an LBA out of a kernel `Medium Error` / `Buffer I/O`
 * line. The kernel prints these in a few shapes depending on
 * subsystem, so try each rather than assuming one.
 */
export const lbaFromKernelLine = (
  line: string,
): number | null => {
  const patterns = [
    /\[sr\d+\].*?\bsector (\d+)/i,
    /\blba[= ](\d+)/i,
    /\blogical block (\d+)/i,
  ]

  for (const pattern of patterns) {
    const matched = line.match(pattern)
    if (matched) {
      const parsed = Number.parseInt(matched[1], 10)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  return null
}
