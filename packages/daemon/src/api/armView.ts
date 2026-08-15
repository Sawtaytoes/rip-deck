import {
  type DiscType,
  discTypeLabel,
  isJobActive,
  isJobFinished,
  type Job,
  type JobState,
  type VerdictKind,
} from "@rip-deck/contracts"
import {
  isSafeJobUuid,
  logCaptureFilename,
} from "./logCapture.ts"
import type {
  BaySnapshot,
  TowerSnapshot,
} from "./snapshot.ts"

/**
 * The compatibility projection: rip-deck's model rendered in the
 * shape the existing ARM-viewer dashboard already fetches from
 * `GET /json`.
 *
 * That dashboard is the only UI that exists — ARM itself is
 * retired as the ripper, but its viewer still runs. Pointing it
 * at rip-deck is worth far more than a from-scratch UI we do not
 * have, so this projection matches
 * `automatic-ripping-machine-viewer`'s `ArmState`/`Host`/`Rip`/
 * `Drive` types exactly, and adds rip-deck's richer fields
 * ALONGSIDE rather than in place of them. The viewer ignores
 * what it does not know; a rip-deck-aware UI reads the extras.
 *
 * The one shape we cannot honour verbatim is the job id: the
 * viewer types it `number` (ARM's SQLite rowid) and uses it as a
 * join key between a rip and its drive, while rip-deck ids are
 * UUIDs. Emitting a string there would quietly falsify the
 * viewer's own contract, so a stable numeric SURROGATE is
 * derived from the UUID and the real id travels beside it as
 * `job_uuid`. The surrogate is display/join only and must never
 * be persisted or matched against anything.
 */

export type ArmMediaKind = string

export type ArmRip = {
  job_id: number
  status: string
  kind: ArmMediaKind
  label: string | null
  drive: string | null
  path: string | null
  percent: number | null
  stage: string
  active: boolean
  logfile: string | null
  ejected: boolean
  poster: string | null
  drive_name: string | null
  tray: "open" | "closed" | "unknown"
  start: string | null
  stop: string | null

  // --- additive, rip-deck-only. The viewer ignores these. ---
  /** The real id. `job_id` above is a surrogate. */
  job_uuid: string
  /** Stable drive identity. `drive` is ephemeral. */
  drive_id: string
  slot: number | null
  disctype: DiscType
  /** House label for the disc type, e.g. "4K". */
  disctype_label: string | null
  volume_label: string | null
  /** rip-deck's measured ETA — not the viewer's extrapolation. */
  eta_seconds: number | null
  eta_trend: "falling" | "steady" | "rising" | null
  throughput_bytes_per_sec: number | null
  /** Non-zero blocks success. Never render this as healthy. */
  read_error_count: number
  verdict: VerdictKind
  verdict_message: string
  verdict_confidence: string
  failure_reason: string | null
  is_adopted: boolean
  is_keep_trying_requested: boolean
}

export type ArmDrive = {
  /** Kernel name, e.g. "sr0". */
  name: string | null
  mount: string | null
  current: number | null
  previous: number | null
  maker: string | null
  model: string | null
  serial_id: string | null

  // --- additive, rip-deck-only. ---
  drive_id: string
  slot: number | null
  is_quarantined: boolean
  quarantine_reason: string | null
}

export type ArmHost = {
  host: string
  rips: ArmRip[]
  drives: ArmDrive[]
  /**
   * The collector round-trip succeeded.
   *
   * TRUE for an empty rack (F3). Zero drives present means the
   * owner switched the tower off, which is a normal state — not
   * a fault, and not something to paint red.
   */
  ok: boolean
  err: string
}

export type ArmStateDocument = {
  hosts: ArmHost[]
}

const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619

/**
 * A stable positive 32-bit surrogate for a UUID job id.
 *
 * FNV-1a, chosen for being short, dependency-free and stable
 * across processes — a React key that changed every poll would
 * remount every card. Display and join only.
 */
