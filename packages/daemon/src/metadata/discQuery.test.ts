import { describe, expect, it } from "vitest"
import {
  isConfidentMatch,
  normaliseForComparison,
  parseDiscLabel,
} from "./discQuery.ts"

/**
 * Where a wrong poster would be born.
 *
 * Every card that ever shows the wrong film gets there through
 * this file: either the normaliser turned a label into somebody
 * else's title, or the confidence check let a near-miss
 * through. Both are pure functions, so all of it is testable
 * without a disc, a key or a network.
 *
 * `TROY - BONUS DISC` is not a hypothetical — it is the literal
 * `CINFO:2` string `identifyDisc` read off slot 8 of the real
 * tower on 2026-07-26.
 */

describe("parseDiscLabel", () => {
  it("keeps the raw label exactly as it was read", () => {
    // The only way to explain a wrong poster after the fact, so
    // it is never normalised in place.
    expect(parseDiscLabel("TROY_BONUS_DISC").rawLabel).toBe(
      "TROY_BONUS_DISC",
    )
  })

  it("turns a real volume label into a film title", () => {
    expect(parseDiscLabel("TROY - BONUS DISC")).toEqual({
      rawLabel: "TROY - BONUS DISC",
      title: "troy",
      year: null,
      discNumber: null,
      discTotal: null,
    })
  })

  it("reads underscores as spaces", () => {
    expect(parseDiscLabel("THE_MATRIX").title).toBe(
      "the matrix",
    )
  })

  it.each([
    ["THE_MATRIX_D1", "the matrix", 1, null],
    ["THE MATRIX DISC 2", "the matrix", 2, null],
    ["THE MATRIX DISC 2 OF 3", "the matrix", 2, 3],
    ["THE MATRIX CD2", "the matrix", 2, null],
  ])(
    "%s numbers itself disc %s",
    (label, title, discNumber, discTotal) => {
      // The disc number exists only in the label — no lookup
      // knows which disc of a set is in this tray.
      expect(parseDiscLabel(label)).toMatchObject({
        title,
        discNumber,
        discTotal,
      })
    },
  )

  it.each([
    "TROY THEATRICAL CUT",
    "TROY DIRECTORS CUT",
    "TROY EXTENDED EDITION",
    "TROY SPECIAL FEATURES",
    "TROY WIDESCREEN",
    "TROY BLU RAY",
    "TROY 4K",
  ])("strips the edition noise from %s", (label) => {
    expect(parseDiscLabel(label).title).toBe("troy")
  })

  it("strips a disc number and an edition together", () => {
    expect(parseDiscLabel("TROY_BONUS_D2")).toMatchObject({
      title: "troy",
      discNumber: 2,
    })
  })

  it("takes a year out of the title and reports it", () => {
    expect(parseDiscLabel("DEADPOOL_2_2018")).toMatchObject(
      {
        title: "deadpool 2",
        year: 2018,
      },
    )
  })

  it("does not read a title that IS a year as a year", () => {
    // A digits-only label is a date or a serial far more often
    // than it is the film *2012*, so it is refused outright —
    // but it is refused as a LABEL, never mistaken for a year
    // and turned into an empty query with `y=2012`, which
    // would match whatever OMDb felt like.
    expect(parseDiscLabel("2012")).toMatchObject({
      title: null,
      year: null,
    })
  })

  it.each([
    "DVD_VIDEO",
    "AUDIO_CD",
    "NEW VOLUME",
    "UNTITLED",
    "VIDEO_TS",
    "",
    "  ",
    "01",
  ])("refuses to query the generic label %s", (label) => {
    // A generic label identifies no work, and OMDb will happily
    // answer *something* for most of them. A card with no
    // thumbnail beats a card showing the wrong film.
    expect(parseDiscLabel(label).title).toBeNull()
  })

  it("never strips a label away to nothing", () => {
    // `BONUS` is in the noise table, but a disc genuinely
    // called that has nothing else to ask about.
    expect(parseDiscLabel("BONUS").title).toBe("bonus")
  })

  it("keeps a volume number, which names a work", () => {
    // *Kill Bill Vol. 1* and *Vol. 2* are different films with
    // different posters, so `vol` is deliberately not noise.
    expect(parseDiscLabel("KILL_BILL_VOL_1").title).toBe(
      "kill bill vol 1",
    )
  })
})

describe("isConfidentMatch", () => {
  it.each([
    [
      "star wars episode iv a new hope",
      "Star Wars: Episode IV - A New Hope",
    ],
    ["the matrix", "The Matrix"],
    ["fast and furious", "Fast & Furious"],
  ])("accepts %s answered by %s", (query, candidate) => {
    expect(isConfidentMatch({ query, candidate })).toBe(
      true,
    )
  })

  it.each([
    ["rocky iv", "Rocky"],
    ["troy", "Troy: Director's Cut"],
    ["the matrix", "The Matrix Reloaded"],
  ])("refuses %s answered by %s", (query, candidate) => {
    // Strict on purpose, and it will say no to matches a human
    // would accept. The error is pushed towards "no poster".
    expect(isConfidentMatch({ query, candidate })).toBe(
      false,
    )
  })

  it("refuses an empty query, whatever comes back", () => {
    expect(
      isConfidentMatch({ query: "", candidate: "" }),
    ).toBe(false)
  })
})

describe("normaliseForComparison", () => {
  it("drops punctuation and folds case", () => {
    expect(
      normaliseForComparison("Spider-Man: No.2!"),
    ).toBe("spider man no 2")
  })
})
