import {
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises"
import { join } from "node:path"
import { parseProcCmdline } from "./orphan.ts"

/**
 * Cleaning up `.rip-deck-incomplete-*` that nothing else will.
 *
 * Read the constraint before the code, because the obvious
 * implementation of this file destroys data.
 *
 * D4 says **failed rips KEEP their partial output** — cleanup is
 * the operator's "give up", not ours. And the tower runs NINE
 * drives concurrently, so at any instant there can legitimately
 * be nine `.rip-deck-incomplete-<uuid>` directories being written
 * to right now. A reaper that matched on the name alone would
 * therefore delete, with equal enthusiasm, an in-flight 90 GB
 * UHD rip and the evidence the owner deliberately kept.
 *
 * So the question this file answers is never "does this look
 * incomplete" — every candidate does, that is what the prefix
 * means. It is "can we POSITIVELY establish that this is
 * ABANDONED", and unless every one of the guards below says yes,
 * the answer is no. Fail closed on ambiguity.
 *
 * The guards, and what each one alone cannot do:
 *
 *  1. **The name parses.** `.rip-deck-incomplete-<uuid>` exactly,
 *     a real directory, directly in the destination root. Proves
 *     only that we made it.
 *  2. **The job index is complete.** If the caller could not
 *     enumerate its jobs, "no job claims this uuid" and "we do
 *     not know which jobs exist" are indistinguishable, and the
 *     second one must never be read as the first. Unknown means
 *     reap nothing at all.
 *  3. **No job claims the uuid.** Neither running (would be a
 *     live rip) nor kept (would be D4 evidence). `liveJobUuids`
 *     comes from `liveRips.ts`, which is the ONE answer to "is
 *     this rip live" — the leftovers panel asks it too, and two
 *     implementations of that question is how the panel came to
 *     offer a running rip as a deletable row
 *     ([decision](../../../../docs/decisions/2026-08-27-a-leftover-control-refuses-a-live-rip.md)).
 *  4. **No running process has the uuid in its argv.** This is
 *     the guard that survives a daemon restart which lost its
 *     job table: it asks the kernel, not our bookkeeping, and
 *     `rip/orphan.ts` already establishes liveness this way.
 *     Note the asymmetry — a match PROVES live, but no match
 *     does not prove dead, which is exactly why it is one guard
 *     among several and never the only one.
 *  5. **Nothing in the tree has been touched recently.** The
 *     newest mtime anywhere beneath it, not the directory's own:
 *     a directory's mtime only moves when entries are added or
 *     removed, so a rip spending two hours writing one enormous
 *     M2TS looks untouched from the top.
 *
 * And then it still does not delete anything, because deleting
 * is opt-in per call — see `reapIncompleteDirectories`.
 */

const INCOMPLETE_PREFIX = ".rip-deck-incomplete-"

/**
 * A week, and deliberately far longer than any rip.
 *
 * The stale window is a backstop for uuids the job index has
 * never heard of — a crash before the job row was written, or
 * leftovers from an older install. Those cases have no upper
 * bound we can reason about, so the window is sized against the
 * thing we CAN bound: the longest plausible rip is hours, and
 * nine of them in parallel is still hours. Seven days is far
 * outside that and costs nothing but disk we were not going to
 * reclaim today anyway.
 */
export const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/** `.rip-deck-incomplete-<uuid>` -> `<uuid>`, or `null`. */
export const parseIncompleteDirName = (
  name: string,
): string | null => {
  if (!name.startsWith(INCOMPLETE_PREFIX)) return null

  const jobUuid = name.slice(INCOMPLETE_PREFIX.length)

  // A bare `.rip-deck-incomplete-` claims no job, so no job can
  // ever disown it. That is unresolvable, not abandoned.
  return jobUuid.length > 0 ? jobUuid : null
}

export type IncompleteDirectory = {
  path: string
  name: string
  jobUuid: string
  /** Newest mtime anywhere in the tree, not the directory's. */
  newestMtimeMs: number
}

export type ReapVerdict =
  | { isAbandoned: true }
  | { isAbandoned: false; reason: string }

export type ReapJudgement = {
  directory: IncompleteDirectory
  verdict: ReapVerdict
}

/**
 * The whole safety argument, as one pure function.
 *
 * Every input is data, and the caller owns all the I/O, so the
 * nine-concurrent-rips case is a unit test rather than a thing
 * we find out about on the pool.
 */
export const judgeIncompleteDirectory = (input: {
  directory: IncompleteDirectory
  /** Jobs the daemon believes are running right now. */
  liveJobUuids: ReadonlySet<string>
  /** Jobs whose partial output D4 says to keep. */
  keepJobUuids: ReadonlySet<string>
  /** False when the job index could not be read. Guard 2. */
  hasCompleteJobIndex: boolean
  /** Uuids appearing in any running process's argv. Guard 4. */
  runningArgvUuids: ReadonlySet<string>
  nowMs: number
  minAgeMs: number
}): ReapVerdict => {
  const { directory } = input

  if (!input.hasCompleteJobIndex) {
    return {
      isAbandoned: false,
      reason:
        "The job index could not be read, so nothing can be " +
        "shown to be unclaimed. Refusing to reap anything.",
    }
  }

  if (input.liveJobUuids.has(directory.jobUuid)) {
    return {
      isAbandoned: false,
      reason: `Job ${directory.jobUuid} is running.`,
    }
  }

  if (input.keepJobUuids.has(directory.jobUuid)) {
    return {
      isAbandoned: false,
      reason:
        `Job ${directory.jobUuid} failed and its partial ` +
        `output is being kept on purpose (D4). Only the ` +
        `operator gives up on a rip.`,
    }
  }

  if (input.runningArgvUuids.has(directory.jobUuid)) {
    return {
      isAbandoned: false,
      reason:
        `A running process still has ${directory.jobUuid} in ` +
        `its argv, so something is writing here even though ` +
        `no job claims it.`,
    }
  }

  const ageMs = input.nowMs - directory.newestMtimeMs

  // Checked before the window, not after, because a future or
  // unreadable mtime is not merely "recent" — it means the age
  // is not a number we are entitled to reason about at all.
  // `Infinity` is what an unreadable entry reports.
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      isAbandoned: false,
      reason:
        "Its newest mtime is unreadable or in the future, so " +
        "nothing here can be shown to be old.",
    }
  }

  if (ageMs < input.minAgeMs) {
    return {
      isAbandoned: false,
      reason:
        `Something in it changed ${hours(ageMs)} ago, inside ` +
        `the ${hours(input.minAgeMs)} stale window.`,
    }
  }

  return { isAbandoned: true }
}

