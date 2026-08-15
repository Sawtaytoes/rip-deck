import {
  createSupervisionState,
  type DriveSupervisionState,
  type Job,
  type Verdict,
} from "@rip-deck/contracts"
import type { BayDiscFacts } from "../mqtt/driveState.ts"
import type { LoadedDiscSummary } from "../rip/loadedDiscs.ts"
import {
  STABLE_USB,
  type UsbStability,
} from "../rip/usbStability.ts"

/**
 * The tower, as the API reads it.
 *
 * This is a READ seam and nothing more. The API renders what it
 * is handed; it computes no verdicts, opens no devices and calls
 * nothing on a drive. That is not tidiness — a synchronous
 * device call in the parent process freezes all nine bays'
 * monitoring and the API at once, which is the exact failure the
 * child-per-drive architecture exists to prevent (AGENTS.md).
 *
 * Up to NINE bays are live at once. The owner has asked for
 * auto-rip across the whole tower, so every view here is a list
 * of bays; there is no "the current job".
 *
 * ZERO bays is a valid, normal state (F3) — the owner powers the
 * tower independently of the host. `collectorError` stays empty
 * in that case; an empty tower is not a fault and must never be
 * rendered as one.
 */

/** One physical bay and whatever it is doing right now. */
export type BaySnapshot = {
  /** Stable drive id — `usb-2-1-1-2-4-4-2`. The real key. */
  driveId: string
  /** House display name, e.g. "07 - Pioneer BDR-211M". */
  label: string
  slot: number | null
  /**
   * `/dev/srN`, EPHEMERAL and never identity — it reshuffles on
   * every USB re-enumeration. Carried only because the ARM
   * viewer keys its per-drive controls on it.
   */
  devPath: string | null
  isPresent: boolean
  vendor: string | null
  /**
   * Pass the REGISTRY's true model, not the drive's reported
   * one: slots 2-4 are LG drives whose OmniDrive firmware
   * reports them as ASUS.
   */
  model: string | null
  /** Firmware serial — canonical identity, from makemkvcon. */
  serial: string | null
  /**
   * The disc in the tray, in 512-byte sectors; null for none.
   *
   * The only field that says a DISC is present, as opposed to a
   * drive — which is what a bay holding a finished disc needs in
   * order to read as held rather than as empty.
   */
  discSizeSectors: number | null
  /** Null when the bay is idle or merely holding a disc. */
  job: Job | null
  supervision: DriveSupervisionState
  /**
   * The tray, exactly as the MQTT publisher describes it.
   *
   * Carried whole rather than flattened into fields here so that
   * `/json` and `drive/<slug>` are the same payload by
   * CONSTRUCTION: both hand this to `buildDriveStatePayload`,
   * which is the only thing that decides what a tray reads as.
   * Re-deriving those seven fields in the API would be a second
   * source of truth for a shape Home Assistant already reads.
   *
   * ⚠️ **Null means "this producer was never told about the
   * tray", and the fields are then OMITTED rather than
   * defaulted.** A fixture has no bay table; emitting
   * `has_disc: false` on its behalf would be the false "nothing
   * loaded" that half of the payload exists to correct.
   */
  disc: BayDiscFacts | null
}

/** The rip whose outcome was announced most recently. */
export type LastRip = {
  job: Job
  verdict: Verdict
  driveLabel: string
}

export type TowerSnapshot = {
  /** Display name of the host, matching the ARM viewer's. */
  host: string
  bays: BaySnapshot[]
  lastRip: LastRip | null
  isMqttEnabled: boolean
  /**
   * A real collector failure — NOT "no drives present". Empty
   * string means healthy.
   */
  collectorError: string
  /**
   * Whether the USB bus is flapping, bus-wide.
   *
   * Its own field rather than a per-bay one because a flap is a
   * property of the shared bus, not of any single drive — the
   * whole bank re-enumerates together. `STABLE_USB` (never null)
   * so a snapshot built without a watcher reads as "steady", not
   * as "unknown", which is the honest default for a fixture.
   */
  usbStability: UsbStability
  /**
   * The watcher's own "what is still in the tower" summary.
   *
   * ⚠️ **Optional, and the reason `/json` and MQTT agree after a
   * restart.** `buildTowerView` would otherwise recompute the
   * loaded set from `bays` alone — the same empty table a daemon
   * restarted against a dark tower starts with — so the dashboard
   * would show nothing while Home Assistant still reminded. When
   * the watcher provides this (`main.ts` folds in
   * `getLoadedDiscs()`), it is the ONE summary both consumers
   * read, phantoms from the on-disk ledger included
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   * Absent for a fixture and for a snapshot built without a
   * watcher, where `buildTowerView` falls back to folding `bays`.
   */
  loadedDiscs?: LoadedDiscSummary
}

