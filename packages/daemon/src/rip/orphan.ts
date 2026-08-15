import { readFile } from "node:fs/promises"
import { hashArgv } from "./ripCommand.ts"

/**
 * Adopting a `makemkvcon` that outlived the daemon (E6).
 *
 * A restart mid-rip leaves a live child with no parent. Killing
 * it throws away an hour of reading; leaving it unclaimed means
 * a phantom row and a drive nobody will touch again. So we adopt
 * it — but only when we can prove it is OUR process.
 *
 * PID alone is emphatically not proof. PIDs are recycled, and on
 * a busy NAS the window is small; adopting the wrong process
 * would attribute a stranger's lifetime to our job and, worse,
 * hand us a PID we would later kill on the operator's behalf.
 *
 * So all THREE guards must agree:
 *
 *  1. `/proc/<pid>` still exists.
 *  2. `/proc/<pid>/stat` field 22 — the process start time in
 *     clock ticks since boot — equals what we recorded. This is
 *     the one that closes the PID-reuse hole: a recycled PID has
 *     a different start time, always.
 *  3. The argv hash matches. The argv contains the output
 *     directory, whose UUID is unique to this job, so a match
 *     cannot be coincidence.
 */

/**
 * Field 22 of `/proc/<pid>/stat`: start time in clock ticks.
 *
 * Parsed by finding the LAST `)` rather than splitting on
 * whitespace, because field 2 is the executable name in
 * parentheses and it may itself contain spaces and parentheses.
 * Naive splitting is a real and well-known bug here, and it
 * would silently shift every subsequent field.
 */
export const parseProcStartTime = (
  statContent: string,
): number | null => {
  const lastParen = statContent.lastIndexOf(")")
  if (lastParen === -1) return null

  // Fields after the closing paren begin at field 3, so field 22
  // is index 19 of what follows.
  const fields = statContent
    .slice(lastParen + 1)
    .trim()
    .split(/\s+/)

  const START_TIME_INDEX = 19
  if (fields.length <= START_TIME_INDEX) return null

  const parsed = Number.parseInt(
    fields[START_TIME_INDEX],
    10,
  )
  return Number.isFinite(parsed) ? parsed : null
}

/** `/proc/<pid>/cmdline` is NUL-separated, with a trailing NUL. */
export const parseProcCmdline = (
  cmdlineContent: string,
): string[] =>
  cmdlineContent
    .split("\0")
    .filter((argument) => argument.length > 0)

export type OrphanClaim = {
  pid: number
  /** `/proc/<pid>/stat` field 22, recorded at spawn. */
  startTimeTicks: number
  argvHash: string
  /** Total fraction complete when we last heard from it. */
  lastTotalFraction: number
}

export type AdoptionVerdict =
  | { isAdoptable: true }
  | { isAdoptable: false; reason: string }

/**
 * Only adopt past the halfway mark.
 *
 * Below it, re-ripping from scratch costs less than the risk of
 * nursing a process whose telemetry we have permanently lost —
 * and we HAVE lost it: the adopted process's stdout went to a
 * pipe that died with the old daemon, so there is no event
 * stream, no progress and no health signal for the remainder.
 * That is why an adopted job's verdict is forced to `unknown`
 * rather than optimistically carried over.
 */
export const ADOPTION_MIN_FRACTION = 0.5

export type AdoptionDeps = {
  readProcFile: (
    pid: number,
    file: "stat" | "cmdline",
  ) => Promise<string | null>
}

const defaultDeps: AdoptionDeps = {
  readProcFile: async (pid, file) => {
    try {
      return await readFile(`/proc/${pid}/${file}`, "utf8")
    } catch {
      // A missing /proc entry is the normal case for a process
      // that exited, not an error worth propagating.
      return null
    }
  },
}

export const canAdoptOrphan = async (
  claim: OrphanClaim,
  deps: AdoptionDeps = defaultDeps,
): Promise<AdoptionVerdict> => {
  if (claim.lastTotalFraction < ADOPTION_MIN_FRACTION) {
    return {
      isAdoptable: false,
      reason:
        `Only ${Math.round(claim.lastTotalFraction * 100)}% ` +
        `complete. Below ` +
        `${ADOPTION_MIN_FRACTION * 100}% it is cheaper and ` +
        `safer to re-rip than to adopt a process we have no ` +
        `telemetry for.`,
    }
  }

  // Guard 1.
  const statContent = await deps.readProcFile(
    claim.pid,
    "stat",
  )
  if (statContent === null) {
    return {
      isAdoptable: false,
      reason: `No process ${claim.pid} — it exited.`,
    }
  }

  // Guard 2. The PID-reuse guard.
  const startTimeTicks = parseProcStartTime(statContent)
  if (startTimeTicks === null) {
    return {
      isAdoptable: false,
      reason: `Could not read the start time of ${claim.pid}.`,
    }
  }

  if (startTimeTicks !== claim.startTimeTicks) {
    return {
      isAdoptable: false,
      reason:
        `PID ${claim.pid} has been reused — its start time is ` +
        `${startTimeTicks}, ours was ${claim.startTimeTicks}. ` +
        `This is a different process.`,
    }
  }

  // Guard 3.
  const cmdlineContent = await deps.readProcFile(
    claim.pid,
    "cmdline",
  )
  if (cmdlineContent === null) {
    return {
      isAdoptable: false,
      reason: `Could not read the argv of ${claim.pid}.`,
    }
  }

  const argvHash = hashArgv(
    parseProcCmdline(cmdlineContent),
  )
  if (argvHash !== claim.argvHash) {
    return {
      isAdoptable: false,
      reason:
        `PID ${claim.pid} is running a different command ` +
        `(${argvHash}, expected ${claim.argvHash}).`,
    }
  }

  return { isAdoptable: true }
}
