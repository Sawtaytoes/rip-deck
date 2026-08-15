/**
 * A volume label is not a film title.
 *
 * `identifyDisc` reads whatever the pressing plant wrote into
 * the media's volume descriptor, and that is a filesystem name
 * with a filesystem's constraints: `TROY - BONUS DISC`,
 * `THE_MATRIX_D1`, `DEADPOOL_2_2018`. Handing one of those to a
 * title lookup gets nothing back, so this module turns a label
 * into the query we would actually ask.
 *
 * ## Two rules it will not break
 *
 * 1. **The raw label survives.** Every parse carries `rawLabel`
 *    through untouched and the cache persists it beside the
 *    query, because when a card ends up with the wrong poster
 *    the raw label is the only way to see why the normaliser
 *    took us there.
 * 2. **A label with nothing in it queries nothing.** Generic
 *    labels are extremely common — `DVD_VIDEO`, `AUDIO_CD`,
 *    `NEW VOLUME` — and OMDb will happily return *something*
 *    for most of them. A confident-looking match on a label that
 *    identifies no film is exactly how a card gets a wrong
 *    poster, and a wrong poster is worse than no poster.
 */

/** What a volume label turns out to be asking for. */
export type DiscQuery = {
  /** Exactly what came off the media. Never normalised. */
  rawLabel: string
  /**
   * The title to look up, or null when the label says nothing.
   *
   * Null is a decision, not a failure: see rule 2 above.
   */
  title: string | null
  /** A year found in the label, when there was one. */
  year: number | null
  /** Disc N of M, when the label numbered itself. */
  discNumber: number | null
  discTotal: number | null
}

/**
 * Trailing phrases that describe the DISC, not the work.
 *
 * Stripped only from the end, and only as whole phrases, so a
 * title that happens to contain one of these words keeps it —
 * `Extended` is noise at the end of `TROY EXTENDED` and part of
 * the name in `THE EXTENDED FAMILY`.
 *
 * `VOL`/`VOLUME` and `PART` are deliberately absent: *Kill Bill
 * Vol. 1* and *Harry Potter … Part 2* are separate works with
 * separate posters, and dropping the number would put the wrong
 * one on the card.
 */
const TRAILING_NOISE = [
  "bonus disc",
  "bonus features",
  "bonus material",
  "bonus",
  "special features",
  "special edition",
  "collectors edition",
  "collector s edition",
  "limited edition",
  "anniversary edition",
  "extended edition",
  "extended cut",
  "extended",
  "theatrical cut",
  "theatrical version",
  "theatrical",
  "directors cut",
  "director s cut",
  "unrated",
  "uncut",
  "remastered",
  "restored",
  "widescreen",
  "fullscreen",
  "full screen",
  "letterbox",
  "feature",
  "main movie",
  "extras",
  "ntsc",
  "pal",
  "uhd",
  "4k",
  "blu ray",
  "bluray",
  "bd",
  "dvd",
  "cd",
] as const

/**
 * Labels that identify no work at all.
 *
 * What is left after normalisation is compared against this
 * list, so `DVD_VIDEO` and `DVD VIDEO` are the same refusal.
 */
const MEANINGLESS_LABELS = new Set([
  "audio cd",
  "cdrom",
  "cd rom",
  "data",
  "disc",
  "dvd",
  "dvd rom",
  "dvd video",
  "movie",
  "movies",
  "my disc",
  "new volume",
  "no label",
  "unlabeled",
  "unlabelled",
  "untitled",
  "video",
  "video cd",
  "video ts",
  "volume",
])

/**
 * The comparison form of a piece of text.
 *
 * Punctuation is dropped rather than mapped, because the
 * question this answers is "are these the same title", and
 * `Star Wars: Episode IV - A New Hope` and
 * `STAR_WARS_EPISODE_IV_A_NEW_HOPE` are. `&` becomes `and`
 * first, since one side of that comparison routinely spells it
 * the other way.
 */
export const normaliseForComparison = (
  text: string,
): string =>
  text
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()

const YEAR_PATTERN = /^(19|20)\d{2}$/

/** `DISC 2`, `DISC 2 OF 3`, `CD 2`, `D2`. */
const NUMBERED_DISC_PATTERN =
  /^(?:(?:disc|disk|cd|dvd|bd)\s*(\d{1,2})|d(\d{1,2}))(?:\s*of\s*(\d{1,2}))?$/

const takeTrailingWords = (
  words: string[],
  count: number,
): string => words.slice(-count).join(" ")

/**
 * Strip one trailing disc marker, if the tail is one.
 *
 * Returns null when it is not, so the caller can stop peeling.
 */
