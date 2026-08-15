/**
 * Drive identity.
 *
 * The whole point of this model is that `/dev/srN` is NOT an
 * identity — it reshuffles on every USB re-enumeration, which
 * happens whenever the tower is power-cycled independently of
 * the host (which is the normal way it is used). Every project
 * in this space keys on srN and every one of them gets a
 * drive's history wrong after a reshuffle.
 *
 * Three tiers, most-stable first:
 *
 *  1. `usbPortPath` — PRIMARY. The physical topology position
 *     (`2-1.1.2.4.4.2`). Stable across reboots and re-plugs;
 *     changes only if someone re-cables the tower. This is also
 *     what maps to a physical bay the owner can walk up to.
 *  2. `bridgeSerial` — SECONDARY. The USB-SATA bridge serial.
 *     Follows the enclosure through a re-cable, so it repairs
 *     identity when the port path changes.
 *  3. `devPath` / `scsiHost` — EPHEMERAL. Used to address the
 *     drive right now; never persisted as identity.
 *
 * Caveat learned from the real tower: the ASMedia ASMT1153e
 * bridges all report a serial with the same `123456789` vendor
 * prefix and differ only in the trailing hex. They are distinct
 * across our nine units, but they are clearly not guaranteed
 * unique, so `bridgeSerial` is a tiebreaker and never the
 * primary key.
 */

/** Live, ephemeral addressing for a drive. */
export type DriveAddress = {
  /** e.g. "sr3" */
  kernelName: string
  /** e.g. "/dev/sr3" */
  devPath: string
  /** e.g. 29 (from hostNN) */
  scsiHost: number
  /** e.g. "29:0:0:0" */
  scsiAddress: string
}

/** Stable identity plus descriptive hardware detail. */
export type DriveIdentity = {
  /** PRIMARY key. e.g. "2-1.1.2.4.4.2" */
  usbPortPath: string
  /** SECONDARY key. e.g. "1234567892BB" */
  bridgeSerial: string | null
  /** Parent hub port path, e.g. "2-1.1.2.4.4" */
  hubPath: string
  /** Every ancestor hub, root-first. Used for correlation. */
  hubChain: string[]
  vendor: string
  model: string
  revision: string
  /** USB link speed in Mb/s, e.g. 5000. */
  linkSpeed: number | null
}

/**
 * Physical placement, from the operator-maintained slot map.
 * Absent for a drive we have never seen before.
 */
export type DrivePlacement = {
  /** 1-based, tower order: top = 1 … bottom = 9. */
  slot: number
  /** Display name, house scheme: "03 - BD-RW BDR-211M". */
  name: string
}

/**
 * The widest read offset we are willing to believe, in samples.
 *
 * A drive's read offset is a small SIGNED sample count and
 * cyanrip's `-s` takes it verbatim, so an unchecked value is a
 * rip aligned to nothing — which looks exactly like the problem
 * the offset exists to fix, and is therefore the last thing
 * anyone would suspect.
 *
 * The bound is ten CD-DA sectors: a sector is 2352 bytes, which
 * at 16-bit stereo is 588 samples, so 5880 samples is about
 * 133 ms. Ten sectors because an offset correction makes the
 * ripper read `|offset| / 588` extra sectors past each track
 * boundary — a real offset is a handful of sectors at most, and
 * the offsets AccurateRip publishes run from single digits to a
 * few hundred with the known outliers still well under 2000. So
 * ten sectors accepts anything genuine with room to spare while
 * still catching the two mistakes that are actually likely: a
 * number pasted in the wrong unit (bytes, or milliseconds) and
 * a stray extra digit.
 *
 * ⚠️ **Unverified against this tower.** No offset has been
 * measured on any of the nine drives yet. This bound comes from
 * CD-DA geometry and published offset lists, not from anything
 * observed here.
 */
export const MAX_READ_OFFSET_SAMPLES = 5880

/**
 * A read offset we are willing to hand to cyanrip's `-s`.
 *
 * Deliberately a type guard rather than a thrown error: the
 * caller's correct response to a bad offset is to OMIT the
 * flag. A rip with no offset is the ordinary everyday state —
 * nothing is measured yet on any drive — while a rip with a
 * garbage offset produces sample-shifted files that no
 * AccurateRip lookup can ever match.
 */
export const isValidReadOffsetSamples = (
  value: unknown,
): value is number =>
  typeof value === "number" &&
  // Also rejects NaN and both infinities.
  Number.isInteger(value) &&
  Math.abs(value) <= MAX_READ_OFFSET_SAMPLES

