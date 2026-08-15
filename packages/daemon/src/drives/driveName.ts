/**
 * Parse MakeMKV's `DRV:` drive-name field.
 *
 * This field is the ONLY place the drive's real firmware serial
 * is available on this rig. Verified 2026-07-24: the ASMedia
 * ASMT1153e bridges expose no SCSI VPD page 0x80, so
 * `/sys/block/srN/device/vpd_pg80` does not exist and
 * `inquiry` carries vendor/model/revision but no serial.
 *
 * Why the firmware serial matters more than the bridge serial:
 *
 *  - It is genuinely unique per physical drive, and it is
 *    RETAINED across a firmware reflash — three of these units
 *    are LG drives running OmniDrive firmware that makes them
 *    report as ASUS, and their original serials survived. So
 *    the serial identifies the drive even when the model string
 *    lies about what it is.
 *  - The USB bridge serials all share a `123456789` vendor
 *    prefix and differ only in the trailing hex. They happen to
 *    be distinct across our nine adapters, but that is luck,
 *    not a guarantee: a replacement adapter could easily
 *    collide.
 *
 * Hence the tiering: firmware serial is CANONICAL identity,
 * USB port path is the runtime key (free, no device access),
 * bridge serial is only a tiebreaker.
 *
 * Format, from real output:
 *   "BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00007"
 *   "BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00001"
 *    ^type ^vendor ^model...      ^rev  ^serial
 *
 * Note the runs of multiple spaces inside the Pioneer model —
 * split on whitespace runs, never on a single space.
 */

export type ParsedDriveName = {
  /** e.g. "BD-RE" */
  driveType: string
  /** e.g. "PIONEER" */
  vendor: string
  /** e.g. "BD-RW BDR-211M" */
  model: string
  /** e.g. "1.53" */
  firmwareRevision: string
  /** e.g. "EXAMPLE00007" — canonical drive identity. */
  firmwareSerial: string
}

/** A firmware revision looks like `1.53` / `3.02`. */
const isRevision = (token: string): boolean =>
  /^\d+\.\d+$/.test(token)

/**
 * Parse a DRV drive-name string.
 *
 * Returns null rather than throwing for anything that does not
 * match, including the empty name MakeMKV emits for its 16
 * always-present but unattached slots.
 */
export const parseDriveName = (
  driveName: string,
): ParsedDriveName | null => {
  const tokens = driveName
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  // type + vendor + model + revision + serial = 5 minimum.
  if (tokens.length < 5) return null

  const firmwareSerial = tokens[tokens.length - 1]
  const firmwareRevision = tokens[tokens.length - 2]

  // If the second-to-last token is not a revision the layout is
  // not what we expect; refuse rather than mis-assign a serial.
  if (!isRevision(firmwareRevision)) return null

  return {
    driveType: tokens[0],
    vendor: tokens[1],
    model: tokens.slice(2, tokens.length - 2).join(" "),
    firmwareRevision,
    firmwareSerial,
  }
}

/**
 * MakeMKV pads its drive list to 16 slots; the unused ones come
 * back with `visible === 256` (NOT_ATTACHED) and three empty
 * strings. Filtering on the empty device path is the reliable
 * test — `visible` also takes other values on real drives.
 */
export const isAttachedDrive = (drive: {
  devicePath: string
  driveName: string
}): boolean =>
  drive.devicePath !== "" && drive.driveName !== ""
