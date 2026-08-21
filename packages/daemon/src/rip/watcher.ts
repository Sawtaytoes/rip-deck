import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
} from "node:fs/promises"
import { join } from "node:path"
import type {
  DiscType,
  JobProgress,
} from "@rip-deck/contracts"
import {
  catchError,
  defaultIfEmpty,
  defer,
  EMPTY,
  exhaustMap,
  firstValueFrom,
  from,
  lastValueFrom,
  mergeMap,
  type Observable,
  of,
  raceWith,
  Subject,
  tap,
} from "rxjs"
import {
  type DriveRegistry,
  type DriveRegistryEntry,
  loadDriveRegistry,
  parseTrueModel,
  resolveDrive,
} from "../drives/registry.ts"
import {
  type ProbedDrive,
  probeAllDrives,
} from "../drives/sysfs.ts"
import {
  adoptBayAtStartup,
  type BayLedger,
  type BayLedgerRecord,
  bayLedgerPath,
  EMPTY_BAY_LEDGER,
  ledgerFingerprint,
  readBayLedger,
  toLedgerRecords,
  toTrayRecords,
  writeBayLedger,
} from "./bayLedger.ts"
import {
  buildCyanripInvocation,
  buildCyanripKillArgs,
  type CyanripCommand,
  type CyanripInvocation,
  resolveCyanripAlbumDir,
  resolveCyanripCommand,
} from "./cyanripCommand.ts"
import {
  applyOutputOwnership,
  buildFolderName,
  checkFreeSpace,
  createOutputOwnership,
  incompleteDirName,
} from "./destination.ts"
import { enumerateDrives } from "./discIndex.ts"
import {
  type DiscAttentionReason,
  detectDiscType,
} from "./discType.ts"
import {
  createEventLog,
  createNullEventLog,
} from "./eventLog.ts"
import type { Governor } from "./governor.ts"
import { identifyDisc } from "./identifyDisc.ts"
import {
  type LoadedDiscSummary,
  phantomLoadedBays,
  summariseLoadedDiscs,
} from "./loadedDiscs.ts"
import {
  ISOLATED_DISC_INDEX,
  type MakemkvCommand,
  type RipIsolation,
  resolveMakemkvCommand,
  resolveRipIsolation,
} from "./ripCommand.ts"
import { runRipJob } from "./ripJob.ts"
import { waitForSettledMedia } from "./settle.ts"
import {
  type EjectCommand,
  resolveEjectCommand,
  runTrayCommand,
  type TrayResult,
} from "./tray.ts"
import {
  type BayTrayCommand,
  buildClearLoadedResponse,
  buildTowerPowerOffResponse,
  buildTrayCommandResponse,
  buildTrayPowerOnResponse,
  decideTrayBayAction,
  hasFinishedDisc,
  isBayTargeted,
  isRipCompleted,
  type TrayBayResult,
  type TrayCommandRequest,
  type TrayCommandResponsePayload,
} from "./trayCommand.ts"
import {
  unrefInterval,
  unrefTimeout,
} from "./unrefTimers.ts"
import {
  detectTransitions,
  pruneTransitions,
  STABLE_USB,
  summariseUsbStability,
  type UsbStability,
  type UsbTransition,
} from "./usbStability.ts"

/**
 * The watcher — insert a disc, get a rip.
 *
 * This is the piece that closes the gap ARM's retirement left
 * open: *"I want it to rip as many discs as I insert. If I insert
 * 9 discs, start 9 rips of the correct type."*
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md))
 *
 * It automates, per bay, exactly the sequence `rip-deck rip`
 * already performs by hand, in the same order and with the same
 * refusals: settle, type, identify, resolve, rip. Nothing here
 * decides anything a human command would have decided
 * differently — the only new question is *when*, and the only new
 * risk is *repeatedly*.
 *
 * ## The failure mode this file exists to prevent
 *
 * A poll loop that starts a rip because a bay has media will start
 * that rip again on the next tick, and the tick after that. The
 * manual CLI never had to think about it — a human runs the
 * command once. Automated, the same logic is an insert/eject-class
 * flap-storm wearing different clothes, and the flap-storm is the
 * documented root cause that killed valid rips in *other* bays.
 *
 * So the bay state machine below is not bookkeeping, it is the
 * safety mechanism, and it holds three lines:
 *
 *  1. **A finished, failed or flagged disc is latched.** Nothing
 *     reconsiders that bay until the media actually changes.
 *  2. **Only a PRESENT drive reporting an empty tray releases the
 *     latch.** A drive vanishing from sysfs is not evidence its
 *     disc left — and USB re-enumeration on this tower is routine,
 *     so treating a disappearance as an ejection would re-rip
 *     every finished disc in the rack.
 *  3. **Starts are counted, and a bay that keeps starting without
 *     the tray ever going empty is quarantined.** That is the
 *     backstop for a drive whose reported size flaps between two
 *     values, which is the one input that could otherwise walk
 *     around rule 1 forever.
 *
 * **No decision in this file ejects anything.** Not one branch of
 * `decideBayAction` produces a tray movement, and none may ever
 * be added: the recorded rule is **never eject-loop**
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md)),
 * and an automatic eject on the rip cycle is exactly the
 * flap-storm that killed valid rips in other bays. It is why
 * `settle.ts` and `discType.ts` refuse rather than retry, and why
 * an unreadable disc's outcome is a state, not an action.
 *
 * ⚠️ That rule is **narrower** than "rip-deck never ejects", which
 * this repo wrongly claimed in three places until 2026-07-26
 * (`docs/HANDOFF-eject-and-open-questions.md` §1). `runTrayCommand`
 * below moves trays on an **operator's** command and is reachable
 * only from the MQTT command surface — never from the poll loop,
 * never from an outcome. Nothing re-inserts, so no loop exists.
 *
 * ## Bay state survives a restart, and has to
 *
 * The bay table used to be built empty on every boot, which meant
 * a restart with finished discs still loaded **re-ripped every
 * one of them** — a fresh bay is `idle`, so THE RULE could not
 * fire. `bayLedger.ts` persists the latched bays and
 * `adoptBayAtStartup` decides what a bay that already has a disc
 * in it may do. Read that file before changing anything here
 * about `done`.
 *
 * ## Why this may live in the parent process
 *
 * `AGENTS.md`: **never block the parent process on a device
 * call.** The watcher supervises nine bays from the parent, so one
 * synchronous device call here freezes all nine and the API with
 * them. It follows the same five rules `rip/sampler.ts` sets out,
 * for the same reason:
 *
 *  - The poll reads **sysfs and udev files only** — `probeAllDrives`
 *    is `readdir`/`readFile`/`realpath`, and `detectDiscType` is
 *    two file reads. No ioctl, no SCSI command, nothing that can
 *    sit in D-state for 600 s.
 *  - Every probe **races a watchdog** shorter than the poll
 *    interval, and a probe is never queued behind an outstanding
 *    one. A wedged drive costs one dangling read, not a queue.
 *  - **Ticks never overlap**, so a slow tick is skipped rather
 *    than interleaved. `exhaustMap` is what says so: a tick that
 *    arrives mid-poll is dropped, not queued.
 *  - The **rip itself is never awaited by the loop.** Everything
 *    that touches a device for real — `waitForSettledMedia`'s
 *    two-minute window, `identifyDisc`'s scoped `info`,
 *    `runRipJob`'s three-hour child — is pushed onto the dispatch
 *    subject, which the tick does not wait for and cannot be
 *    wedged by.
 *  - The timer is **`unref()`d** unless the caller says this
 *    watcher IS the process — `unrefInterval`, because RxJS's own
 *    `interval` keeps its handle ref'd and would make
 *    `rip-deck rip` hang on exit.
 *
 * One wedged drive therefore costs exactly one bay.
 *
 * ## Concurrency is bounded twice, on purpose
 *
 * The governor holds the leases and is the real cap. The dispatch
 * pipeline's `mergeMap` is bounded to **that same number**, so it
 * can never queue a rip the governor has already leased a slot to
 * — a queued dispatch would hold a lease while doing nothing,
 * which is the one way a bound here could make the tower slower
 * rather than safer. Unbounded `mergeMap` was the alternative and
 * is the wrong one: nine wedged drives are exactly the case this
 * file exists for, and "as many as arrive" is not a bound.
 *
 * ## Zero drives is normal
 *
 * The tower is powered independently of this service (F3), so an
 * empty bus is a valid steady state and never an alarm. The
 * watcher keeps polling and says nothing until that changes.
 */

export const WATCHER_TUNING = {
  /**
   * How often the bus is re-read.
   *
   * Five seconds is chosen against the human, not the machine: a
   * disc takes ~15 s to spin up and `waitForSettledMedia` spends
   * six of those debouncing anyway, so polling faster buys no
   * latency a person could notice while multiplying the number of
   * chances to act on a half-inserted disc.
   */
  pollIntervalMs: 5_000,

  /**
   * How long a bus probe gets before it is abandoned.
   *
   * Shorter than `pollIntervalMs`, so an abandoned probe can never
   * still be running when the next tick fires. Same reasoning and
   * same shape as `SAMPLER_TUNING.readTimeoutMs`: sysfs reads are
   * not supposed to be able to hang, and "not supposed to" is not
   * a guarantee worth betting nine bays on.
   */
  probeTimeoutMs: 3_000,

  /**
   * Consecutive empty-tray readings needed to re-arm a bay.
   *
   * More than one, because a single reading is not evidence: the
   * kernel reports the 1 GiB sentinel (2097151 sectors) for a tray
   * that is empty *or* momentarily unreadable, and a disc being
   * re-read mid-spin can produce one of those. Two readings ten
   * seconds apart cannot.
   */
  rearmEmptyObservations: 2,

  /**
   * Starts allowed on one bay before it is quarantined.
   *
   * The counter resets only when the tray is confirmed empty, so
   * this bounds the one loop the latch cannot: a drive whose
   * reported size oscillates between two values looks like a new
   * disc arriving, over and over. Three attempts, then the bay
   * stops on its own and waits for the disc to be taken out.
   */
  maxStartsPerDisc: 3,

  /**
   * Consecutive empty readings before a bay's tray is trusted as
   * GENUINELY empty (`hasSettledEmpty`), and a disc that appears is
   * a fresh insert to rip rather than one that was already loaded.
   *
   * ⚠️ **This is the cold-power-on guard.** When the tower powers
   * on, a drive enumerates a moment before its disc is readable, so
   * the drive's first sighting looks EMPTY. Trusting that one empty
   * reading meant the disc that appeared a poll later was treated
   * as freshly inserted and RE-RIPPED a disc that was loaded before
   * the tower came on (measured: an already-backed-up Soylent Green
   * UHD). A genuinely empty drive stays empty for many polls; a
   * spin-up is over in one. Higher than `rearmEmptyObservations`
   * because the cost of trusting empty too early is a 90 GB re-rip,
   * where the cost of trusting it too late is a few seconds before
   * a real insert starts
   * ([decision](docs/decisions/2026-07-31-a-disc-present-at-power-on-is-adopted-not-ripped.md)).
   */
  settleEmptyObservations: 3,
} as const

/* ------------------------------------------------------------ *
 * The per-bay state machine — a pure reducer.
 * ------------------------------------------------------------ */

/**
 * What a bay is doing.
 *
 * Deliberately NOT `JobState` from `@rip-deck/contracts`. That type
 * describes a *job*, which ends; this describes a *bay*, which
 * outlives its jobs and whose whole purpose is to remember that
 * one already happened.
 */
export type BayPhase =
  /** Armed and empty. The only phase a rip can start from. */
  | "idle"
  /** Settling, typing and identifying. The bay is claimed. */
  | "starting"
  /** A ripper child is running against this drive. */
  | "ripping"
  /** Terminal for the disc that is in the drive right now. */
  | "done"
  /** Started too many times without the tray ever going empty. */
  | "quarantined"

export type BayOutcomeKind =
  | "completed"
  | "failed"
  /** Flagged for a human. The disc STAYS in the drive. */
  | "needs_attention"
  /**
   * The disc left before the rip could start.
   *
   * Not a failure and not a latch: it re-arms the bay. The start
   * counter survives it, so a drive that produces this in a loop
   * still quarantines.
   */
  | "no_media"

export type BayOutcome = {
  kind: BayOutcomeKind
  /** Plain language, for the console and the card. */
  detail: string
}

