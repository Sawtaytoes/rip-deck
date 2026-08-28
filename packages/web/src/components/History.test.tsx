import {
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "../testing/renderWithProviders"
import { createStubDataSource } from "../testing/stubDataSource"
import type {
  HistoryPage,
  HistoryRip,
  RipDeckDataSource,
} from "../types"
import { History } from "./History"

/**
 * ⚠️ What this pins:
 *
 *  - a rip that FINISHED while the drive logged read errors shows
 *    both facts, because the green chip swallowing the second one
 *    is ARM #1298 and the reason this project exists;
 *  - "the disc had no name" and "nobody recorded a name" are told
 *    apart, because only one of them is a limit of ours;
 *  - an empty list says which of the two empties it is, so a
 *    narrowed filter does not read as an empty tower;
 *  - a filter change RESETS the page, so a narrowed search cannot
 *    leave the reader on page 3 of a one-page result;
 *  - the daemon's own outcome sentence is rendered, not rewritten.
 *
 * ⚠️ Outcome chips are asked for INSIDE the list. "Finished" is
 * also a word on the outcome filter three inches above, so an
 * unscoped `getByText("Finished")` matches the control rather
 * than the card — and the negative form of that assertion passes
 * for the wrong reason forever.
 */

const inList = () =>
  within(
    screen.getByRole("list", { name: "Finished rips" }),
  )

/**
 * A stub typed as the real member, not a bare `vi.fn()`.
 *
 * A bare one infers `any`, which the type-aware lint refuses —
 * and rightly: an `any` mock cannot tell you that the page called
 * `fetchHistory` with the wrong shape, which is exactly what the
 * offset and filter assertions below are for.
 */
const mockFetchHistory = () =>
  vi.fn<RipDeckDataSource["fetchHistory"]>()

/**
 * What the page last ASKED the daemon for.
 *
 * Read off the recorded call rather than matched with
 * `expect.objectContaining`, which returns `any` and takes the
 * type-aware lint with it. Reading the argument keeps the
 * assertion typed — a renamed filter field fails the typecheck
 * instead of quietly matching nothing.
 */
const lastRequest = (
  fetchHistory: ReturnType<typeof mockFetchHistory>,
) => fetchHistory.mock.calls.at(-1)?.[0]

const buildRip = (
  overrides: Partial<HistoryRip> = {},
): HistoryRip => ({
  job_uuid: "a1659124-308c-4f16-be4f-e0be021fee87",
  drive_id: "2-1.1.2.4.2",
  slot: 5,
  bay_name: "05 - Pioneer BDR-212U",
  disc_name: "THE MUMMY",
  is_named: true,
  disctype: "bluray",
  destination_path: "/media/Disc-Rips/The Mummy - Blu-ray",
  size_bytes: 45_400_000_000,
  started_at_ms: 1_787_800_000_000,
  finished_at_ms: 1_787_801_830_000,
  duration_ms: 1_830_000,
  outcome_kind: "completed",
  outcome_detail:
    "Backup at /media/Disc-Rips/The Mummy - Blu-ray.",
  is_successful: true,
  failure_reason: null,
  verdict: "unknown",
  verdict_message: null,
  read_error_count: 0,
  throughput_bytes_per_sec: 24_800_000,
  has_log: true,
  source: "live",
  ...overrides,
})

const buildPage = (
  rips: HistoryRip[],
  overrides: Partial<HistoryPage> = {},
): HistoryPage => ({
  total: rips.length,
  total_unfiltered: rips.length,
  offset: 0,
  limit: 25,
  rips,
  oldest_at_ms:
    rips.length === 0
      ? null
      : Math.min(...rips.map((one) => one.finished_at_ms)),
  newest_at_ms:
    rips.length === 0
      ? null
      : Math.max(...rips.map((one) => one.finished_at_ms)),
  ...overrides,
})

describe("History", () => {
  it("lists a finished rip with its own sentence", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(buildPage([buildRip()])),
      }),
    )

    expect(
      await screen.findByText("THE MUMMY"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Backup at /media/Disc-Rips/The Mummy - Blu-ray.",
      ),
    ).toBeInTheDocument()
    expect(
      inList().getByText("Finished"),
    ).toBeInTheDocument()
  })

  it("⚠️ shows read errors on a rip that FINISHED", async () => {
    // ARM reports this as a clean success
    // (automatic-ripping-machine#1298) and it is the defect this
    // whole project was built around. The chip and the count are
    // two different facts and the card must carry both.
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(
            buildPage([buildRip({ read_error_count: 14 })]),
          ),
      }),
    )

    expect(
      await screen.findByText("14 read errors"),
    ).toBeInTheDocument()
    expect(
      inList().getByText("Finished"),
    ).toBeInTheDocument()
  })

  it("⚠️ never calls a flagged bay finished", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(
            buildPage([
              buildRip({
                is_successful: false,
                outcome_detail:
                  "udev and sysfs disagree about what is in " +
                  "this drive.",
                outcome_kind: "needs_attention",
              }),
            ]),
          ),
      }),
    )

    expect(
      await screen.findByText("Flagged"),
    ).toBeInTheDocument()
    expect(
      inList().queryByText("Finished"),
    ).not.toBeInTheDocument()
  })

  it("⚠️ tells an unnamed disc from an unrecorded name", async () => {
    // One is a fact about the disc, the other is a limit of ours.
    // A blank for both would let the reader assume the disc had
    // no label, which is a claim nobody checked.
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(
            buildPage([
              buildRip({
                disc_name: null,
                is_named: true,
                job_uuid: "unnamed-disc",
              }),
              buildRip({
                disc_name: null,
                is_named: false,
                job_uuid: "rebuilt-row",
                source: "backfill",
              }),
            ]),
          ),
      }),
    )

    expect(
      await screen.findByText("Disc not identified"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Name not recorded"),
    ).toBeInTheDocument()
  })

  it("offers Logs only when a capture exists", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(
            buildPage([buildRip({ has_log: false })]),
          ),
      }),
    )

    await screen.findByText("THE MUMMY")

    expect(
      screen.queryByRole("button", { name: "Logs" }),
    ).not.toBeInTheDocument()
  })

  it("⚠️ says an empty list is the FILTER's doing, not the tower's", async () => {
    // Two states that look identical without `total_unfiltered`,
    // and only one of them is worth offering a button over.
    const fetchHistory = mockFetchHistory()
      .mockResolvedValueOnce(buildPage([buildRip()]))
      .mockResolvedValue(
        buildPage([], { total_unfiltered: 42 }),
      )

    renderWithProviders(
      <History />,
      createStubDataSource({ fetchHistory }),
    )

    await screen.findByText("THE MUMMY")

    await userEvent.type(
      screen.getByLabelText("Search"),
      "nothing matches this",
    )

    expect(
      await screen.findByText("No rips match"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/42 in the history altogether/),
    ).toBeInTheDocument()
  })

  it("says an empty HISTORY is empty, with nothing to clear", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () => Promise.resolve(buildPage([])),
      }),
    )

    expect(
      await screen.findByText("No rips in the history"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: "Clear filters",
      }),
    ).not.toBeInTheDocument()
  })

  it("narrows to failures, and asks the daemon for them", async () => {
    const fetchHistory =
      mockFetchHistory().mockResolvedValue(
        buildPage([buildRip()]),
      )

    renderWithProviders(
      <History />,
      createStubDataSource({ fetchHistory }),
    )

    await screen.findByText("THE MUMMY")

    await userEvent.click(
      screen.getByRole("radio", { name: "Not finished" }),
    )

    await waitFor(() => {
      expect(
        lastRequest(fetchHistory)?.filters.outcome,
      ).toBe("failed")
    })
  })

  it("⚠️ resets to the first page when a filter moves", async () => {
    // Otherwise a narrowed search leaves the reader on page 3 of
    // a result that now has one page, i.e. looking at nothing.
    const fetchHistory =
      mockFetchHistory().mockResolvedValue(
        buildPage([buildRip()], { total: 60 }),
      )

    renderWithProviders(
      <History />,
      createStubDataSource({ fetchHistory }),
    )

    await screen.findByText("THE MUMMY")

    await userEvent.click(
      screen.getByRole("button", { name: "Older" }),
    )

    await waitFor(() => {
      expect(lastRequest(fetchHistory)?.offset).toBe(25)
    })

    await userEvent.click(
      screen.getByRole("radio", { name: "Finished" }),
    )

    await waitFor(() => {
      expect(lastRequest(fetchHistory)?.offset).toBe(0)
    })
  })

  it("hides the pager when everything fits on one page", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(buildPage([buildRip()])),
      }),
    )

    await screen.findByText("THE MUMMY")

    expect(
      screen.queryByRole("button", { name: "Older" }),
    ).not.toBeInTheDocument()
  })

  it("reports a daemon that will not answer", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.reject(
            new Error("/api/history failed: 503"),
          ),
      }),
    )

    expect(
      await screen.findByText("Could not read the history"),
    ).toBeInTheDocument()
  })

  it("keeps the Deck destination in the shared navigation", async () => {
    renderWithProviders(
      <History />,
      createStubDataSource({
        fetchHistory: () =>
          Promise.resolve(buildPage([buildRip()])),
      }),
    )

    const navigation = await screen.findByRole(
      "navigation",
      {
        name: "Main",
      },
    )

    expect(
      within(navigation).getByRole("link", {
        name: "Deck",
      }),
    ).toHaveAttribute("href", "/")
  })
})
