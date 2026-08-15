import { isConfidentMatch } from "./discQuery.ts"

/**
 * Title, year and poster art, from OMDb.
 *
 * Requirement B1 — *"auto-identify title + year and fetch a
 * poster"*, the owner's single favourite ARM feature — and OMDb
 * answers all three in one request.
 *
 * ## Why OMDb and not TMDB
 *
 * ARM uses TMDB and every write-up of this feature assumes it.
 * There is no TMDB key in this house; there IS an `OMDB_API_KEY`
 * in the workspace root `.env`. OMDb returns `Poster` and
 * `Year`, which is the whole of B1, so the provider changed and
 * the feature did not.
 *
 * That is also why `DiscIdentity.source` gained `"omdb"`.
 * Reporting an OMDb answer as `"tmdb"` because the union
 * happened to have that member would make the one field whose
 * entire job is the trust trail into the least trustworthy
 * thing on the card.
 *
 * ## No key is a supported state
 *
 * Exactly as `RIP_DECK_MQTT_URL` being unset yields the no-op
 * publisher and every bay rips as normal: with no
 * `RIP_DECK_OMDB_API_KEY` there is no client at all, `posterUrl`
 * stays null, the card renders without a thumbnail, and nothing
 * is logged as an error. A missing poster is not a fault.
 *
 * ## Nothing here may be slow, and nothing here may throw
 *
 * The caller is the daemon that supervises nine bays from the
 * parent process. A network call is not a device call, but it
 * is still unbounded latency, so every request is bounded by
 * `requestTimeoutMs` and every failure — DNS, 401, a rate
 * limit, a body that is not JSON — comes back as a value.
 */

export const OMDB_TUNING = {
  endpoint: "https://www.omdbapi.com/",
  /**
   * How long one lookup gets.
   *
   * Generous next to a sysfs probe and irrelevant next to a
   * rip: nothing waits on this. The bound exists so a hung
   * connection cannot pin a slot in the store's in-flight set
   * forever, not because eight seconds is a latency budget.
   */
  requestTimeoutMs: 8_000,
} as const

/** What a confident OMDb answer contains. */
export type OmdbMatch = {
  /** OMDb's own spelling of the title. */
  title: string
  year: number | null
  /** Always an absolute URL; `N/A` is not a poster. */
  posterUrl: string
  imdbId: string | null
}

/**
 * The three outcomes, kept apart on purpose.
 *
 * `unmatched` is an answer — this disc has no poster, remember
 * that and stop asking. `unavailable` is the absence of an
 * answer, and caching it would mean one flaky minute costs
 * every disc its thumbnail until someone clears the cache.
 */
export type OmdbResult =
  | { kind: "matched"; match: OmdbMatch }
  | { kind: "unmatched"; reason: string }
  | { kind: "unavailable"; reason: string }

/** The one network call, injected so no test can make it. */
export type FetchJson = (input: {
  url: string
  signal: AbortSignal
}) => Promise<unknown>

export const buildOmdbUrl = (input: {
  apiKey: string
  query: string
  year: number | null
}): string => {
  const url = new URL(OMDB_TUNING.endpoint)

  url.searchParams.set("apikey", input.apiKey)
  // `t=` and never `s=`: `s` is a search that returns a list,
  // and picking a row out of a list is the guessing this
  // feature must not do. `t` either has a title match or says
  // it has not.
  url.searchParams.set("t", input.query)
  url.searchParams.set("r", "json")

  if (input.year !== null) {
    url.searchParams.set("y", String(input.year))
  }

  return url.toString()
}

/** `"2004"`, `"2004–2010"` and `"N/A"` all arrive as strings. */
const parseYear = (value: unknown): number | null => {
  if (typeof value !== "string") return null

  const match = /^(19|20)\d{2}/.exec(value)

  return match === null ? null : Number(match[0])
}

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null

/**
 * Read one OMDb payload, and refuse a doubtful one.
 *
 * Exported for its tests: this function is where a wrong poster
 * would be born, and it is a pure function of a JSON body.
 */