export const DEFAULT_HOST_LABEL = "tower"

export const createBaySnapshot = (input: {
  driveId: string
  label: string
  slot?: number | null
  devPath?: string | null
  isPresent?: boolean
  vendor?: string | null
  model?: string | null
  serial?: string | null
  discSizeSectors?: number | null
  job?: Job | null
  supervision?: DriveSupervisionState
  disc?: BayDiscFacts | null
}): BaySnapshot => ({
  driveId: input.driveId,
  label: input.label,
  slot: input.slot ?? null,
  devPath: input.devPath ?? null,
  isPresent: input.isPresent ?? true,
  vendor: input.vendor ?? null,
  model: input.model ?? null,
  serial: input.serial ?? null,
  discSizeSectors: input.discSizeSectors ?? null,
  job: input.job ?? null,
  supervision:
    input.supervision ??
    createSupervisionState(input.driveId),
  disc: input.disc ?? null,
})

export const createTowerSnapshot = (
  input: {
    host?: string
    bays?: BaySnapshot[]
    lastRip?: LastRip | null
    isMqttEnabled?: boolean
    collectorError?: string
    usbStability?: UsbStability
  } = {},
): TowerSnapshot => ({
  host: input.host ?? DEFAULT_HOST_LABEL,
  bays: input.bays ?? [],
  lastRip: input.lastRip ?? null,
  isMqttEnabled: input.isMqttEnabled ?? false,
  collectorError: input.collectorError ?? "",
  usbStability: input.usbStability ?? STABLE_USB,
})

/**
 * Tower order: slot 1 at the top, slot 9 at the bottom, and a
 * drive we cannot place last. This is the order the owner walks
 * up to the rack in, so it is the order the dashboard shows.
 */
const compareBays = (
  left: BaySnapshot,
  right: BaySnapshot,
): number => {
  if (left.slot !== right.slot) {
    if (left.slot === null) return 1
    if (right.slot === null) return -1
    return left.slot - right.slot
  }

  return left.driveId.localeCompare(right.driveId)
}

export type TowerStore = {
  readSnapshot: () => TowerSnapshot
  /** Insert or replace one bay, keyed by `driveId`. */
  setBay: (params: { bay: BaySnapshot }) => void
  removeBay: (params: { driveId: string }) => void
  setLastRip: (params: { lastRip: LastRip | null }) => void
  setMqttEnabled: (params: {
    isMqttEnabled: boolean
  }) => void
  setCollectorError: (params: { error: string }) => void
  setUsbStability: (params: {
    usbStability: UsbStability
  }) => void
}

/**
 * In-memory tower state.
 *
 * Deliberately a store rather than a poller: the sampler loop
 * and `ripJob` already know when something changed, so the API
 * never has to go and ask a drive. `readSnapshot` is a pure
 * memory read and cannot block.
 */
export const createTowerStore = (
  input: { host?: string; isMqttEnabled?: boolean } = {},
): TowerStore => {
  const baysByDriveId = new Map<string, BaySnapshot>()

  let lastRip: LastRip | null = null
  let isMqttEnabled = input.isMqttEnabled ?? false
  let collectorError = ""
  let usbStability: UsbStability = STABLE_USB

  return {
    readSnapshot: () =>
      createTowerSnapshot({
        host: input.host ?? DEFAULT_HOST_LABEL,
        bays: [...baysByDriveId.values()].sort(compareBays),
        lastRip,
        isMqttEnabled,
        collectorError,
        usbStability,
      }),

    setBay: ({ bay }) => {
      baysByDriveId.set(bay.driveId, bay)
    },

    removeBay: ({ driveId }) => {
      baysByDriveId.delete(driveId)
    },

    setLastRip: (params) => {
      lastRip = params.lastRip
    },

    setMqttEnabled: (params) => {
      isMqttEnabled = params.isMqttEnabled
    },

    setCollectorError: ({ error }) => {
      collectorError = error
    },

    setUsbStability: (params) => {
      usbStability = params.usbStability
    },
  }
}
