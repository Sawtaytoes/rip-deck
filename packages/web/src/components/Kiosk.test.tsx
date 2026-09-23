import {
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Navigate, Route, Routes } from "react-router"
import { afterEach, expect, test, vi } from "vitest"
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

afterEach(() => {
  vi.unstubAllGlobals()
})

test("shows disc artwork and targeted controls on a direct detail route", async () => {
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
  const detailRoutes = (
    <Routes>
      <Route
        path="/"
        element={
          <Navigate
            to={`/kiosk/slots/${bay.drive_id}`}
            replace
          />
        }
      />
      <Route path="/kiosk" element={<Kiosk />} />
      <Route
        path="/kiosk/slots/:driveId"
        element={<Kiosk />}
      />
    </Routes>
  )
  renderWithProviders(
    detailRoutes,
    createStubDataSource({
      fetchState: async () => state,
      runTrayCommand,
    }),
  )
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
  ).toHaveLength(8)
})

test("hides idle and finished slots so active rips fill the kiosk", async () => {
  const fixture =
    await mockDataSource.fetchState("showcase")
  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => fixture,
    }),
  )

  const rows = await screen.findAllByRole("link", {
    name: /^Slot \d:/,
  })
  expect(rows).toHaveLength(4)
  expect(rows[0]).toHaveTextContent(/^1/)
  expect(
    within(rows[0]).queryByText(/Slot/, {
      ignore: ".sr-only",
    }),
  ).toBeNull()
  expect(
    rows.map((row) => row.getAttribute("aria-label")),
  ).toEqual([
    expect.stringMatching(/^Slot 1:/),
    expect.stringMatching(/^Slot 2:/),
    expect.stringMatching(/^Slot 3:/),
    expect.stringMatching(/^Slot 4:/),
  ])
  expect(
    screen.getByRole("region", {
      name: "Active drive slots",
    }),
  ).toHaveAttribute("data-row-density", "roomy")
})

test("shows a calm idle message instead of nine empty rows", async () => {
  const fixture = await mockDataSource.fetchState(
    "held-at-startup",
  )
  const tower = fixture.ripDeck
  if (!tower) throw new Error("Fixture needs a tower")

  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => ({
        ...fixture,
        ripDeck: {
          ...tower,
          bays: tower.bays.map((bay) => ({
            ...bay,
            state: {
              ...bay.state,
              state: "idle" as const,
              job_id: null,
              title: null,
            },
          })),
        },
      }),
    }),
  )

  expect(
    await screen.findByRole("heading", {
      name: "No rips running",
    }),
  ).toBeVisible()
  expect(screen.queryByRole("link")).toBeNull()
})

test("briefly includes an inactive slot after its tray changes", async () => {
  const fixture =
    await mockDataSource.fetchState("showcase")
  const initialTower = fixture.ripDeck
  const target = initialTower?.bays.find(
    (bay) => bay.slot === 5,
  )
  if (!initialTower || !target)
    throw new Error("Fixture needs a completed slot 5")

  let current = {
    ...fixture,
    ripDeck: { ...initialTower, is_fake: false },
  }
  const runTrayCommand = vi.fn(async () => {
    const tower = current.ripDeck
    current = {
      ...current,
      ripDeck: {
        ...tower,
        bays: tower.bays.map((bay) =>
          bay.drive_id === target.drive_id
            ? {
                ...bay,
                last_tray_command: "open_bay" as const,
              }
            : bay,
        ),
      },
    }
    return buildTrayCommandReport({
      bays: [
        {
          drive_id: target.drive_id,
          slot: target.slot,
          label: target.label,
          result: "opened",
          detail: "Slot 5 opened.",
        },
      ],
    })
  })
  const detailRoutes = (
    <Routes>
      <Route
        path="/"
        element={
          <Navigate
            to={`/kiosk/slots/${target.drive_id}`}
            replace
          />
        }
      />
      <Route path="/kiosk" element={<Kiosk />} />
      <Route
        path="/kiosk/slots/:driveId"
        element={<Kiosk />}
      />
    </Routes>
  )

  renderWithProviders(
    detailRoutes,
    createStubDataSource({
      fetchState: async () => current,
      runTrayCommand,
    }),
  )

  await userEvent.click(
    await screen.findByRole("button", { name: "Open" }),
  )
  await waitFor(() =>
    expect(runTrayCommand).toHaveBeenCalledOnce(),
  )
  await userEvent.click(
    screen.getByRole("link", { name: "Back" }),
  )

  expect(
    await screen.findByRole("link", { name: /^Slot 5:/ }),
  ).toBeVisible()
  expect(
    screen.getAllByRole("link", { name: /^Slot \d:/ }),
  ).toHaveLength(5)
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
  expect(
    screen.getByRole("button", { name: "Cancel rip" }),
  ).toBeDisabled()
  expect(runTrayCommand).not.toHaveBeenCalled()
})

test("confirms and cancels one live rip without a browser dialog", async () => {
  const fixture =
    await mockDataSource.fetchState("nine-rips")
  const tower = fixture.ripDeck
  const bay = tower?.bays[0]
  if (!tower || !bay?.state.title)
    throw new Error("Fixture needs an active named bay")

  const state = {
    ...fixture,
    ripDeck: { ...tower, is_fake: false },
  }
  const runBayAction = vi.fn(async () => ({
    ok: true,
    msg: `Cancelled ${bay.state.title} and opened its tray.`,
  }))
  const browserConfirm = vi.fn(() => {
    throw new Error(
      "The remote kiosk cannot answer this dialog",
    )
  })
  vi.stubGlobal("confirm", browserConfirm)

  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => state,
      runBayAction,
    }),
  )

  await userEvent.click(
    await screen.findByRole("link", { name: /^Slot 1:/ }),
  )
  expect(
    screen.getByText(
      "Cancel stops the rip, keeps its partial output, and opens its tray after the ripper exits.",
    ),
  ).toBeVisible()

  await userEvent.click(
    screen.getByRole("button", { name: "Cancel rip" }),
  )
  let dialog = screen.getByRole("alertdialog", {
    name: "Cancel this rip?",
  })
  expect(dialog).toHaveTextContent(bay.state.title)
  await userEvent.click(
    within(dialog).getByRole("button", {
      name: "Keep ripping",
    }),
  )
  expect(runBayAction).not.toHaveBeenCalled()

  await userEvent.click(
    screen.getByRole("button", { name: "Cancel rip" }),
  )
  dialog = screen.getByRole("alertdialog", {
    name: "Cancel this rip?",
  })
  await userEvent.click(
    within(dialog).getByRole("button", {
      name: "Cancel rip",
    }),
  )

  await waitFor(() =>
    expect(runBayAction).toHaveBeenCalledWith({
      driveId: bay.drive_id,
      action: "cancel",
    }),
  )
  expect(browserConfirm).not.toHaveBeenCalled()
  expect(
    await screen.findByText(
      `Cancelled ${bay.state.title} and opened its tray.`,
    ),
  ).toBeVisible()
})

test("says the tower is off when no drive answered", async () => {
  const fixture = await mockDataSource.fetchState("empty")
  renderWithProviders(
    routes,
    createStubDataSource({
      fetchState: async () => fixture,
    }),
  )
  expect(
    await screen.findByRole("heading", {
      name: "Tower is off",
    }),
  ).toBeVisible()
  expect(screen.queryByRole("link")).toBeNull()
})
