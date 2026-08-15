import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { TowerAlert } from "../types"
import { TowerAlerts } from "./TowerAlerts"

const buildAlert = (
  overrides: Partial<TowerAlert> = {},
): TowerAlert => ({
  verdict: "hub_fault",
  subject: "hub",
  action: "check_hub",
  message:
    "Several drives on the same USB hub stopped responding " +
    "together — this is the hub or its power, not your discs.",
  confidence: "confirmed",
  is_announceable: true,
  drive_ids: ["usb-a", "usb-b", "usb-c", "usb-d"],
  labels: [
    "04 - Pioneer BDR-211M",
    "05 - Pioneer BDR-211M",
    "06 - Pioneer BDR-211M",
    "07 - Pioneer BDR-211M",
  ],
  ...overrides,
})

describe("TowerAlerts", () => {
  it("states a hub fault once, naming every bay it touched", () => {
    render(<TowerAlerts alerts={[buildAlert()]} />)

    expect(
      screen.getByText(/not your discs/),
    ).toBeInTheDocument()
    expect(screen.getByText(/4 bays/)).toBeInTheDocument()
  })

  // A trouble confined to one bay is already fully told by that
  // bay's card. Repeating it here would make the banner a second
  // copy of the page, and then the hub fault it exists for gets
  // skimmed past.
  it("stays silent about a single-bay trouble", () => {
    const { container } = render(
      <TowerAlerts
        alerts={[
          buildAlert({
            verdict: "disc_dirty",
            drive_ids: ["usb-a"],
            labels: ["02 - Pioneer BDR-211M"],
          }),
        ]}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("says when MQTT has not announced a shared trouble", () => {
    // Only `confirmed` verdicts announce. A `suspected` one
    // showing up here for the first time is not a missed
    // notification, and saying so answers the question before it
    // is asked.
    render(
      <TowerAlerts
        alerts={[
          buildAlert({
            confidence: "suspected",
            is_announceable: false,
          }),
        ]}
      />,
    )

    expect(
      screen.getByText(/not announced/),
    ).toBeInTheDocument()
  })

  it("renders nothing at all when the tower is healthy", () => {
    const { container } = render(
      <TowerAlerts alerts={[]} />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
