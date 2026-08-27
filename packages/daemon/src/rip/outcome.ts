import {
  type FailureReason,
  isBackupCompleteMessage,
  isBackupFailureMessage,
  isHashCheckFailureMessage,
  isMakemkvPrompt,
  isRipSuccessful,
  isScrambledSectorError,
  type MakemkvEvent,
  MakemkvMsgCode,
  parseTitlesSaved,
  type RipMode,
  type RipWarning,
} from "@rip-deck/contracts"

/**
 * Deciding whether a rip actually worked.
 *
 * This is the reason the project exists. `makemkvcon` exits 0
 * after saving zero titles, and exits 0 after read errors it
 * merely logged — so an exit-code check reports success on a
 * corrupt or empty rip. That is ARM's #1298, open eighteen
 * months, and it is why `isRipSuccessful` takes three inputs
 * instead of one.
 *
 * Everything here is a pure fold over parsed events, so the
 * decision can be replayed from a captured log and asserted
 * exactly, without a disc.
 */

export type RipObservations = {
  /** From MSG:5004. Null until the copy reports completion. */
  titlesSaved: number | null
  /**
   * GENUINE SCSI read errors reported by MakeMKV (MSG:2003).
   *
   * ⚠️ Excludes the CSS handshake probe — see `hasBackupStarted`
   * and `cssProbeErrorCount`. This is the count a warning is
   * written from, so a number here means the disc really did
   * refuse to give up a sector.
   */
  readErrorCount: number
  /** Error offsets as sector numbers, for scratch-vs-dirt. */
  errorLbas: number[]
  /**
   * The copy has begun — `MSG:5072`, "Backing up disc into
   * folder …".
   *
   * The divider that makes a read error mean something. Before
   * it, MakeMKV is still opening the disc and negotiating the
   * key; after it, every byte it reads is a byte it is copying.
   */
  hasBackupStarted: boolean
  /**
   * CSS probe errors that were NOT counted as read errors.
   *
   * Recorded rather than silently dropped, because "we saw one
   * and deliberately ignored it" and "there were none" are
   * different facts and only one of them is normal for a
   * protected DVD. Nothing acts on it; it exists so a capture
   * can be audited against the rule.
   */
  cssProbeErrorCount: number
  /** MakeMKV said so itself — `MSG:5070` / `MSG:5081`. */
  hasBackupCompleted: boolean
  /** MakeMKV said the backup FAILED — `MSG:5069` / `MSG:5080`. */
  hasFailureMessage: boolean
  /** `MSG:5085` — MakeMKV is hash-verifying this backup itself. */
  hasContentHashTable: boolean
  /**
   * MakeMKV's own hash check reported corrupt files.
   *
   * Matched by text; see `isHashCheckFailureMessage` for why the
   * code is not known yet.
   */
  hasHashCheckFailure: boolean
  /** MSG 5021 / 5052 / 5055 — the key needs refreshing (D8). */
  hasKeyExpired: boolean
  /**
   * The question makemkvcon asked, if it asked one.
   *
   * BOXYESNO means it is blocked waiting for an answer that a
   * robot-mode pipe will never supply. Recording the text is the
   * whole point: without it the job just looks hung, and the one
   * piece of information that would explain it is lost.
   */
  interactivePrompt: string | null
  /** Malformed lines seen, as a parser-health signal. */
  malformedLineCount: number
}

export const createRipObservations =
  (): RipObservations => ({
    titlesSaved: null,
    readErrorCount: 0,
    errorLbas: [],
    hasBackupStarted: false,
    cssProbeErrorCount: 0,
    hasBackupCompleted: false,
    hasFailureMessage: false,
    hasContentHashTable: false,
    hasHashCheckFailure: false,
    hasKeyExpired: false,
    interactivePrompt: null,
    malformedLineCount: 0,
  })

/** Bytes per optical sector, for offset -> LBA conversion. */
const SECTOR_BYTES = 2048

