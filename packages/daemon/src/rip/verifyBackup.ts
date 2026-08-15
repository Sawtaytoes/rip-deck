import { stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Prove a backup actually produced a disc.
 *
 * `backup` mode emits no title count, so there is no message to
 * check — and checking one would be the wrong instinct anyway.
 * A message says what makemkvcon believes; this says what is on
 * the dataset.
 *
 * Deliberately structural rather than byte-exact, and measured
 * as APPARENT size rather than allocation. On the first real rip
 * those two answers differed: `du` reported 33 G because it
 * counts ZFS allocation, while the summed file sizes came to
 * 34,535,584,646 bytes — 32.2 GB, matching what sysfs said the
 * disc held. Allocation depends on recordsize and compression,
 * so a threshold written against `du` would be a threshold
 * against the pool's settings.
 *
 * Even so the check is a floor, not an equality: a backup omits
 * some structures and adds MakeMKV's own AACS/CMAP data, so the
 * two are only ever close. The floor catches the case that
 * matters — a directory that is empty or holds only stubs.
 */

/** Marker directories a video disc backup must contain. */
const DISC_MARKERS = ["BDMV", "VIDEO_TS"] as const

/**
 * Fraction of the disc's reported size the output must reach.
 *
 * A guess, like every other threshold here — but a deliberately
 * loose one. It exists to separate "a disc" from "a few stub
 * files", not to audit completeness, and the read-error count
 * plus the exit code already cover truncation.
 */
const MINIMUM_SIZE_FRACTION = 0.5

export type BackupVerification = {
  isVerified: boolean
  /** Which marker was found, for the log. */
  markerFound: string | null
  bytesOnDisk: number
  /** Plain language, because this shows up on a phone. */
  reason: string
}

/**
 * Sum file sizes under a directory.
 *
 * Uses apparent size rather than shelling to `du`, so it is the
 * same number on any filesystem and needs no child process.
 */
const measureTree = async (
  path: string,
): Promise<number> => {
  const { readdir } = await import("node:fs/promises")

  let total = 0
  const entries = await readdir(path, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const child = join(path, entry.name)

    if (entry.isDirectory()) {
      total += await measureTree(child)
      continue
    }

    if (!entry.isFile()) continue

    try {
      total += (await stat(child)).size
    } catch {
      // A file that vanished mid-walk is not worth failing a
      // verification over.
    }
  }

  return total
}

export const verifyBackupStructure = async (input: {
  path: string
  discBytes: number
}): Promise<BackupVerification> => {
  let markerFound: string | null = null

  for (const marker of DISC_MARKERS) {
    try {
      const info = await stat(join(input.path, marker))
      if (info.isDirectory()) {
        markerFound = marker
        break
      }
    } catch {
      // Absent; try the next marker.
    }
  }

  if (markerFound === null) {
    return {
      isVerified: false,
      markerFound: null,
      bytesOnDisk: 0,
      reason:
        "the output has no BDMV or VIDEO_TS directory, so " +
        "whatever ran did not produce a disc",
    }
  }

  const bytesOnDisk = await measureTree(input.path)
  const required = input.discBytes * MINIMUM_SIZE_FRACTION

  if (bytesOnDisk < required) {
    return {
      isVerified: false,
      markerFound,
      bytesOnDisk,
      reason:
        `only ${formatGb(bytesOnDisk)} landed for a ` +
        `${formatGb(input.discBytes)} disc — the structure is ` +
        "there but the content is not",
    }
  }

  return {
    isVerified: true,
    markerFound,
    bytesOnDisk,
    reason: `${markerFound}, ${formatGb(bytesOnDisk)} on disk`,
  }
}

const formatGb = (bytes: number): string =>
  `${(bytes / 1024 ** 3).toFixed(1)} GB`
