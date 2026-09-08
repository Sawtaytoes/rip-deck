import { screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "../testing/renderWithProviders"
import { createStubDataSource } from "../testing/stubDataSource"
import { LogModal } from "./LogModal"

/**
 * The web log is an operator view over the retained raw capture.
 */

/**
 * jsdom ships `<dialog>` without `showModal`/`close`.
 *
 * Stubbed here rather than in the shared setup: it is this one
 * component's dependency, and the native dialog is what buys
 * Escape-to-close and focus handling in a real browser.
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal =
    function showModal() {
      this.open = true
    }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
})

const TARGET = {
  jobUuid: "fixture-job-7",
  label: "Ivanhoe",
}

// A robot log is a parsed format. This is a real-shaped scrap of
// one, including the message code whose "helpful" interpretation
// was the MSG:5072 bug.
const CAPTURE = [
  'MSG:3007,0,0,"Using direct disc access mode"',
  'MSG:5072,0,0,"Failed to save title 3"',
  "PRGV:4096,8192,65536",
].join("\n")

describe("LogModal", () => {
  it("stays shut until a job is named", () => {
    renderWithProviders(
      <LogModal target={null} onClose={() => {}} />,
      createStubDataSource(),
    )

    expect(
      screen.queryByText(/Load more/),
    ).not.toBeInTheDocument()
  })

  it("shows important messages without progress telemetry", async () => {
    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({
        fetchLog: () => Promise.resolve(CAPTURE),
      }),
    )

    const body = await screen.findByText(
      /Failed to save title 3/,
    )

    expect(body.textContent).toBe(
      'MSG:5072,0,0,"Failed to save title 3"',
    )
  })

  it("asks for the bounded complete capture once", async () => {
    const fetchLog = vi.fn(() => Promise.resolve(CAPTURE))

    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({ fetchLog }),
    )

    await waitFor(() => {
      expect(fetchLog).toHaveBeenCalledWith(
        "fixture-job-7",
        "all",
      )
    })
  })

  it("shows a failed fetch rather than an empty box", async () => {
    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({
        fetchLog: () =>
          Promise.reject(new Error("/logs failed: 404")),
      }),
    )

    expect(
      await screen.findByText(/\/logs failed: 404/),
    ).toBeInTheDocument()
  })
})