export type ReaperDeps = {
  /**
   * Uuids visible in running processes' argv.
   *
   * Injected so tests never depend on what happens to be running
   * on the machine running them.
   */
  readRunningArgvUuids: () => Promise<ReadonlySet<string>>
}

const defaultDeps: ReaperDeps = {
  readRunningArgvUuids: async () =>
    await readRunningArgvUuidsFromProc(),
}

export type ReapReport = {
  judgements: ReapJudgement[]
  /** Directories actually unlinked. Empty unless opted in. */
  deletedPaths: string[]
  /** Paths whose delete threw, with the reason. */
  failures: { path: string; reason: string }[]
  isDeleteEnabled: boolean
}

/**
 * Report on — and only on explicit request, delete — abandoned
 * partial output.
 *
 * `isDeleteEnabled` is a required argument with no default and
 * no environment variable behind it. An env var is a thing
 * somebody sets once while debugging and never unsets, and the
 * failure mode of this particular switch being left on is
 * unrecoverable data loss, so the opt-in has to be visible at
 * the call site every time.
 */
export const reapIncompleteDirectories = async (
  input: {
    rootPath: string
    liveJobUuids: ReadonlySet<string>
    keepJobUuids: ReadonlySet<string>
    hasCompleteJobIndex: boolean
    isDeleteEnabled: boolean
    nowMs?: number
    minAgeMs?: number
  },
  deps: ReaperDeps = defaultDeps,
): Promise<ReapReport> => {
  const nowMs = input.nowMs ?? Date.now()
  const minAgeMs = input.minAgeMs ?? DEFAULT_MIN_AGE_MS

  const directories = await findIncompleteDirectories(
    input.rootPath,
  )

  // Only asked for once the candidates are known, so a run with
  // nothing to consider does not walk /proc at all.
  const runningArgvUuids =
    directories.length === 0
      ? new Set<string>()
      : await deps.readRunningArgvUuids()

  const judgements = directories.map((directory) => ({
    directory,
    verdict: judgeIncompleteDirectory({
      directory,
      liveJobUuids: input.liveJobUuids,
      keepJobUuids: input.keepJobUuids,
      hasCompleteJobIndex: input.hasCompleteJobIndex,
      runningArgvUuids,
      nowMs,
      minAgeMs,
    }),
  }))

  const deletedPaths: string[] = []
  const failures: { path: string; reason: string }[] = []

  if (input.isDeleteEnabled) {
    for (const judgement of judgements) {
      if (!judgement.verdict.isAbandoned) continue

      try {
        await rm(judgement.directory.path, {
          recursive: true,
          // No `force`: a directory that vanished under us
          // between the judgement and the delete means the world
          // moved, and that is worth surfacing rather than
          // shrugging at.
          force: false,
        })
        deletedPaths.push(judgement.directory.path)
      } catch (error) {
        failures.push({
          path: judgement.directory.path,
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        })
      }
    }
  }

  return {
    judgements,
    deletedPaths,
    failures,
    isDeleteEnabled: input.isDeleteEnabled,
  }
}

