import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildBayView } from "../testing/buildRip"
import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayBayReport,
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import type { BayView, RipDeckDataSource } from "../types"
import { QuarantinedBayCard } from "./QuarantinedBayCard"

/**
 * A bay taken out of service.
 *
 * The control that matters here is the tray: quarantine's
 * documented way out is "take the disc out to re-arm this bay",
 * and without one a disc is locked in a drive no button opens.
 */

const noop = () => {
  // intentionally empty
}

const buildQuarantinedBay = (
  overrides: Partial<BayView> = {},
): BayView => {
  const base = buildBayView()

  return {
    ...base,
    is_quarantined: true,
    quarantine_reason:
      "Three spawn failures in a row — clear it once the " +
      "drive has been looked at.",
    actions: ["clear_quarantine"],
    state: { ...base.state, state: "idle", job_id: null },
    ...overrides,
  }
}

const renderCard = (
  ui: ReactElement,
  dataSource: RipDeckDataSource = createStubDataSource(),
) => renderWithProviders(ui, dataSource)

describe("QuarantinedBayCard", () => {
  it("names the slot and the bare drive, and says why", () => {
    renderCard(
      <QuarantinedBayCard
        bay={buildQuarantinedBay()}
        onAction={noop}
      />,
    )

    expect(screen.getByText("Slot 7")).toBeInTheDocument()
    expect(
      screen.getByText(/Pioneer BDR-211M · out of service/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/07 - Pioneer/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Three spawn failures/),
    ).toBeInTheDocument()
  })

  it("keeps the human's clear control", async () => {
    const onAction = vi.fn()

    renderCard(
      <QuarantinedBayCard
        bay={buildQuarantinedBay()}
        onAction={onAction}
      />,
    )

    await userEvent.click(
      screen.getByRole("button", {
        name: "Clear quarantine",
      }),
    )

    expect(onAction).toHaveBeenCalledWith({
      driveId: "usb-2-1-1-2-4-4-7",
      label: "07 - Pioneer BDR-211M",
      action: "clear_quarantine",
    })
  })

  // Quarantine says nothing about what is in the drive, so
  // `trayActionsFor` calls the bay eligible for both directions
  // — which is exactly where one toggle beats two buttons.
  it("offers the ⏏ toggle so a trapped disc can come out", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(buildTrayCommandReport()),
    )

    renderCard(
      <QuarantinedBayCard
        bay={buildQuarantinedBay()}
        onAction={noop}
      />,
      createStubDataSource({ runTrayCommand }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Open tray" }),
    )

    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "open_bay",
      driveId: "usb-2-1-1-2-4-4-7",
    })
  })

  it("reports the bay's own answer to a tray press", async () => {
    renderCard(
      <QuarantinedBayCard
        bay={buildQuarantinedBay()}
        onAction={noop}
      />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              message: "Opened 1 tray.",
              bays: [
                buildTrayBayReport({
                  result: "skipped_no_disc",
                  detail: "Slot 7 has nothing in it.",
                }),
              ],
            }),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Open tray" }),
    )

    await waitFor(() => {
      expect(
        screen.getByText("Slot 7 has nothing in it."),
      ).toBeInTheDocument()
    })
  })
})
