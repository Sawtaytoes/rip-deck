import { readRunningArgvUuidsFromProc } from "./reaper.ts"
import type { BayPhase } from "./watcher.ts"

/**
 * "Which rips are running right now", asked ONCE.
 *
 * ⚠️ **Read this before adding a second answer.** Two places that
 * both decide whether a rip is live will disagree, and the one
 * that disagrees quietly is the one that deletes a rip. That is
 * not hypothetical here: `reaper.ts` guards `liveJobUuids` before
 * it removes a `.rip-deck-incomplete-<uuid>` directory, and
 * `leftovers.ts` — which offers the OPERATOR a Delete button over
 * the same directories — had no such guard at all. A rip in
 * progress was listed in the panel as a deletable leftover with
 * its bytes still arriving.
 *
 * So this module is the single answer, and both readers take it:
 * the reaper's caller passes its `jobUuids` as `liveJobUuids`,
 * and the leftovers endpoint passes the whole `LiveRips` value.
 *
 * ## Two pieces of evidence, not two opinions
 *
 * `reaper.ts` already establishes liveness from two independent
 * places, and this keeps both, for the reasons its header gives:
 *
 *  1. **The watcher's bay table.** A bay in `starting` or
 *     `ripping` is CLAIMED — `watcher.ts` and `trayCommand.ts`
 *     both refuse to touch a drive in those two phases, and
 *     `mqtt/activity.ts` counts the same pair as an active rip.
 *     Definitive while this daemon owns the rip.
 *  2. **`/proc/<pid>/cmdline`.** `makemkvcon` is handed the
 *     incomplete directory, so the uuid is in its argv verbatim.
 *     This is the evidence that survives a daemon RESTART, which
 *     the bay table does not: nothing re-adopts a running ripper
 *     child today, so a restart mid-rip leaves the bay table
 *     empty while the child keeps writing.
 *
 * Note the asymmetry `reaper.ts` names: a match PROVES live, and
 * no match proves nothing. That is why neither is used alone, and
 * why the failure to read either one is `isKnown: false` rather
 * than an empty set.
 *
 * ## Unknown is a state, not a zero
 *
 * "No job claims this uuid" and "we could not find out which jobs
 * exist" are different facts, and reading the second as the first
 * is exactly how a live rip becomes a deletable row. `LiveRips`
 * therefore has an `isKnown: false` arm carrying the reason, and
 * every caller must fail closed on it. This is `reaper.ts`'s
 * guard 2 — *"the job index is complete"* — as a type rather than
 * as a boolean somebody has to remember to check.
 */
export type LiveRips =
  | {
      isKnown: true
      /** Job uuids with a ripper running against them. */
      jobUuids: ReadonlySet<string>
    }
  | {
      isKnown: false
      /** Why not, said in a clause a refusal can quote. */
      reason: string
    }

/** Read on demand, never on the 5-second snapshot path. */
export type LiveRipsReader = () => Promise<LiveRips>

/**
 * Nothing is running, and we KNOW nothing is running.
 *
 * For tests and for a fixture server. Deliberately not the
 * default anywhere: a default of "all clear" is the one value
 * that turns a forgotten argument into a deleted rip.
 */
export const NO_LIVE_RIPS: LiveRips = {
  isKnown: true,
  jobUuids: new Set<string>(),
}

export const unknownLiveRips = (
  reason: string,
): LiveRips => ({ isKnown: false, reason })

/**
 * The bay phases in which a ripper is, or is about to be,
 * writing into `.rip-deck-incomplete-<uuid>`.
 *
 * `starting` is in the set even though its ripper child has not
 * been spawned yet. `prepareDestination` creates the incomplete
 * directory BEFORE the spawn, and `applyRipStarted` flips the
 * phase to `ripping` after it, so the window between them is a
 * real directory belonging to a real rip with no process behind
 * it. Both other readings of a claimed bay — `watcher.ts`'s
 * "already starting" hold and `trayCommand.ts`'s eject refusal —
 * name the same pair.
 */
const CLAIMED_BAY_PHASES: ReadonlySet<BayPhase> =
  new Set<BayPhase>(["ripping", "starting"])

/** One bay, reduced to the two fields this question needs. */
export type BayClaim = {
  phase: BayPhase
  /** The rip this bay is running, or the last one it ran. */
  jobUuid: string | null
}

/**
 * The uuids claimed by a bay that is mid-rip.
 *
 * ⚠️ **The phase filter is the whole function.** `BayState.jobUuid`
 * SURVIVES the outcome latch — deliberately, so a finished disc's
 * card can still offer its `<uuid>.robot.log` — so a bay's uuid
 * alone says "this bay ran that rip at some point", not "that rip
 * is running". Taking it unfiltered would lock the panel against
 * the one folder the operator most wants to clear: the leftover
 * of the rip that just failed in that very bay.
 */
export const liveJobUuidsFromBays = (
  bays: readonly BayClaim[],
): ReadonlySet<string> => {
  const jobUuids = new Set<string>()

  for (const bay of bays) {
    if (!CLAIMED_BAY_PHASES.has(bay.phase)) continue
    if (bay.jobUuid === null) continue

    jobUuids.add(bay.jobUuid)
  }

  return jobUuids
}

export type LiveRipsDeps = {
  /**
   * Uuids visible in running processes' argv.
   *
   * `reaper.ts`'s reader, shared rather than re-implemented —
   * the point of this module is that there is one answer. It
   * THROWS when `/proc` itself cannot be listed, which is
   * correct and is why the reader below catches it into
   * `isKnown: false` instead of into an empty set.
   */
  readRunningArgvUuids: () => Promise<ReadonlySet<string>>
}

const defaultDeps: LiveRipsDeps = {
  readRunningArgvUuids: async () =>
    await readRunningArgvUuidsFromProc(),
}

/**
 * The reader the API is handed.
 *
 * `readBays` is a getter returning null rather than a bay table
 * passed by value, for the same reason `readTrayRunner` is: the
 * API server is brought up BEFORE the watcher exists, so a
 * request landing in that startup window has no table to read.
 * Null there means UNKNOWN — the panel then refuses to touch an
 * unfinished rip folder for a second or two, which is the right
 * way round.
 */
export const createLiveRipsReader = (
  input: {
    readBays: () => readonly BayClaim[] | null
  },
  deps: LiveRipsDeps = defaultDeps,
): LiveRipsReader => {
  return async () => {
    const bays = input.readBays()

    if (bays === null) {
      return unknownLiveRips(
        "the disc watcher has not finished starting, so " +
          "nothing here knows which bays are mid-rip",
      )
    }

    let argvUuids: ReadonlySet<string>

    try {
      argvUuids = await deps.readRunningArgvUuids()
    } catch (error) {
      return unknownLiveRips(
        "the running processes could not be listed " +
          `(${error instanceof Error ? error.message : String(error)})`,
      )
    }

    return {
      isKnown: true,
      jobUuids: new Set([
        ...liveJobUuidsFromBays(bays),
        ...argvUuids,
      ]),
    }
  }
}
