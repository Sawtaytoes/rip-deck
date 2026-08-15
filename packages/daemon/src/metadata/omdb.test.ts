import { describe, expect, it } from "vitest"
import {
  buildOmdbUrl,
  createOmdbClient,
  type FetchJson,
  parseOmdbPayload,
} from "./omdb.ts"

/**
 * The lookup, with no network anywhere near it.
 *
 * ⚠️ **No test in this repo may reach the real OMDb API.**
 * Every one below injects `fetchJson`, and a lookup that
 * escaped this file would be a test that fails when the
 * house's internet does and burns a shared rate limit while it
 * passes.
 *
 * The assertions that matter are the refusals: OMDb's `t=`
 * search is fuzzy, so most of this file is about the answers we
 * throw away.
 */

const TROY = {
  Title: "Troy",
  Year: "2004",
  Poster: "https://m.media-amazon.com/images/troy.jpg",
  imdbID: "tt0332452",
  Response: "True",
}

const recordingFetch = (
  payload: unknown,
): { fetchJson: FetchJson; urls: string[] } => {
  const urls: string[] = []

  return {
    urls,
    fetchJson: async ({ url }) => {
      urls.push(url)
      return payload
    },
  }
}

describe("buildOmdbUrl", () => {
  it("asks by title, never by search", () => {
    // `s=` returns a LIST, and picking a row out of a list is
    // the guessing this feature must not do.
    const url = new URL(
      buildOmdbUrl({
        apiKey: "k",
        query: "troy",
        year: null,
      }),
    )

    expect(url.searchParams.get("t")).toBe("troy")
    expect(url.searchParams.get("s")).toBeNull()
    expect(url.searchParams.get("apikey")).toBe("k")
    expect(url.searchParams.get("y")).toBeNull()
  })

  it("passes a year when the label carried one", () => {
    expect(
      new URL(
        buildOmdbUrl({
          apiKey: "k",
          query: "deadpool 2",
          year: 2018,
        }),
      ).searchParams.get("y"),
    ).toBe("2018")
  })
})

describe("parseOmdbPayload", () => {
  it("accepts an answer about the film we asked about", () => {
    const result = parseOmdbPayload({
      payload: TROY,
      query: "troy",
    })

    expect(result).toEqual({
      kind: "matched",
      match: {
        title: "Troy",
        year: 2004,
        posterUrl: TROY.Poster,
        imdbId: "tt0332452",
      },
    })
  })

  it("refuses an answer about a different film", () => {
    // The whole guard: a wrong poster is worse than no poster,
    // so a near-miss is `unmatched` and the card stays bare.
    const result = parseOmdbPayload({
      payload: { ...TROY, Title: "Troy: Fall of a City" },
      query: "troy",
    })

    expect(result.kind).toBe("unmatched")
  })

  it("refuses a record with no artwork", () => {
    expect(
      parseOmdbPayload({
        payload: { ...TROY, Poster: "N/A" },
        query: "troy",
      }).kind,
    ).toBe("unmatched")
  })

  it("reads a not-found as an answer about the disc", () => {
    expect(
      parseOmdbPayload({
        payload: {
          Response: "False",
          Error: "Movie not found!",
        },
        query: "troy",
      }).kind,
    ).toBe("unmatched")
  })

  it.each(["Request limit reached!", "Invalid API key!"])(
    "reads %s as no answer at all",
    (message) => {
      // Cacheable-vs-not is the whole distinction: remembering
      // a rate limit as "this disc has no poster" would cost
      // every disc queried during it a week of thumbnails.
      expect(
        parseOmdbPayload({
          payload: { Response: "False", Error: message },
          query: "troy",
        }).kind,
      ).toBe("unavailable")
    },
  )

  it("reads a series year range as its first year", () => {
    expect(
      parseOmdbPayload({
        payload: { ...TROY, Year: "2004–2010" },
        query: "troy",
      }),
    ).toMatchObject({ match: { year: 2004 } })
  })

  it.each([null, "not json", 42])(
    "treats %s as no answer rather than throwing",
    (payload) => {
      expect(
        parseOmdbPayload({ payload, query: "troy" }).kind,
      ).toBe("unavailable")
    },
  )
})

describe("createOmdbClient", () => {
  it("never throws when the request fails", async () => {
    // A poster lookup failing is not a fault of the rip, the
    // disc or the daemon, so every failure is a value.
    const client = createOmdbClient({
      apiKey: "k",
      fetchJson: async () => {
        throw new Error("getaddrinfo ENOTFOUND")
      },
    })

    expect(
      await client.lookup({ query: "troy", year: null }),
    ).toEqual({
      kind: "unavailable",
      reason: "getaddrinfo ENOTFOUND",
    })
  })

  it("retries once without the year, and only then", async () => {
    // A year in a volume label is as often the DVD's release
    // year as the film's, and `y=` is an exact filter.
    const urls: string[] = []

    const client = createOmdbClient({
      apiKey: "k",
      fetchJson: async ({ url }) => {
        urls.push(url)

        return url.includes("y=2005")
          ? { Response: "False", Error: "Movie not found!" }
          : TROY
      },
    })

    const result = await client.lookup({
      query: "troy",
      year: 2005,
    })

    expect(result.kind).toBe("matched")
    expect(urls).toHaveLength(2)
    expect(urls[1]).not.toContain("&y=")
  })

  it("does not retry a match", async () => {
    const { fetchJson, urls } = recordingFetch(TROY)

    await createOmdbClient({
      apiKey: "k",
      fetchJson,
    }).lookup({ query: "troy", year: 2004 })

    expect(urls).toHaveLength(1)
  })

  it("does not retry when OMDb never answered", async () => {
    // An unreachable OMDb is not a year problem, and asking it
    // twice as fast is the wrong response to it.
    const { fetchJson, urls } = recordingFetch({
      Response: "False",
      Error: "Request limit reached!",
    })

    const result = await createOmdbClient({
      apiKey: "k",
      fetchJson,
    }).lookup({ query: "troy", year: 2004 })

    expect(result.kind).toBe("unavailable")
    expect(urls).toHaveLength(1)
  })
})