export type BayState = {
  /**
   * Stable drive identity — the USB port path.
   *
   * **Never `/dev/srN`.** It reshuffles on every USB
   * re-enumeration, and a bay's memory of "this disc is already
   * done" attached to a name that moves is worse than no memory at
   * all: it would latch the wrong bay and re-rip the right one.
   */
  driveId: string
  phase: BayPhase
  /**
   * `/sys/block/srN/size` for the disc this bay last acted on.
   *
   * The disc fingerprint, and the reason a finished disc is not
   * re-ripped on the next tick. Coarse on purpose — it is not
   * trying to tell two same-sized discs apart, it is trying to
   * tell "the same disc, still sitting there" from "something
   * changed", and it is backed by the start counter for the case
   * where it is fooled.
   */
  sizeSectors: number | null
  /**
   * The disc's own name, as `identifyDisc` read it.
   *
   * Written from `onIdentified`, which already fires minutes
   * before the outcome does — so this costs no extra device
   * access, and there is exactly one `makemkvcon` read of the
   * label per rip either way.
   *
   * It is here rather than only inside `outcome.detail` because
   * the dashboard needs the NAME, and pulling it back out of an
   * English sentence is the `MSG:5072` mistake this repo refuses
   * on principle. Persisted (`bayLedger.ts` v2), so a held disc
   * still has a name after a restart.
   */
  discName: string | null
  /**
   * What the disc turned out to be — `cd`, `bluray`, `uhd`, …
   *
   * Written from the same `onIdentified` as `discName`, which is
   * why it costs nothing: `decideDiscType` has already run by
   * then (it is what chose the ripper), and re-deriving it later
   * would need udev and a settled drive.
   *
   * Here because the poster lookup has to route on it — an audio
   * CD belongs at a music provider, and asking a film database
   * about an album is how a CD ends up wearing a film's poster.
   * Everything downstream used to write `discType: "unknown"`
   * because the bay table did not record it. Persisted, so an
   * adopted disc is still typed after a restart.
   */
  discType: DiscType | null
  /**
   * Where this bay's rip landed. Null until one has.
   *
   * Same argument as `discName`: the path is in the completion
   * sentence for a human to read, and a structured field for
   * anything that has to render it. Only a rip that actually
   * published sets it — a failure's partial output is reported
   * in the outcome, never here, because this field reads as
   * "the backup is at".
   */
  destinationPath: string | null
  outcome: BayOutcome | null
  /**
   * This bay's disc was ADOPTED, not started here.
   *
   * True only for a bay `adoptBayAtStartup` latched from the
   * ledger: the disc was finished with by the daemon that ran
   * before this one, so nothing in this process ever ripped it
   * and it has no telemetry of its own. It cannot be inferred
   * downstream — an adopted bay does emit one "held on startup"
   * note, which looks exactly like any other bay speaking.
   */
  isAdopted: boolean
  /**
   * When the CURRENT outcome was latched. Null for none.
   *
   * Distinct from `updatedAtMs`, which moves on every tick a
   * held bay is looked at and so cannot date anything: this is
   * the instant the disc in this tray was finished with, and it
   * survives both a restart (through the ledger) and every
   * subsequent hold. It is the only timestamp an ADOPTED disc
   * has, and what stops its card from claiming its rip started
   * one second ago, every second, forever.
   */
  latchedAtMs: number | null
  /**
   * The rip this bay is running, or the last one it ran.
   *
   * It SURVIVES the latch (`applyBayOutcome`) rather than being
   * cleared with it, because `<uuid>.robot.log` outlives the rip
   * and a finished disc's card offers that log. Cleared by the
   * disc leaving, which is when the capture stops describing
   * what is in the tray. Null for a bay that has never started
   * one, and for a quarantine — decided by the poll loop, which
   * never had a job.
   */
  jobUuid: string | null
  /**
   * The last tray command rip-deck itself sent this bay.
   *
   * ⚠️ **Not a reading of the drawer.** There is no reading of
   * the drawer to be had: sysfs reports MEDIA, and an open tray
   * and a closed empty tray are the same bytes without a
   * `CDROM_DRIVE_STATUS` ioctl Node cannot issue. This is the
   * honest substitute the dashboard's ⏏ toggle stands on — *"the
   * last thing I did was open it"* — and it is written only when
   * a tray actually moved, never on a refusal or a skip.
   *
   * It OUTLIVES the disc: `applyBayDecision`'s `rearm` rebuilds
   * every other field from scratch and carries this one across,
   * because the press it exists to answer is the one after the
   * operator has taken the disc out.
   */
  lastTrayCommand: BayTrayCommand | null
  /** Starts since the tray was last confirmed empty. */
  startCount: number
  /** Consecutive empty readings, for the re-arm debounce. */
  emptyObservationCount: number
  /**
   * This drive's tray has been confirmed GENUINELY empty since the
   * drive last appeared on the bus.
   *
   * ⚠️ **The cold-power-on guard.** A disc auto-rips only from a bay
   * whose tray was seen settled-empty first — proof the disc is a
   * fresh insert, not one that was already loaded when the tower
   * powered on. It is FALSE on a fresh bay and reset to false the
   * moment a drive drops off the bus (a power cycle re-opens the
   * question), and becomes true only after
   * `settleEmptyObservations` consecutive empty readings. A disc
   * that appears before then is routed back through
   * `adoptBayAtStartup` — held or ledger-recognised, never
   * blind-ripped
   * ([decision](docs/decisions/2026-07-31-a-disc-present-at-power-on-is-adopted-not-ripped.md)).
   */
  hasSettledEmpty: boolean
  /**
   * The disc this bay last FINISHED with — set the instant a rip
   * latches terminal (`applyBayOutcome`), and carried THROUGH a
   * re-arm where every other disc field is wiped.
   *
   * ⚠️ **The power-cycle guard.** When the tower's USB power cycles,
   * the daemon keeps running: `adoptBayAtStartup` never re-runs, the
   * in-memory `ledger` is a stale startup snapshot, and the drive
   * enumerates for ~10s reporting an empty tray before its disc is
   * readable — long enough that a `done` bay RE-ARMS to `idle` and
   * `persistLedger` erases its on-disk record before the disc reads.
   * So neither the ledger nor `hasSettledEmpty` can tell that the
   * disc which reappears is one already ripped: the 1.2.4 guard keyed
   * on `hasSettledEmpty` and re-ripped a completed disc live
   * (2026-07-31, Desk Set). This field is the bay's OWN memory that
   * survives the re-arm — a returning disc whose size matches it is
   * held, never re-ripped. `null` for a bay that has finished
   * nothing
   * ([decision](docs/decisions/2026-07-31-power-cycle-holds-a-finished-disc-from-bay-memory.md)).
   */
  lastFinished: BayLedgerRecord | null
  updatedAtMs: number
}

/** One tick's reading of one bay. */
export type BayObservation = {
  /**
   * The drive is in this probe's results at all.
   *
   * False is NOT "the disc was removed" — it is "we cannot see the
   * drive", which happens on a USB re-enumeration and every time
   * the tower is powered off.
   */
  isDrivePresent: boolean
  hasMedia: boolean
  sizeSectors: number
}

/**
 * What the last probe saw of one bay's HARDWARE.
 *
 * Kept beside `BayState` rather than inside it, and never
 * persisted: `BayState` is the pure fold the ledger writes down
 * and none of this is worth remembering across a restart — it is
 * a reading, retaken every tick. `/dev/srN` above all, which
 * reshuffles on every USB re-enumeration.
 *
 * It exists because every field below is knowable ONLY in the
 * poll loop, which holds the probe and the registry; no handler
 * carries either. Until this was surfaced, every drive in
 * `/json` read `name: null, mount: null, maker: null,
 * model: null, serial_id: null` — the dashboard had no drive
 * identity at all.
 */
export type BaySighting = {
  driveId: string
  /**
   * The drive answered THIS probe.
   *
   * The real fact behind `BayObservation.isDrivePresent`, and
   * not "the watcher has seen this bay once" — which is what the
   * API used to publish, so bays lingered as present forever
   * after the owner switched the tower off.
   */
  isDrivePresent: boolean
  slot: number | null
  /** House label, already slot-prefixed: `07 - Pioneer BDR-211M`. */
  label: string
  /** `/dev/srN`. EPHEMERAL — never identity. Null when absent. */
  devPath: string | null
  vendor: string | null
  /**
   * The REGISTRY's true model wherever there is one: slots 2-4
   * are LG drives whose OmniDrive firmware reports them as ASUS.
   */
  model: string | null
  /** Firmware serial — canonical identity, registry only. */
  serial: string | null
}

export type BayDecision =
  | { action: "start" }
  /** Media confirmed gone. Forget the disc, arm the bay. */
  | { action: "rearm" }
  | { action: "quarantine"; reason: string }
  /** Do nothing this tick, and say why. */
  | { action: "hold"; reason: string }

export const createBayState = (input: {
  driveId: string
  atMs: number
}): BayState => ({
  driveId: input.driveId,
  phase: "idle",
  sizeSectors: null,
  discName: null,
  discType: null,
  destinationPath: null,
  outcome: null,
  isAdopted: false,
  latchedAtMs: null,
  jobUuid: null,
  lastTrayCommand: null,
  startCount: 0,
  emptyObservationCount: 0,
  // A fresh bay has not confirmed its tray empty yet — the drive
  // may have just powered on with a disc already in it.
  hasSettledEmpty: false,
  // A fresh bay has finished nothing to remember.
  lastFinished: null,
  updatedAtMs: input.atMs,
})

/**
 * What to do about one bay, given one reading.
 *
 * Pure, and takes the governor's answer as a boolean rather than
 * the governor itself, so all nine bays' transitions — including
 * the ones that only happen on hardware nobody can reproduce on
 * demand — are testable without a drive. Same shape as
 * `decideOnChildExit` in `@rip-deck/contracts`.
 *
 * Read the order of these branches as the safety argument: every
 * path that could start a rip is guarded by all three of the
 * latch, the fingerprint and the start counter, and there is no
 * path at all that ejects.
 */
export const decideBayAction = (input: {
  bay: BayState
  observation: BayObservation
  /** The governor has room for another rip right now. */
  isSlotAvailable: boolean
}): BayDecision => {
  const { bay, observation } = input

  // A drive we cannot see tells us nothing about its disc. Holding
  // here is what stops a USB re-enumeration — routine on this
  // tower — from reading as "nine discs were just ejected", which
  // would re-rip the entire rack.
  if (!observation.isDrivePresent) {
    return {
      action: "hold",
      reason: "the drive is not on the bus right now",
    }
  }

  // The bay is claimed. Whatever the tray says, the running task
  // owns this drive: a disc that vanishes mid-rip is `ripJob`'s
  // business (it fails `disc_removed`), not the poll loop's, and
  // two opinions about one device is how a drive gets two writers.
  if (bay.phase === "starting" || bay.phase === "ripping") {
    return {
      action: "hold",
      reason: `already ${bay.phase}`,
    }
  }

  if (!observation.hasMedia) {
    const isRearmDue =
      bay.phase !== "idle" &&
      bay.emptyObservationCount + 1 >=
        WATCHER_TUNING.rearmEmptyObservations

    return isRearmDue
      ? { action: "rearm" }
      : { action: "hold", reason: "the tray is empty" }
  }

  // Quarantine clears on an empty tray and on nothing else — see
  // the branch above. That is deliberate and it matches
  // `clearQuarantine`'s reasoning in `@rip-deck/contracts`: the way
  // out is a human doing something, and here the human action IS
  // taking the disc out.
  if (bay.phase === "quarantined") {
    return {
      action: "hold",
      reason:
        "quarantined — take the disc out to re-arm this bay",
    }
  }

  // THE RULE. A disc that has already been ripped, has already
  // failed, or has already been flagged is not picked up again
  // while it is still sitting in the drive.
  if (
    bay.phase === "done" &&
    observation.sizeSectors === bay.sizeSectors
  ) {
    return {
      action: "hold",
      reason: `already ${bay.outcome?.kind ?? "handled"}`,
    }
  }

  // Reachable two ways: a genuinely new disc that arrived without
  // us ever seeing the tray empty, or a drive whose reported size
  // is oscillating. The second one is indistinguishable from the
  // first at this level and would loop forever, so it is bounded
  // here rather than diagnosed.
  if (bay.startCount >= WATCHER_TUNING.maxStartsPerDisc) {
    return {
      action: "quarantine",
      reason:
        `Started ${bay.startCount} times without the tray ` +
        "ever reading empty. Either the disc keeps changing " +
        "size or the drive is confused; the disc has been " +
        "left exactly where it is.",
    }
  }

  if (!input.isSlotAvailable) {
    return {
      action: "hold",
      reason: "waiting for a rip slot",
    }
  }

  return { action: "start" }
}

/**
 * Fold a decision back into the bay.
 *
 * Takes the observation too, because the two counters are
 * observation arithmetic rather than decisions — keeping them here
 * is what lets `decideBayAction` stay a readable list of refusals.
 */
export const applyBayDecision = (input: {
  bay: BayState
  observation: BayObservation
  action: BayDecision
  atMs: number
  /** Required for `start`; ignored otherwise. */
  jobUuid?: string
}): BayState => {
  const { bay, observation, action, atMs } = input

  // A drive that is off the bus tells us nothing about its tray,
  // so it must HOLD this tally rather than reset it. Resetting to
  // zero on every off-bus poll meant a drive flapping off the bus
  // between two confirmed-empty reads oscillated 1 → 0 → 1 → 0 and
  // never reached `rearmEmptyObservations` — so a rip that failed
  // while the tower's USB power was unstable latched its verdict
  // forever, with no disc in the tray (the 2026-07-27 12V incident;
  // see `docs/decisions/2026-07-28-empty-tray-clears-a-terminal-verdict.md`).
  // Only a disc we can actually SEE — present, with media — is
  // evidence the tray is not empty and resets the count. A running
  // rip's tray readings still belong to the rip, not to this count.
  const emptyObservationCount = !observation.isDrivePresent
    ? bay.emptyObservationCount
    : observation.hasMedia
      ? 0
      : bay.emptyObservationCount + 1

  // Confirmed genuinely empty after `settleEmptyObservations`
  // consecutive empty readings, and stays confirmed until the drive
  // drops off the bus — a power cycle re-opens the question, because
  // the disc could have been swapped while the tower was dark. A
  // drive off the bus tells us nothing, so it resets rather than
  // holds this (unlike the re-arm tally): the whole point is that a
  // drive which has just reappeared is NOT yet trusted as empty.
  const hasSettledEmpty = !observation.isDrivePresent
    ? false
    : observation.hasMedia
      ? bay.hasSettledEmpty
      : bay.hasSettledEmpty ||
        emptyObservationCount >=
          WATCHER_TUNING.settleEmptyObservations

  switch (action.action) {
    case "start":
      return {
        ...bay,
        phase: "starting",
        sizeSectors: observation.sizeSectors,
        // A start means a disc nothing has identified yet. The
        // name and path this bay was carrying describe the disc
        // that came BEFORE this one, and leaving them in place
        // would label the new rip with the old rip's folder
        // until identify caught up.
        discName: null,
        discType: null,
        destinationPath: null,
        outcome: null,
        // This process is starting this rip, so whatever the
        // bay was carrying from the last daemon is over.
        isAdopted: false,
        latchedAtMs: null,
        jobUuid: input.jobUuid ?? null,
        startCount: bay.startCount + 1,
        emptyObservationCount: 0,
        // A rip is starting, so the settle question is closed for
        // this disc — the bay will not be re-adopted while it is
        // starting/ripping, and a failure re-arms from scratch.
        hasSettledEmpty: true,
        updatedAtMs: atMs,
      }

    case "rearm":
      return {
        ...createBayState({
          driveId: bay.driveId,
          atMs,
        }),
        // Everything else about this bay described the disc,
        // and the disc has gone. The tray memory did not: it
        // describes the DRAWER, and re-arming is what happens
        // moments after the operator takes out the disc rip-deck
        // just opened the tray for. Dropping it here would reset
        // the ⏏ toggle to "open" at exactly the instant the
        // owner is about to press it to close.
        lastTrayCommand: bay.lastTrayCommand,
        // A re-arm only fires after the tray was confirmed empty,
        // so the drive IS settled empty — the next disc is a fresh
        // insert to rip, not one adopted from a power-on.
        hasSettledEmpty: true,
        // CARRIED across, like `lastTrayCommand` — and for the same
        // shape of reason. A power cycle's spin-up re-arms this bay
        // before its still-loaded disc is readable; without keeping
        // this, the disc that reappears a poll later looks fresh and
        // re-rips. This is the memory that lets the poll loop
        // recognise it coming back (`isFinishedDiscBack`).
        lastFinished: bay.lastFinished,
      }

    case "quarantine": {
      const outcome: BayOutcome = {
        kind: "needs_attention",
        detail: action.reason,
      }
      return {
        ...bay,
        phase: "quarantined",
        outcome,
        latchedAtMs: atMs,
        // A quarantine is the poll loop's own decision and never
        // had a rip, so there is no capture to point a card at.
        jobUuid: null,
        emptyObservationCount,
        hasSettledEmpty,
        // A quarantined disc is terminal too: if a power cycle
        // re-arms this bay before the disc reads, it is re-held
        // (quarantined) from this memory, not blind-ripped.
        lastFinished: {
          driveId: bay.driveId,
          phase: "quarantined",
          sizeSectors: observation.sizeSectors,
          discName: bay.discName,
          discType: bay.discType,
          destinationPath: bay.destinationPath,
          jobUuid: null,
          outcome,
          updatedAtMs: atMs,
        },
        updatedAtMs: atMs,
      }
    }

    case "hold":
      return {
        ...bay,
        emptyObservationCount,
        hasSettledEmpty,
        updatedAtMs: atMs,
      }
  }
}

