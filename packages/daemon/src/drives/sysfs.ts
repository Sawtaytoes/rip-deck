import {
  readdir,
  readFile,
  realpath,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  type Drive,
  type DriveAddress,
  type DriveIdentity,
  type DriveMedia,
  driveIdFromPortPath,
  hubChainOf,
  hubPathOf,
  inferDiscType,
} from "@rip-deck/contracts"

/**
 * Drive discovery and sampling, straight from sysfs.
 *
 * Everything here is a plain file read. That is the point: no
 * ioctl, no SCSI command, no `makemkvcon info`. A drive whose
 * SCSI host is wedged in error recovery will block any device
 * command for up to 600 seconds, and the kernel's own polling
 * keeps these files current regardless — so reading files is
 * both cheaper and, more importantly, cannot hang.
 */

const SYS_BLOCK = "/sys/block"

/** Read a sysfs attribute, trimmed. Null if unreadable. */
const readAttr = async (
  path: string,
): Promise<string | null> => {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch {
    return null
  }
}

const readIntAttr = async (
  path: string,
): Promise<number | null> => {
  const raw = await readAttr(path)
  if (raw === null) return null

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Read `ioerr_cnt`, which the SCSI layer formats as HEX with an
 * `0x` prefix (`0x5c`) — not decimal, despite every other
 * counter in sysfs being decimal.
 *
 * Parsing it as base 10 silently yields 0 for `0x5c` and 5 for
 * `0x5`, so the error counter would look flat forever. Verified
 * against the live tower, where all nine drives report hex.
 */
export const parseIoErrorCount = (
  raw: string | null,
): number | null => {
  if (raw === null) return null

  const trimmed = raw.trim()
  const parsed = trimmed.toLowerCase().startsWith("0x")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 16)

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * `/sys/block/srN/stat` — the fields we use.
 *
 * Space-separated, whitespace-padded. Fields are 0-indexed
 * here: 0 reads completed, 1 reads merged, 2 sectors read,
 * 3 milliseconds spent reading.
 */
export type BlockStat = {
  readsCompleted: number
  sectorsRead: number
  readTicksMs: number
}

export const parseBlockStat = (
  raw: string | null,
): BlockStat | null => {
  if (raw === null) return null

  const fields = raw.trim().split(/\s+/)
  if (fields.length < 4) return null

  const readsCompleted = Number.parseInt(fields[0], 10)
  const sectorsRead = Number.parseInt(fields[2], 10)
  const readTicksMs = Number.parseInt(fields[3], 10)

  if (
    !Number.isFinite(readsCompleted) ||
    !Number.isFinite(sectorsRead) ||
    !Number.isFinite(readTicksMs)
  ) {
    return null
  }

  return { readsCompleted, sectorsRead, readTicksMs }
}

/**
 * Walk up from a block device's sysfs path to the USB device
 * directory that owns it — the first ancestor with `idVendor`.
 *
 * We cannot compute this path: the number of intermediate
 * levels differs between a drive on a root port and one behind
 * three cascaded hub chips.
 */
const findUsbDeviceDir = async (
  startPath: string,
): Promise<string | null> => {
  let current = startPath

  while (current !== "/" && current !== ".") {
    const vendor = await readAttr(join(current, "idVendor"))
    if (vendor !== null) return current

    current = dirname(current)
  }

  return null
}

/** Extract `hostNN` -> NN from a resolved sysfs path. */
const scsiHostFromPath = (path: string): number | null => {
  const matched = path.match(/\/host(\d+)\//)
  return matched ? Number.parseInt(matched[1], 10) : null
}

/** Extract the `H:C:T:L` address from a resolved sysfs path. */
const scsiAddressFromPath = (
  path: string,
): string | null => {
  const matched = path.match(/\/(\d+:\d+:\d+:\d+)\//)
  return matched ? matched[1] : null
}

/** List the optical device names currently present. */
export const listOpticalDeviceNames = async (): Promise<
  string[]
> => {
  try {
    const entries = await readdir(SYS_BLOCK)
    return entries
      .filter((entry) => /^sr\d+$/.test(entry))
      .sort(
        (a, b) =>
          Number.parseInt(a.slice(2), 10) -
          Number.parseInt(b.slice(2), 10),
      )
  } catch {
    // No drives at all is a normal state, not an error: the
    // owner powers the tower on and off independently of this
    // service, so starting with zero drives must work (F3).
    return []
  }
}

export type ProbedDrive = {
  address: DriveAddress
  identity: DriveIdentity
  media: DriveMedia
}

/** Probe one drive by kernel name, e.g. "sr3". */
export const probeDrive = async (
  kernelName: string,
): Promise<ProbedDrive | null> => {
  const blockPath = join(SYS_BLOCK, kernelName)

  // Resolve the real device path via the `device` symlink.
  // The number of intermediate sysfs levels varies with how
  // deep the drive sits in the hub cascade, so this must be
  // resolved rather than constructed.
  let devicePath: string
  try {
    devicePath = await realpath(join(blockPath, "device"))
  } catch {
    // The drive vanished between listing and probing — normal
    // when the tower is powered off mid-scan.
    return null
  }

  const usbDir = await findUsbDeviceDir(devicePath)
  if (usbDir === null) return null

  const usbPortPath = basename(usbDir)

  const [
    vendor,
    model,
    revision,
    bridgeSerial,
    speed,
    sizeRaw,
  ] = await Promise.all([
    readAttr(join(devicePath, "vendor")),
    readAttr(join(devicePath, "model")),
    readAttr(join(devicePath, "rev")),
    readAttr(join(usbDir, "serial")),
    readIntAttr(join(usbDir, "speed")),
    readIntAttr(join(blockPath, "size")),
  ])

  const sizeSectors = sizeRaw ?? 0
  const discType = inferDiscType(sizeSectors)

  return {
    address: {
      kernelName,
      devPath: `/dev/${kernelName}`,
      scsiHost: scsiHostFromPath(devicePath) ?? -1,
      scsiAddress: scsiAddressFromPath(devicePath) ?? "",
    },
    identity: {
      usbPortPath,
      bridgeSerial,
      hubPath: hubPathOf(usbPortPath) ?? usbPortPath,
      hubChain: hubChainOf(usbPortPath),
      vendor: vendor ?? "",
      model: model ?? "",
      revision: revision ?? "",
      linkSpeed: speed,
    },
    media: {
      sizeSectors,
      hasMedia: discType !== "none",
      capacityBytes: sizeSectors * 512,
      discType,
    },
  }
}

/** Probe every optical drive currently present. */
export const probeAllDrives = async (): Promise<
  ProbedDrive[]
> => {
  const names = await listOpticalDeviceNames()
  const probed = await Promise.all(
    names.map((name) => probeDrive(name)),
  )

  return probed.filter(
    (drive): drive is ProbedDrive => drive !== null,
  )
}

/** Convert a probe result into the shared `Drive` shape. */
export const toDrive = (
  probed: ProbedDrive,
  placement: Drive["placement"],
): Drive => ({
  id: driveIdFromPortPath(probed.identity.usbPortPath),
  identity: probed.identity,
  placement,
  address: probed.address,
  isPresent: true,
})

/** Sample the volatile counters for one drive. */
export const sampleDrive = async (
  kernelName: string,
): Promise<{
  ioErrorCount: number | null
  stat: BlockStat | null
  sizeSectors: number | null
}> => {
  const blockPath = join(SYS_BLOCK, kernelName)

  const [ioErrRaw, statRaw, sizeSectors] =
    await Promise.all([
      readAttr(join(blockPath, "device", "ioerr_cnt")),
      readAttr(join(blockPath, "stat")),
      readIntAttr(join(blockPath, "size")),
    ])

  return {
    ioErrorCount: parseIoErrorCount(ioErrRaw),
    stat: parseBlockStat(statRaw),
    sizeSectors,
  }
}

/**
 * The drive's SCSI generic node, e.g. `/dev/sg207`.
 *
 * **Measured on hardware 2026-07-26, and it is not optional.** A
 * per-rip container given only `--device /dev/sr0` answers
 *
 *   MSG:5042 "The program can't find any usable optical drives."
 *
 * and emits a DRV table of pure padding. MakeMKV issues SCSI
 * commands through the generic node, so `srN` alone is a drive it
 * can see and cannot use. Add the matching `sgN` and the very same
 * command reports exactly one drive at index 0.
 *
 * ⚠️ **The number does not follow `N`.** On this host `sr0..sr8`
 * are `sg207..sg215`, because the NAS's own pool disks hold the
 * low numbers — so `sg0` is somebody else's disk, and guessing it
 * would hand a rip container the wrong device entirely. It has to
 * be read per drive, and read FRESH per rip: it renumbers on USB
 * re-enumeration exactly like `srN`.
 *
 * Returns null when the drive has no generic node, which the
 * caller must treat as "cannot isolate this rip" rather than
 * silently dropping the flag.
 */
export const readScsiGenericPath = async (
  kernelName: string,
): Promise<string | null> => {
  try {
    const entries = await readdir(
      `/sys/block/${kernelName}/device/scsi_generic`,
    )

    const name = entries[0]

    return name === undefined ? null : `/dev/${name}`
  } catch {
    return null
  }
}
