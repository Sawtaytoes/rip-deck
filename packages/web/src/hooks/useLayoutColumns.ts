import { useCallback, useEffect, useState } from "react"

/**
 * How many columns of bay cards the page draws.
 *
 * The owner's rule, in his words:
 *
 * > "With this many bays, I'm wondering if we can do them
 * > side-by-side instead of a single column. […] I could easily
 * > fit 3 side-by-side columns here. It would look weird to do 9
 * > side-by-side, but maybe we could have a width selection
 * > somewhere at the top and store that value in LocalStorage or
 * > be smart about it. Like if you have enough height, try to
 * > fill it. If you don't, then abuse as much width side-by-side
 * > as possible. That way, you don't get 9-wide just because
 * > you're on an ultrawide even if you have more height
 * > available."
 *
 * Stated plainly: **height is spent first**. A second column is
 * something the page is FORCED into when nine cards will not
 * stack inside the viewport — never something it takes merely
 * because a monitor is wide. That inversion is the whole
 * heuristic, and it is why width only ever caps the answer here
 * rather than producing it.
 *
 * The decision is a pure fold (`chooseAutoColumns`) taking the
 * viewport as an argument, exactly like the daemon's folds take
 * their clock: a heuristic nobody can unit-test at nine sizes is
 * a heuristic hand-tuned against one screenshot, which is the
 * mistake the handoff calls out by name.
 */

/**
 * The most columns AUTO will ever choose.
 *
 * > "It would look weird to do 9 side-by-side […] That way, you
 * > don't get 9-wide just because you're on an ultrawide even if
 * > you have more height available."
 *
 * Three is the number he said he could "easily fit". The manual
 * picker goes one higher, because a cap is a default and not a
 * ceiling on what a person is allowed to ask for.
 */
export const MAX_AUTO_COLUMNS = 3

/** The widest the manual picker offers. */
export const MAX_MANUAL_COLUMNS = 4

/**
 * The narrowest a column may be, in CSS px, before the page
 * stops adding them.
 *
 * Deliberately BELOW the card's 448px accordion threshold, which
 * looks backwards and is not. The accordion is a real density,
 * not a failure — it is what the owner asked for when space is
 * tight ("1 column is fine, 2 acceptable… cards become
 * accordions") — so a 360px column is still a column worth
 * having. What this number rules out is the width at which a
 * card cannot show a slot, a name and a progress bar at all.
 *
 * It is also the whole of the phone case: 390px holds one column
 * because 390 < 2 x 380, and a landscape phone at 844px gets two
 * accordions. Neither is a device check.
 */
const MIN_COLUMN_WIDTH_PX = 380

/**
 * A bay card's height, roughly, in CSS px.
 *
 * MEASURED off the dev server rather than invented, because
 * there is no single answer: a mid-rip card came out at 124px, a
 * short held bay at 112, and a held bay carrying the daemon's
 * full five-line paragraph at 234. 150 is a deliberate
 * over-estimate of the common case — erring high means the page
 * reaches for a column slightly early, and a page that scrolls
 * when it did not have to is the complaint this feature exists
 * to answer.
 *
 * It only has to be right to within about a card: being one out
 * shifts a borderline viewport by one column, which is taste.
 */
const CARD_HEIGHT_PX = 150

/**
 * Everything on the page that is not a card: the header, the
 * host row, the drive rail, the bucket labels.
 */
const CHROME_HEIGHT_PX = 260

/** `"auto"`, or the number of columns the owner asked for. */
export type ColumnChoice = "auto" | number

export const COLUMN_CHOICES: readonly ColumnChoice[] = [
  "auto",
  1,
  2,
  3,
  4,
]

/**
 * Where the manual override lives between visits.
 *
 * Namespaced because this origin also serves `/json` and may one
 * day serve something else that wants a `columns` key.
 */
export const COLUMNS_STORAGE_KEY = "rip-deck.layout-columns"

export type Viewport = {
  width: number
  height: number
}

/**
 * The column count AUTO wants, for one viewport and one rack.
 *
 * Pure, and exported for the tests — the only proof this reads
 * the owner's rule the way he stated it is a table of sizes with
 * the answers written down beside them.
 */
