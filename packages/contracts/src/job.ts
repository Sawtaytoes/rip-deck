/**
 * Job model, shared daemon <-> UI.
 *
 * Shape informed by `arm-contracts` (uprightbass360), which is
 * conformance-tested schema design we get to learn from without
 * taking the dependency. Ported as a TypeScript discriminated
 * union rather than transcribed from Pydantic.
 */

import type { DiscType } from "./drive.ts"
import type { Verdict } from "./health.ts"

export type JobState =
  /** Media detected, waiting for the settle window to close. */
  | "settling"
  /** Working out what the disc is. */
  | "identifying"
  /** Identified, waiting for a slot / operator decision. */
  | "queued"
  /** `makemkvcon backup --decrypt` is running. */
  | "ripping"
  /** Reading, but far below this drive's baseline. */
  | "throttled"
  /** Emitting nothing at all; the stall watchdog has fired. */
  | "stalled"
  /** Rip finished, output being moved into place. */
  | "finalising"
  | "completed"
  | "failed"
  | "cancelled"
  /** Needs a human: unidentified disc, or a health verdict. */
  | "needs_attention"

/** States in which a `makemkvcon` child should be alive. */
export const ACTIVE_JOB_STATES: readonly JobState[] = [
  "ripping",
  "throttled",
  "stalled",
] as const

export const isJobActive = (state: JobState): boolean =>
  ACTIVE_JOB_STATES.includes(state)

export const isJobFinished = (state: JobState): boolean =>
  state === "completed" ||
  state === "failed" ||
  state === "cancelled"

/** Why a job stopped without producing output. */
export type FailureReason =
  | "read_errors"
  /** MSG:5004 said 0 titles saved — the silent-success trap. */
  | "no_titles_saved"
  /**
   * Backup exited cleanly and produced no disc.
   *
   * The backup-mode counterpart of `no_titles_saved`: there is
   * no title count to inspect, so the evidence is the absence of
   * a BDMV/VIDEO_TS structure on the dataset.
   */
  | "empty_output"
  | "stall_timeout"
  /** makemkvcon asked an interactive question (BOXYESNO). */
  | "interactive_prompt"
  | "disc_removed"
  | "drive_disappeared"
  /**
   * MakeMKV opened a different drive than the one we targeted.
   *
   * `backup` takes only a `disc:<index>` source, and that index
   * comes from bus-enumeration order — so a drive appearing or
   * disappearing between our enumeration and the rip renumbers
   * it. Caught by comparing MakeMKV's own DRV table against the
   * device we meant. Fatal, because the alternative is ripping
   * one bay's disc into a folder named after another's.
   */
  | "wrong_drive"
  | "insufficient_space"
  | "key_expired"
  | "cancelled_by_operator"
  | "daemon_restart"
  | "unknown"

/**
 * Something worth telling the owner about a rip that WORKED.
 *
 * The third state, and the one this project was missing. A rip
 * was `pass` or `fail`, so a backup that produced a complete,
 * verified, plausible-size ISO with one bad sector in the middle
 * of it was badged `fail` and read as "there is no backup" —
 * which was false, and hid the thing actually worth knowing.
 *
 * The owner's rule: *"This should be a warning. It didn't fail
 * because it made the ISO, but the ISO is problematic, so I'd
 * like to know that."*
 * ([decision](../../../docs/decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md))
 *
 * A warning NEVER changes `isSuccessful`. It rides beside it.
 */
export type RipWarningKind =
  /** SCSI read errors during the copy. The disc has bad sectors. */
  | "read_errors"
  /** MakeMKV's own content-hash check reported corrupt files. */
  | "hash_check_failed"

export type RipWarning = {
  kind: RipWarningKind
  /** Plain language, written to be read on a phone. */
  message: string
}

