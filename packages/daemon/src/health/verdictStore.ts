import { readFile } from "node:fs/promises"
import type {
  Verdict,
  VerdictKind,
} from "@rip-deck/contracts"
import { computedVerdictPath } from "./sampleStore.ts"

/**
 * The engine's saved answer for a finished job, read back.
 *
 * `api/towerFeed.ts` used to read no engine output at all, and
 * stamped a placeholder `unknown` on every bay. That was correct
 * while the gate was a hand-written `false` — there was nothing
 * to show. With `publish.ts` opening on its own, there is, and
 * this is the way back to it.
 *
 * ## Why a file read, and not a new field on the bay
 *
 * The alternative was to carry `verdictKind` through `BayState`,
 * the bay ledger (a v3), the watcher's events and the feed. That
 * is four surfaces changed to move a fact that is already
 * written down, and the ledger version bump would have to be
 * survived by every deployed tower.
 *
 * `<jobUuid>.verdict.json` is already the authority, already
 * keyed by the id `towerFeed` holds, and already survives a
 * restart — which the ledger route would have had to reimplement.
 * Reading it is not scraping: it is a structured document this
 * repo writes, parsed as one. The rule it must not break is
 * `MSG:5072` — never recover structured data from an English
 * sentence — and nothing here touches prose.
 *
 * ## Never on the request path
 *
 * Modelled on `metadata/posterStore.ts`, for the same reason and
 * with the same shape. `request` returns at once and starts at
 * most one read; `get` is a synchronous `Map` lookup. The feed
 * calls both from the watcher's own poll, so `/json` never waits
 * for a disk read, and a job whose file has not landed yet is
 * simply `null` this poll and answered on the next one.
 */

export type ComputedVerdictStore = {
  /** Make sure this job's verdict has been read. Never blocks. */
  request: (input: { jobUuid: string }) => void
  /** A synchronous memory read. Null until an answer lands. */
  get: (input: { jobUuid: string }) => Verdict | null
}

/**
 * The store you get with no state directory.
 *
 * A null object rather than a flag, so no caller branches on
 * "is this wired up" — the same shape as
 * `createNullPosterStore` and `createNullSampleStore`.
 */
export const createNullComputedVerdictStore =
  (): ComputedVerdictStore => ({
    request: () => {},
    get: () => null,
  })

/**
 * How long a MISS is remembered before the file is looked for
 * again.
 *
 * A hit is cached forever: a sealed verdict never changes. A
 * miss must expire, because the normal reason for one is that
 * the rip has not finished writing yet — caching that answer
 * permanently would mean a bay that never showed its verdict
 * until the daemon restarted. Long enough that nine bays polling
 * every five seconds do not turn into a directory scan, short
 * enough to be invisible to somebody watching the card.
 */
const MISS_RETRY_MS = 30_000

export const createComputedVerdictStore = ({
  stateDir,
  now = () => Date.now(),
  read = (path: string) => readFile(path, "utf8"),
}: {
  stateDir: string
  now?: () => number
  /** Injected so a test never needs a real state directory. */
  read?: (path: string) => Promise<string>
}): ComputedVerdictStore => {
  const hits = new Map<string, Verdict>()
  const missedAtMs = new Map<string, number>()
  const inFlight = new Set<string>()

  return {
    request: ({ jobUuid }) => {
      if (jobUuid === "") return
      if (hits.has(jobUuid)) return
      if (inFlight.has(jobUuid)) return

      const missedAt = missedAtMs.get(jobUuid)

      if (
        missedAt !== undefined &&
        now() - missedAt < MISS_RETRY_MS
      ) {
        return
      }

      inFlight.add(jobUuid)

      void read(computedVerdictPath(stateDir, jobUuid))
        .then((text) => {
          const verdict = parseVerdict(text)

          if (verdict === null) {
            missedAtMs.set(jobUuid, now())

            return
          }

          hits.set(jobUuid, verdict)
          missedAtMs.delete(jobUuid)
        })
        // A missing or unreadable file is the ordinary case for
        // a rip still running, not an error worth a log line.
        .catch(() => {
          missedAtMs.set(jobUuid, now())
        })
        .finally(() => {
          inFlight.delete(jobUuid)
        })
    },

    get: ({ jobUuid }) => hits.get(jobUuid) ?? null,
  }
}

/**
 * The `verdict` field of a `ComputedJobVerdict` document.
 *
 * Shape-checked rather than cast. These files are written by
 * builds that may be months apart, and a document whose verdict
 * lost a field would otherwise reach the card as an object with
 * an undefined message — a blank alert with no way to tell it
 * from a real one.
 */
const parseVerdict = (text: string): Verdict | null => {
  try {
    const parsed: unknown = JSON.parse(text)

    if (typeof parsed !== "object" || parsed === null) {
      return null
    }

    const verdict = (parsed as { verdict?: unknown })
      .verdict

    return isVerdict(verdict) ? verdict : null
  } catch {
    return null
  }
}

const isVerdict = (value: unknown): value is Verdict => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const verdict = value as Partial<Verdict>

  return (
    typeof verdict.kind === "string" &&
    typeof verdict.action === "string" &&
    typeof verdict.subject === "string" &&
    typeof verdict.message === "string" &&
    (verdict.confidence === "suspected" ||
      verdict.confidence === "confirmed") &&
    Array.isArray(verdict.evidence) &&
    typeof verdict.isKeepTryingSensible === "boolean" &&
    KNOWN_KINDS.has(verdict.kind)
  )
}

/**
 * The closed verdict set, as a runtime guard.
 *
 * Duplicating the union costs a line each; letting an unknown
 * kind through would cost `verdictTone` a `switch` case it has
 * no arm for, in the browser, on a card nobody can explain.
 */
const KNOWN_KINDS: ReadonlySet<VerdictKind> =
  new Set<VerdictKind>([
    "ok",
    "hub_fault",
    "key_expired",
    "drive_failing",
    "enumeration_flap",
    "disc_scratched",
    "disc_dirty",
    "disc_read_error",
    "disc_marginal_slow",
    "unknown",
  ])