/**
 * Candidates directly under the destination root.
 *
 * Not recursive: the only place `prepareDestination` ever makes
 * one of these is the root itself, so a match found deeper is
 * something we did not create and has no business being trusted
 * to our naming convention.
 */
export const findIncompleteDirectories = async (
  rootPath: string,
): Promise<IncompleteDirectory[]> => {
  const entries = await readdir(rootPath, {
    withFileTypes: true,
  })

  const directories: IncompleteDirectory[] = []

  for (const entry of entries) {
    // `isDirectory()` here is readdir's own entry type, which
    // does not follow symlinks — a symlink named like a
    // candidate is not one.
    if (!entry.isDirectory()) continue

    const jobUuid = parseIncompleteDirName(entry.name)
    if (jobUuid === null) continue

    const path = join(rootPath, entry.name)

    directories.push({
      path,
      name: entry.name,
      jobUuid,
      newestMtimeMs: await findNewestMtimeMs(path),
    })
  }

  return directories
}

/**
 * The newest mtime anywhere in the tree, root included.
 *
 * An unreadable entry yields `Infinity` — "as recently modified
 * as it is possible to be" — so anything we cannot inspect
 * survives the staleness guard rather than sliding under it.
 */
export const findNewestMtimeMs = async (
  path: string,
): Promise<number> => {
  const stats = await statOrNull(path)
  if (stats === null) return Number.POSITIVE_INFINITY
  if (!stats.isDirectory()) return stats.mtimeMs

  const entries = await readdirOrNull(path)
  if (entries === null) return Number.POSITIVE_INFINITY

  let newestMtimeMs = stats.mtimeMs

  for (const entry of entries) {
    newestMtimeMs = Math.max(
      newestMtimeMs,
      await findNewestMtimeMs(join(path, entry.name)),
    )
  }

  return newestMtimeMs
}

const statOrNull = async (path: string) => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

const readdirOrNull = async (path: string) => {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return null
  }
}

/**
 * Every `.rip-deck-incomplete-<uuid>` mentioned by a live argv.
 *
 * `makemkvcon` is told to write to the incomplete directory, so
 * the uuid is in its argv verbatim — the same property
 * `rip/orphan.ts` leans on for adoption. Any read failure is
 * ignored per-process (processes exit while /proc is being
 * walked, and that is normal), but a failure to list /proc at
 * all propagates: silently returning an empty set would look
 * exactly like "nothing is running", which is the one wrong
 * answer this function can give.
 */
export const readRunningArgvUuidsFromProc = async (
  procPath = "/proc",
): Promise<ReadonlySet<string>> => {
  const entries = await readdir(procPath)
  const uuids = new Set<string>()

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue

    let cmdline: string
    try {
      cmdline = await readFile(
        join(procPath, entry, "cmdline"),
        "utf8",
      )
    } catch {
      continue
    }

    for (const argument of parseProcCmdline(cmdline)) {
      for (const jobUuid of uuidsInArgument(argument)) {
        uuids.add(jobUuid)
      }
    }
  }

  return uuids
}

/**
 * The uuid part of any incomplete-directory path in one argv
 * entry, whatever it is nested inside — makemkvcon is handed the
 * container-side path (`incompleteInnerPath`), which shares only
 * the directory name with ours.
 */
const uuidsInArgument = (argument: string): string[] => {
  const found: string[] = []

  for (const segment of argument.split(/[/\s]/)) {
    const jobUuid = parseIncompleteDirName(segment)
    if (jobUuid !== null) found.push(jobUuid)
  }

  return found
}

const hours = (ms: number): string =>
  `${Math.round(ms / (60 * 60 * 1_000))}h`
