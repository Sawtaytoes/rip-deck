import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import { ClearLoadedButton } from "./ClearLoadedButton"

/**
 * The "took the trash out" button on the loaded-discs reminder.
 *
 * ⚠️ What this pins is that the press is a plain `clear_loaded` the
 * daemon owns — never a decision this component makes about which
 * discs to forget — and that a press which changes nothing SAYS so,
 * whether the endpoint was unreachable or the daemon simply
 * answered "nothing to clear". Success needs no assertion here: a
 * clear that lands makes the whole banner unmount, which is the
 * confirmation, and is `HostSection`'s to render.
 */

describe("ClearLoadedButton", () => {
  it("sends a plain clear_loaded, no bay and no name", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(
        buildTrayCommandReport({ command: "clear_loaded" }),
      ),
    )

    renderWithProviders(
      <ClearLoadedButton />,
      createStubDataSource({ runTrayCommand }),
    )

    await userEvent.click(
      screen.getByRole("button", {
        name: "🗑 Mark as taken out",
      }),
    )

    await waitFor(() => {
      expect(runTrayCommand).toHaveBeenCalledWith({
        command: "clear_loaded",
        driveId: undefined,
        name: undefined,
      })
    })
  })

  it("⚠️ shows the daemon's answer when nothing was cleared", async () => {
    // The silence that made a wrong answer look like a broken
    // button: the daemon replied "nothing to clear", the banner
    // stayed put, and this component rendered none of it — so the
    // owner pressed it again, and again (2026-08-20).
    renderWithProviders(
      <ClearLoadedButton />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              command: "clear_loaded",
              message:
                "Nothing was loaded, so there was no " +
                "reminder to clear.",
            }),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", {
        name: "🗑 Mark as taken out",
      }),
    )

    await waitFor(() => {
      expect(
        screen.getByText(/no reminder to clear/),
      ).toBeInTheDocument()
    })
  })

  it("shows why the clear did not land", async () => {
    // The endpoint was unreachable, so the banner is still here —
    // a press that looked ignored is worse than one that explains
    // itself.
    renderWithProviders(
      <ClearLoadedButton />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.reject(
            new Error("503 Service Unavailable"),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", {
        name: "🗑 Mark as taken out",
      }),
    )

    await waitFor(() => {
      expect(
        screen.getByText(/could not clear the reminder/),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByText(/503 Service Unavailable/),
    ).toBeInTheDocument()
  })
})
