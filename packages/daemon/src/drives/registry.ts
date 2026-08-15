import { readFile } from "node:fs/promises"
import {
  type DrivePlacement,
  parseReadOffsetSamples,
} from "@rip-deck/contracts"

/**
 * Resolve a physically-present drive to its tower slot.
 *
 * The identity tiering, strongest first:
 *
 *  1. `firmwareSerial` — CANONICAL. The drive's own serial, and
 *     the only key that is genuinely unique per physical unit.
 *     It survives a firmware reflash (slots 2-4 are LG drives
 *     running OmniDrive firmware that reports them as ASUS, and
 *     their original serials came through intact) and it
 *     survives re-cabling. Its one cost: it is not in sysfs on
 *     this hardware, so reading it needs a `makemkvcon` call.
 *  2. `usbPortPath` — the RUNTIME key. Free from sysfs, needs
 *     no device access, and stable unless someone re-cables.
 *     This is what the 2-second sampler keys on.
 *  3. `bridgeSerial` — TIEBREAKER ONLY. The ASMedia adapters
 *     all report a `123456789`-prefixed serial and differ only
 *     in the trailing hex. Distinct across our nine, but that
 *     is not a guarantee a replacement adapter would honour.
 *
 * So: resolve fast by port path, and let the firmware serial
 * repair the map when the port path moves.
 */

export type DriveRegistryEntry = {
  slot: number
  name: string
  firmwareSerial: string
  trueModel: string
  reportedModel: string
  usbPortPath: string
  bridgeSerial: string
  isUhdCapable: boolean
  /**
   * The drive's AccurateRip read offset, in samples. Null until
   * someone has measured it; that is a supported state and not
   * an error, and it means the rip runs with no `-s` flag.
   *
   * **Keyed on THIS ENTRY'S `firmwareSerial`, never on a model
   * string, and that is not a stylistic preference.**
   * AccurateRip publishes its offsets per drive MODEL, so the
   * obvious shortcut is a model table — and on this tower that
   * shortcut is silently wrong for three of nine bays: slots
   * 2-4 are LG drives running OmniDrive firmware that reports
   * them as ASUS, so a model lookup would hand an ASUS offset
   * to an LG drive. The only symptom would be AccurateRip
   * saying "not in database" forever, which reads as a metadata
   * bug rather than a configuration one. Do not "simplify" this
   * into a lookup by `trueModel` or `reportedModel`.
   *
   * Measured once per physical drive with `cyanrip -f` and then
   * true forever — it is a property of the drive itself, so it
   * survives a re-cable and a `/dev/srN` reshuffle precisely
   * because the key is the serial. Procedure:
   * `docs/deployment-requirements.md`.
   */
  readOffsetSamples: number | null
}

export type DriveRegistry = {
  towerRootPortPath: string
  entries: DriveRegistryEntry[]
}

type RegistryFile = {
  towerRootPortPath?: string
  drives?: Partial<DriveRegistryEntry>[]
}

export const loadDriveRegistry = async (
  path: string,
): Promise<DriveRegistry> => {
  const parsed = JSON.parse(
    await readFile(path, "utf8"),
  ) as RegistryFile

  const entries = (parsed.drives ?? []).flatMap((drive) =>
    // A slot without a firmware serial cannot be resolved
    // reliably, so drop it loudly rather than half-trust it.
    typeof drive.slot === "number" &&
    typeof drive.firmwareSerial === "string"
      ? [
          {
            slot: drive.slot,
            name: drive.name ?? `${drive.slot}`,
            firmwareSerial: drive.firmwareSerial,
            trueModel: drive.trueModel ?? "",
            reportedModel: drive.reportedModel ?? "",
            usbPortPath: drive.usbPortPath ?? "",
            bridgeSerial: drive.bridgeSerial ?? "",
            isUhdCapable: drive.isUhdCapable ?? false,
            // Unmeasured, mistyped and implausible all land on
            // null here. A bad offset must cost one drive its
            // `-s` flag, never cost nine bays their watcher, so
            // this is the one field the loader validates rather
            // than defaults.
            readOffsetSamples: parseReadOffsetSamples(
              drive.readOffsetSamples,
            ),
          },
        ]
      : [],
  )

  return {
    towerRootPortPath: parsed.towerRootPortPath ?? "",
    entries,
  }
}

