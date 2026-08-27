import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { buildBayView } from "../testing/buildRip"
import type { BayView } from "../types"
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

  /** The chip is the span wrapping the label and the detail. */
  const chipAround = (detail: string): HTMLElement => {
    const found = screen.getByText(detail).parentElement

    if (found === null) throw new Error("chip not found")

    return found
  }

  const buildBayInState = (
    state: BayView["state"]["state"],
    verdict: BayView["state"]["verdict"] = "ok",
  ): BayView =>
    buildBayView({
      drive_id: "usb-a",
      state: {
        ...buildBayView().state,
        state,
        verdict,
        progress_percent: 62,
      },
    })

  // ⚠️ The bug the owner reported from the rack: a rip that
  // produced NO backup wore the same green as one that did,
  // because `failed` sat in a "latched" set beside `completed`.
  it("paints a failed bay red, never the finished green", () => {
    render(<DriveRail bays={[buildBayInState("failed")]} />)

    const chip = chipAround("failed")

    expect(chip.className).toContain("intent-danger")
    expect(chip.className).not.toContain("intent-success")
  })

  // The verdict names the action, so it stays the word on the
  // chip. It must not soften the colour: no backup exists.
  it("keeps a failed bay red even with a disc verdict", () => {
    render(
      <DriveRail
        bays={[buildBayInState("failed", "disc_scratched")]}
      />,
    )

    const chip = chipAround("disc_scratched")

    expect(chip.className).toContain("intent-danger")
    expect(chip.className).not.toContain("intent-warning")
  })

  // The owner stopped it, so it is not an alarm — and it made no
  // backup, so it is not a success either.
  it("shows a cancelled bay as neither green nor an alarm", () => {
    render(
      <DriveRail bays={[buildBayInState("cancelled")]} />,
    )

    const chip = chipAround("cancelled")

    expect(chip.className).not.toContain("intent-success")
    expect(chip.className).not.toContain("intent-danger")
  })

  it("still reads a completed bay as done, in green", () => {
    render(
      <DriveRail bays={[buildBayInState("completed")]} />,
    )

    expect(chipAround("done").className).toContain(
      "intent-success",
    )
  })

  it("renders nothing when the tower is switched off", () => {
    // F3. The empty-rack wording belongs to `HostSection`; the
    // rail must not invent an empty-state of its own.
    const { container } = render(<DriveRail bays={[]} />)

    expect(container).toBeEmptyDOMElement()
  })
})