/** Identification result for a disc. */
export type DiscIdentity = {
  title: string
  year: number | null
  discType: DiscType
  /** Where the metadata came from, for the trust trail. */
  source:
    | "tmdb"
    /**
     * OMDb answered — the poster and the year on the card.
     *
     * `tmdb` was the only film-metadata member and it is a lie
     * here: there is no TMDB key in this house and there is an
     * OMDb one, so the provider that actually runs is OMDb
     * (`metadata/omdb.ts`). Reporting its answers as `tmdb`
     * because the union already had that member would make the
     * one field whose whole job is the trust trail the least
     * trustworthy thing on the card — the same argument that
     * added `"disc"`.
     *
     * It means the LOOKED-UP metadata came from OMDb. The
     * title and `volumeLabel` still come off the media; see
     * `buildIdentity` in `api/towerFeed.ts` for why the disc's
     * own name is not overwritten by the matched one.
     */
    | "omdb"
    | "musicbrainz"
    | "gnudb"
    | "vgmdb"
    | "manual"
    /**
     * `identifyDisc`'s read of the disc's own volume label.
     *
     * The other five all mean "somebody or something looked
     * this up", and none of them was true of the one name
     * rip-deck actually has today: the label `makemkvcon info`
     * reports off the media, which is the name the folder is
     * built from. Calling that `manual` would claim a human
     * typed it and `tmdb` would claim a lookup happened, so a
     * card carrying it could not say where it came from —
     * which is the entire job of this field.
     */
    | "disc"
  posterUrl: string | null
  /** The disc's own volume label, as read from the media. */
  volumeLabel: string | null
  /** Disc N of M, when we can tell. */
  discNumber: number | null
  discTotal: number | null
}

/**
 * Two-level progress (requirement C5).
 *
 * MakeMKV gives us both: PRGC/`current` is the file being
 * written right now, PRGT/`total` is the whole backup. Showing
 * only one of them is why the current viewer feels opaque.
 */
export type JobProgress = {
  /** 0..1 for the overall operation. */
  totalFraction: number
  /** 0..1 for the current sub-operation. */
  currentFraction: number
  /** Human label from PRGT, e.g. "Saving all titles to MKV". */
  totalLabel: string | null
  /** Human label from PRGC, e.g. "Saving title 3". */
  currentLabel: string | null
  /** Which file of how many. */
  fileIndex: number | null
  fileCount: number | null
  bytesWritten: number
  throughputBytesPerSec: number | null
  /** Seconds remaining; null until we have a rate. */
  etaSeconds: number | null
  /**
   * ETA direction over the recent window.
   *
   * A rising ETA is not a cosmetic annoyance — it is the same
   * d(progress)/dt collapse the health engine watches, so it is
   * surfaced as a signal in its own right (requirement C6).
   */
  etaTrend: "falling" | "steady" | "rising" | null
}

export type Job = {
  id: string
  driveId: string
  state: JobState
  /** Epoch milliseconds. */
  startedAt: number
  finishedAt: number | null
  identity: DiscIdentity | null
  progress: JobProgress
  verdict: Verdict
  failureReason: FailureReason | null
  /**
   * Trouble on a rip that still SUCCEEDED. Empty for a clean one.
   *
   * Orthogonal to `failureReason`: a job can be `completed` and
   * carry warnings, which is the whole point of the three-state
   * outcome. A FAILED job may carry them too — the read errors
   * that preceded a failure are still worth naming.
   *
   * Sentences rather than `RipWarning`s, deliberately. The kind
   * is a fold-time discriminator (`buildRipWarnings` switches on
   * it); by the time a warning reaches a card there is nothing
   * left to decide, and a UI that switched on the kind would be
   * a second place the wording lived.
   */
  warnings: string[]
  /** Final destination, once known. */
  destinationPath: string | null
  /** Count of read errors seen so far. Non-zero blocks success. */
  readErrorCount: number
  /**
   * True when this job was adopted after a daemon restart.
   * An adopted process has no stdout stream, so it has no
   * health telemetry and its verdict is forced to `unknown`.
   */
  isAdopted: boolean
  /** Operator chose "keep trying" on a bad verdict (D4). */
  isKeepTryingRequested: boolean
}

export const EMPTY_PROGRESS: JobProgress = {
  totalFraction: 0,
  currentFraction: 0,
  totalLabel: null,
  currentLabel: null,
  fileIndex: null,
  fileCount: null,
  bytesWritten: 0,
  throughputBytesPerSec: null,
  etaSeconds: null,
  etaTrend: null,
}