export function chooseAutoColumns({
  cardCount,
  viewport,
}: {
  cardCount: number
  viewport: Viewport
}): number {
  // Width is a CAP, never a reason. This is the "don't go 9-wide
  // just because you're on an ultrawide" half of the rule.
  const widthCap = Math.max(
    1,
    Math.min(
      MAX_AUTO_COLUMNS,
      Math.floor(viewport.width / MIN_COLUMN_WIDTH_PX),
    ),
  )

  if (cardCount <= 1) return 1

  // Height is the reason. How many cards stack inside the
  // viewport, then how many stacks that many cards need.
  const rowsThatFit = Math.max(
    1,
    Math.floor(
      (viewport.height - CHROME_HEIGHT_PX) / CARD_HEIGHT_PX,
    ),
  )
  const columnsNeeded = Math.ceil(cardCount / rowsThatFit)

  return Math.max(1, Math.min(widthCap, columnsNeeded))
}

/**
 * How wide the page itself may grow, in rem, for a column count.
 *
 * A single column stays at the width it has always been — a
 * 2000 px-wide card is not a better card, it is one line of text
 * the eye has to track across a monitor. Beyond that the cap
 * grows with the columns, so three columns get room to be three
 * readable cards rather than three slivers.
 */
export const contentMaxWidthRem = (
  columns: number,
): number => (columns === 1 ? 56 : 34 * columns + 4)

const readViewport = (): Viewport => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

/**
 * The stored override, or `"auto"` for anything unreadable.
 *
 * Every failure lands on `"auto"` on purpose: a corrupt key, a
 * browser that refuses storage, a number somebody typed into
 * devtools. The default is the mode that works everywhere, so a
 * bad value costs a preference rather than a page.
 */
export const readStoredChoice = (): ColumnChoice => {
  let stored: string | null = null

  try {
    stored = window.localStorage.getItem(
      COLUMNS_STORAGE_KEY,
    )
  } catch {
    return "auto"
  }

  if (stored === null || stored === "auto") return "auto"

  const parsed = Number(stored)

  if (!Number.isInteger(parsed)) return "auto"

  if (parsed < 1 || parsed > MAX_MANUAL_COLUMNS) {
    return "auto"
  }

  return parsed
}

export function useLayoutColumns({
  cardCount,
}: {
  /**
   * How many bays the rack has — the card count this page is
   * being asked to fit. Bays rather than rendered cards: the
   * buckets shuffle between polls and a column count that
   * reflowed every time a rip finished would be worse than one
   * that is a card out.
   */
  cardCount: number
}): {
  /** What to actually draw. */
  columns: number
  /** What the owner picked, `"auto"` included. */
  choice: ColumnChoice
  /** What AUTO would pick right now, shown beside the control. */
  autoColumns: number
  setChoice: (choice: ColumnChoice) => void
} {
  const [viewport, setViewport] =
    useState<Viewport>(readViewport)
  const [choice, setStoredChoice] = useState<ColumnChoice>(
    readStoredChoice,
  )

  useEffect(() => {
    const handleResize = () => {
      const next = readViewport()

      // Same size, same object — a resize event fires many times
      // per drag and every one of them would otherwise re-render
      // nine cards.
      setViewport((current) =>
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      )
    }

    window.addEventListener("resize", handleResize)

    return () => {
      window.removeEventListener("resize", handleResize)
    }
  }, [])

  const setChoice = useCallback((next: ColumnChoice) => {
    setStoredChoice(next)

    // A storage failure must not swallow the click. The
    // preference is a nicety; the column count the owner just
    // asked for is not.
    try {
      window.localStorage.setItem(
        COLUMNS_STORAGE_KEY,
        String(next),
      )
    } catch {
      // Private-mode Safari and friends. Nothing to do.
    }
  }, [])

  const autoColumns = chooseAutoColumns({
    cardCount,
    viewport,
  })

  return {
    columns: choice === "auto" ? autoColumns : choice,
    choice,
    autoColumns,
    setChoice,
  }
}