/**
 * Best-effort LBA for a read error.
 *
 * MakeMKV reports a byte offset inside the disc image rather
 * than an LBA, and which parameter carries it varies by message
 * format, so the largest plausible integer wins. This feeds the
 * scratch-vs-dirt clustering, which cares about whether errors
 * bunch together — so an approximate sector is useful and a
 * wrong one is merely noise, never a wrong verdict on its own.
 */
export const parseReadErrorLba = (
  params: string[],
): number | null => {
  let best: number | null = null

  for (const param of params) {
    // Anchored so a value with trailing junk is rejected rather
    // than silently truncated to its numeric prefix.
    if (!/^\d+$/.test(param.trim())) continue

    const parsed = Number.parseInt(param.trim(), 10)
    if (!Number.isSafeInteger(parsed)) continue

    if (best === null || parsed > best) best = parsed
  }

  // Small integers are counters and codes, not disc offsets.
  return best === null || best < SECTOR_BYTES
    ? null
    : Math.floor(best / SECTOR_BYTES)
}

const KEY_PROBLEM_CODES: readonly number[] = [
  MakemkvMsgCode.KEY_EXPIRED,
  MakemkvMsgCode.KEY_INVALID,
  MakemkvMsgCode.KEY_BETA_EXPIRED,
]

/** Fold one parsed event into the observations. */
export const observeOutcomeEvent = (input: {
  observations: RipObservations
  event: MakemkvEvent
}): RipObservations => {
  const { observations, event } = input

  if (event.type === "MALFORMED") {
    return {
      ...observations,
      malformedLineCount:
        observations.malformedLineCount + 1,
    }
  }

  if (event.type !== "MSG") return observations

  // Checked before the code switch: the prompt is identified by
  // its flags, and it can arrive on any message code.
  if (
    isMakemkvPrompt(event) &&
    observations.interactivePrompt === null
  ) {
    return {
      ...observations,
      interactivePrompt: event.message,
    }
  }

  if (KEY_PROBLEM_CODES.includes(event.code)) {
    return { ...observations, hasKeyExpired: true }
  }

  // The copy has begun. Recorded BEFORE the read-error branch,
  // so a read error carried on the same line as the divider
  // could never be mistaken for a pre-backup one — MakeMKV does
  // not do that, and the ordering costs nothing.
  if (event.code === MakemkvMsgCode.BACKUP_STARTED) {
    return { ...observations, hasBackupStarted: true }
  }

  if (isBackupCompleteMessage(event)) {
    return { ...observations, hasBackupCompleted: true }
  }

  if (isBackupFailureMessage(event)) {
    return { ...observations, hasFailureMessage: true }
  }

  if (
    event.code === MakemkvMsgCode.BACKUP_HASH_TABLE_LOADED
  ) {
    return { ...observations, hasContentHashTable: true }
  }

  // Checked before READ_ERROR because the hash-check messages
  // are matched by text and their codes are unknown — one of
  // them could turn out to BE 2003's neighbour, and a corrupt
  // file is a stronger fact than a sector that would not read.
  if (isHashCheckFailureMessage(event)) {
    return { ...observations, hasHashCheckFailure: true }
  }

  if (event.code === MakemkvMsgCode.READ_ERROR) {
    // The CSS handshake artefact: a scrambled-sector complaint
    // raised before the copy started. Every protected DVD makes
    // one and every one of them is benign, so it is recorded
    // and NOT counted. Both halves of the test must hold — see
    // `isScrambledSectorError`.
    if (
      !observations.hasBackupStarted &&
      isScrambledSectorError(event)
    ) {
      return {
        ...observations,
        cssProbeErrorCount:
          observations.cssProbeErrorCount + 1,
      }
    }

    const lba = parseReadErrorLba(event.params)

    return {
      ...observations,
      readErrorCount: observations.readErrorCount + 1,
      errorLbas:
        lba === null
          ? observations.errorLbas
          : [...observations.errorLbas, lba],
    }
  }

  if (event.code === MakemkvMsgCode.COPY_COMPLETE) {
    return {
      ...observations,
      titlesSaved: parseTitlesSaved(event),
    }
  }

  return observations
}

