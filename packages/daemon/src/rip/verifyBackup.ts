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

/**
 * ⚠️ **A DVD backup is a FILE, not a directory.**
 *
 * `makemkvcon backup` produces two completely different shapes
 * and nothing in its output says which you are about to get:
 *
 *  - **Blu-ray / UHD** — a DIRECTORY at the destination path,
 *    holding `BDMV`, `CERTIFICATE` and the rest.
 *  - **DVD** — a single decrypted **ISO image file** at that
 *    exact path, with no extension and no directory anywhere.
 *
 * Measured on the live tower 2026-08-26. Slot 6 rode to
 * `MSG:5070 "Backup done"` and left
 * `.rip-deck-incomplete-68fa9004-…` as an 8,203,894,784-byte
 * regular file which `file(1)` reads as
 * `UDF filesystem data (version 1.5) 'TEENAGE_MUTANT_NINJA_TURTLE_V6'`
 * and which loop-mounts with an intact `VIDEO_TS`. The rip was
 * perfect. This function called it `empty_output`, because it
 * looked for a `VIDEO_TS` **directory** inside a path that was
 * not a directory at all.
 *
 * The same fact explains `MSG:5068 "Folder … already contains a
 * backup"`: MakeMKV wanted to CREATE a file at that path, and a
 * directory was sitting in the way. The message is misleading —
 * the directory was empty — and it is why Blu-ray never hit it
 * while every DVD did.
 *
 * So the marker for an ISO is the ISO9660 signature at its own
 * fixed offset rather than a filename: MakeMKV writes no
 * extension, so there is nothing else to key on, and trusting
 * "it is a big file" would bless a truncated one.
 */

/** `CD001`, at byte 32769 — sector 16, offset 1. */
const ISO9660_MAGIC = "CD001"
const ISO9660_MAGIC_OFFSET = 32_769

/** Is this file an ISO image MakeMKV wrote? */
const readIsoMarker = async (
  path: string,
): Promise<string | null> => {
  const { open } = await import("node:fs/promises")

  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(path, "r")
    const buffer = Buffer.alloc(ISO9660_MAGIC.length)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      ISO9660_MAGIC_OFFSET,
    )

    return bytesRead === buffer.length &&
      buffer.toString("latin1") === ISO9660_MAGIC
      ? "ISO"
      : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export const verifyBackupStructure = async (input: {
  path: string
  discBytes: number
}): Promise<BackupVerification> => {
  const target = await stat(input.path).catch(() => null)

  if (target === null) {
    return {
      isVerified: false,
      markerFound: null,
      bytesOnDisk: 0,
      reason:
        "nothing was written at the destination at all",
    }
  }

  // The DVD shape. Checked FIRST because it is the cheap,
  // unambiguous one — a regular file is never a Blu-ray backup.
  if (target.isFile()) {
    return verifySize({
      markerFound: await readIsoMarker(input.path),
      bytesOnDisk: target.size,
      discBytes: input.discBytes,
      missingReason:
        "the output is a file with no ISO9660 signature in " +
        "it, so whatever ran did not produce a disc image",
    })
  }

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

  return verifySize({
    markerFound,
    bytesOnDisk: await measureTree(input.path),
    discBytes: input.discBytes,
    missingReason:
      "the output has no BDMV or VIDEO_TS directory, so " +
      "whatever ran did not produce a disc",
  })
}

/**
 * The floor both shapes are held to, once their marker is known.
 *
 * Shared so a DVD image and a Blu-ray directory cannot drift
 * apart on the one threshold that decides whether a rip counts —
 * the shapes differ, the standard does not.
 */
const verifySize = (input: {
  markerFound: string | null
  bytesOnDisk: number
  discBytes: number
  missingReason: string
}): BackupVerification => {
  if (input.markerFound === null) {
    return {
      isVerified: false,
      markerFound: null,
      bytesOnDisk: input.bytesOnDisk,
      reason: input.missingReason,
    }
  }

  const required = input.discBytes * MINIMUM_SIZE_FRACTION

  if (input.bytesOnDisk < required) {
    return {
      isVerified: false,
      markerFound: input.markerFound,
      bytesOnDisk: input.bytesOnDisk,
      reason:
        `only ${formatGb(input.bytesOnDisk)} landed for a ` +
        `${formatGb(input.discBytes)} disc — the structure is ` +
        "there but the content is not",
    }
  }

  return {
    isVerified: true,
    markerFound: input.markerFound,
    bytesOnDisk: input.bytesOnDisk,
    reason:
      `${input.markerFound}, ` +
      `${formatGb(input.bytesOnDisk)} on disk`,
  }
}

const formatGb = (bytes: number): string =>
  `${(bytes / 1024 ** 3).toFixed(1)} GB`