/**
 * Read one `readOffsetSamples` out of the operator's slot map.
 *
 * Absent, null and implausible all collapse to null, and null
 * is a SUPPORTED state rather than an error — the same shape as
 * a missing `RIP_DECK_MQTT_URL` or `RIP_DECK_OMDB_API_KEY`. One
 * daemon watches nine bays, so a typo in one drive's offset has
 * to cost that drive its `-s` flag, not cost the tower its
 * watcher.
 */
export const parseReadOffsetSamples = (
  value: unknown,
): number | null =>
  isValidReadOffsetSamples(value) ? value : null

/** A drive as currently present on the system. */
export type Drive = {
  /** Stable slug derived from the identity; used in topics. */
  id: string
  identity: DriveIdentity
  placement: DrivePlacement | null
  /** Null when the drive is known but not currently present. */
  address: DriveAddress | null
  isPresent: boolean
}

/**
 * Media state, derived from sysfs only — deliberately never
 * from an ioctl, so that polling a wedged drive cannot block.
 *
 * The kernel's own disk-event polling keeps `/sys/block/srN/size`
 * current, so media presence costs us zero device access.
 */
export type DriveMedia = {
  /** `/sys/block/srN/size`, in 512-byte sectors. */
  sizeSectors: number
  hasMedia: boolean
  /** Bytes; `sizeSectors * 512`. */
  capacityBytes: number
  discType: DiscType
}

/**
 * Capacity thresholds for disc typing.
 *
 * The kernel reports a 1 GiB sentinel (2097151 sectors) when a
 * tray is empty or unreadable — treat that as "no media", not
 * as a tiny disc.
 */
export const EMPTY_TRAY_SECTORS = 2097151

export type DiscType =
  | "none"
  | "cd"
  | "dvd"
  | "bluray"
  | "uhd"
  | "unknown"

const GIB = 1024 * 1024 * 1024

/**
 * Infer disc type from capacity alone.
 *
 * UHD is inferred at >= 55 GB because a BD-100 triple-layer is
 * UHD-only in practice, and a dual-layer BD-50 tops out around
 * 50 GB. Anything above the BD-50 ceiling is 4K.
 */
export const inferDiscType = (
  sizeSectors: number,
): DiscType => {
  if (
    sizeSectors <= 0 ||
    sizeSectors === EMPTY_TRAY_SECTORS
  ) {
    return "none"
  }

  const bytes = sizeSectors * 512

  if (bytes < 1 * GIB) return "cd"
  if (bytes < 9.5 * GIB) return "dvd"
  if (bytes < 55 * GIB) return "bluray"
  return "uhd"
}

/** Folder-naming label for a disc type (requirement B2). */
export const discTypeLabel = (
  discType: DiscType,
): string | null => {
  switch (discType) {
    case "dvd":
      return "DVD"
    case "bluray":
      return "Blu-ray"
    case "uhd":
      return "4K"
    default:
      return null
  }
}

/**
 * Derive the stable slug used in MQTT topics and the database.
 *
 * Port path is the primary key, so the slug follows it; the
 * separator is normalised because `.` is meaningful in some
 * topic hierarchies.
 */
export const driveIdFromPortPath = (
  usbPortPath: string,
): string => `usb-${usbPortPath.replace(/[.:]/g, "-")}`

/** Parent hub of a port path, or null for a root-port device. */
export const hubPathOf = (
  usbPortPath: string,
): string | null => {
  const lastDot = usbPortPath.lastIndexOf(".")
  return lastDot === -1
    ? null
    : usbPortPath.slice(0, lastDot)
}

/**
 * Every ancestor hub of a port path, root-first.
 *
 * `2-1.1.2.4.4.2` -> ["2-1", "2-1.1", "2-1.1.2",
 *                     "2-1.1.2.4", "2-1.1.2.4.4"]
 *
 * The tower is a daisy chain of 4-port hubs, so a fault in one
 * link takes out everything below it. Correlating on the whole
 * chain — not just the immediate parent — is what lets the
 * health engine blame the right hub.
 */
export const hubChainOf = (
  usbPortPath: string,
): string[] => {
  const parts = usbPortPath.split(".")
  const chain: string[] = []

  for (let i = 1; i < parts.length; i += 1) {
    chain.push(parts.slice(0, i).join("."))
  }

  return chain
}
