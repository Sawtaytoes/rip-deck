import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayBayReport,
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import { TrayControls } from "./TrayControls"

/**
 * The header's three bulk controls.
 *
 * ⚠️ **Tower off is the one that matters here.** It cuts mains to
 * the rack, and the only thing standing between a press and a
 * destroyed rip is the daemon's refusal — so what this file pins
 * is that the refusal is RENDERED rather than swallowed, and that
 * the press is a plain `power_off` the daemon can say no to,
 * never a decision this component makes.
 */

describe("TrayControls", () => {
  it("sends the three bulk commands, unadorned", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(buildTrayCommandReport()),
    )

    renderWithProviders(
      <TrayControls />,
      createStubDataSource({ runTrayCommand }),
    )

    for (const [name, command] of [
      ["⏏ Open trays", "open_trays"],
      ["Close trays", "close_trays"],
      ["Tower off", "power_off"],
    ] as const) {
      await userEvent.click(
        screen.getByRole("button", { name }),
      )

      await waitFor(() => {
        expect(runTrayCommand).toHaveBeenCalledWith({
          command,
          driveId: undefined,
          name: undefined,
        })
      })
    }
  })

  it("⚠️ renders the daemon's refusal to cut power", async () => {
    // `is_accepted: true` with a refused bay is the daemon saying
    // "I heard you, and no". Treating anything short of total
    // success as an error would throw away the single most
    // important sentence this button can produce.
    renderWithProviders(
      <TrayControls />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              command: "power_off",
              message:
                "NOT powering the tower off — slot 4 is " +
                "still ripping. Cutting power now would " +
                "lose it.",
              counts: {
                opened: 0,
                opened_not_ripped: 0,
                closed: 0,
                refused: 1,
                failed: 0,
                skipped: 0,
                rip_started: 0,
              },
              bays: [
                buildTrayBayReport({
                  slot: 4,
                  result: "refused_ripping",
                  detail:
                    "REFUSED — this bay is ripping. Nothing " +
                    "was touched.",
                }),
              ],
            }),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Tower off" }),
    )

    await waitFor(() => {
      expect(
        screen.getByText(/NOT powering the tower off/),
      ).toBeInTheDocument()
    })

    // The bay, by name — `counts.refused` says how many, only
    // this says which one to go and look at.
    expect(screen.getByText("slot 4")).toBeInTheDocument()
    expect(
      screen.getByText(/Nothing was touched/),
    ).toBeInTheDocument()
  })

  it("shows the trapped-disc warning it was given", async () => {
    // The owner's own call: warn, then power off anyway. The
    // warning is the daemon's words, so the UI must not quietly
    // drop it.
    renderWithProviders(
      <TrayControls />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              command: "power_off",
              message:
                "Turning the optical ripper tower off. ⚠️ 3 " +
                "discs are still loaded — slots 7, 8 and 9 — " +
                "and an unpowered drive will not open its tray.",
              bays: [],
            }),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Tower off" }),
    )

    await waitFor(() => {
      expect(
        screen.getByText(/still loaded — slots 7, 8 and 9/),
      ).toBeInTheDocument()
    })
  })
})