/**
 * Which makemkvcon command produced a job.
 *
 * They report completion differently, and conflating them cost
 * us a 33 GB rip being declared a failure — see `isRipSuccessful`.
 */
export type RipMode = "backup" | "mkv"

/**
 * The success test.
 *
 * Exit code 0 is necessary and NOT sufficient: MakeMKV exits 0
 * having saved zero titles, and exits 0 after read errors it
 * merely logged. This is ARM's #1298 bug, and getting it right
 * is most of the reason this project exists.
 *
 * The two modes prove completion differently, and this function
 * originally knew only the `mkv` one:
 *
 *  - **mkv** emits `MSG:5004 "Copy complete. N titles saved."`,
 *    and N == 0 with exit 0 is the silent-success trap.
 *  - **backup** never emits 5004 at all. There are no "titles"
 *    to save — it writes a disc structure. Requiring a title
 *    count in backup mode makes EVERY successful backup report
 *    as a failure, which is exactly what happened on the first
 *    real rip: 24m29s, exit 0, zero read errors, a complete
 *    33 GB BDMV on disk, and `titlesSaved=null` -> FAILED.
 *
 * That false negative is the mirror image of #1298 and just as
 * bad: a tool that cries failure on good rips gets ignored on
 * the real ones. So backup proves itself structurally — the
 * output has to actually contain a disc — rather than by a
 * message, which is both mode-specific and locale-fragile.
 *
 * ## ⚠️ A read error is a WARNING here, not a failure
 *
 * This used to open `if (readErrorCount !== 0) return false`,
 * and on 2026-08-27 that line badged a perfect DVD `fail`: one
 * `MSG:2003` at offset 1 MB — the CSS handshake artefact every
 * protected DVD produces — against `Backup done` and an 8 GB
 * mountable ISO.
 *
 * Two separate fixes, and they must not be confused:
 *
 *  1. The CSS probe error is not a read error AT ALL, and is
 *     dropped before it reaches this function. See
 *     `isScrambledSectorError`.
 *  2. A GENUINE mid-disc read error on a backup that still
 *     produced a verified, plausible-size disc is a WARNING.
 *     The bytes are on the pool and the owner can use them; the
 *     ISO is merely suspect. Badging it `fail` says "there is no
 *     backup", which is false, and the owner then has to work
 *     out for himself which of the two it was.
 *
 * This is NOT a retreat to ARM's #1298. ARM reports read errors
 * as a plain success and says nothing. Rip Deck states the count
 * and the offsets, on the card and on the chip, in its own
 * colour — see `RipWarning`. The rule the project was built on
 * ("never report success on a rip that had read errors") becomes
 * "never report a rip that had read errors WITHOUT SAYING SO".
 *
 * A rip that produced NO verified output is still a failure,
 * read errors or not — nothing here softens that.
 */
export const isRipSuccessful = (input: {
  mode: RipMode
  exitCode: number | null
  titlesSaved: number | null
  /**
   * Genuine read errors only.
   *
   * No longer consulted — kept because it documents the input
   * the caller has, and because removing it would let a caller
   * silently stop counting. `summariseRip` turns a non-zero
   * count into a `RipWarning` instead.
   */
  readErrorCount: number
  /**
   * Backup only: the output directory holds a real disc
   * structure (BDMV/VIDEO_TS), or a real ISO image, of
   * plausible size.
   *
   * Evidence that bytes landed, independent of anything
   * makemkvcon said about itself.
   */
  hasVerifiedStructure?: boolean
  /**
   * MakeMKV said the backup failed — `MSG:5069` / `MSG:5080`.
   *
   * Declared here since the first version of this function and
   * fed by NOTHING until 2026-08-27. `observeOutcomeEvent` now
   * sets it, which matters far more than it used to: with the
   * read-error gate gone, this is the message half of the
   * failure test.
   */
  hasFailureMessage?: boolean
}): boolean => {
  if (input.exitCode !== 0) return false
  if (input.hasFailureMessage === true) return false

  return input.mode === "backup"
    ? input.hasVerifiedStructure === true
    : input.titlesSaved !== null && input.titlesSaved > 0
}