/**
 * The registry's `trueModel`, split into maker and model.
 *
 * `config/drives.json` writes one string — `LG WH14NS40`,
 * `Pioneer BDR-211M` — because that is how the owner says a
 * drive out loud, while a dashboard has a maker column and a
 * model column. Split on the first whitespace run; a
 * single-token entry is all model and no maker, which is honest
 * rather than a maker invented out of half a model number.
 *
 * This is the ONLY trustworthy source for either field on this
 * tower: slots 2-4 are LG drives whose OmniDrive firmware
 * reports them as ASUS, so the drive's own answer is known to
 * lie and the operator's file is the truth.
 */
export const parseTrueModel = (
  trueModel: string,
): { vendor: string | null; model: string | null } => {
  const tokens = trueModel
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length === 0) {
    return { vendor: null, model: null }
  }

  if (tokens.length === 1) {
    return { vendor: null, model: tokens[0] }
  }

  return {
    vendor: tokens[0],
    model: tokens.slice(1).join(" "),
  }
}

export type ResolutionInput = {
  usbPortPath: string
  bridgeSerial: string | null
  /** Present only when a MakeMKV drive scan has been done. */
  firmwareSerial?: string | null
}

export type DriveResolution = {
  placement: DrivePlacement | null
  entry: DriveRegistryEntry | null
  /** Which key matched, for the trust trail. */
  matchedBy:
    | "firmware_serial"
    | "usb_port_path"
    | "bridge_serial"
    | "none"
  /**
   * True when the drive was found by firmware serial but its
   * cached port path no longer matches — i.e. someone re-cabled
   * the tower and the hint needs rewriting.
   */
  isPortPathStale: boolean
}

/**
 * Resolve one present drive against the registry.
 *
 * Deliberately falls through the tiers rather than requiring a
 * firmware serial: the sampler runs every 2 seconds and must
 * never be blocked on a device command.
 */
export const resolveDrive = (
  registry: DriveRegistry,
  input: ResolutionInput,
): DriveResolution => {
  const toPlacement = (
    entry: DriveRegistryEntry,
  ): DrivePlacement => ({
    slot: entry.slot,
    name: entry.name,
  })

  if (input.firmwareSerial) {
    const bySerial = registry.entries.find(
      (entry) =>
        entry.firmwareSerial === input.firmwareSerial,
    )

    if (bySerial) {
      return {
        placement: toPlacement(bySerial),
        entry: bySerial,
        matchedBy: "firmware_serial",
        isPortPathStale:
          bySerial.usbPortPath !== input.usbPortPath,
      }
    }
  }

  const byPortPath = registry.entries.find(
    (entry) => entry.usbPortPath === input.usbPortPath,
  )

  if (byPortPath) {
    return {
      placement: toPlacement(byPortPath),
      entry: byPortPath,
      matchedBy: "usb_port_path",
      isPortPathStale: false,
    }
  }

  // Last resort. Only trustworthy because we additionally know
  // the drive is physically present right now; never use this
  // to reason about a drive we cannot see.
  if (input.bridgeSerial) {
    const byBridge = registry.entries.filter(
      (entry) => entry.bridgeSerial === input.bridgeSerial,
    )

    // Ambiguous means the vendor reused a serial — refuse.
    if (byBridge.length === 1) {
      return {
        placement: toPlacement(byBridge[0]),
        entry: byBridge[0],
        matchedBy: "bridge_serial",
        isPortPathStale:
          byBridge[0].usbPortPath !== input.usbPortPath,
      }
    }
  }

  return {
    placement: null,
    entry: null,
    matchedBy: "none",
    isPortPathStale: false,
  }
}

/**
 * Drives sharing a hub subtree with the given port path.
 *
 * Used by the hub-correlation detector. Note the physical
 * reality this models: the rack is ONE 10-port hub on ONE long
 * active USB extension, and what sysfs shows as a three-tier
 * tree is that hub's internal 4-port chips. So a subtree match
 * implicates a chip, while a match at the tower root implicates
 * the cable or the hub itself — most often its aux power, which
 * is the tower's known single point of failure.
 */
export const drivesSharingHub = (
  registry: DriveRegistry,
  hubPath: string,
): DriveRegistryEntry[] =>
  registry.entries.filter(
    (entry) =>
      entry.usbPortPath === hubPath ||
      entry.usbPortPath.startsWith(`${hubPath}.`),
  )
