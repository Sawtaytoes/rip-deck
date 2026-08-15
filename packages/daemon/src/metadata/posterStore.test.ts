import { describe, expect, it } from "vitest"
import type { OmdbResult } from "./omdb.ts"
import {
  EMPTY_POSTER_CACHE,
  type PosterCache,
  type PosterRecord,
} from "./posterCache.ts"
import {
  createPosterStore,
  createPosterStoreFromEnv,
  POSTER_STORE_TUNING,
  type PosterLookup,
} from "./posterStore.ts"

/**
 * The store, and the four promises it makes.
 *
 * 1. No key configured is a supported state — no request, no
 *    file, no log line, and every bay rips as normal.
 * 2. A slow OMDb never delays a reader. `get` is a `Map` read
 *    and `request` returns before anything is awaited.
 * 3. A cached hit does not re-query. `rip-deck watch` restarts
 *    with its container and the same nine discs come back.
 * 4. A doubtful match yields null, not a wrong poster.
 *
 * A green suite is not evidence on its own, so these are
 * written against the failure each one prevents rather than
 * against the implementation.
 */

const NOW_MS = 1_800_000_000_000
const CACHE_PATH = "/state/posters.json"
const POSTER_URL = "https://example.invalid/troy.jpg"

const matched: OmdbResult = {
  kind: "matched",
  match: {
    title: "Troy",
    year: 2004,
    posterUrl: POSTER_URL,
    imdbId: "tt0332452",
  },
}

/** A lookup that records what it was asked, and by how many. */
const createSpyLookup = (
  answer: OmdbResult | (() => Promise<OmdbResult>),
) => {
  const queries: string[] = []

  const lookup: PosterLookup = async ({ query }) => {
    queries.push(query)

    return typeof answer === "function"
      ? await answer()
      : answer
  }

  return { lookup, queries }
}

