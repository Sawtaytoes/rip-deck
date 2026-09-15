import { open, stat } from "node:fs/promises"

import {
  DATA_DISC_SECTOR_BYTES,
  parseDiscImageMap,
} from "./ddrescueCommand.ts"

/**
 * Prove a data-disc rip actually produced the whole disc.
 *
 * The data-disc twin of `verifyBackup.ts`, and it asks a
 * different question because it has a better source. A video
 * backup is judged by its SHAPE — is there a `BDMV`, is the
 * total within a loose fraction of the disc — because
 * `makemkvcon` adds and omits structures and no exact figure
 * exists. A raw image has an exact figure: ddrescue's mapfile
 * names every sector it could not read, so completeness is
 * counted rather than estimated.
 *
 * ## ⚠️ ISO 9660 is REPORTED, never REQUIRED
 *
 * This is the rule that a later "tidy-up" is most likely to
 * break, because `verifyBackup.ts` sitting next door does the
 * opposite: it treats a file with no `CD001` signature as proof
 * that whatever ran did not produce a disc image.
 *
 * That is right for a DVD and wrong here. A large family of
 * data CD-ROMs carry no ISO 9660 filesystem at all — sampler
 * libraries in particular, where E-MU, Akai and Ensoniq each
 * wrote their instrument banks in the sampler's own on-disc
 * format, because the sampler had no operating system to mount
 * a filesystem with. Those discs are exactly the ones a person
 * still needs imaged in 2026, since the hardware that reads
 * them is long gone and a converter takes the raw image.
 *
 * Requiring the signature would fail every one of them, and the
 * failure would read as "the drive could not read this disc" —
 * sending someone to clean a disc that was read perfectly.
 *
 * So the signature is recorded as a MARKER, the way
 * `leftovers.ts` records it: useful for a listing, never a
 * gate. What gates is the mapfile.
 *
 * ## The ISO 9660 cross-check, when there IS one
 *
 * A filesystem that IS ISO 9660 states its own length, in its
 * primary volume descriptor, and that is a second opinion worth
 * having: it is the only check that can catch a drive reporting
 * a smaller capacity than the disc actually holds. A mismatch
 * is a WARNING and not a failure — a disc whose last session is
 * unreadable still images its first one usefully, and the
 * mapfile already says what is missing.
 */

/** `CD001`, at byte 32769 — sector 16, offset 1. */
const ISO9660_MAGIC = "CD001"
const ISO9660_MAGIC_OFFSET = 32_769

/**
 * The primary volume descriptor begins at sector 16.
 *
 * Both fields read below are stored twice, little-endian then
 * big-endian ("both-byte-order"), and the little-endian copy is
 * first. Offsets are from ECMA-119 §8.4: volume space size at
 * byte 80 of the descriptor, logical block size at byte 128.
 */
const PVD_OFFSET = 32_768
const PVD_VOLUME_SPACE_SIZE_OFFSET = PVD_OFFSET + 80
const PVD_LOGICAL_BLOCK_SIZE_OFFSET = PVD_OFFSET + 128

/**
 * Fraction of the disc the image must reach to be publishable.
 *
 * Deliberately loose and deliberately NOT the completeness
 * test — `unrecoveredBytes` is that, exactly, and it is
 * reported separately. This floor answers a cruder question:
 * is there enough here to be worth putting in the library at
 * all, or did the drive give up almost immediately?
 */
const MINIMUM_RECOVERED_FRACTION = 0.5

export type DiscImageVerification = {
  /** Is there an image worth publishing? */
  isVerified: boolean
  bytesOnDisk: number
  /**
   * Bytes the drive never read, straight from the mapfile.
   *
   * Zero is the only value that means a perfect rip. Null means
   * the mapfile could not be read at all, which is itself a
   * refusal — see `verifyDiscImage`.
   */
  unrecoveredBytes: number | null
  /** `"ISO"` when the image carries the ISO 9660 signature. */
  markerFound: string | null
  /** Trouble that does not sink the rip. */
  warnings: string[]
  /** Plain language, because this shows up on a phone. */
  reason: string
}