export const parseOmdbPayload = (input: {
  payload: unknown
  query: string
}): OmdbResult => {
  if (
    typeof input.payload !== "object" ||
    input.payload === null
  ) {
    return {
      kind: "unavailable",
      reason: "the response body was not a JSON object",
    }
  }

  const body = input.payload as Record<string, unknown>

  // OMDb answers a bad key with HTTP 401, but it answers a
  // rate limit with 200 and `Response: "False"` — the same
  // shape it uses for "no such film". The only thing that tells
  // them apart is the English in `Error`, and this repo's
  // standing lesson (`MSG:5072`) is never to scrape structure
  // out of prose.
  //
  // It is read here anyway, and the reason it is not the same
  // mistake: nothing about the DISC is derived from it. The
  // sniff can only ever suppress a cache write — worst case we
  // re-ask OMDb about a film it does not have, or we remember a
  // rate limit as "no poster" for `negativeTtlMs`. Neither can
  // put a poster on a card.
  const error = textOf(body.Error)

  if (body.Response !== "True") {
    return error !== null &&
      /limit|key|denied/i.test(error) === true
      ? { kind: "unavailable", reason: error }
      : {
          kind: "unmatched",
          reason: error ?? "OMDb had no match",
        }
  }

  const title = textOf(body.Title)

  if (title === null) {
    return {
      kind: "unavailable",
      reason: "the response carried no title",
    }
  }

  if (
    !isConfidentMatch({
      query: input.query,
      candidate: title,
    })
  ) {
    return {
      kind: "unmatched",
      reason:
        `OMDb answered "${title}" for "${input.query}", ` +
        "which is not the same title. Refusing it — a wrong " +
        "poster is worse than no poster.",
    }
  }

  const posterUrl = textOf(body.Poster)

  // `N/A` is OMDb's way of saying the record exists and has no
  // artwork. A real answer, and not one worth a broken image.
  if (posterUrl === null || !posterUrl.startsWith("http")) {
    return {
      kind: "unmatched",
      reason: `OMDb has no poster for "${title}"`,
    }
  }

  return {
    kind: "matched",
    match: {
      title,
      year: parseYear(body.Year),
      posterUrl,
      imdbId: textOf(body.imdbID),
    },
  }
}

/**
 * The default transport.
 *
 * `AbortSignal.timeout` rather than a hand-rolled timer: its
 * handle does not keep the event loop alive, which is the same
 * property `rip/unrefTimers.ts` exists to give the RxJS
 * schedulers, and for the same reason — `rip-deck rip` has to be
 * able to exit.
 */
export const fetchJsonOverHttp: FetchJson = async ({
  url,
  signal,
}) => {
  const response = await fetch(url, { signal })

  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`)
  }

  return await response.json()
}

export type OmdbClient = {
  lookup: (input: {
    query: string
    year: number | null
  }) => Promise<OmdbResult>
}

export const createOmdbClient = ({
  apiKey,
  fetchJson = fetchJsonOverHttp,
  requestTimeoutMs = OMDB_TUNING.requestTimeoutMs,
}: {
  apiKey: string
  fetchJson?: FetchJson
  requestTimeoutMs?: number
}): OmdbClient => {
  const ask = async (input: {
    query: string
    year: number | null
  }): Promise<OmdbResult> => {
    try {
      return parseOmdbPayload({
        payload: await fetchJson({
          url: buildOmdbUrl({ apiKey, ...input }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
        query: input.query,
      })
    } catch (error: unknown) {
      // Never rethrown, and never `console.error`: a poster
      // lookup failing is not a fault of the rip, of the disc
      // or of the daemon, and a log line per bay per poll for
      // an unreachable OMDb would bury the lines that matter.
      return {
        kind: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : String(error),
      }
    }
  }

  return {
    lookup: async ({ query, year }) => {
      const answer = await ask({ query, year })

      // A year in a volume label is as often the DVD's release
      // year as the film's, and `y=` is an exact filter — so a
      // year that disagrees costs the poster entirely. One
      // retry without it, and only when the year was the thing
      // that could have failed. Still bounded: two requests per
      // disc, once, and the result is cached.
      return answer.kind === "unmatched" && year !== null
        ? await ask({ query, year: null })
        : answer
    },
  }
}
