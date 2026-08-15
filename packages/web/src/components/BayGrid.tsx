import { Children, type ReactNode } from "react"

/**
 * One bucket of bay cards, laid out side by side.
 *
 * Two jobs, and the second is the important one.
 *
 * **It draws the columns.** `grid-template-columns` is inline
 * because the count is a runtime number — `useLayoutColumns`
 * decides it from the viewport and from what the owner picked —
 * and a class per possible count would be four classes that must
 * all survive Tailwind's scan of the source.
 *
 * **It gives every card a QUERY CONTAINER.** Each cell is
 * `container-name: bay; container-type: inline-size`, so a card
 * can size itself against the space it was handed instead of
 * against the window. That distinction is the whole reason this
 * wrapper exists rather than a bare `grid` class: at three
 * columns on a wide monitor each card is ~400 px wide, which is
 * phone-shaped, and a card reading `@media` would draw its full
 * desktop density into a column that cannot hold it. The
 * viewport is not the space the card is in.
 *
 * The contract with the card, verbatim:
 *
 *   container name : `bay`
 *   container type : `inline-size`
 *   narrow density : `@max-md/bay:` — under 28rem / 448px
 *   full density   : `@md/bay:`     — 28rem / 448px and up
 *
 * The card owns everything inside that; this file owns nothing
 * inside it. `min-w-0` on the cell is not decoration — without
 * it a grid item's automatic minimum size is its content, and
 * one long destination path would push every column out of the
 * viewport.
 */
export function BayGrid({
  columns,
  children,
}: {
  columns: number
  children: ReactNode
}) {
  return (
    <div
      // Read by the layout tests and by the browser sweep, which
      // is the only way to state an OBSERVED column count rather
      // than an intended one.
      data-columns={columns}
      className="grid items-start gap-x-3"
      style={{
        gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
      }}
    >
      {Children.map(children, (child) => (
        <div className="@container/bay min-w-0">
          {child}
        </div>
      ))}
    </div>
  )
}
