import { parseDiscLabel } from "./discQuery.ts"
import {
  createOmdbClient,
  type OmdbResult,
} from "./omdb.ts"
import {
  EMPTY_POSTER_CACHE,
  type PosterCache,
  type PosterProvider,
  type PosterRecord,
  posterCachePath,
  readPosterCache,
  writePosterCache,
} from "./posterCache.ts"

/**
 * The disc thumbnail, off the request path.
 *
 * `api/router.ts`'s contract is that `/json` handlers are
 * SYNCHRONOUS memory reads — the dashboard polls it, and a
 * handler that waits on a network call turns nine bays'
 * telemetry into whatever OMDb's latency is that minute. So the
 * lookup does not live where the poster is read:
 *
 *  1. Something that knows a disc's name calls `request`. It
 *     returns immediately, always, and starts at most one
 *     lookup for that label ever.
 *  2. The answer lands in a `Map` here.
 *  3. `buildJob` calls `get`, which is a `Map` read and cannot
 *     block. No answer yet means `posterUrl: null` and the next
 *     poll — five seconds later — picks it up.
 *
 * That ordering is the whole design, and it is why a slow OMDb
 * can never delay `/json`.
 *
 * ## What is bounded, and why each bound is there
 *
 * - **One lookup per label, forever.** A matched record never
 *   expires; the tower holds the same nine discs for days.
 * - **`negativeTtlMs`.** A disc OMDb has never heard of is
 *   remembered as such, but not permanently: the normaliser
 *   will grow, and a label it cannot parse today may parse next
 *   month. Bounded the other way too — a re-ask every week is
 *   nothing, an re-ask every five seconds is a rate limit.
 * - **`unavailableCooldownMs`.** When OMDb is unreachable or
 *   angry, everything stops for a few minutes rather than nine
 *   bays retrying every poll. This is the bound that matters
 *   most: `request` is called from a five-second loop.
 * - **`maxInFlight`.** Nine labels arriving at once is nine
 *   sockets; three at a time is plenty when nothing waits on
 *   the result, and the rest are picked up by the next poll.
 *
 * ## No key configured is a supported state
 *
 * `createPosterStoreFromEnv` with no `RIP_DECK_OMDB_API_KEY`
 * returns `createNullPosterStore()` — `request` does nothing,
 * `get` returns null, no file is touched, nothing is logged and
 * every bay rips exactly as before. This mirrors the MQTT
 * no-op publisher, deliberately: a missing optional credential
 * must never look like a fault.
 */

export const POSTER_STORE_TUNING = {
  /** How long "OMDb has no such film" is believed. */
  negativeTtlMs: 7 * 24 * 60 * 60 * 1_000,
  /** How long an unreachable OMDb stops all lookups. */
  unavailableCooldownMs: 5 * 60 * 1_000,
  /** Concurrent lookups. The rest wait for the next poll. */
  maxInFlight: 3,
} as const

/** A poster, and the metadata that came with it. */
export type PosterMatch = {
  /** The provider's spelling of the title, not the label's. */
  title: string
  year: number | null
  posterUrl: string
  /** Which lookup answered — `DiscIdentity.source`'s value. */
  provider: PosterProvider
}

export type PosterStore = {
  /**
   * Make sure this disc has been looked up. Never blocks.
   *
   * Safe to call on every poll for every bay: the record, the
   * in-flight set and the cooldown between them mean the second
   * call and the ten-thousandth do nothing.
   */
  request: (input: { discName: string }) => void
  /** A synchronous memory read. Null until an answer lands. */
  get: (input: { discName: string }) => PosterMatch | null
}

/**
 * The store you get with no API key.
 *
 * A null object rather than a flag, so no caller ever branches
 * on "is the poster feature configured" — the same shape as
 * `createNullEventLog`.
 */
export const createNullPosterStore = (): PosterStore => ({
  request: () => {},
  get: () => null,
})

/** One lookup, whichever provider does it. */
export type PosterLookup = (input: {
  query: string
  year: number | null
}) => Promise<OmdbResult>