export const verifyDiscImage = async (input: {
  imagePath: string
  /** The mapfile ddrescue was told to write. */
  mapfilePath: string
  /** What sysfs said the disc holds. */
  discBytes: number
  /** Injected so a test needs no ddrescue and no disc. */
  readMapfile?: (path: string) => Promise<string>
  readIsoGeometry?: (
    path: string,
  ) => Promise<IsoGeometry | null>
}): Promise<DiscImageVerification> => {
  const image = await stat(input.imagePath).catch(
    () => null,
  )

  if (image === null || !image.isFile()) {
    return {
      isVerified: false,
      bytesOnDisk: 0,
      unrecoveredBytes: null,
      markerFound: null,
      warnings: [],
      reason:
        "ddrescue wrote no image file at all, so there is " +
        "nothing to publish",
    }
  }

  const readMapfile =
    input.readMapfile ?? defaultReadMapfile
  const readIsoGeometry =
    input.readIsoGeometry ?? defaultReadIsoGeometry

  const contents = await readMapfile(
    input.mapfilePath,
  ).catch(() => null)

  const discImageMap =
    contents === null ? null : parseDiscImageMap(contents)

  if (discImageMap === null) {
    // ⚠️ A refusal, not a fallback to "the file looks big
    // enough". The mapfile IS the evidence, and an image
    // published without it carries an unanswerable question —
    // whether those bytes are the disc's or ddrescue's idea of
    // what it could not reach. Say so instead of guessing.
    return {
      isVerified: false,
      bytesOnDisk: image.size,
      unrecoveredBytes: null,
      markerFound: await readIsoMarker(input.imagePath),
      warnings: [],
      reason:
        "ddrescue left no readable mapfile, so nothing can " +
        `say which sectors were read. ${formatBytes(image.size)} ` +
        "is on the pool and it is NOT being published as a " +
        "complete disc",
    }
  }

  const markerFound = await readIsoMarker(input.imagePath)
  const warnings: string[] = []

  if (image.size < input.discBytes) {
    warnings.push(
      `The image is ${formatBytes(image.size)} for a ` +
        `${formatBytes(input.discBytes)} disc — its tail was ` +
        "never written.",
    )
  }

  const geometry =
    markerFound === null
      ? null
      : await readIsoGeometry(input.imagePath)

  const isoBytes =
    geometry === null
      ? null
      : geometry.volumeSpaceSize * geometry.logicalBlockSize

  if (isoBytes !== null && image.size < isoBytes) {
    warnings.push(
      `The ISO 9660 filesystem says it is ` +
        `${formatBytes(isoBytes)}, which is more than the ` +
        `${formatBytes(image.size)} the drive reported and ` +
        "read. Some of the filesystem is not in this image.",
    )
  }

  if (discImageMap.unrecoveredBytes > 0) {
    warnings.push(
      `${formatBytes(discImageMap.unrecoveredBytes)} ` +
        `(${describeSectors(discImageMap.unrecoveredBytes)}) ` +
        "could not be read off this disc. The mapfile beside " +
        "the image lists exactly where, and ddrescue can " +
        "resume from it.",
    )
  }

  const required =
    input.discBytes * MINIMUM_RECOVERED_FRACTION

  if (discImageMap.recoveredBytes < required) {
    return {
      isVerified: false,
      bytesOnDisk: image.size,
      unrecoveredBytes: discImageMap.unrecoveredBytes,
      markerFound,
      warnings,
      reason:
        `only ${formatBytes(discImageMap.recoveredBytes)} of ` +
        `a ${formatBytes(input.discBytes)} disc was read — ` +
        "that is not an image of this disc, it is the part " +
        "the drive managed before it gave up",
    }
  }

  return {
    isVerified: true,
    bytesOnDisk: image.size,
    unrecoveredBytes: discImageMap.unrecoveredBytes,
    markerFound,
    warnings,
    reason:
      `${formatBytes(image.size)} on disk` +
      // Said out loud on the SUCCESS line, because its absence
      // is normal here and looks alarming anywhere else.
      (markerFound === null
        ? ", no ISO 9660 filesystem (normal for a sampler or " +
          "console disc — the image is still complete)"
        : ", ISO 9660") +
      (discImageMap.unrecoveredBytes === 0
        ? ", every sector read"
        : ""),
  }
}

/** Both-byte-order fields out of an ISO 9660 volume descriptor. */
export type IsoGeometry = {
  volumeSpaceSize: number
  logicalBlockSize: number
}

/** Is this image an ISO 9660 filesystem? */
const readIsoMarker = async (
  path: string,
): Promise<string | null> => {
  const buffer = await readAt({
    path,
    position: ISO9660_MAGIC_OFFSET,
    length: ISO9660_MAGIC.length,
  })

  return buffer !== null &&
    buffer.toString("latin1") === ISO9660_MAGIC
    ? "ISO"
    : null
}

/**
 * The filesystem's own idea of how long it is.
 *
 * Little-endian halves of both-byte-order fields, which is why
 * the lengths read are 4 and 2 rather than 8 and 4.
 */
const defaultReadIsoGeometry = async (
  path: string,
): Promise<IsoGeometry | null> => {
  const size = await readAt({
    path,
    position: PVD_VOLUME_SPACE_SIZE_OFFSET,
    length: 4,
  })

  const block = await readAt({
    path,
    position: PVD_LOGICAL_BLOCK_SIZE_OFFSET,
    length: 2,
  })

  if (size === null || block === null) return null

  const volumeSpaceSize = size.readUInt32LE(0)
  const logicalBlockSize = block.readUInt16LE(0)

  // A zero in either field is a descriptor this code does not
  // understand rather than a zero-length filesystem, and
  // multiplying them would produce a confident 0 bytes.
  return volumeSpaceSize === 0 || logicalBlockSize === 0
    ? null
    : { volumeSpaceSize, logicalBlockSize }
}

const readAt = async (input: {
  path: string
  position: number
  length: number
}): Promise<Buffer | null> => {
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(input.path, "r")
    const buffer = Buffer.alloc(input.length)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      input.length,
      input.position,
    )

    return bytesRead === input.length ? buffer : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

const defaultReadMapfile = async (
  path: string,
): Promise<string> => {
  const { readFile } = await import("node:fs/promises")

  return await readFile(path, "utf8")
}

/**
 * Sectors, because that is the unit a person acts on.
 *
 * "2 MB could not be read" says nothing about whether one file
 * is damaged or a thousand are. A sector count is what a
 * recovery tool, and the mapfile itself, talks in.
 */
const describeSectors = (bytes: number): string => {
  const sectors = Math.ceil(bytes / DATA_DISC_SECTOR_BYTES)

  return `${String(sectors)} sector${sectors === 1 ? "" : "s"}`
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