/**
 * Why the child stopped, as known from OUTSIDE the event stream.
 *
 * Kept separate from the observations because these are things
 * only the supervisor can know — makemkvcon cannot tell us that
 * the operator cancelled, or that the drive vanished off the USB
 * bus underneath it.
 */
export type RipTermination =
  | "exited"
  | "cancelled_by_operator"
  | "stall_timeout"
  | "disc_removed"
  | "drive_disappeared"
  | "wrong_drive"
  | "insufficient_space"
  | "daemon_restart"

export type RipSummary = {
  isSuccessful: boolean
  failureReason: FailureReason | null
  titlesSaved: number | null
  readErrorCount: number
  /**
   * Trouble worth reporting on a rip that still worked.
   *
   * The third state. Empty means a clean rip; non-empty on a
   * successful one is the `warning` badge, and non-empty on a
   * failed one is extra context under the failure reason.
   */
  warnings: RipWarning[]
}

/** How many error offsets a warning sentence will name. */
const MAX_LISTED_OFFSETS = 5

/** Bytes -> a short human string, e.g. "3.4 GB". */
const formatOffset = (lba: number): string => {
  const bytes = lba * SECTOR_BYTES
  const gb = bytes / 1024 ** 3

  return gb >= 1
    ? `${gb.toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * The read-error sentence, offsets and all.
 *
 * ## Why it refuses to say whether MakeMKV recovered
 *
 * The owner asked for exactly that: *"I'd like to know if there
 * are read errors, but I'd also wanna know if MakeMKV was able
 * to work around it or fix it. It has that capability
 * sometimes."*
 *
 * **Robot mode does not carry the answer, and this must not
 * pretend otherwise.** The message catalogue compiled into the
 * `libmakemkv.so.1` this image ships (MakeMKV 1.18.4) was read
 * end to end on 2026-08-27 for any retry, recovery, re-read or
 * zero-fill message. There is none. `MSG:2003` is emitted once
 * per failed read and nothing afterwards ever refers back to it;
 * the only aggregate is "Encountered %1 errors of type '%2'",
 * which counts them again rather than resolving them.
 *
 * So a warning states the fact and states the gap. Inventing a
 * "recovered" signal out of "the backup finished anyway" would
 * be the confidently-wrong reading the whole verdict model
 * exists to prevent — a backup finishes whether MakeMKV re-read
 * the sector successfully or wrote zeros over it.
 *
 * There IS one real integrity signal, and it is separate:
 * `MSG:5085` means MakeMKV loaded a content hash table and is
 * verifying the copy itself. When that happened and no hash
 * failure followed, the sentence says so — that is MakeMKV's own
 * check passing, not an inference of ours. It is Blu-ray only; a
 * DVD has no hash table, so on a DVD the honest answer stays
 * "cannot tell".
 */
export const buildRipWarnings = (
  observations: RipObservations,
): RipWarning[] => {
  const warnings: RipWarning[] = []

  if (observations.readErrorCount > 0) {
    const listed = observations.errorLbas
      .slice(0, MAX_LISTED_OFFSETS)
      .map(formatOffset)

    const where =
      listed.length === 0
        ? ""
        : ` at ${listed.join(", ")}` +
          (observations.errorLbas.length > listed.length
            ? ` and ${String(
                observations.errorLbas.length -
                  listed.length,
              )} more`
            : "")

    const recovery = observations.hasContentHashTable
      ? observations.hasHashCheckFailure
        ? " MakeMKV checked the copy against the disc's own " +
          "hash table and found corrupt files, so at least " +
          "one of these was NOT recovered."
        : " MakeMKV checked the copy against the disc's own " +
          "hash table and it passed, so the copy matches what " +
          "the disc says it should be."
      : " MakeMKV does not report whether it re-read those " +
        "sectors successfully or wrote them off, and robot " +
        "mode has no message that would say — so Rip Deck " +
        "cannot tell you which. Play the disc through before " +
        "you throw the original away."

    warnings.push({
      kind: "read_errors",
      message:
        `${String(observations.readErrorCount)} read ` +
        `error${observations.readErrorCount === 1 ? "" : "s"}` +
        `${where}. The backup finished and its structure ` +
        `verified, so there IS a copy — it may have damage ` +
        `in it.${recovery}`,
    })
  }

  if (
    observations.hasHashCheckFailure &&
    observations.readErrorCount === 0
  ) {
    warnings.push({
      kind: "hash_check_failed",
      message:
        "MakeMKV's own content-hash check found corrupt " +
        "files in this backup, even though the copy finished " +
        "and nothing failed to read. Treat this copy as " +
        "suspect and re-rip the disc if you can.",
    })
  }

  return warnings
}

/**
 * The final word on a rip.
 *
 * Reason precedence is deliberate and ordered most-explanatory
 * first, because the reason is what the owner reads on a phone:
 *
 *  1. An externally-known termination outranks everything — if
 *     we killed it, that is the reason, whatever the exit code.
 *  2. A key problem is next, because it makes every rip fail and
 *     mistaking it for a disc problem sends the owner to clean
 *     nine perfectly good discs (D8).
 *  3. Read errors outrank zero-titles, because when both are
 *     true the errors are the CAUSE and zero-titles is the
 *     symptom.
 *  4. Zero titles saved with no errors at all is its own
 *     distinct failure, and pointing at the disc would be wrong.
 *
 * ⚠️ Reason 3 is reached ONLY once the rip has already failed
 * the success test. Read errors no longer fail a rip by
 * themselves — a backup that verified is a success that carries
 * a `RipWarning` (see `isRipSuccessful`). What reason 3 still
 * does is name the better cause when there is genuinely no
 * output: "read_errors" explains an empty result and
 * "empty_output" does not.
 */
export const summariseRip = (input: {
  observations: RipObservations
  exitCode: number | null
  termination: RipTermination
  /**
   * Which command ran. Defaults to `backup` because that is the
   * only mode rip-deck currently drives (A1/A2 — never
   * transcode), and a default of `mkv` would silently reinstate
   * the title-count requirement that failed a good 33 GB rip.
   */
  mode?: RipMode
  /** Backup only: the output really holds a disc. */
  hasVerifiedStructure?: boolean
}): RipSummary => {
  const { observations, exitCode, termination } = input
  const { titlesSaved, readErrorCount } = observations

  const warnings = buildRipWarnings(observations)

  const summary = (
    failureReason: FailureReason | null,
  ): RipSummary => ({
    isSuccessful: failureReason === null,
    failureReason,
    titlesSaved,
    readErrorCount,
    warnings,
  })

  if (termination !== "exited") {
    return summary(terminationReason(termination))
  }

  // A prompt means it blocked on a question forever. Even if it
  // somehow exited 0 afterwards, the run was not unattended and
  // must not be trusted.
  if (observations.interactivePrompt !== null) {
    return summary("interactive_prompt")
  }

  if (observations.hasKeyExpired)
    return summary("key_expired")

  if (
    isRipSuccessful({
      mode: input.mode ?? "backup",
      exitCode,
      titlesSaved,
      readErrorCount,
      hasVerifiedStructure: input.hasVerifiedStructure,
      hasFailureMessage: observations.hasFailureMessage,
    })
  ) {
    return summary(null)
  }

  if (readErrorCount > 0) return summary("read_errors")

  if (titlesSaved !== null && titlesSaved === 0) {
    return summary("no_titles_saved")
  }

  // Backup mode reaching here means exit 0, no errors, nothing
  // makemkvcon complained about — and no disc on disk. That is
  // an empty output directory, not an unknown.
  if ((input.mode ?? "backup") === "backup") {
    return summary("empty_output")
  }

  return summary("unknown")
}

const terminationReason = (
  termination: Exclude<RipTermination, "exited">,
): FailureReason => {
  switch (termination) {
    case "cancelled_by_operator":
      return "cancelled_by_operator"
    case "stall_timeout":
      return "stall_timeout"
    case "disc_removed":
      return "disc_removed"
    case "drive_disappeared":
      return "drive_disappeared"
    case "wrong_drive":
      return "wrong_drive"
    case "insufficient_space":
      return "insufficient_space"
    case "daemon_restart":
      return "daemon_restart"
  }
}
