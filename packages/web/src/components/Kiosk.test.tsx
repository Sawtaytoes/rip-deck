import {
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Navigate, Route, Routes } from "react-router"
import { expect, test, vi } from "vitest"
import { mockDataSource } from "../api/mockDataSource"
import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import { Kiosk } from "./Kiosk"

const routes = (
  <Routes>
    <Route
      path="/"
      element={<Navigate to="/kiosk" replace />}
    />
    <Route path="/kiosk" element={<Kiosk />} />
    <Route
      path="/kiosk/slots/:driveId"
      element={<Kiosk />}
    />
  </Routes>
)

test("shows nine rows, disc artwork and targeted controls, with a route back", async () => {
  const fixture =
    await mockDataSource.fetchState("nine-rips")
  const tower = fixture.ripDeck
  const bay = tower?.bays[0]
  if (!tower || !bay?.state.title)
    throw new Error("Fixture needs a named bay")
  const poster =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
  const state = {
    ...fixture,
    hosts: fixture.hosts.map((host) => ({
      ...host,
      rips: host.rips.map((rip) =>
        rip.drive_id === bay.drive_id
          ? { ...rip, poster }
          : rip,
      ),
    })),
    ripDeck: {
      ...tower,
      is_fake: false,
      bays: tower.bays.map((entry) =>
        entry.drive_id === bay.drive_id
          ? {
              ...entry,
              actions: [
                "open_bay" as const,
                "close_bay" as const,
              ],
              state: {
                ...entry.state,
                state: "completed" as const,
                progress_percent: 0,
              },
            }
          : entry,
      ),
    },
  }
  const runTrayCommand = vi.fn(async () =>
    buildTrayCommandReport(),
  )
  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => state,
      runTrayCommand,
    }),
  )
  expect(
    await screen.findAllByRole("link", {
      name: /^Slot \d:/,
    }),
  ).toHaveLength(9)
  expect(screen.queryByRole("heading")).toBeNull()
  // The visible label is the bare number — never the word "Slot" —
  // and the rip name is the headline of every row.
  const firstRow = screen.getByRole("link", {
    name: /^Slot 1:/,
  })
  expect(firstRow).toHaveTextContent(/^1/)
  expect(firstRow).toHaveTextContent(bay.state.title)
  // The progress bar's accessible name still says "slot"; it is
  // screen-reader only, so nothing visible may say the word.
  expect(
    within(firstRow).queryByText(/Slot/, {
      ignore: ".sr-only",
    }),
  ).toBeNull()
  await userEvent.click(firstRow)
  const heading = await screen.findByRole("heading", {
    name: new RegExp(`^1\\s*${bay.state.title}$`),
  })
  expect(heading).toBeVisible()
  expect(heading).not.toHaveTextContent("Slot")
  expect(screen.getByText("Success · 100%")).toBeVisible()
  expect(
    screen.getByRole("img", {
      name: `Poster for ${bay.state.title}`,
    }),
  ).toHaveAttribute("src", poster)
  expect(
    screen.getByRole("button", {
      name: "Open",
    }),
  ).toBeEnabled()
  expect(
    screen.getByRole("button", {
      name: "Close",
    }),
  ).toBeEnabled()
  await userEvent.click(
    screen.getByRole("button", { name: "Disc removed" }),
  )
  await waitFor(() =>
    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "clear_loaded",
      driveId: bay.drive_id,
      name: undefined,
    }),
  )
  await userEvent.click(
    screen.getByRole("link", { name: "Back" }),
  )
  expect(
    await screen.findAllByRole("link", {
      name: /^Slot \d:/,
    }),
  ).toHaveLength(9)
})

test("disables all physical controls for preview data and an active rip", async () => {
  const fixture =
    await mockDataSource.fetchState("nine-rips")
  const runTrayCommand = vi.fn()
  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => fixture,
      runTrayCommand,
    }),
  )
  await userEvent.click(
    await screen.findByRole("link", { name: /^Slot 1:/ }),
  )
  expect(
    screen.getByRole("button", {
      name: "Open",
    }),
  ).toBeDisabled()
  expect(
    screen.getByRole("button", {
      name: "Close",
    }),
  ).toBeDisabled()
  expect(
    screen.getByRole("button", { name: "Disc removed" }),
  ).toBeDisabled()
  expect(runTrayCommand).not.toHaveBeenCalled()
})
