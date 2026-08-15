import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { buildBayView } from "../testing/buildRip"
import { DriveRail } from "./DriveRail"

describe("DriveRail", () => {
  // Slot, `/dev/srN` and MakeMKV's disc index are three
  // different numberings and only one of them is a place the
  // owner can walk up to and count.
  it("labels each chip with the slot, not the kernel name", () => {
    render(
      <DriveRail
        bays={[
          buildBayView({
            drive_id: "usb-a",
            slot: 7,
            dev_path: "/dev/sr2",
            label: "07 - Pioneer BDR-211M",
          }),
        ]}
      />,
    )

    expect(screen.getByText("07")).toBeInTheDocument()
    expect(
      screen.queryByText("sr2"),
    ).not.toBeInTheDocument()
  })

  it("shows an idle bay, which has no card of its own", () => {
    render(
      <DriveRail
        bays={[
          buildBayView({
            drive_id: "usb-a",
            slot: 1,
            state: {
              ...buildBayView().state,
              state: "idle",
              progress_percent: 0,
            },
          }),
        ]}
      />,
    )

    expect(screen.getByText("idle")).toBeInTheDocument()
  })

  it("shows progress for an active bay", () => {
    render(
      <DriveRail
        bays={[
          buildBayView({
            drive_id: "usb-a",
            state: {
              ...buildBayView().state,
              state: "ripping",
              progress_percent: 43,
            },
          }),
        ]}
      />,
    )

    expect(screen.getByText("43%")).toBeInTheDocument()
  })

  // Quarantine outranks everything: the bay is out of service,
  // so whatever its last job did is history.
  it("marks a quarantined bay ahead of anything else", () => {
    render(
      <DriveRail
        bays={[
          buildBayView({
            drive_id: "usb-a",
            is_quarantined: true,
            state: {
              ...buildBayView().state,
              state: "ripping",
              progress_percent: 43,
            },
          }),
        ]}
      />,
    )

    expect(
      screen.getByText("quarantined"),
    ).toBeInTheDocument()
    expect(
      screen.queryByText("43%"),
    ).not.toBeInTheDocument()
  })

  it("surfaces a verdict ahead of progress", () => {
    render(
      <DriveRail
        bays={[
          buildBayView({
            drive_id: "usb-a",
            state: {
              ...buildBayView().state,
              verdict: "disc_scratched",
            },
          }),
        ]}
      />,
    )

    expect(
      screen.getByText("disc_scratched"),
    ).toBeInTheDocument()
  })

  it("renders nothing when the tower is switched off", () => {
    // F3. The empty-rack wording belongs to `HostSection`; the
    // rail must not invent an empty-state of its own.
    const { container } = render(<DriveRail bays={[]} />)

    expect(container).toBeEmptyDOMElement()
  })
})