/**
 * The ripper child actually started. `starting` -> `ripping`.
 *
 * ⚠️ **This is also the one moment the drawer's position can be
 * known rather than remembered.** A drive cannot read a disc with
 * its drawer out, so a bay that has started ripping is shut - and
 * that is independent of `lastTrayCommand`, which is written only
 * when rip-deck itself moved a tray and is otherwise blind.
 *
 * Without this the normal way to load a disc poisons the memory
 * permanently: press ▲, put the disc in, push the drawer shut by
 * hand. Nothing tells rip-deck the drawer moved, so
 * `lastTrayCommand` reads `open_bay` through the whole rip and
 * after it. `open_trays` folds exactly that field to decide
 * whether every finished bay is already open, so one stale
 * `open_bay` makes the fold say yes, collapses the escalation
 * straight to `"all"`, and opens all nine drawers on the FIRST
 * press instead of the finished one.
 */
export const applyRipStarted = (input: {
  bay: BayState
  atMs: number
}): BayState =>
  input.bay.phase === "starting"
    ? {
        ...input.bay,
        phase: "ripping",
        lastTrayCommand: "close_bay",
        updatedAtMs: input.atMs,
      }
    : input.bay

/**
 * The dispatched task finished. This is where the latch closes.
 *
 * `no_media` is the one outcome that does not latch — the disc
 * left before anything could be done with it, so there is nothing
 * to remember. The start counter survives it deliberately, so a
 * drive that produces `no_media` on every attempt still runs out
 * of attempts instead of retrying forever.
 */
export const applyBayOutcome = (input: {
  bay: BayState
  outcome: BayOutcome
  atMs: number
}): BayState =>
  input.outcome.kind === "no_media"
    ? {
        ...input.bay,
        phase: "idle",
        sizeSectors: null,
        // The disc left, so nothing about it is true of this
        // bay any more — including the name identify may have
        // read off it a moment before it was pulled.
        discName: null,
        discType: null,
        destinationPath: null,
        outcome: input.outcome,
        latchedAtMs: input.atMs,
        jobUuid: null,
        updatedAtMs: input.atMs,
      }
    : {
        ...input.bay,
        phase: "done",
        outcome: input.outcome,
        latchedAtMs: input.atMs,
        // KEPT, where this used to null it. The rip is over but
        // `$RIP_DECK_STATE_DIR/<uuid>.robot.log` is not: it is
        // the capture behind the finished card's log button, and
        // clearing the id here is what left an adopted disc —
        // the case the owner most wants a log for — falling back
        // to a placeholder that names no file. Cleared instead
        // by the disc leaving (`rearm`), which is when the
        // capture stops describing what is in the tray.
        // The bay's own memory of the disc it just finished with,
        // so a tower power-cycle that re-arms this bay before the
        // still-loaded disc is readable can recognise it coming
        // back and hold it, instead of re-ripping a completed
        // backup. Survives the re-arm; the on-disk ledger does not.
        lastFinished: {
          driveId: input.bay.driveId,
          phase: "done",
          sizeSectors: input.bay.sizeSectors,
          discName: input.bay.discName,
          discType: input.bay.discType,
          destinationPath: input.bay.destinationPath,
          jobUuid: input.bay.jobUuid,
          outcome: input.outcome,
          updatedAtMs: input.atMs,
        },
        updatedAtMs: input.atMs,
      }

/* ------------------------------------------------------------ *
 * The start pipeline — one bay, one disc, off the poll loop.
 * ------------------------------------------------------------ */

export type WatcherConfig = {
  destinationRoot: string
  /** The same dataset as the ripper sees it, when it differs. */
  innerDestinationRoot?: string
  stateDir: string
  registryPath: string
  makemkv: MakemkvCommand
  cyanrip: CyanripCommand
  /**
   * How to move a tray. Operator commands only — see `tray.ts`.
   */
  eject: EjectCommand
  isolation: RipIsolation | null
  /** Raw robot-mode capture, on by default (HANDOFF §5). */
  isEventLogEnabled?: boolean
}

export const createWatcherConfig = (
  env: Record<string, string | undefined>,
): WatcherConfig => ({
  destinationRoot: env.RIP_DECK_DEST ?? "/media/Disc-Rips",
  innerDestinationRoot: env.RIP_DECK_DEST_INNER,
  stateDir: env.RIP_DECK_STATE_DIR ?? "/var/lib/rip-deck",
  registryPath:
    env.RIP_DECK_DRIVES_CONFIG ?? "config/drives.json",
  makemkv: resolveMakemkvCommand(env.RIP_DECK_MAKEMKVCON),
  cyanrip: resolveCyanripCommand(env.RIP_DECK_CYANRIP),
  eject: resolveEjectCommand(env.RIP_DECK_EJECT),
  isolation: resolveRipIsolation(env),
  isEventLogEnabled: env.RIP_DECK_EVENT_LOG !== "false",
})

/** One bay's dispatched task, as the pipeline sees it. */
export type BayRipInput = {
  driveId: string
  slot: number | null
  name: string
  /** e.g. "sr3". Ephemeral; re-read every tick. */
  kernelName: string
  /** e.g. "/dev/sr3". Ephemeral; resolved just before the spawn. */
  devPath: string
  jobUuid: string
  /**
   * This drive's measured AccurateRip read offset, in samples,
   * straight off its `config/drives.json` entry — resolved by
   * FIRMWARE SERIAL, never by model, because slots 2-4 are LG
   * drives whose OmniDrive firmware reports them as ASUS.
   *
   * Null for every drive on this tower today: nothing has been
   * measured yet. That is a supported state — the CD rip runs
   * with no `-s` flag and says nothing about it.
   */
  readOffsetSamples: number | null
  /**
   * A name the OPERATOR gave, or null to read one off the disc.
   *
   * Non-null only when a `rip_bay` command carried one. It is the
   * daemon-side twin of `rip-deck rip --name`, and it is the whole
   * point of that flag: a disc whose label is unreadable is not
   * unrippable, it just needs a human to say what it is.
   *
   * ⚠️ **Requirement B3 is untouched.** B3 forbids *rip-deck*
   * inventing a name. Nothing here invents one — with `null` the
   * disc is identified and a nameless disc is still held; with a
   * value, a person typed it.
   */
  explicitName?: string | null
  config: WatcherConfig
  signal: AbortSignal
  /** Progress narration, for the console. */
  note: (message: string) => void
  /** Called the instant a ripper child exists. */
  onRipStarted: () => void
  /**
   * Called once the disc has a name, BEFORE the rip finishes.
   *
   * The title is the one fact a listener actually hears — the
   * house announcement says "{title} finished ripping" — and it
   * is known here minutes before the outcome is. Without this,
   * anything downstream of the outcome would have to
   * reverse-engineer it out of the destination path.
   */
  onIdentified?: (identity: BayDiscIdentity) => void
  /**
   * Called once the rip is published, with where it landed.
   *
   * The destination is decided late and by the ripper — a
   * collision renames it — so it is reported the instant it is
   * a fact rather than derived by anything downstream. It
   * already travels inside the completion sentence for a human
   * to read; this is the same path as a FIELD, so the dashboard
   * never has to parse the sentence to find it.
   */
  onDestination?: (destinationPath: string) => void
  onProgress?: (progress: JobProgress) => void
}

/** What the disc in a bay turned out to be. */
export type BayDiscIdentity = {
  title: string
  discType: DiscType
}

/** Why a flagged disc is flagged, in the owner's words. */
export const describeAttentionReason = (
  reason: DiscAttentionReason,
): string => {
  switch (reason) {
    case "audio_cd_unconfirmed":
      return (
        "CD-sized, but nothing confirmed it carries audio " +
        "tracks — udev's database was unreadable, and " +
        "cyanrip is never chosen on capacity alone."
      )
    case "data_disc_deferred":
      return (
        "A data CD-ROM. Ripping data discs to ISO is not " +
        "built yet (A4), so there is no ripper for this."
      )
    case "blank_media":
      return "Blank recordable media. Nothing to rip."
    case "conflicting_evidence":
      return (
        "udev and sysfs disagree about what is in this " +
        "drive, so typing it would be a guess."
      )
    case "unrecognised_media":
      return "Optical media of a kind we have no ripper for."
  }
}

/**
 * Everything that happens between "a disc appeared" and "there is
 * a finished rip", for one bay.
 *
 * This is `runRip` in `cli.ts` with the console taken out and the
 * disc-type fork put in — same order, same refusals, same
 * fail-closed behaviour. Where the two differ, `cli.ts` is the
 * reference: it is the sequence that has ripped two real discs.
 *
 * Returns an outcome; never throws. A rejection here would land in
 * a timer callback and could take the whole daemon down with it,
 * so `startWatcher` also catches — this is belt and braces on the
 * one path where a bug costs all nine bays rather than one.
 */
export const runBayRip = async (
  input: BayRipInput,
): Promise<BayOutcome> => {
  // --- Three-layer settle. ---------------------------------
  input.note("waiting for the disc to settle…")

  const settled = await waitForSettledMedia({
    kernelName: input.kernelName,
  })

  if (settled.kind === "no_media") {
    return {
      kind: "no_media",
      detail: "the disc was gone before it settled",
    }
  }

  if (settled.kind === "timed_out") {
    // NEVER eject. The eject loop is what caused the flap-storm
    // that killed valid rips in other bays (B3/E8).
    return {
      kind: "needs_attention",
      detail:
        "the disc never settled — its reported size kept " +
        "changing. It is still in the drive; nothing was " +
        "ejected.",
    }
  }

  // --- Route by disc type, and refuse rather than guess. ----
  const typed = await detectDiscType({
    kernelName: input.kernelName,
  })

  if (typed.kind === "no_media") {
    return {
      kind: "no_media",
      detail: "the disc was gone before it could be typed",
    }
  }

  if (typed.kind === "needs_attention") {
    return {
      kind: "needs_attention",
      detail: describeAttentionReason(typed.reason),
    }
  }

  input.note(
    `${typed.discType}, ` +
      `${formatBytes(typed.capacityBytes)} — ` +
      `${typed.ripper}`,
  )

  if (typed.hasDataTracks && typed.ripper === "cyanrip") {
    input.note(
      "this disc also carries a data session; cyanrip rips " +
        "the audio tracks and leaves that behind.",
    )
  }

  // Said out loud rather than swallowed. An audio CD's folder is
  // built from its own AccurateRip/CDDB metadata, not from a
  // volume label, so there is no identify step for a name to
  // stand in for — and a name silently ignored is worse than one
  // refused, because the operator has no way to tell.
  if (
    input.explicitName != null &&
    typed.ripper === "cyanrip"
  ) {
    input.note(
      "an audio CD names itself from its own disc metadata, " +
        `so the name you gave ("${input.explicitName}") is ` +
        "not used.",
    )
  }

  return typed.ripper === "cyanrip"
    ? await ripAudioCd({
        input,
        capacityBytes: typed.capacityBytes,
      })
    : await ripWithMakemkv({
        input,
        discType: typed.discType,
        capacityBytes: typed.capacityBytes,
      })
}

/**
 * The proven path: `makemkvcon backup --decrypt`.
 *
 * Two real Blu-rays have gone through this, byte-identical, via
 * `rip-deck rip`. The only thing auto-rip changes is who typed the
 * command.
 */