const stripDiscMarker = (
  words: string[],
): {
  words: string[]
  discNumber: number
  discTotal: number | null
} | null => {
  // Longest first: `disc 2 of 3` is four words and `d2` is one,
  // and matching the short form first would leave `of 3` behind.
  for (const count of [5, 4, 3, 2, 1]) {
    if (words.length <= count) continue

    const match = NUMBERED_DISC_PATTERN.exec(
      takeTrailingWords(words, count),
    )

    if (match === null) continue

    const [, spelled, abbreviated, total] = match

    return {
      words: words.slice(0, -count),
      discNumber: Number(spelled ?? abbreviated),
      discTotal: total === undefined ? null : Number(total),
    }
  }

  return null
}

/** Strip one trailing noise phrase, or null when there is none. */
const stripNoise = (words: string[]): string[] | null => {
  for (const phrase of TRAILING_NOISE) {
    const count = phrase.split(" ").length

    // Never strip the whole label: a disc genuinely called
    // `BONUS` tells us nothing either way, and leaving it is
    // what makes `parseDiscLabel` refuse rather than query the
    // empty string.
    if (words.length <= count) continue

    if (takeTrailingWords(words, count) === phrase) {
      return words.slice(0, -count)
    }
  }

  return null
}

/**
 * A volume label, read as a lookup.
 *
 * Pure, so the whole normalisation table is testable without a
 * disc, a network or a key — which matters because every wrong
 * poster this feature could ever show starts here.
 */
export const parseDiscLabel = (
  rawLabel: string,
): DiscQuery => {
  const empty: DiscQuery = {
    rawLabel,
    title: null,
    year: null,
    discNumber: null,
    discTotal: null,
  }

  const normalised = normaliseForComparison(rawLabel)

  // Checked BEFORE anything is peeled as well as after: the
  // noise table would turn `AUDIO CD` into `audio`, which is
  // not in the list and is not a film either.
  if (
    normalised === "" ||
    MEANINGLESS_LABELS.has(normalised)
  )
    return empty

  let words = normalised.split(" ")

  let year: number | null = null
  let discNumber: number | null = null
  let discTotal: number | null = null

  // Peel from the end until nothing more comes off. Order is
  // not fixed on purpose: `TROY D1 BONUS` and `TROY BONUS D1`
  // are both real shapes.
  for (;;) {
    const marker = stripDiscMarker(words)

    if (marker !== null) {
      words = marker.words
      discNumber ??= marker.discNumber
      discTotal ??= marker.discTotal
      continue
    }

    const stripped = stripNoise(words)

    if (stripped !== null) {
      words = stripped
      continue
    }

    break
  }

  // A four-digit year anywhere, but never when it is the whole
  // title: *2012* is a film, and asking OMDb for the empty
  // string with `y=2012` would match whatever it felt like.
  const yearIndex = words.findIndex((word) =>
    YEAR_PATTERN.test(word),
  )

  if (yearIndex !== -1 && words.length > 1) {
    year = Number(words[yearIndex])
    words = words.toSpliced(yearIndex, 1)
  }

  const title = words.join(" ").trim()

  // Two characters and a letter, at least. A one-character
  // query matches by accident, and a digits-only label is a
  // date or a serial far more often than it is *2012* — so
  // that film loses its poster, which is the direction of
  // error this whole module is tuned for.
  if (
    title.length < 2 ||
    !/[a-z]/.test(title) ||
    MEANINGLESS_LABELS.has(title)
  ) {
    return { ...empty, year, discNumber, discTotal }
  }

  return { rawLabel, title, year, discNumber, discTotal }
}

/**
 * Is this answer about the disc we asked about?
 *
 * The one guard between "a lookup happened" and "this poster is
 * this disc". OMDb's `t=` search is a fuzzy title match and will
 * answer `Rocky` for `ROCKY IV` if it feels like it, so the
 * returned title is compared back against the query and
 * anything short of equality is refused.
 *
 * **Deliberately strict, and it will say no to matches a human
 * would accept** — `TROY DIRECTORS CUT` against `Troy` only
 * passes because the noise table removed the suffix first, and
 * a title the table has never heard of simply gets no poster.
 * That is the intended direction of the error: a card with no
 * thumbnail is a card missing a nice-to-have, while a card
 * showing the wrong film is a card lying about which disc is in
 * the drive.
 */
export const isConfidentMatch = (input: {
  query: string
  candidate: string
}): boolean =>
  normaliseForComparison(input.query) !== "" &&
  normaliseForComparison(input.query) ===
    normaliseForComparison(input.candidate)
