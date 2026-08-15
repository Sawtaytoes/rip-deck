import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { LoadedDiscsView } from "../types"
import { LoadedDiscsBanner } from "./LoadedDiscsBanner"

/**
 * The take-the-discs-out reminder.
 *
 * ⚠️ The case it exists for is a tower that has been switched
 * OFF, which renders no cards at all — so this banner is then the
 * only thing on the page, and a test that only covers the
 * tower-on path would miss the whole point.
 */

const loaded = (
  overrides: Partial<LoadedDiscsView> = {},
): LoadedDiscsView => ({
  count: 2,
  slots: [7, 9],
  discs: [
    {
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      title: "TROY - BONUS DISC",
      is_ripped: true,
    },
    {
      slot: 9,
      label: "09 - Pioneer BDR-211M",
      title: null,
      is_ripped: false,
    },
  ],
  is_tower_on: false,
  message:
    "2 discs are still in the tower — slots 7 and 9. The " +
    "tower is off, so the trays cannot open until it is " +
    "powered back on.",
  spoken_message:
    "2 discs are still in the optical ripper tower.",
  updated_at: 0,
  ...overrides,
})

describe("LoadedDiscsBanner", () => {
  it("renders the daemon's sentence, not one of its own", () => {
    // The daemon already knows whether the tower is on, which
    // changes what the reminder asks the reader to DO. A second
    // phrasing here would drift from the one Home Assistant
    // speaks out loud.
    render(<LoadedDiscsBanner loaded={loaded()} />)

    expect(
      screen.getByText(/2 discs are still in the tower/),
    ).toHaveTextContent("The tower is off")
  })

  it("names each disc and where to find it", () => {
    render(<LoadedDiscsBanner loaded={loaded()} />)

    expect(
      screen.getByText("TROY - BONUS DISC · slot 7"),
    ).toBeInTheDocument()

    // A bay whose disc was never named still earns its slot —
    // dropping it would make the list disagree with the count.
    expect(screen.getByText("slot 9")).toBeInTheDocument()
  })

  it("says nothing when the trays are empty", () => {
    render(
      <LoadedDiscsBanner
        loaded={loaded({
          count: 0,
          discs: [],
          message: "",
        })}
      />,
    )

    expect(
      screen.queryByLabelText("Discs still in the tower"),
    ).not.toBeInTheDocument()
  })

  it("says nothing against a daemon too old to answer", () => {
    // `loaded_discs` is optional on the wire; a missing field is
    // "this daemon does not know", which must not render as an
    // all-clear OR as a reminder.
    render(<LoadedDiscsBanner loaded={undefined} />)

    expect(
      screen.queryByLabelText("Discs still in the tower"),
    ).not.toBeInTheDocument()
  })
})