export const createPosterStore = ({
  lookup,
  cachePath,
  readCache = readPosterCache,
  writeCache = writePosterCache,
  now = () => Date.now(),
  tuning = POSTER_STORE_TUNING,
}: {
  lookup: PosterLookup
  /** `$RIP_DECK_STATE_DIR/posters.json`, normally. */
  cachePath: string
  readCache?: (input: {
    path: string
  }) => Promise<PosterCache>
  writeCache?: (input: {
    path: string
    cache: PosterCache
  }) => Promise<void>
  now?: () => number
  tuning?: typeof POSTER_STORE_TUNING
}): PosterStore => {
  const records = new Map<string, PosterRecord>()
  const inFlight = new Set<string>()

  let loading: Promise<void> | null = null
  let cooldownUntilMs = 0
  let isWriteInFlight = false
  let isWritePending = false

  /**
   * Read the cache once, lazily.
   *
   * Lazily because a store that is never asked anything — an
   * empty tower — should not touch the disk at all, and once
   * because nine bays call `request` on the same tick.
   */
  const ensureCacheLoaded = async (): Promise<void> => {
    loading ??= readCache({ path: cachePath })
      .catch(() => EMPTY_POSTER_CACHE)
      .then((cache) => {
        for (const record of cache.records) {
          // Anything learned since the read wins: a lookup that
          // finished while the file was being read is newer
          // than the file.
          if (!records.has(record.rawLabel)) {
            records.set(record.rawLabel, record)
          }
        }
      })

    await loading
  }

  /**
   * Write the cache, one at a time.
   *
   * Fired and forgotten, on the same bargain the bay ledger
   * makes: a state directory that has gone read-only costs the
   * memory of what we looked up, never a rip. A write already
   * running sets a flag instead of queueing, so a burst of nine
   * answers produces two writes rather than nine.
   */
  const persist = (): void => {
    if (isWriteInFlight) {
      isWritePending = true
      return
    }

    isWriteInFlight = true

    void writeCache({
      path: cachePath,
      cache: {
        ...EMPTY_POSTER_CACHE,
        records: [...records.values()],
      },
    })
      .catch(() => {})
      .finally(() => {
        isWriteInFlight = false

        if (isWritePending) {
          isWritePending = false
          persist()
        }
      })
  }

  const isRecordFresh = (record: PosterRecord): boolean =>
    record.isMatched ||
    now() - record.lookedUpAtMs < tuning.negativeTtlMs

  const remember = (record: PosterRecord): void => {
    records.set(record.rawLabel, record)
    persist()
  }

  const run = async (rawLabel: string): Promise<void> => {
    await ensureCacheLoaded()

    const known = records.get(rawLabel)

    if (known !== undefined && isRecordFresh(known)) return
    if (now() < cooldownUntilMs) return

    const parsed = parseDiscLabel(rawLabel)

    // Nothing in the label to ask about. Written down anyway,
    // with `query: null`, so the file says WHY this disc has no
    // poster rather than looking like a lookup that never ran.
    if (parsed.title === null) {
      remember({
        rawLabel,
        query: null,
        matchedTitle: null,
        matchedYear: null,
        posterUrl: null,
        provider: null,
        isMatched: false,
        lookedUpAtMs: now(),
      })

      return
    }

    const result = await lookup({
      query: parsed.title,
      year: parsed.year,
    })

    // No answer, so nothing is remembered — caching this would
    // turn one unreachable minute into a week without posters.
    // Everything stops briefly instead, because the caller is a
    // five-second poll loop.
    if (result.kind === "unavailable") {
      cooldownUntilMs = now() + tuning.unavailableCooldownMs
      return
    }

    remember({
      rawLabel,
      query: parsed.title,
      matchedTitle:
        result.kind === "matched"
          ? result.match.title
          : null,
      matchedYear:
        result.kind === "matched"
          ? result.match.year
          : null,
      posterUrl:
        result.kind === "matched"
          ? result.match.posterUrl
          : null,
      provider: result.kind === "matched" ? "omdb" : null,
      isMatched: result.kind === "matched",
      lookedUpAtMs: now(),
    })
  }

  return {
    request: ({ discName }) => {
      if (discName.trim() === "") return
      if (inFlight.has(discName)) return
      if (inFlight.size >= tuning.maxInFlight) return

      const known = records.get(discName)

      if (known !== undefined && isRecordFresh(known))
        return

      inFlight.add(discName)

      // Fired and forgotten on purpose: this is called from the
      // watcher's poll, which must not wait for a network call.
      // `run` never throws — every failure inside it is a value
      // — and the `finally` is what lets the next poll try
      // again after a cooldown.
      void run(discName)
        .catch(() => {})
        .finally(() => {
          inFlight.delete(discName)
        })
    },

    get: ({ discName }) => {
      const record = records.get(discName)

      if (
        record === undefined ||
        !record.isMatched ||
        record.posterUrl === null ||
        record.provider === null
      ) {
        return null
      }

      return {
        title: record.matchedTitle ?? discName,
        year: record.matchedYear,
        posterUrl: record.posterUrl,
        provider: record.provider,
      }
    },
  }
}

/**
 * The store this deployment should have, from the environment.
 *
 * Variable names follow the existing `RIP_DECK_*` scheme, and
 * the state directory default matches `createWatcherConfig`'s
 * so both halves of the daemon read the same directory.
 *
 * ⚠️ **Audio CDs are not handled here.** MusicBrainz plus the
 * Cover Art Archive is the right provider for a CD and needs no
 * key at all, and this is the seam it plugs into — `lookup`
 * would become a router over `DiscType`. It is deliberately not
 * half-built, because the prerequisite is missing rather than
 * the client: nothing carries a disc's TYPE to this layer.
 * `BayState` records `discName` and not `discType`
 * (`api/towerFeed.ts` hard-codes `discType: "unknown"` and says
 * so), so a router here could only guess which provider to ask,
 * and asking OMDb about an album is how a CD gets a film
 * poster. Carry `discType` onto the bay first.
 */
export const createPosterStoreFromEnv = (
  env: Record<string, string | undefined> = process.env,
): PosterStore => {
  const apiKey = env.RIP_DECK_OMDB_API_KEY?.trim() ?? ""

  // Not a misconfiguration. See the header.
  if (apiKey === "") return createNullPosterStore()

  return createPosterStore({
    lookup: createOmdbClient({ apiKey }).lookup,
    cachePath: posterCachePath(
      env.RIP_DECK_STATE_DIR ?? "/var/lib/rip-deck",
    ),
  })
}
