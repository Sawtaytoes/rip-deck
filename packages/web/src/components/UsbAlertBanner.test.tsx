import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { TowerAlert } from "../types"
import { UsbAlertBanner } from "./UsbAlertBanner"

const usbAlert = (
  overrides: Partial<TowerAlert> = {},
): TowerAlert => ({
  verdict: "hub_fault",
  subject: "hub",
  action: "check_hub",
  message:
    "The USB connection to the tower keeps dropping and " +
    "reconnecting. Try a different USB cable or port.",
  confidence: "confirmed",
  is_announceable: false,
  drive_ids: ["usb-2-1-1-2-4-4-7", "usb-2-1-1-2-4-4-8"],
  labels: [
    "07 - Pioneer BDR-211M",
    "08 - Pioneer BDR-211M",
  ],
  ...overrides,
})

describe("UsbAlertBanner", () => {
  it("renders nothing while the bus is steady", () => {
    const { container } = render(
      <UsbAlertBanner alert={null} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("tells the owner to change the cable, naming the bays", () => {
    render(<UsbAlertBanner alert={usbAlert()} />)

    expect(
      screen.getByText(/keeps dropping and reconnecting/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/07 - Pioneer BDR-211M/),
    ).toBeInTheDocument()
  })

  it("shows without a bay list when no drive is named", () => {
    // A flap the detector caught but could not pin to a specific
    // bay still warns — the message is the point, the list is a
    // bonus. Never a blank "Seen flapping:" line.
    render(
      <UsbAlertBanner alert={usbAlert({ labels: [] })} />,
    )

    expect(
      screen.getByText(/keeps dropping and reconnecting/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Seen flapping/),
    ).not.toBeInTheDocument()
  })
})
