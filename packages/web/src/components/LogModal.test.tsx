import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "../testing/renderWithProviders"
import { createStubDataSource } from "../testing/stubDataSource"
import { LogModal } from "./LogModal"

/**
 * The capture tail (§7: *"there's no log view […] If something
 * goes wrong, do you wanna see the log?"*).
 *
 * ⚠️ The tests that matter here are about what the modal does
 * NOT do: it does not paraphrase a robot log, and it does not
 * claim to have loaded the whole file when the daemon may have
 * ignored the parameter asking for it.
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

  it("shows the capture exactly as the daemon wrote it", async () => {
    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({
        fetchLog: () => Promise.resolve(CAPTURE),
      }),
    )

    const body = await screen.findByText(
      /Failed to save title 3/,
    )

    // Byte for byte. No summary, no verdict, no highlighted
    // "error" banner — reading structure out of MakeMKV's prose
    // by matching it is the MSG:5072 mistake, and a diagnosis
    // screen is the worst place to repeat it.
    expect(body.textContent).toBe(CAPTURE)
  })

  it("asks for a tail first, not three megabytes", async () => {
    const fetchLog = vi.fn(() => Promise.resolve(CAPTURE))

    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({ fetchLog }),
    )

    await waitFor(() => {
      expect(fetchLog).toHaveBeenCalledWith(
        "fixture-job-7",
        600,
      )
    })
  })

  it("asks for more, and reports what actually arrived", async () => {
    const fetchLog = vi.fn((_uuid: string, lines) =>
      Promise.resolve(
        lines === 600 ? CAPTURE : `${CAPTURE}\nMSG:5011`,
      ),
    )

    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({ fetchLog }),
    )

    expect(
      await screen.findByText("3 lines"),
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: "Load more" }),
    )

    expect(
      await screen.findByText("4 lines"),
    ).toBeInTheDocument()
  })

  // ⚠️ `lines` / `all=1` are the WEB side's proposal. A daemon
  // that does not implement them answers with its own default
  // tail and no error, so the control must never promise
  // "everything" — it retires instead.
  it("retires the control when the answer stops growing", async () => {
    renderWithProviders(
      <LogModal target={TARGET} onClose={() => {}} />,
      createStubDataSource({
        fetchLog: () => Promise.resolve(CAPTURE),
      }),
    )

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Load more",
      }),
    )

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument()
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