const ripWithMakemkv = async (context: {
  input: BayRipInput
  discType: DiscType
  capacityBytes: number
}): Promise<BayOutcome> => {
  const { input } = context
  const { config } = input

  // --- Identify, fail closed. ------------------------------
  // …unless an operator already said what this disc is, which is
  // the one case identify has nothing to add: he is looking at the
  // sleeve. Exactly what `cli.ts` does for `--name` (~L427), and
  // deliberately the same shape, because the whole argument for
  // `runBayRip` is that it IS `rip-deck rip` with the console taken
  // out — same order, same refusals. Skipping the read is not just
  // a saving: on a disc identify could not name, running it again
  // would return the same nothing and hold the bay a second time.
  const identified =
    input.explicitName == null
      ? await identifyDisc({
          devPath: input.devPath,
          makemkv: config.makemkv,
        })
      : {
          discName: input.explicitName,
          spawnFailure: null,
        }

  if (identified.spawnFailure !== null) {
    // NOT a disc fault, and saying so matters: this disc was
    // never read. Reporting it as "nameless" sent a reader to the
    // tower to inspect a disc whose label was fine, while the
    // real fault was a PATH that had lost /opt/makemkv/bin.
    return {
      kind: "needs_attention",
      detail:
        "could not run makemkvcon to identify this disc — " +
        `${identified.spawnFailure}. The disc was never read, ` +
        "so this is a rip-deck/deployment fault, not a disc " +
        "fault; `--name` will not help.",
    }
  }

  if (identified.discName === null) {
    // Requirement B3, and it is not softened by the rip being
    // automatic: an invented name buries the one fact that makes
    // the disc findable again.
    //
    // What CHANGED is the instruction. This used to end *"rip it by
    // hand with `rip-deck rip --slot N --name "…"`"* — a CLI
    // command printed on a dashboard that cannot run one, next to
    // an eject button that does not un-hold on this hardware. The
    // operator's own words: "I don't have a way to do anything
    // actionable other than eject. Horrible user experience." The
    // `rip_bay` command is the way, so the text names the button
    // instead of a shell.
    return {
      kind: "needs_attention",
      detail:
        "could not read a name off this disc. Refusing to " +
        "invent one — it stays in the drive. Type its name on " +
        "this card and press Rip.",
    }
  }

  const folderName = buildFolderName({
    title: identified.discName,
    year: null,
    discType: context.discType,
    // Always a backup: A2 forbids transcoding, so every video
    // rip rip-deck performs is a whole disc structure that still
    // needs its real titles pulled out by hand.
    isDiscBackup: true,
  })

  input.note(`identified as "${folderName}"`)

  input.onIdentified?.({
    // The disc's own name, not the folder name: the folder
    // carries a `[BACKUP]` marker and a type suffix that nobody
    // wants read out loud.
    title: identified.discName,
    discType: context.discType,
  })

  // --- Resolve the disc index. -----------------------------
  // Under isolation this is a constant and NO bus scan happens,
  // which is the half of the isolation win that `cli.ts` had to
  // fix separately. It matters far more here: nine auto-started
  // rips each pre-scanning the bus is the 81-probe contention the
  // isolation decision exists to prevent, and it would happen
  // every time the owner loaded the tower.
  const discIndex =
    config.isolation === null
      ? (
          await enumerateDrives({ makemkv: config.makemkv })
        ).indexByDevPath.get(input.devPath)
      : ISOLATED_DISC_INDEX

  if (discIndex === undefined) {
    return {
      kind: "needs_attention",
      detail:
        `MakeMKV does not list ${input.devPath}. The drive ` +
        "is present and not usable, so the disc stays put.",
    }
  }

  const eventLogPath = `${config.stateDir}/${input.jobUuid}.robot.log`
  const eventLog =
    config.isEventLogEnabled === false
      ? createNullEventLog()
      : await createEventLog({ path: eventLogPath }).catch(
          () => createNullEventLog(),
        )

  input.onRipStarted()
  input.note(`ripping -> ${folderName}`)

  const result = await runRipJob(
    {
      driveId: input.driveId,
      devPath: input.devPath,
      discIndex,
      jobUuid: input.jobUuid,
      discBytes: context.capacityBytes,
      destinationRoot: config.destinationRoot,
      innerDestinationRoot: config.innerDestinationRoot,
      folderName,
      stateDir: config.stateDir,
      makemkv: config.makemkv,
      isolation: config.isolation,
      eventLog,
      signal: input.signal,
    },
    { onProgress: input.onProgress },
  )

  if (result.isSuccessful) {
    const destinationPath =
      result.destinationPath ?? config.destinationRoot

    input.onDestination?.(destinationPath)

    return {
      kind: "completed",
      detail:
        destinationPath +
        // A collision never clobbers: the new rip lands beside the
        // old one under a marked name and a human picks. Saying so
        // on the success line is the only place it gets said.
        (result.hasCollision
          ? " (landed beside an existing folder of the same " +
            "name — decide which copy to keep)"
          : ""),
    }
  }

  // Exit code 0 with a failure reason is the whole point of this
  // project, so it is stated rather than flattened into "failed".
  return {
    kind: "failed",
    detail:
      `${result.failureReason}` +
      (result.exitCode === 0
        ? " (makemkvcon exited 0 — the silent-success case " +
          "ARM reports as a completed rip)"
        : ` (exit ${String(result.exitCode)})`) +
      (result.incompletePath === null
        ? ""
        : `. Partial output KEPT at ${result.incompletePath}`),
  }
}

/**
 * One bay's cyanrip invocation, offset and all.
 *
 * A named, exported function rather than an inline call inside
 * `ripAudioCd`, for one reason: `ripAudioCd` cannot be reached
 * from a test. It sits behind `waitForSettledMedia` and
 * `detectDiscType`, both of which read `/sys/block/srN`
 * directly, so nothing without the real tower gets past them.
 * This repo has already shipped five functions that were
 * written, unit-tested and called by NOTHING, so the one link
 * that carries a drive's read offset out of the registry and
 * into the argv is an expression a test can execute rather than
 * a line only a code reader can check.
 *
 * `BayRipInput` is passed whole on purpose — the point is that
 * the offset is not re-derived here. Whatever the watcher put
 * on the bay is what cyanrip is told.
 */
export const buildBayCyanripInvocation = (input: {
  cyanrip: CyanripCommand
  incompletePath: string
  rip: BayRipInput
}): CyanripInvocation =>
  buildCyanripInvocation({
    cyanrip: input.cyanrip,
    incompletePath: input.incompletePath,
    rip: {
      devPath: input.rip.devPath,
      driveOffsetSamples: input.rip.readOffsetSamples,
    },
  })

/**
 * The audio-CD path: cyanrip to FLAC.
 *
 * ⚠️ **Nothing here has ever met a disc.** The MakeMKV path has
 * two complete real rips behind it; this has zero, and cyanrip has
 * never run on this rig at all. The invocation comes from
 * `cyanripCommand.ts` — read its warnings before trusting any of
 * this — and what is added here is only the spawn and the move
 * into place.
 *
 * ## Why it is a spawn here rather than a `runCyanripJob`
 *
 * It ought to be its own module beside `ripJob.ts`, and it should
 * become one. It is not, because the file allocation for this
 * change gave `rip/ripJob.ts` and its neighbours to other units
 * and this watcher had to route audio CDs somewhere real rather
 * than to a stub. What it deliberately does NOT do, and what a
 * proper module would: no health sampling, no progress parsing, no
 * liveness watchdog, no heartbeat. cyanrip's output is not
 * robot-mode and nothing in this repo parses it.
 *
 * ## The output layout differs from backup mode, and it matters
 *
 * `makemkvcon backup` writes the disc structure directly into the
 * directory it is handed, so `finaliseDestination` can rename that
 * directory into place. cyanrip creates an album directory
 * *inside* its working directory, so the same rename would produce
 * `Album/Album [flac]/01 - …` — one level too deep. The album
 * directory is therefore resolved afterwards and moved on its own.
 */
const ripAudioCd = async (context: {
  input: BayRipInput
  capacityBytes: number
}): Promise<BayOutcome> => {
  const { input } = context
  const { config } = input

  const space = await checkFreeSpace({
    rootPath: config.destinationRoot,
    discBytes: context.capacityBytes,
  })

  if (!space.hasEnoughSpace) {
    return {
      kind: "failed",
      detail: "not enough free space; refusing to start",
    }
  }

  // Straight onto the destination dataset, exactly as A6/A7 ask
  // and for the same reason: a killed rip must leave its partial
  // output where the operator can see it (D4), which staging in a
  // container's overlay would not.
  const incompletePath = join(
    config.destinationRoot,
    incompleteDirName(input.jobUuid),
  )

  await mkdir(incompletePath, { recursive: true })

  const invocation = buildBayCyanripInvocation({
    cyanrip: config.cyanrip,
    incompletePath,
    rip: input,
  })

  input.onRipStarted()
  input.note(
    "ripping with cyanrip (never verified on this rig)",
  )

  const exitCode = await spawnCyanrip({
    invocation,
    cyanrip: config.cyanrip,
    devPath: input.devPath,
    signal: input.signal,
  })

  if (exitCode !== 0) {
    return {
      kind: "failed",
      detail:
        `cyanrip exited ${String(exitCode)}. Partial output ` +
        `KEPT at ${incompletePath}`,
    }
  }

  const entries = await readdir(incompletePath, {
    withFileTypes: true,
  }).catch(() => [])

  const albumDirName = resolveCyanripAlbumDir(
    entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  )

  if (albumDirName === null) {
    // Zero directories means cyanrip wrote no album at all — the
    // audio-path twin of the `backup` silent-success trap, and
    // exit 0 does not excuse it (D1). More than one means a
    // multi-disc set or leftovers, and picking one would file half
    // an album under the other half's name.
    return {
      kind: "failed",
      detail:
        "cyanrip exited 0 but did not leave exactly one album " +
        `directory in ${incompletePath}, so there is nothing ` +
        "safe to publish. The output is KEPT.",
    }
  }

  // Late, and unavoidably so: cyanrip decides the album name from
  // the metadata it looked up, and there is nothing to report
  // until it has written the directory.
  input.onIdentified?.({
    title: albumDirName,
    discType: "cd",
  })

  return await publishAlbum({
    incompletePath,
    albumDirName,
    destinationRoot: config.destinationRoot,
    jobUuid: input.jobUuid,
    onDestination: input.onDestination,
  })
}