const createHarness = (
  input: {
    answer?: OmdbResult | (() => Promise<OmdbResult>)
    cache?: PosterCache
    nowMs?: number
    isWritable?: boolean
  } = {},
) => {
  const spy = createSpyLookup(input.answer ?? matched)
  const writes: PosterCache[] = []

  let nowMs = input.nowMs ?? NOW_MS

  const store = createPosterStore({
    lookup: spy.lookup,
    cachePath: CACHE_PATH,
    readCache: async () =>
      input.cache ?? EMPTY_POSTER_CACHE,
    writeCache: async ({ cache }) => {
      if (input.isWritable === false) {
        throw new Error("EROFS: read-only file system")
      }

      writes.push(cache)
    },
    now: () => nowMs,
  })

  return {
    store,
    writes,
    queries: spy.queries,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

/** Let the fired-and-forgotten lookup land. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const cachedRecord = (
  input: Partial<PosterRecord> = {},
): PosterCache => ({
  ...EMPTY_POSTER_CACHE,
  records: [
    {
      rawLabel: "TROY - BONUS DISC",
      query: "troy",
      matchedTitle: "Troy",
      matchedYear: 2004,
      posterUrl: POSTER_URL,
      provider: "omdb",
      isMatched: true,
      lookedUpAtMs: NOW_MS - 60_000,
      ...input,
    },
  ],
})

describe("createPosterStoreFromEnv", () => {
  it("is a no-op with no API key", async () => {
    // The MQTT bargain, applied to posters: an unset optional
    // credential is a supported state and never a fault. The
    // owner adds `RIP_DECK_OMDB_API_KEY` at deploy time; until
    // he does, the card renders without a thumbnail.
    const store = createPosterStoreFromEnv({})

    store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(
      store.get({ discName: "TROY - BONUS DISC" }),
    ).toBeNull()
  })

  it("treats a blank key as no key", () => {
    // A `RIP_DECK_OMDB_API_KEY=` line in a compose file must not
    // produce a client that 401s on every disc.
    expect(
      createPosterStoreFromEnv({
        RIP_DECK_OMDB_API_KEY: "   ",
      }).get({ discName: "TROY" }),
    ).toBeNull()
  })
})

describe("createPosterStore", () => {
  it("returns null until the answer lands", async () => {
    const harness = createHarness()

    harness.store.request({ discName: "TROY - BONUS DISC" })

    // The `/json` contract: reads are synchronous memory reads,
    // so the first poll after a disc is named shows no poster
    // and the next one shows it.
    expect(
      harness.store.get({ discName: "TROY - BONUS DISC" }),
    ).toBeNull()

    await settle()

    expect(
      harness.store.get({ discName: "TROY - BONUS DISC" }),
    ).toEqual({
      title: "Troy",
      year: 2004,
      posterUrl: POSTER_URL,
      provider: "omdb",
    })
  })

  it("does not block on a slow OMDb", async () => {
    // The assertion that keeps a network call off the request
    // path: `request` returns while the lookup is still
    // hanging, and `get` answers immediately.
    const harness = createHarness({
      answer: () => new Promise<OmdbResult>(() => {}),
    })

    const startedAt = Date.now()

    harness.store.request({ discName: "TROY - BONUS DISC" })

    expect(
      harness.store.get({ discName: "TROY - BONUS DISC" }),
    ).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it("asks the normalised title, not the label", async () => {
    const harness = createHarness()

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(harness.queries).toEqual(["troy"])
  })

  it("asks once, however often it is told", async () => {
    // `request` is called from a five-second poll loop, for
    // nine bays.
    const harness = createHarness()

    for (let index = 0; index < 20; index += 1) {
      harness.store.request({
        discName: "TROY - BONUS DISC",
      })
    }

    await settle()

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(harness.queries).toEqual(["troy"])
  })

  it("does not re-query what the cache already answered", async () => {
    // `CMD` is `rip-deck watch`, so the daemon restarts with its
    // container and the same nine discs come back. Re-querying
    // every restart is one bad afternoon from a rate limit.
    const harness = createHarness({ cache: cachedRecord() })

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(harness.queries).toEqual([])
    expect(
      harness.store.get({ discName: "TROY - BONUS DISC" }),
    ).toMatchObject({ posterUrl: POSTER_URL })
  })

  it("writes the raw label beside the query", async () => {
    // When a card shows the wrong film, the raw label is the
    // only way to see how the normaliser got there.
    const harness = createHarness()

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(harness.writes.at(-1)?.records[0]).toMatchObject(
      {
        rawLabel: "TROY - BONUS DISC",
        query: "troy",
        matchedTitle: "Troy",
        provider: "omdb",
      },
    )
  })

  it("remembers a film OMDb has never heard of", async () => {
    const harness = createHarness({
      answer: { kind: "unmatched", reason: "not found" },
    })

    harness.store.request({ discName: "SOME HOME VIDEO" })
    await settle()
    harness.store.request({ discName: "SOME HOME VIDEO" })
    await settle()

    expect(harness.queries).toHaveLength(1)
    expect(
      harness.store.get({ discName: "SOME HOME VIDEO" }),
    ).toBeNull()
  })

  it("asks again about an old miss, but not soon", async () => {
    // The normaliser will grow, so a miss is remembered for a
    // week rather than forever — and a week rather than the
    // five seconds the caller polls at.
    const harness = createHarness({
      answer: { kind: "unmatched", reason: "not found" },
    })

    harness.store.request({ discName: "SOME HOME VIDEO" })
    await settle()

    harness.advance(POSTER_STORE_TUNING.negativeTtlMs - 1)
    harness.store.request({ discName: "SOME HOME VIDEO" })
    await settle()

    expect(harness.queries).toHaveLength(1)

    harness.advance(2)
    harness.store.request({ discName: "SOME HOME VIDEO" })
    await settle()

    expect(harness.queries).toHaveLength(2)
  })

  it("never re-queries a hit, however old", async () => {
    const harness = createHarness({ cache: cachedRecord() })

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    harness.advance(POSTER_STORE_TUNING.negativeTtlMs * 52)
    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(harness.queries).toEqual([])
  })

  it("queries nothing at all for a generic label", async () => {
    // `DVD_VIDEO` identifies no film, and OMDb would answer
    // *something* for it.
    const harness = createHarness()

    harness.store.request({ discName: "DVD_VIDEO" })
    await settle()

    expect(harness.queries).toEqual([])
    expect(
      harness.store.get({ discName: "DVD_VIDEO" }),
    ).toBeNull()
    // Written down anyway, with `query: null`, so the file says
    // WHY rather than looking like a lookup that never ran.
    expect(harness.writes.at(-1)?.records[0]).toMatchObject(
      {
        rawLabel: "DVD_VIDEO",
        query: null,
        isMatched: false,
      },
    )
  })

  it("stops asking while OMDb is unreachable", async () => {
    // The bound that matters most: `request` is driven by a
    // five-second loop across nine bays, so an outage must not
    // become a retry storm.
    const harness = createHarness({
      answer: { kind: "unavailable", reason: "ENOTFOUND" },
    })

    harness.store.request({ discName: "TROY" })
    await settle()
    harness.store.request({ discName: "THE MATRIX" })
    await settle()

    expect(harness.queries).toEqual(["troy"])

    harness.advance(
      POSTER_STORE_TUNING.unavailableCooldownMs + 1,
    )

    harness.store.request({ discName: "THE MATRIX" })
    await settle()

    expect(harness.queries).toEqual(["troy", "the matrix"])
  })

  it("does not remember an outage as an answer", async () => {
    // Caching "unavailable" would turn one unreachable minute
    // into a week without posters.
    const harness = createHarness({
      answer: { kind: "unavailable", reason: "ENOTFOUND" },
    })

    harness.store.request({ discName: "TROY" })
    await settle()

    expect(harness.writes).toEqual([])
  })

  it("bounds how many lookups run at once", async () => {
    const harness = createHarness({
      answer: () => new Promise<OmdbResult>(() => {}),
    })

    for (const discName of [
      "TROY",
      "THE MATRIX",
      "ALIENS",
      "HEAT",
      "JAWS",
    ]) {
      harness.store.request({ discName })
    }

    await settle()

    expect(harness.queries).toHaveLength(
      POSTER_STORE_TUNING.maxInFlight,
    )
  })

  it("survives a read-only state directory", async () => {
    // The bay ledger's bargain: a state directory that has
    // gone read-only costs the memory of what we looked up,
    // never a rip and never a poster we already have.
    const harness = createHarness({ isWritable: false })

    harness.store.request({ discName: "TROY - BONUS DISC" })
    await settle()

    expect(
      harness.store.get({ discName: "TROY - BONUS DISC" }),
    ).toMatchObject({ posterUrl: POSTER_URL })
  })

  it("ignores a nameless disc", async () => {
    const harness = createHarness()

    harness.store.request({ discName: "   " })
    await settle()

    expect(harness.queries).toEqual([])
  })
})