export const toArmJobId = (jobId: string): number => {
  let hash = FNV_OFFSET_BASIS

  for (let index = 0; index < jobId.length; index += 1) {
    hash ^= jobId.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return hash >>> 0
}

const pad = (value: number): string =>
  String(value).padStart(2, "0")

/**
 * ARM's `YYYY-MM-DD HH:MM:SS` timestamp, in LOCAL wall-clock.
 *
 * Deliberately not `toISOString()`: ARM writes local time and
 * the viewer parses these as local, so a UTC string reads hours
 * into the future and the elapsed/ETA text goes nonsense.
 */
export const formatLocalTimestamp = (
  epochMs: number,
): string => {
  const at = new Date(epochMs)

  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-` +
    `${pad(at.getDate())} ${pad(at.getHours())}:` +
    `${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  )
}

/**
 * ARM's free-form `status` string.
 *
 * The viewer only special-cases `success` and `fail`; everything
 * else is printed as-is, so the remaining states keep rip-deck's
 * own vocabulary rather than being flattened into ARM's.
 */
export const toArmStatus = (state: JobState): string => {
  if (state === "completed") return "success"
  if (state === "failed") return "fail"
  if (isJobActive(state)) return "ripping"

  return state
}

/**
 * ARM's `kind`, which drives the card icon.
 *
 * `cd` becomes `music` because that is ARM's name for an audio
 * disc. `uhd` is left alone: the viewer tolerates unknown kinds
 * with a generic disc icon, and calling a 4K disc a Blu-ray to
 * win a prettier glyph would be a lie on the card. A
 * rip-deck-aware UI reads `disctype_label` ("4K").
 */
export const toArmKind = (
  discType: DiscType,
): ArmMediaKind => (discType === "cd" ? "music" : discType)

/**
 * Overall percent, or null for "indeterminate".
 *
 * Null while an active rip has produced no forward progress:
 * that is the AACS/BD+ preamble, which is genuinely slow and
 * emits nothing, and the viewer renders null as a sweeping
 * indeterminate bar rather than a misleading empty one.
 */
export const toArmPercent = (job: Job): number | null => {
  if (job.state === "completed") return 100

  if (
    isJobActive(job.state) &&
    job.progress.totalFraction <= 0
  ) {
    return null
  }

  // One decimal place, matching what makemkv itself reports.
  return Math.round(job.progress.totalFraction * 1000) / 10
}

/**
 * The capture this job would have, if it has one.
 *
 * Null is what hides the card's Logs button, so this answers
 * "could a capture exist" rather than "does one exist" — the
 * latter is a `stat`, and the parent process does no disk I/O on
 * the way to `/json`. `/logs` answers the real question with a
 * 404, which the modal shows.
 *
 * The test is structural, not a guess: every real capture is
 * named for a `randomUUID()` job id, while a bay that never got
 * a job carries `towerFeed`'s `<driveId>@<ms>` placeholder — a
 * deliberately non-UUID string precisely so it cannot name a
 * file. An ADOPTED bay from a previous daemon keeps its real
 * UUID and therefore keeps its capture, which is the case the
 * owner most wants a log for.
 */
const logCaptureNameFor = (job: Job): string | null =>
  isSafeJobUuid(job.id) ? logCaptureFilename(job.id) : null

const buildArmRip = (input: {
  bay: BaySnapshot
  job: Job
}): ArmRip => {
  const { bay, job } = input
  const { identity, progress, verdict } = job

  return {
    job_id: toArmJobId(job.id),
    status: toArmStatus(job.state),
    kind: toArmKind(identity?.discType ?? "unknown"),
    label: identity?.title ?? identity?.volumeLabel ?? null,
    drive: bay.devPath,
    path: job.destinationPath,
    percent: toArmPercent(job),
    stage:
      progress.currentLabel ?? progress.totalLabel ?? "",
    active: isJobActive(job.state),
    logfile: logCaptureNameFor(job),
    // rip-deck never eject-loops: an unidentified or failed disc
    // stays in the drive and is marked needs-attention, because
    // the eject flap-storm is what killed valid rips on other
    // drives.
    ejected: false,
    poster: identity?.posterUrl ?? null,
    drive_name: bay.label,
    // Reading the tray means an ioctl on the device, and the
    // parent process must never make a device call — a wedged
    // drive would freeze all nine bays and the API with it.
    tray: "unknown",
    start: formatLocalTimestamp(job.startedAt),
    stop:
      job.finishedAt === null
        ? null
        : formatLocalTimestamp(job.finishedAt),

    job_uuid: job.id,
    drive_id: bay.driveId,
    slot: bay.slot,
    disctype: identity?.discType ?? "unknown",
    disctype_label: discTypeLabel(
      identity?.discType ?? "unknown",
    ),
    volume_label: identity?.volumeLabel ?? null,
    eta_seconds: progress.etaSeconds,
    eta_trend: progress.etaTrend,
    throughput_bytes_per_sec:
      progress.throughputBytesPerSec,
    read_error_count: job.readErrorCount,
    verdict: verdict.kind,
    verdict_message: verdict.message,
    verdict_confidence: verdict.confidence,
    failure_reason: job.failureReason,
    is_adopted: job.isAdopted,
    is_keep_trying_requested: job.isKeepTryingRequested,
  }
}

const kernelNameOf = (bay: BaySnapshot): string | null =>
  bay.devPath === null
    ? null
    : (bay.devPath.split("/").pop() ?? null)

const buildArmDrive = (bay: BaySnapshot): ArmDrive => {
  const { job } = bay
  const jobId = job === null ? null : toArmJobId(job.id)

  return {
    name: kernelNameOf(bay),
    mount: bay.devPath,
    current:
      job !== null && isJobActive(job.state) ? jobId : null,
    previous:
      job !== null && isJobFinished(job.state)
        ? jobId
        : null,
    maker: bay.vendor,
    model: bay.model,
    serial_id: bay.serial,

    drive_id: bay.driveId,
    slot: bay.slot,
    is_quarantined: bay.supervision.isQuarantined,
    quarantine_reason: bay.supervision.quarantineReason,
  }
}

export const buildArmState = (input: {
  snapshot: TowerSnapshot
}): ArmStateDocument => {
  const { snapshot } = input

  const rips = snapshot.bays
    .flatMap((bay) =>
      bay.job === null ? [] : [{ bay, job: bay.job }],
    )
    // Newest first — the viewer assumes the list is already in
    // that order and takes the first match per drive.
    .sort(
      (left, right) =>
        right.job.startedAt - left.job.startedAt,
    )
    .map(buildArmRip)

  return {
    hosts: [
      {
        host: snapshot.host,
        rips,
        drives: snapshot.bays
          .filter((bay) => bay.isPresent)
          .map(buildArmDrive),
        ok: snapshot.collectorError === "",
        err: snapshot.collectorError,
      },
    ],
  }
}