/** Run cyanrip, and make sure a cancel actually lands (E5). */
const spawnCyanrip = async (input: {
  invocation: {
    command: string
    args: string[]
    cwd: string
  }
  cyanrip: CyanripCommand
  devPath: string
  signal: AbortSignal
}): Promise<number | null> => {
  const child = spawn(
    input.invocation.command,
    input.invocation.args,
    {
      cwd: input.invocation.cwd,
      // stdin CLOSED, matching `ripJob`: a ripper that decides to
      // ask a question must fail fast rather than sit holding the
      // drive forever.
      stdio: ["ignore", "ignore", "ignore"],
    },
  )

  const onAbort = () => {
    child.kill("SIGTERM")

    // A wrapper (`docker exec …`, `ssh … cyanrip`) does not
    // forward signals, so killing our handle would leave a cyanrip
    // inside the container still holding the drive. Measured for
    // the makemkvcon twin on Tower 2026-07-25.
    if (input.cyanrip.wrapperArgs === null) return

    try {
      spawn(
        input.cyanrip.command,
        buildCyanripKillArgs({
          wrapperArgs: input.cyanrip.wrapperArgs,
          devPath: input.devPath,
          signal: "TERM",
        }),
        { stdio: "ignore" },
      ).on("error", () => {})
    } catch {
      // The outer signal has already gone; nothing else to do.
    }
  }

  input.signal.addEventListener("abort", onAbort, {
    once: true,
  })

  try {
    return await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null))
      child.once("close", (code) => resolve(code))
    })
  } finally {
    input.signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Move a finished album out of the incomplete directory.
 *
 * Same two refusals as `finaliseDestination`, for the same
 * reasons: an existing folder is never clobbered, and the rip log
 * cyanrip writes beside the album is carried along rather than
 * stranded in a dot-directory nobody looks in — it is the file
 * that records the AccurateRip and CRC32 results.
 */
const publishAlbum = async (input: {
  incompletePath: string
  albumDirName: string
  destinationRoot: string
  jobUuid: string
  onDestination?: (destinationPath: string) => void
}): Promise<BayOutcome> => {
  const intendedPath = join(
    input.destinationRoot,
    input.albumDirName,
  )

  const hasCollision = await pathExists(intendedPath)
  const finalPath = hasCollision
    ? `${intendedPath} ` +
      `(rip-deck-duplicate-${input.jobUuid.slice(0, 8)})`
    : intendedPath

  const albumPath = join(
    input.incompletePath,
    input.albumDirName,
  )

  const ownership = createOutputOwnership()

  // Before the move, so the library never contains — even for an
  // instant — a folder a scanner can see but not read (§2.7).
  // Reported rather than thrown: the bytes are good, and refusing
  // to publish them over a metadata problem strands them.
  const ownershipError =
    ownership === null
      ? null
      : await applyOutputOwnership({
          path: albumPath,
          ownership,
        }).then(
          () => null,
          (error: unknown) =>
            error instanceof Error
              ? error.message
              : String(error),
        )

  await rename(albumPath, finalPath)

  // The rip log lives beside the album, not inside it. Carry it
  // over, then take the empty directory away — `rmdir` and not
  // `rm -r`, so anything unexpected left behind survives instead
  // of being deleted by a cleanup step.
  const leftovers = await readdir(
    input.incompletePath,
  ).catch(() => [])

  for (const name of leftovers) {
    await rename(
      join(input.incompletePath, name),
      join(finalPath, name),
    ).catch(() => {})
  }

  await rmdir(input.incompletePath).catch(() => {})

  // After the move, not before: until the rename lands there is
  // nothing at this path, and a bay claiming a destination that
  // does not exist yet is the same class of lie as claiming a
  // rip finished.
  input.onDestination?.(finalPath)

  return {
    kind: "completed",
    detail:
      finalPath +
      (hasCollision
        ? " (landed beside an existing folder of the same " +
          "name — decide which copy to keep)"
        : "") +
      (ownershipError === null
        ? ""
        : ` — WRONG OWNER: ${ownershipError}. Plex cannot ` +
          `read it until you chown it.`),
  }
}

const pathExists = async (
  path: string,
): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * An empty sysfs attribute is "we do not know", not a value.
 *
 * `probeDrive` writes `""` for an attribute it could not read,
 * and `""` rendered on a card reads as a blank field the owner
 * would take for a bug.
 */
const textOrNull = (value: string): string | null =>
  value.trim() === "" ? null : value.trim()

export const formatBytes = (bytes: number): string =>
  `${(bytes / 1024 ** 3).toFixed(1)} GB`

/* ------------------------------------------------------------ *
 * The loop.
 * ------------------------------------------------------------ */

export type WatcherDeps = {
  /** The ONLY device-adjacent read in the poll loop. */
  probeDrives: () => Promise<ProbedDrive[]>
  loadRegistry: (path: string) => Promise<DriveRegistry>
  runBayRip: (input: BayRipInput) => Promise<BayOutcome>
  readLedger: (input: {
    path: string
  }) => Promise<BayLedger>
  writeLedger: (input: {
    path: string
    ledger: BayLedger
  }) => Promise<void>
  /**
   * Move one tray. Reachable ONLY from `runTrayCommand`, i.e.
   * from an operator pressing something.
   */
  runTray: (input: {
    action: "open" | "close"
    devPath: string
    eject: EjectCommand
  }) => Promise<TrayResult>
  now: () => number
}

export const defaultWatcherDeps: WatcherDeps = {
  probeDrives: probeAllDrives,
  loadRegistry: loadDriveRegistry,
  runBayRip,
  readLedger: readBayLedger,
  writeLedger: writeBayLedger,
  runTray: runTrayCommand,
  now: () => Date.now(),
}

/** Everything the console wants to say, as it happens. */
export type WatcherHandlers = {
  onBayNote?: (input: {
    driveId: string
    slot: number | null
    name: string
    message: string
  }) => void
  onBayIdentified?: (input: {
    driveId: string
    slot: number | null
    name: string
    identity: BayDiscIdentity
  }) => void
  onBayOutcome?: (input: {
    driveId: string
    slot: number | null
    name: string
    outcome: BayOutcome
    /**
     * Absent for a quarantine, which is decided by the poll loop
     * and never had a job.
     */
    jobUuid?: string
  }) => void
  onBayProgress?: (input: {
    driveId: string
    slot: number | null
    name: string
    progress: JobProgress
  }) => void
  /** Bus-level news: drive count changed, a probe timed out. */
  onNote?: (message: string) => void
  /**
   * One poll finished and the bay table now describes it.
   *
   * The one handler that is not news and is never printed. It
   * exists because an IDLE bay says nothing at all — no note, no
   * progress, no outcome — so the bay table is the only place
   * eight quiet bays are described, and a reader of that table
   * needs to be told when it is worth re-reading.
   *
   * Fired at the END of the tick, after every bay has been
   * decided, because that is the first instant `getBays()` and
   * `getBaySightings()` describe THIS poll rather than the last
   * one. Firing it earlier is what left `/json` showing three
   * bays of nine.
   */
  onTickComplete?: () => void
}

export type WatcherInput = {
  config: WatcherConfig
  governor: Governor
  handlers?: WatcherHandlers
  pollIntervalMs?: number
  /**
   * This watcher IS the process, so its timer holds it open.
   *
   * Default false, matching every other timer in this codebase: a
   * watcher embedded in something larger must never be the reason
   * that process refuses to exit. `main.ts` passes true.
   */
  isKeepingProcessAlive?: boolean
  /**
   * Ask Home Assistant to power the tower on, over MQTT.
   *
   * Called only from the `open_trays` path when the tower is off,
   * and injected by the MQTT bridge (`withPublishing`) — a watcher
   * with no broker leaves it unset, and an Open press on an off
   * tower then reports "off" without a power-on it cannot send.
   * The daemon never touches the HA switch directly; it publishes a
   * request an HA automation acts on
   * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md)).
   */
  publishTowerPowerOn?: () => void
  /**
   * Ask Home Assistant to power the tower OFF, over MQTT.
   *
   * The mirror of `publishTowerPowerOn`, injected the same way and
   * for the same reason: rip-deck never touches the HA switch
   * directly, it publishes a request an automation acts on. Called
   * only from the `power_off` command, and only once every bay has
   * been asked whether a rip owns it.
   */
  publishTowerPowerOff?: () => void
}

export type RunningWatcher = {
  /** One poll, driven by hand. Never overlaps a timer tick. */
  tickNow: () => Promise<void>
  /** Cancel every running rip and wait for them to land. */
  stop: () => Promise<void>
  getBays: () => BayState[]
  /**
   * What the last probe saw of each bay's hardware.
   *
   * Separate from `getBays()` because the two have different
   * lifetimes: a `BayState` is remembered across a restart, a
   * sighting is only ever as old as the last poll. Both are
   * memory reads and neither touches a device.
   */
  getBaySightings: () => BaySighting[]
  /**
   * Is the USB bus flapping right now?
   *
   * A bus-wide reading of drive presence over the last few
   * minutes — see `usbStability.ts`. Like a sighting it is only
   * as old as the last poll and touches no device; unlike a
   * sighting it describes the whole bus, not one bay, which is
   * why it is its own accessor rather than a field on each.
   */
  getUsbStability: () => UsbStability
  /**
   * Move trays, because a human asked.
   *
   * Lives on the watcher rather than beside the broker because
   * the watcher is the only thing that holds both halves of the
   * answer: the bay table (which bay is mid-rip and must be
   * refused) and the bus probe (which `/dev/srN` a bay is
   * wearing this minute — never assumed, it reshuffles).
   *
   * Two opinions about one device is how a drive gets two
   * writers, so there is exactly one command path and it is
   * this one.
   */
  runTrayCommand: (input: {
    request: TrayCommandRequest
    requestId?: string | null
  }) => Promise<TrayCommandResponsePayload>
  /**
   * The discs still sitting in the tower, waiting for a human.
   *
   * Folded from the bay table and the sighting table rather than
   * from a probe, because the case it exists for is a tower that
   * has been switched OFF — where there is nothing to probe and
   * every bay reads absent. Both tables keep a vanished bay, which
   * is what makes the answer survive the power going out.
   * See `loadedDiscs.ts`.
   */
  getLoadedDiscs: () => LoadedDiscSummary
}

/** One bay's rip, queued for the dispatch pipeline. */
type BayDispatch = {
  drive: ProbedDrive
  jobUuid: string
  /**
   * Created at ENQUEUE time, not at start time.
   *
   * `stop()` cancels whatever is in `controllers`, and a dispatch
   * still waiting for a `mergeMap` slot has to be cancellable
   * too — otherwise Ctrl-C would leave it to start a rip nobody
   * is waiting for (E5).
   */
  controller: AbortController
  /**
   * The name an OPERATOR supplied, or null to identify the disc.
   *
   * Only ever non-null on a `rip_bay` command. The poll loop always
   * enqueues null — an auto-rip has nobody to ask, and B3 is why it
   * holds a disc it cannot name rather than making one up.
   */
  explicitName: string | null
}

export const startWatcher = (
  input: WatcherInput,
  deps: WatcherDeps = defaultWatcherDeps,
): RunningWatcher => {
  const handlers = input.handlers ?? {}
  const pollIntervalMs =
    input.pollIntervalMs ?? WATCHER_TUNING.pollIntervalMs

  const bays = new Map<string, BayState>()
  const sightings = new Map<string, BaySighting>()
  const controllers = new Map<string, AbortController>()
  const dispatches = new Subject<BayDispatch>()

  let registry: DriveRegistry | null = null
  let ledger: BayLedger | null = null
  let publishedLedgerFingerprint: string | null = null
  let isLedgerWriteInFlight = false
  /**
   * When a write is already in flight, keep the LATEST desired
   * payload and flush it in `finally`. Dropping the update used
   * to lose a just-latched completion if a poll write was mid-flight
   * (completion called `persistLedger` and returned, disk kept the
   * older empty set, and the next blind tick never re-wrote the
   * record).
   */
  let pendingLedgerWrite: {
    records: ReturnType<typeof toLedgerRecords>
    trayCommands: ReturnType<typeof toTrayRecords>
  } | null = null
  let isStopped = false
  let isTickInFlight = false
  let outstandingProbeCount = 0
  let lastDriveCount: number | null = null

  // Drive presence as the LAST poll saw it, and the rolling window
  // of present↔absent edges since. Kept here, never persisted: a
  // flap is a live hardware condition, not a fact worth remembering
  // across a restart, and the window prunes itself every tick.
  let previousPresence = new Map<string, boolean>()
  let usbTransitions: UsbTransition[] = []
  let usbStability: UsbStability = STABLE_USB

  /**
   * Write the latched bays down, if they have changed.
   *
   * Fired and forgotten, and that is the rule this obeys rather
   * than an oversight: a state directory that has gone
   * read-only must cost the memory of what finished, never a
   * rip. It is the same bargain `mqtt/watchMqtt.ts` makes with
   * the broker.
   *
   * The fingerprint check is what stops nine held bays
   * rewriting the file every five seconds — `updatedAtMs` moves
   * on every tick, so comparing the JSON would never settle.
   * One write in flight at a time, because two concurrent
   * `rename`s of the same temp path is a race with no upside.
   *
   * ⚠️ **`isBlind` is what keeps a restart against a dark tower
   * from erasing the ledger.** The poll loop builds NO bays when
   * no drive is on the bus, so `toLedgerRecords([])` is empty —
   * and writing that would overwrite the record of a disc left
   * loaded in a powered-off tower, so the next daemon re-rips it.
   * That empty set is not "everything was taken out", it is "we
   * cannot see anything": the same distinction
   * `shouldPublishLoadedDiscs` draws, and the reason this ledger
   * (and the loaded-discs reminder that reads it) can survive a
   * tower-off restart at all
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   * So an empty **records** result is persisted only when NOT
   * blind — a drive is present to have gone empty, or the caller
   * is an operator action that knows what it changed (the
   * default). A non-empty result is always evidence and always
   * written.
   *
   * ⚠️ **Tray commands alone must not punch a hole in that guard.**
   * Measured 2026-08-09: after a finished UHD rip the on-disk
   * ledger held `records: []` but a full set of `trayCommands`
   * (`close_bay` on idle bays). The old guard required BOTH
   * records and trayCommands empty before skipping a blind write,
   * so a dark-tower tick with only tray memory rewrote the file
   * and wiped any latched disc records. Tray position is not
   * evidence that the finished discs came out.
   */
  const persistLedger = (
    options: { isBlind?: boolean } = {},
  ): void => {
    const allBays = [...bays.values()]
    const records = toLedgerRecords(allBays)
    // Written on the same file and the same trigger, because
    // the two facts change on the same events: a tray command
    // that opens a finished bay is both the last thing done to
    // that drawer and — one debounce later — the removal that
    // clears the disc record.
    const trayCommands = toTrayRecords(allBays)

    // Never wipe latched-disc records while blind. Tray-command
    // churn alone is not enough evidence that the discs left —
    // only a non-blind empty (tower on, trays readable) or an
    // explicit operator clear may publish records: [].
    if (options.isBlind === true && records.length === 0) {
      return
    }

    flushLedgerWrite({ records, trayCommands })
  }

  const flushLedgerWrite = (payload: {
    records: ReturnType<typeof toLedgerRecords>
    trayCommands: ReturnType<typeof toTrayRecords>
  }): void => {
    const fingerprint = ledgerFingerprint(payload)

    if (fingerprint === publishedLedgerFingerprint) return

    if (isLedgerWriteInFlight) {
      // Keep the newest intent; the in-flight `finally` flushes it.
      pendingLedgerWrite = payload
      return
    }

    publishedLedgerFingerprint = fingerprint
    isLedgerWriteInFlight = true

    void deps
      .writeLedger({
        path: bayLedgerPath(input.config.stateDir),
        ledger: {
          ...EMPTY_BAY_LEDGER,
          records: payload.records,
          trayCommands: payload.trayCommands,
          hasPriorState: true,
        },
      })
      .catch((error: unknown) => {
        // Re-armed so the next tick tries again: a transient
        // ENOSPC must not make us stop remembering forever.
        publishedLedgerFingerprint = null

        console.error(
          "[watcher] could not write the bay ledger. A " +
            "restart will not know which discs are already " +
            "finished.",
          error,
        )
      })
      .finally(() => {
        isLedgerWriteInFlight = false
        const pending = pendingLedgerWrite
        pendingLedgerWrite = null
        if (pending !== null) {
          flushLedgerWrite(pending)
        }
      })
  }

  /**
   * Where a bay is, in the words the owner uses.
   *
   * The registry is loaded once and cached: it is a config file,
   * it changes when someone re-cables the tower, and re-reading it
   * nine times a minute buys nothing. A missing one is not fatal —
   * the slot number is how a human finds the bay, not how the code
   * finds the drive.
   */
  const registryEntryOf = (
    drive: ProbedDrive,
  ): DriveRegistryEntry | null =>
    registry === null
      ? null
      : resolveDrive(registry, {
          usbPortPath: drive.identity.usbPortPath,
          bridgeSerial: drive.identity.bridgeSerial,
        }).entry

  const placementOf = (drive: ProbedDrive) => {
    const entry = registryEntryOf(drive)

    return {
      slot: entry?.slot ?? null,
      // Already the house label, prefix and all — the registry
      // writes `07 - Pioneer BDR-211M`. Nothing downstream may
      // add the prefix a second time.
      name: entry?.name ?? drive.identity.usbPortPath,
    }
  }

  /**
   * This bay's measured read offset, or null.
   *
   * A drive the registry has never heard of gets null, which is
   * the same answer as a drive nobody has measured yet — and
   * that collapse is deliberate. Both mean "we have no offset
   * for this drive", and the only correct response to either is
   * to omit `-s`. Guessing one from the model is the thing this
   * whole field exists to prevent.
   */
  const readOffsetOf = (
    drive: ProbedDrive,
  ): number | null =>
    registryEntryOf(drive)?.readOffsetSamples ?? null

  /**
   * Everything this probe learned about one bay's hardware.
   *
   * The registry wins over the drive's own answers wherever it
   * has one, and that is not a preference: slots 2-4 are LG
   * drives whose OmniDrive firmware reports them as ASUS, so a
   * self-reported model is the one fact on this tower known to
   * lie. The self-reported pair is used only for a drive the
   * registry has never heard of, where it is all there is.
   */
  const sightingOf = (drive: ProbedDrive): BaySighting => {
    const entry = registryEntryOf(drive)
    const trueModel = parseTrueModel(entry?.trueModel ?? "")

    return {
      driveId: drive.identity.usbPortPath,
      isDrivePresent: true,
      slot: entry?.slot ?? null,
      label: entry?.name ?? drive.identity.usbPortPath,
      devPath: drive.address.devPath,
      vendor:
        trueModel.vendor ??
        textOrNull(drive.identity.vendor),
      model:
        trueModel.model ?? textOrNull(drive.identity.model),
      // The FIRMWARE serial, never the bridge's: the ASMedia
      // adapters all share a `123456789` prefix and their being
      // distinct across our nine is luck, not identity.
      serial: entry?.firmwareSerial ?? null,
    }
  }

  /**
   * One bus probe, raced against a watchdog.
   *
   * The loser is not cancelled — a file read has no cancellation
   * — but `raceWith` unsubscribes it, its rejection is already
   * handled and its result is dropped, so the worst case is one
   * dangling probe rather than a wedged loop. Same shape as
   * `sampler.ts`, which solves the identical problem one level
   * down; both take their timer from `unrefTimers.ts`.
   */
  const probe = async (): Promise<ProbedDrive[] | null> =>
    await firstValueFrom(
      defer((): Observable<ProbedDrive[] | null> => {
        // A probe issued by an earlier tick has still not come
        // back, so the bus is not answering. Queueing a second one
        // behind it would pile up file handles and tell us nothing
        // the first one will not.
        if (outstandingProbeCount > 0) return of(null)

        outstandingProbeCount += 1

        // Settled BEFORE the race, so a rejection can never
        // surface as an unhandled rejection after the watchdog
        // has won.
        const work = deps
          .probeDrives()
          .catch(() => [] as ProbedDrive[])
          .finally(() => {
            outstandingProbeCount -= 1
          })

        return from(work).pipe(
          raceWith(
            unrefTimeout<ProbedDrive[] | null>({
              delayMs: WATCHER_TUNING.probeTimeoutMs,
              value: null,
            }),
          ),
        )
      }),
    )

  /**
   * Record a fact a running rip learned, onto its bay.
   *
   * A no-op for a bay that is no longer there — the disc was
   * pulled, the drive left the bus — because a rip's late news
   * must never resurrect a bay the poll loop has re-armed.
   *
   * `updatedAtMs` is deliberately untouched: it dates the last
   * DECISION about a bay, and learning the disc's name is not
   * one. Moving it here would make the ledger's own timestamp
   * drift for reasons a reader could not account for.
   */
  const rememberOnBay = (
    driveId: string,
    remember: (bay: BayState) => BayState,
  ): void => {
    const current = bays.get(driveId)
    if (current === undefined) return

    bays.set(driveId, remember(current))
  }

  /**
   * Write down that rip-deck itself moved this drawer.
   *
   * Called from ONE place — the branch of `runTrayCommand` where
   * `runTray` came back successful — and that placement is the
   * whole correctness argument. A refusal (`refused_ripping`) and
   * a skip (`skipped_no_disc`, `skipped_not_present`, …) never
   * reach it, because neither touched the tray, and a toggle
   * that flipped on a refusal would tell the owner his ripping
   * bay was open.
   *
   * Persisted immediately rather than at the next tick: the point
   * of remembering is to survive a restart, and a deploy landing
   * in the five seconds after a press is exactly when the owner
   * is standing at the tower.
   *
   * ⚠️ **A bay the poll loop has never seen is skipped, not
   * created.** `rememberOnBay` no-ops on an unknown bay, and that
   * is deliberate: the tick treats "no entry in `bays`" as *this
   * process has never seen this bay*, which is the one moment
   * `adoptBayAtStartup` gets to decide whether a loaded disc was
   * already ripped. Inventing an entry here to hold one string
   * would skip that decision and re-rip a finished disc. The
   * memory is the cheap thing to lose; fail closed.
   */
  const rememberTrayCommand = (params: {
    driveId: string
    action: "open" | "close"
  }): void => {
    const lastTrayCommand: BayTrayCommand =
      params.action === "open" ? "open_bay" : "close_bay"

    rememberOnBay(params.driveId, (bay) => ({
      ...bay,
      lastTrayCommand,
    }))

    persistLedger()
  }

  /**
   * Everything one dispatched bay does, as one observable.
   *
   * It never errors: a throw from the pipeline has to become an
   * outcome, because this runs inside the shared dispatch
   * subscription and an error there would tear down the pipeline
   * for all nine bays rather than fail the one.
   */
  const runDispatched = (
    dispatch: BayDispatch,
  ): Observable<BayOutcome> => {
    const { slot, name } = placementOf(dispatch.drive)
    const driveId = dispatch.drive.identity.usbPortPath

    return defer(() =>
      // Cancelled before it ever reached the head of the queue.
      // Only reachable if the `mergeMap` bound is ever set below
      // the governor's cap, and far cheaper than the alternative:
      // a rip started against a signal that has already fired,
      // whose cancel therefore never lands.
      dispatch.controller.signal.aborted
        ? of<BayOutcome>({
            kind: "failed",
            detail: "cancelled_by_operator",
          })
        : deps.runBayRip({
            driveId,
            slot,
            name,
            kernelName: dispatch.drive.address.kernelName,
            devPath: dispatch.drive.address.devPath,
            jobUuid: dispatch.jobUuid,
            readOffsetSamples: readOffsetOf(dispatch.drive),
            explicitName: dispatch.explicitName,
            config: input.config,
            signal: dispatch.controller.signal,
            note: (message) =>
              handlers.onBayNote?.({
                driveId,
                slot,
                name,
                message,
              }),
            onRipStarted: () => {
              const current = bays.get(driveId)
              if (current === undefined) return

              bays.set(
                driveId,
                applyRipStarted({
                  bay: current,
                  atMs: deps.now(),
                }),
              )
            },
            onIdentified: (identity) => {
              // Onto the bay table FIRST, because that table is
              // what the ledger writes down and what `/json`
              // reads: a console handler that throws must not
              // cost this bay the one name it has. The name and
              // not the folder — the folder carries a
              // `[BACKUP]` marker nobody wants read out loud.
              rememberOnBay(driveId, (bay) => ({
                ...bay,
                discName: identity.title,
                // Typed by `decideDiscType` before the ripper
                // was even chosen — it is what chose the ripper
                // — so recording it here costs nothing and is
                // the only chance: nothing later re-derives it,
                // and the poster lookup has to know whether to
                // ask a music provider or a film one.
                discType: identity.discType,
              }))

              handlers.onBayIdentified?.({
                driveId,
                slot,
                name,
                identity,
              })
            },
            onDestination: (destinationPath) =>
              rememberOnBay(driveId, (bay) => ({
                ...bay,
                destinationPath,
              })),
            onProgress: (progress) =>
              handlers.onBayProgress?.({
                driveId,
                slot,
                name,
                progress,
              }),
          }),
    ).pipe(
      catchError((error: unknown) =>
        of<BayOutcome>({
          kind: "failed",
          detail:
            error instanceof Error
              ? error.message
              : String(error),
        }),
      ),
      tap((outcome) => {
        input.governor.release({ driveId })
        controllers.delete(driveId)

        const current = bays.get(driveId)
        if (current !== undefined) {
          bays.set(
            driveId,
            applyBayOutcome({
              bay: current,
              outcome,
              atMs: deps.now(),
            }),
          )
        }

        // Here rather than only at the next tick: a rip that
        // finishes and is followed by a SIGKILL five seconds
        // later must not come back as a disc nobody remembers
        // ripping.
        persistLedger()

        handlers.onBayOutcome?.({
          driveId,
          slot,
          name,
          outcome,
          jobUuid: dispatch.jobUuid,
        })
      }),
      // A console handler that throws must cost this bay and not
      // the dispatch pipeline. Without this the eight bays that
      // did nothing wrong would never be dispatched again.
      catchError(() => EMPTY),
    )
  }

  /**
   * The dispatch pipeline, subscribed for the watcher's lifetime.
   *
   * Awaited by `stop()`: completing the subject lets `mergeMap`
   * finish once every inner rip has landed, which is the "cancel,
   * then wait for them" half of E5.
   */
  const dispatchesSettled = lastValueFrom(
    dispatches.pipe(
      // Bounded at the governor's own cap — see the header. Never
      // unbounded: nine wedged drives is the case this file is
      // for.
      mergeMap(
        runDispatched,
        input.governor.maxConcurrentRips,
      ),
      defaultIfEmpty(undefined),
    ),
  )

  const dispatch = (input: {
    drive: ProbedDrive
    jobUuid: string
    /** Operator-supplied; null on every poll-loop dispatch. */
    explicitName?: string | null
  }): void => {
    const controller = new AbortController()
    controllers.set(
      input.drive.identity.usbPortPath,
      controller,
    )

    dispatches.next({
      drive: input.drive,
      jobUuid: input.jobUuid,
      controller,
      explicitName: input.explicitName ?? null,
    })
  }

  const tickNow = async (): Promise<void> => {
    // Overlap would let two ticks decide about the same bay from
    // the same stale reading and start two rips on one drive.
    if (isStopped || isTickInFlight) return

    isTickInFlight = true

    try {
      if (registry === null) {
        registry = await deps
          .loadRegistry(input.config.registryPath)
          // A missing registry costs slot NUMBERS, not identity —
          // bays are keyed on the USB port path either way. Not a
          // reason to stop ripping.
          .catch(() => ({
            towerRootPortPath: "",
            entries: [],
          }))
      }

      if (ledger === null) {
        // Read once, lazily, on the same tick as the registry.
        // An unreadable ledger reads as NO memory rather than
        // as an empty one, which is the fail-closed path in
        // `adoptBayAtStartup` — and never a reason to refuse to
        // start.
        ledger = await deps
          .readLedger({
            path: bayLedgerPath(input.config.stateDir),
          })
          .catch(() => EMPTY_BAY_LEDGER)
      }

      const probed = await probe()

      if (probed === null) {
        handlers.onNote?.(
          "sysfs did not answer within " +
            `${WATCHER_TUNING.probeTimeoutMs}ms. Skipping ` +
            "this poll; no bay was touched.",
        )
        return
      }

      if (probed.length !== lastDriveCount) {
        // Zero drives is a valid normal state (F3) — the tower is
        // powered independently of this service — so this is news,
        // never an alarm.
        handlers.onNote?.(
          probed.length === 0
            ? "No optical drives present. That is a valid " +
                "state; still watching."
            : `${probed.length} drive(s) present.`,
        )
        lastDriveCount = probed.length
      }

      const atMs = deps.now()
      const seen = new Set<string>()

      // Lowest slot first, so a scarce rip slot goes to a
      // predictable bay rather than to whichever one sysfs
      // happened to list first.
      const ordered = [...probed].sort(
        (a, b) =>
          (placementOf(a).slot ?? 99) -
          (placementOf(b).slot ?? 99),
      )

      for (const drive of ordered) {
        const driveId = drive.identity.usbPortPath
        seen.add(driveId)

        // Recorded for EVERY present drive, whatever the bay
        // then decides to do: a bay that is quietly idle still
        // has to be nameable on the dashboard, and it emits no
        // event that could carry this.
        sightings.set(driveId, sightingOf(drive))

        const observation: BayObservation = {
          isDrivePresent: true,
          hasMedia: drive.media.hasMedia,
          sizeSectors: drive.media.sizeSectors,
        }

        const known = bays.get(driveId)

        // Adopt a loaded disc — decide rip vs hold vs
        // ledger-recognised — from the ledger and the owner's
        // decision, failing closed. Factored because the poll loop
        // now runs it in TWO moments: a bay's first sighting, and
        // (below) a disc that appears on a bay whose tray never
        // settled empty since the drive appeared.
        // The bay's OWN memory of its last finished disc beats the
        // in-memory `ledger` here: `ledger` is a snapshot frozen the
        // tick this daemon started, so a disc this same daemon has
        // ripped since is simply not in it, and — the bug this
        // supersedes — a re-arm erases the on-disk record before the
        // disc reads. `lastFinished` survives the re-arm.
        const finishedMemory =
          known?.lastFinished ??
          ledger?.records.find(
            (record) => record.driveId === driveId,
          )

        const adopt = (): BayState =>
          adoptBayAtStartup({
            driveId,
            record: finishedMemory,
            trayRecord: ledger?.trayCommands.find(
              (record) => record.driveId === driveId,
            ),
            // A bay that remembers finishing a disc IS prior state,
            // even when the frozen ledger predates it — so a
            // genuinely DIFFERENT disc on that bay ripens through
            // branch 3 (rip), not the no-memory fail-closed hold.
            hasPriorState:
              ledger?.hasPriorState === true ||
              known?.lastFinished != null,
            observation,
            atMs,
          })

        // The FIRST time this process ever sees a bay is the
        // one moment a loaded disc is ambiguous: it may have
        // been ripped by the daemon that was running a minute
        // ago, and nothing in a fresh `BayState` remembers.
        // `adoptBayAtStartup` is where that is decided, and it
        // fails closed. Every later tick reads the bay we
        // already have.
        let bay = known ?? adopt()

        if (known === undefined) {
          bays.set(driveId, bay)

          if (bay.outcome !== null) {
            // A NOTE, deliberately, and never `onBayOutcome`.
            // An outcome publishes `rip/event`, which is what
            // makes the house speakers talk — so adopting three
            // finished discs at boot would announce three rips
            // that did not just happen, on every restart. That
            // is the 3am "Ivanhoe finished ripping" failure the
            // retention rules exist to prevent, arriving
            // through a different door.
            handlers.onBayNote?.({
              driveId,
              ...placementOf(drive),
              message: `held on startup — ${bay.outcome.detail}`,
            })
          }
        }

        // ⚠️ **The power-cycle guard.** A disc reappearing on a bay
        // this process has already seen, whose size matches a disc
        // the bay remembers FINISHING, is that same disc coming back
        // on the bus after the tower's USB power cycled — not a
        // fresh insert. The daemon never restarted, so
        // `adoptBayAtStartup` did not re-run; the drive enumerated
        // empty for the ~10s of spin-up, long enough to re-arm this
        // bay to `idle` and set `hasSettledEmpty` — which is exactly
        // why the 1.2.4 guard, keyed on that flag, re-ripped a
        // completed disc live (Desk Set, 2026-07-31). Key on the
        // finished-disc memory instead: held or recognised, never a
        // blind re-rip. A genuinely different disc (no size match)
        // is left to `decideBayAction`, which rips it under the
        // owner's rule; and a bay already holding this disc as
        // terminal is left to THE RULE there, so this fires once —
        // on the tick the re-armed bay recognises its disc is back
        // ([decision](docs/decisions/2026-07-31-power-cycle-holds-a-finished-disc-from-bay-memory.md)).
        const isHoldingThisDisc =
          (bay.phase === "done" ||
            bay.phase === "quarantined") &&
          bay.sizeSectors === observation.sizeSectors

        // (a) The COLD power-on case: a disc appeared on a bay whose
        // tray never read genuinely empty since the drive came up,
        // so it was loaded before power-on, not freshly inserted —
        // adopt it, failing closed even with no memory at all
        // ([decision](docs/decisions/2026-07-31-a-disc-present-at-power-on-is-adopted-not-ripped.md)).
        const isUnsettledLoad = !bay.hasSettledEmpty
        // (b) The RUNNING-daemon power-cycle case: the disc matches
        // one this bay finished, so it is that disc coming back even
        // though the ~10s spin-up re-armed the bay and marked the
        // tray settled-empty — the flag `isUnsettledLoad` trusts and
        // this case cannot.
        const isFinishedDiscBack =
          finishedMemory != null &&
          finishedMemory.sizeSectors ===
            observation.sizeSectors

        if (
          known !== undefined &&
          observation.hasMedia &&
          bay.phase !== "starting" &&
          bay.phase !== "ripping" &&
          !isHoldingThisDisc &&
          (isUnsettledLoad || isFinishedDiscBack)
        ) {
          const readopted = adopt()

          if (readopted.phase !== "idle") {
            // Held or recognised as a finished disc — never a
            // blind rip.
            bays.set(driveId, readopted)

            if (readopted.outcome !== null) {
              handlers.onBayNote?.({
                driveId,
                ...placementOf(drive),
                message: `held on power-on — ${readopted.outcome.detail}`,
              })
            }

            continue
          }

          // Size matched a record, so `adopt` returns a hold, not
          // `idle` — but if a future branch ever let it, fall
          // through with the armed bay rather than skip the rip.
          bay = readopted
        }

        const action = decideBayAction({
          bay,
          observation,
          isSlotAvailable: input.governor.hasCapacity(),
        })

        if (action.action !== "start") {
          bays.set(
            driveId,
            applyBayDecision({
              bay,
              observation,
              action,
              atMs,
            }),
          )

          if (action.action === "quarantine") {
            handlers.onBayOutcome?.({
              driveId,
              ...placementOf(drive),
              outcome: {
                kind: "needs_attention",
                detail: action.reason,
              },
            })
          }

          continue
        }

        // The lease is the last word. `hasCapacity` answered a
        // moment ago and this loop has been handing out leases
        // since, so the governor — not the decision — decides.
        if (!input.governor.tryAcquire({ driveId })) {
          bays.set(
            driveId,
            applyBayDecision({
              bay,
              observation,
              action: {
                action: "hold",
                reason: "no rip slot free",
              },
              atMs,
            }),
          )
          continue
        }

        const jobUuid = randomUUID()

        bays.set(
          driveId,
          applyBayDecision({
            bay,
            observation,
            action,
            atMs,
            jobUuid,
          }),
        )

        dispatch({ drive, jobUuid })
      }

      // Bays whose drive is not in this probe. Their state is
      // KEPT and fed an absent observation, never dropped: a
      // dropped bay comes back as a fresh idle one, and a fresh
      // idle bay with a finished disc still in it re-rips that
      // disc. USB re-enumeration on this tower is routine.
      for (const [driveId, bay] of bays) {
        if (seen.has(driveId)) continue

        const sighting = sightings.get(driveId)

        if (sighting !== undefined) {
          sightings.set(driveId, {
            ...sighting,
            isDrivePresent: false,
            // The identity is KEPT so a bay that vanished is
            // still named on the dashboard — but `/dev/srN` is
            // dropped, because it now belongs to whatever
            // inherits the name at the next re-enumeration.
            devPath: null,
          })
        }

        const observation: BayObservation = {
          isDrivePresent: false,
          hasMedia: false,
          sizeSectors: 0,
        }

        bays.set(
          driveId,
          applyBayDecision({
            bay,
            observation,
            action: decideBayAction({
              bay,
              observation,
              isSlotAvailable: false,
            }),
            atMs,
          }),
        )
      }

      // Blind when this probe found no drive at all — a
      // powered-off tower. An empty bay table then is absence of
      // sight, not proof the discs came out, so the guard keeps
      // the last ledger rather than erasing it.
      persistLedger({ isBlind: probed.length === 0 })

      // Now that `sightings` describes this whole poll — present
      // drives from the loop above, absent ones from the sweep —
      // fold its presence into the flap window. Every drive the
      // watcher knows is in the map with a real present/absent
      // reading, so a drive that dropped off the bus this tick
      // registers an edge here even though it emitted no event.
      const currentPresence = new Map<string, boolean>()
      for (const [driveId, sighting] of sightings) {
        currentPresence.set(
          driveId,
          sighting.isDrivePresent,
        )
      }

      usbTransitions = pruneTransitions({
        transitions: [
          ...usbTransitions,
          ...detectTransitions({
            previous: previousPresence,
            current: currentPresence,
            atMs,
          }),
        ],
        nowMs: atMs,
      })
      usbStability = summariseUsbStability({
        transitions: usbTransitions,
        nowMs: atMs,
      })
      previousPresence = currentPresence

      // Last, because everything above is what it announces:
      // the bay table and the sightings now describe this poll.
      handlers.onTickComplete?.()
    } finally {
      isTickInFlight = false
    }
  }

  const pollSubscription = unrefInterval({
    periodMs: pollIntervalMs,
    isKeepingProcessAlive: input.isKeepingProcessAlive,
  })
    .pipe(
      exhaustMap(() =>
        defer(tickNow).pipe(
          // A poll failure must cost this poll and never the
          // daemon. This used to be a `void tickNow()` inside a
          // timer callback, where the same failure surfaced as an
          // unhandled rejection instead.
          catchError(() => EMPTY),
        ),
      ),
    )
    .subscribe()

  /**
   * Slot + house label for a driveId, from the registry alone.
   *
   * Phantom loaded discs (below) exist for a drive that is NOT on
   * the bus, so there is no sighting and no probe to name them
   * from — only the registry, which is a config file loaded once
   * and does not depend on the tower's power. A driveId the
   * registry has never heard of keeps its usbPortPath as the
   * label, which is what `placementOf` does for a present drive
   * too.
   */
  const placementForDriveId = (
    driveId: string,
  ): { slot: number | null; label: string } => {
    const entry =
      registry?.entries.find(
        (candidate) => candidate.usbPortPath === driveId,
      ) ?? null

    return {
      slot: entry?.slot ?? null,
      label: entry?.name ?? driveId,
    }
  }

  /**
   * Fold "what is still in there" from the bay table AND the ledger.
   *
   * ⚠️ **Off memory, never off a probe**, and that is the whole
   * design: the question is asked most often about a tower that
   * has been switched OFF, where a probe returns nothing and every
   * `hasFinishedDisc` answers false. Two layers of memory feed it:
   *
   *  1. **The live bay + sighting tables.** `tickNow` KEEPS a bay
   *     whose drive left the bus (a dropped bay comes back idle and
   *     re-rips its own finished disc) and keeps its sighting with
   *     the slot and label intact — so a tower switched off *while
   *     the daemon keeps running* still remembers what is loaded.
   *  2. **The on-disk bay ledger**, for the case the tables cannot
   *     cover: a daemon RESTARTED against a dark tower starts with
   *     both tables empty, because nothing answered the probe.
   *     `phantomLoadedBays` rebuilds the loaded set from the ledger
   *     records for every driveId the probe did not answer for.
   *     These are display-only and never enter the `bays` map, so
   *     they cannot start a rip or move a tray (`loadedDiscs.ts`).
   *
   * `isBlind` is the honest floor under both: only when the bus is
   * empty AND the ledger was not readable does the daemon truly not
   * know, and only then must an empty answer be withheld rather
   * than published as an all-clear
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   */
  const loadedDiscsNow = (): LoadedDiscSummary => {
    const liveBays = [...bays.values()].map((bay) => {
      const sighting = sightings.get(bay.driveId)

      return {
        slot: sighting?.slot ?? null,
        label: sighting?.label ?? bay.driveId,
        isDrivePresent: sighting?.isDrivePresent ?? false,
        hasDisc: bay.sizeSectors !== null,
        // The same latch `buildDriveDiscState` publishes as
        // `is_holding_finished_disc`, spelled out here rather
        // than imported from the MQTT layer, which this file
        // must not depend on.
        isLatched:
          bay.phase === "done" ||
          bay.phase === "quarantined",
        isRipped: bay.outcome?.kind === "completed",
        title: bay.discName,
      }
    })

    const phantoms = phantomLoadedBays({
      records: (ledger?.records ?? []).map((record) => ({
        driveId: record.driveId,
        phase: record.phase,
        discName: record.discName,
        isRipped: record.outcome.kind === "completed",
      })),
      // A live bay already speaks for its drive; the ledger phantom
      // for the same driveId would double-count it.
      liveDriveIds: new Set(bays.keys()),
      placementOf: placementForDriveId,
    })

    // Blind = nothing on the bus AND no readable ledger. A readable
    // ledger that recorded nothing is a genuine all-clear, not
    // blindness; `summariseLoadedDiscs` also forces this false the
    // moment any drive is present.
    const isBlind =
      !liveBays.some((bay) => bay.isDrivePresent) &&
      ledger?.hasPriorState !== true

    return summariseLoadedDiscs(
      [...liveBays, ...phantoms],
      {
        isBlind,
      },
    )
  }

  /**
   * Cut mains to the tower, once every bay has been asked.
   *
   * ⚠️ **The refusal is the feature.** Every candidate goes through
   * `decideTrayBayAction` exactly as it would for ⏏, so a
   * `starting`/`ripping` bay refuses the whole press — not just its
   * own tray, because there is one power lead and one of the nine
   * saying no is enough. Trapping a loaded disc costs a walk
   * downstairs; cutting power mid-rip costs 90 GB and an hour, and
   * those two are not traded off against each other.
   *
   * Loaded-but-idle discs are WARNED about and the tower goes off
   * anyway — the owner's own call when asked
   * ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)).
   */
  const runTowerPowerOff = async (params: {
    request: TrayCommandRequest
    requestId: string | null
    startedAtMs: number
  }): Promise<TrayCommandResponsePayload> => {
    const probed = await probe()

    // A bus we could not read is NOT a bus with nothing running on
    // it. Fail closed: the one input that could refuse this press
    // is missing, so the press is refused instead of guessed.
    if (probed === null) {
      return buildTrayCommandResponse({
        request: params.request,
        requestId: params.requestId,
        results: [
          {
            driveId: "",
            slot: null,
            label: "the tower",
            resultKind: "failed",
            detail:
              "sysfs did not answer in time, so rip-deck cannot " +
              "tell whether a rip is running. The tower was NOT " +
              "powered off.",
          },
        ],
        startedAtMs: params.startedAtMs,
        finishedAtMs: deps.now(),
      })
    }

    const refused = probed
      .map((drive) => ({
        drive,
        decision: decideTrayBayAction({
          request: params.request,
          bay: bays.get(drive.identity.usbPortPath) ?? null,
          observation: {
            isDrivePresent: true,
            hasMedia: drive.media.hasMedia,
            sizeSectors: drive.media.sizeSectors,
          },
        }),
      }))
      .filter(
        ({ decision }) => decision.action === "refuse",
      )

    if (refused.length > 0) {
      for (const { drive } of refused) {
        console.warn(
          `[power] REFUSED to power off: ${
            placementOf(drive).name
          } is mid-rip.`,
        )
      }

      return buildTrayCommandResponse({
        request: params.request,
        requestId: params.requestId,
        results: refused.map(({ drive, decision }) => ({
          driveId: drive.identity.usbPortPath,
          ...placementOf(drive),
          label: placementOf(drive).name,
          resultKind: "refused_ripping" as const,
          detail:
            decision.action === "refuse"
              ? decision.detail
              : "",
        })),
        startedAtMs: params.startedAtMs,
        finishedAtMs: deps.now(),
      })
    }

    // Read BEFORE the request goes out, while the drives are still
    // on the bus and the tables are current. After the switch flips
    // this is unanswerable for anything the tables had not already
    // seen.
    const loaded = loadedDiscsNow()

    input.publishTowerPowerOff?.()

    return buildTowerPowerOffResponse({
      requestId: params.requestId,
      atMs: deps.now(),
      loaded,
    })
  }

  /**
   * Forget the discs the tower is holding — the "took the trash
   * out" press.
   *
   * ⚠️ **It clears MEMORY, and it moves no tray.** A human has
   * physically pulled the finished discs the reminder was naming —
   * usually while the tower was off, where rip-deck could not watch
   * them go — so this drops rip-deck's record of them and lets the
   * reminder fall silent. No probe, because the thing it acts on is
   * the daemon's own state, and no bus read could add to it
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   *
   * Two sources of that memory, cleared together:
   *
   *  1. **The on-disk ledger's latched records** — the phantom
   *     source `phantomLoadedBays` reads. `hasPriorState` is set
   *     TRUE, not left as read: the operator saying "they are out"
   *     is authoritative, so the next publish is a real all-clear
   *     and never a blind one withheld by `shouldPublishLoadedDiscs`.
   *  2. **Live bays kept only as loaded memory whose drive is off
   *     the bus.** A PRESENT drive still holding its disc is left
   *     alone — clearing must never claim a disc anyone can see is
   *     gone; for those the honest path stays Open trays. A cleared
   *     absent bay whose drive and disc later return is re-adopted
   *     through the fail-closed startup path, which HOLDS rather
   *     than re-rips.
   *
   * `persistLedger` then writes the trimmed set through, so a
   * restart reads the same all-clear this press asserted.
   */
  const runClearLoaded = (params: {
    requestId: string | null
    startedAtMs: number
  }): TrayCommandResponsePayload => {
    const before = loadedDiscsNow().count

    ledger = {
      ...(ledger ?? EMPTY_BAY_LEDGER),
      records: [],
      hasPriorState: true,
    }

    for (const [driveId, bay] of [...bays]) {
      const isPresent =
        sightings.get(driveId)?.isDrivePresent ?? false
      const isLatched =
        bay.phase === "done" || bay.phase === "quarantined"

      if (!isPresent && isLatched) {
        bays.delete(driveId)
        sightings.delete(driveId)
      }
    }

    persistLedger()

    // What actually fell off the reminder: everything before, minus
    // any present-and-loaded disc deliberately kept. A tower that is
    // on with a disc still in it is not lied about.
    const cleared = before - loadedDiscsNow().count

    return buildClearLoadedResponse({
      requestId: params.requestId,
      atMs: deps.now(),
      cleared,
    })
  }

  /**
   * Start a rip on one bay because a human pressed Rip.
   *
   * The dead end this ends: a held card offered ⏏ and a sentence
   * telling the operator to run `rip-deck rip --slot N --name "…"`
   * — a CLI command a dashboard cannot run — and ⏏ does not even
   * un-hold on this rig, because the drives keep reporting the disc
   * after the tray opens. Physically pulling the disc out was the
   * only working way to get it ripped
   * ([decision](docs/decisions/2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)).
   *
   * ⚠️ **Everything it does is `tickNow`'s start path, in the same
   * order, with the poll loop's *reasons to decline* removed and
   * none of its *safety* removed.** That distinction is the whole
   * design:
   *
   *  - **The refusal is untouched and already happened.** A
   *    `starting`/`ripping` bay is refused by `decideTrayBayAction`
   *    before this is ever called, exactly as it is for ⏏. This
   *    function is unreachable for a bay a rip owns.
   *  - **The governor still has the last word.** Same
   *    `tryAcquire` the poll loop takes, so an operator cannot
   *    push a tenth rip onto a nine-rip cap. Refused loudly, not
   *    queued: a button that silently means "in a while" is the
   *    other kind of dead end.
   *  - **The latch, the fingerprint and the start counter are
   *    what he is overruling.** They exist to stop the POLL LOOP
   *    re-ripping a disc nobody asked about. A person pressing Rip
   *    on a card that says "held" is the ask.
   *
   * `applyBayDecision`'s `start` does the state change, rather than
   * a hand-rolled one — it is the fold that clears the outcome,
   * takes the fingerprint and bumps `startCount`, and a second
   * transcription of it here would be the copy that drifts.
   */
  const startOperatorRip = async (params: {
    drive: ProbedDrive
    base: {
      driveId: string
      slot: number | null
      label: string
    }
    bay: BayState | null
    observation: BayObservation
    name: string | null
  }): Promise<TrayBayResult> => {
    const { base, drive } = params
    const driveId = base.driveId

    // ⚠️ Close the tray first if rip-deck opened it. On this rig a
    // drive with an OPEN tray still reports its disc, so nothing
    // upstream can tell — and `makemkvcon` reading an open tray
    // fails in a way that looks like a bad disc
    // ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
    // `lastTrayCommand` is the only tray knowledge there is, and a
    // held bay has usually been opened at least once by someone
    // trying to un-hold it. The three-layer settle at the top of
    // `runBayRip` covers the spin-up.
    if (params.bay?.lastTrayCommand === "open_bay") {
      const closed = await deps.runTray({
        action: "close",
        devPath: drive.address.devPath,
        eject: input.config.eject,
      })

      if (!closed.isSuccessful) {
        return {
          ...base,
          resultKind: "failed",
          detail:
            "this bay's tray is open and would not close, so " +
            `there is nothing to read: ${closed.detail}`,
        }
      }

      rememberTrayCommand({ driveId, action: "close" })
    }

    // The lease, before any state is changed: a bay moved to
    // `starting` that then fails to get a slot would sit claimed
    // with nothing running it.
    if (!input.governor.tryAcquire({ driveId })) {
      return {
        ...base,
        resultKind: "failed",
        detail:
          "every rip slot is busy. Nothing was changed; press " +
          "Rip again when one of the running rips finishes.",
      }
    }

    const jobUuid = randomUUID()

    bays.set(
      driveId,
      applyBayDecision({
        bay:
          params.bay ??
          createBayState({ driveId, atMs: deps.now() }),
        observation: params.observation,
        action: { action: "start" },
        atMs: deps.now(),
        jobUuid,
      }),
    )

    // Now, not at the next tick: the ledger is what a restart
    // reads, and a bay that is `starting` on disk is a bay the
    // next daemon will not adopt as finished.
    persistLedger()

    dispatch({ drive, jobUuid, explicitName: params.name })

    return {
      ...base,
      resultKind: "rip_started",
      detail:
        params.name === null
          ? "reading the disc's own name, then ripping"
          : `ripping as "${params.name}"`,
    }
  }

  /**
   * Every tray the operator asked about, moved and reported.
   *
   * ## Why it re-probes rather than trusting the last tick
   *
   * `/dev/srN` is never identity — it reshuffles on every USB
   * re-enumeration, which is routine on this tower. A tray
   * command resolved from a five-second-old probe is a command
   * that can open the wrong bay, and "the wrong bay" here means
   * a bay that was ripping. The probe is the same watchdog-raced
   * one the poll loop uses, so a wedged bus costs a reported
   * failure rather than a hung button.
   *
   * ## Why the bays are moved in parallel
   *
   * Bounded by construction: at most the nine drives this probe
   * returned, each its own device with no shared lock. Serially,
   * one drive that has stopped answering would spend the whole
   * `TRAY_TUNING.commandTimeoutMs` before the next bay was even
   * tried, and an operator standing at the tower would wait
   * three minutes to hear about nine bays. In parallel a wedged
   * bay costs its own line in the report and nobody else's.
   */
  const runTrayCommandForRequest = async (params: {
    request: TrayCommandRequest
    requestId?: string | null
  }): Promise<TrayCommandResponsePayload> => {
    const startedAtMs = deps.now()
    const requestId = params.requestId ?? null

    // Its own path: it moves no tray, it acts on the whole tower
    // rather than a set of bays, and it asks every bay one
    // question. Routed before the probe below because it takes its
    // own.
    if (params.request.kind === "power_off") {
      return await runTowerPowerOff({
        request: params.request,
        requestId,
        startedAtMs,
      })
    }

    // Its own path too, and for the same reason: it acts on
    // rip-deck's memory of what is loaded, not on any drawer, so it
    // needs no probe and takes none. Routed before the probe below.
    if (params.request.kind === "clear_loaded") {
      return runClearLoaded({ requestId, startedAtMs })
    }

    const probed = await probe()

    if (probed === null) {
      return buildTrayCommandResponse({
        request: params.request,
        requestId,
        results: [
          {
            driveId: "",
            slot: null,
            label: "the tower",
            resultKind: "failed",
            detail:
              "sysfs did not answer in time, so no bay could " +
              "be resolved to a device. Nothing was touched.",
          },
        ],
        startedAtMs,
        finishedAtMs: deps.now(),
      })
    }

    // ⚠️ Tower off: an `open_trays` press powers it on and moves no
    // tray this press. "Off" is no drives on the bus — a real,
    // valid state (the rack is powered independently). Only the
    // bulk Open does this; a targeted or close command on an empty
    // bus falls through to the "no bay matches" report below.
    if (
      params.request.kind === "open_trays" &&
      probed.length === 0
    ) {
      input.publishTowerPowerOn?.()

      return buildTrayPowerOnResponse({
        requestId,
        atMs: deps.now(),
      })
    }

    // Observed once per drive, then read twice: by the
    // tower-wide fold below and by the per-bay decision.
    const observationOf = (
      drive: ProbedDrive,
    ): BayObservation => ({
      isDrivePresent: true,
      hasMedia: drive.media.hasMedia,
      sizeSectors: drive.media.sizeSectors,
    })

    // ⚠️ The tower-wide questions, answered HERE because
    // `decideTrayBayAction` is per bay and cannot see the tower.
    // Over the whole probe, never over `candidates` — a targeted
    // command must not change what "the tower" means — and off
    // this same probe, so the answer and the per-bay readings
    // are one snapshot rather than two.
    //
    // The bays finished with, disc still in them: the set an
    // `open_trays` press opens first.
    const finishedDriveIds = probed
      .filter((drive) =>
        hasFinishedDisc({
          bay: bays.get(drive.identity.usbPortPath) ?? null,
          observation: observationOf(drive),
        }),
      )
      .map((drive) => drive.identity.usbPortPath)

    // The escalation, resolved statelessly from tray memory rather
    // than a click counter: the first press opens the finished
    // bays; once they are ALL open, the next press widens to every
    // non-ripping bay (`"all"`). No finished bays collapses both
    // into a single "open everything" press.
    const areAllFinishedBaysOpen =
      finishedDriveIds.length > 0 &&
      finishedDriveIds.every(
        (driveId) =>
          bays.get(driveId)?.lastTrayCommand === "open_bay",
      )

    const openScope: "finished" | "all" =
      finishedDriveIds.length > 0 && !areAllFinishedBaysOpen
        ? "finished"
        : "all"

    const target =
      "target" in params.request
        ? params.request.target
        : null

    const candidates = [...probed]
      .sort(
        (a, b) =>
          (placementOf(a).slot ?? 99) -
          (placementOf(b).slot ?? 99),
      )
      .filter((drive) =>
        target === null
          ? true
          : isBayTargeted({
              target,
              driveId: drive.identity.usbPortPath,
              slot: placementOf(drive).slot,
            }),
      )

    if (candidates.length === 0) {
      return buildTrayCommandResponse({
        request: params.request,
        requestId,
        results: [
          {
            driveId: "",
            slot: null,
            label: "that bay",
            resultKind: "skipped_not_present",
            detail:
              "no drive on the bus matches that slot or drive " +
              "id right now",
          },
        ],
        startedAtMs,
        finishedAtMs: deps.now(),
        openScope,
      })
    }

    const results = await Promise.all(
      candidates.map(
        async (drive): Promise<TrayBayResult> => {
          const driveId = drive.identity.usbPortPath
          const placement = placementOf(drive)
          const bay = bays.get(driveId) ?? null

          const base = {
            driveId,
            slot: placement.slot,
            // Already `07 - Pioneer BDR-211M`. Re-applying the
            // slot prefix here is what produced
            // "06 - 06 - Pioneer BDR-211M" out loud.
            label: placement.name,
          }

          const decision = decideTrayBayAction({
            request: params.request,
            bay,
            observation: observationOf(drive),
            openScope,
          })

          if (
            decision.action === "skip" ||
            decision.action === "refuse"
          ) {
            if (decision.action === "refuse") {
              // On the daemon's own log too, not only in the
              // MQTT reply: the operator hears the reply, and
              // whoever reads the log tomorrow needs to see
              // that a button came within one branch of
              // destroying a rip.
              console.warn(
                `[tray] ${base.label}: ${decision.detail}`,
              )
            }

            return {
              ...base,
              resultKind: decision.resultKind,
              detail: decision.detail,
            }
          }

          if (decision.action === "rip") {
            return await startOperatorRip({
              drive,
              base,
              bay,
              observation: observationOf(drive),
              name:
                params.request.kind === "rip_bay"
                  ? params.request.name
                  : null,
            })
          }

          const result = await deps.runTray({
            action: decision.action,
            devPath: drive.address.devPath,
            eject: input.config.eject,
          })

          if (!result.isSuccessful) {
            return {
              ...base,
              resultKind: "failed",
              detail: result.detail,
            }
          }

          rememberTrayCommand({
            driveId,
            action: decision.action,
          })

          return {
            ...base,
            resultKind:
              decision.action === "close"
                ? "closed"
                : isRipCompleted(bay)
                  ? "opened"
                  : "opened_not_ripped",
            detail: result.detail,
          }
        },
      ),
    )

    return buildTrayCommandResponse({
      request: params.request,
      requestId,
      results,
      startedAtMs,
      finishedAtMs: deps.now(),
      openScope,
    })
  }

  return {
    tickNow,
    runTrayCommand: runTrayCommandForRequest,

    stop: async () => {
      isStopped = true
      pollSubscription.unsubscribe()

      // Cancel rather than abandon: E5 says no orphaned rippers,
      // and `runRipJob` escalates SIGTERM to SIGKILL on its own.
      for (const controller of controllers.values()) {
        controller.abort()
      }

      // Completing the subject is what lets `mergeMap` finish:
      // it waits for every rip already in flight, which is the
      // "and wait for them to land" half of the contract.
      dispatches.complete()

      await dispatchesSettled
    },

    getBays: () =>
      [...bays.values()].sort((a, b) =>
        a.driveId.localeCompare(b.driveId),
      ),

    getBaySightings: () =>
      [...sightings.values()].sort((a, b) =>
        a.driveId.localeCompare(b.driveId),
      ),

    getUsbStability: () => usbStability,

    getLoadedDiscs: () => loadedDiscsNow(),
  }
}
