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
 *
 * ⚠️ And for rename: the form starts from the name WITHOUT the
 * `(rip-deck-duplicate-…)` marker, the daemon is sent exactly
 * what was typed, and a refused rename leaves the folder listed
 * under its old name. That last one is the clobber guard seen
 * from the panel's side.
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

  it("⚠️ starts the rename from the name WITHOUT the duplicate marker", async () => {
    // Dropping `(rip-deck-duplicate-…)` is the main reason to
    // rename, so the operator should not have to delete it by
    // hand from a 70-character name.
    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([
            buildLeftover({
              path: "/media/Disc-Rips/TMNT - DVD (rip-deck-duplicate-68fa9004).iso",
              name: "TMNT - DVD (rip-deck-duplicate-68fa9004).iso",
              kind: "duplicate",
              occupied_name: "TMNT - DVD.iso",
              size_bytes: 8_203_894_784,
              disc_structure: "ISO",
              detail: "A FINISHED rip that landed beside…",
              is_safe_to_delete: false,
            }),
          ]),
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename" }),
    )

    expect(
      screen.getByRole("textbox", { name: /New name/ }),
    ).toHaveValue("TMNT - DVD.iso")
  })

  it("sends the daemon exactly the name that was typed", async () => {
    const renameLeftover = vi.fn(() =>
      Promise.resolve({
        ok: true,
        msg: "Renamed to TMNT Season 4 Disc 2 - DVD.iso.",
        leftovers: [],
      }),
    )

    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
        renameLeftover,
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename" }),
    )

    const field = screen.getByRole("textbox", {
      name: /New name/,
    })
    await userEvent.clear(field)
    await userEvent.type(
      field,
      "TMNT Season 4 Disc 2 - DVD",
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Save name" }),
    )

    await waitFor(() => {
      expect(renameLeftover).toHaveBeenCalledWith({
        newName: "TMNT Season 4 Disc 2 - DVD",
        path: "/media/Disc-Rips/.rip-deck-incomplete-abc-123",
      })
    })
  })

  it("⚠️ RENDERS a refused rename and keeps the old name listed", async () => {
    // "That name is already taken" is the sentence the whole
    // feature exists to be able to say. Nothing moved, so the
    // folder must still be on screen under its old name.
    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
        renameLeftover: () =>
          Promise.resolve({
            ok: false,
            msg: 'Refused to rename: "TMNT - DVD.iso" is already taken.',
            leftovers: [buildLeftover()],
          }),
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename" }),
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Save name" }),
    )

    expect(
      await screen.findByText(
        'Refused to rename: "TMNT - DVD.iso" is already taken.',
      ),
    ).toBeInTheDocument()

    expect(
      screen.getByText(".rip-deck-incomplete-abc-123"),
    ).toBeInTheDocument()
  })

  it("closes the form on Cancel without calling the daemon", async () => {
    const renameLeftover = vi.fn(() =>
      Promise.resolve({ ok: true, msg: "", leftovers: [] }),
    )

    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
        renameLeftover,
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename" }),
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel" }),
    )

    expect(
      screen.queryByRole("textbox", { name: /New name/ }),
    ).not.toBeInTheDocument()
    expect(renameLeftover).not.toHaveBeenCalled()
  })

  it("⚠️ disables Delete while the rename form is open", async () => {
    // Deleting the folder you are in the middle of renaming is
    // not a press anybody means to make.
    renderWithProviders(
      <LeftoverRips />,
      createStubDataSource({
        fetchLeftovers: () =>
          Promise.resolve([buildLeftover()]),
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename" }),
    )

    expect(
      screen.getByRole("button", { name: "Delete" }),
    ).toBeDisabled()
  })
})
