import {
  type FailureReason,
  isMakemkvPrompt,
  isRipSuccessful,
  type MakemkvEvent,
  MakemkvMsgCode,
  parseTitlesSaved,
  type RipMode,
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
  /** SCSI read errors reported by MakeMKV (MSG:2003). */
  readErrorCount: number
  /** Error offsets as sector numbers, for scratch-vs-dirt. */
  errorLbas: number[]
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

  if (event.code === MakemkvMsgCode.READ_ERROR) {
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

  const summary = (
    failureReason: FailureReason | null,
  ): RipSummary => ({
    isSuccessful: failureReason === null,
    failureReason,
    titlesSaved,
    readErrorCount,
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
