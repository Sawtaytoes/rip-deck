import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "../testing/renderWithProviders"
import { createStubDataSource } from "../testing/stubDataSource"
import type { Leftover } from "../types"
import { LeftoverRips } from "./LeftoverRips"

/**
 * ⚠️ What this pins: the panel is INVISIBLE when there is nothing
 * to clear, an unfinished rip and a finished duplicate are told
 * apart on sight, the daemon's own sentence is what gets rendered,
 * and a REFUSAL stays on screen instead of being thrown away. That
 * last one is the failure `ClearLoadedButton` was built to stop
 * repeating: a button that looks dead because the daemon's answer
 * went into a variable nobody rendered.
 */

const buildLeftover = (
  overrides: Partial<Leftover> = {},
): Leftover => ({
  path: "/media/Disc-Rips/.rip-deck-incomplete-abc-123",
  name: ".rip-deck-incomplete-abc-123",
  kind: "incomplete",
  occupied_name: null,
  size_bytes: 0,
  disc_structure: null,
  modified_at_ms: 1_787_700_000_000,
  detail: "An EMPTY rip folder.",
  is_safe_to_delete: true,
  ...overrides,
})

describe("LeftoverRips", () => {
  it("⚠️ renders NOTHING when there is nothing to clear", async () => {
    // A chore that is usually already done. An empty panel every
    // day teaches the eye to skip the place the real one appears.
    const { container } = renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () => Promise.resolve([]),
      }),
    )

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement()
    })
  })

  it("tells an unfinished rip from a finished duplicate", async () => {
    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([
            buildLeftover(),
            buildLeftover({
              path: "/media/Disc-Rips/Ivanhoe (rip-deck-duplicate-01234567)",
              name: "Ivanhoe (rip-deck-duplicate-01234567)",
              kind: "duplicate",
              occupied_name: "Ivanhoe",
              size_bytes: 22_400_000_000,
              disc_structure: "BDMV",
              detail: "A FINISHED rip that landed beside…",
              is_safe_to_delete: false,
            }),
          ]),
      }),
    )

    expect(
      await screen.findByText("Unfinished"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Finished — duplicate"),
    ).toBeInTheDocument()

    // The daemon's words, not ours.
    expect(
      screen.getByText("An EMPTY rip folder."),
    ).toBeInTheDocument()

    // 0 bytes reads as "empty", never "0.0 GB" — that exact
    // number is the MSG:5068 signature an operator acts on.
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.getByText("22.4 GB")).toBeInTheDocument()
  })

  it("clears one by its exact path", async () => {
    const deleteLeftover = vi.fn(() =>
      Promise.resolve({
        ok: true,
        msg: "Cleared .rip-deck-incomplete-abc-123.",
        leftovers: [],
      }),
    )

    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
        deleteLeftover,
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete" }),
    )

    await waitFor(() => {
      expect(deleteLeftover).toHaveBeenCalledWith({
        path: "/media/Disc-Rips/.rip-deck-incomplete-abc-123",
      })
    })
  })

  it("⚠️ RENDERS a refusal rather than swallowing it", async () => {
    // "That is a finished rip, not a leftover" is the most useful
    // sentence this endpoint produces. It must reach the screen.
    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
        deleteLeftover: () =>
          Promise.resolve({
            ok: false,
            msg: "Refused to delete: that is a finished rip.",
            leftovers: [buildLeftover()],
          }),
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete" }),
    )

    expect(
      await screen.findByText(
        "Refused to delete: that is a finished rip.",
      ),
    ).toBeInTheDocument()

    // Still listed, because nothing was removed.
    expect(
      screen.getByText(".rip-deck-incomplete-abc-123"),
    ).toBeInTheDocument()
  })
})
