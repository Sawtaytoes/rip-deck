import {
  act,
  renderHook,
  waitFor,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import {
  AppProviders,
  createQueryClient,
} from "../components/AppProviders"
import type {
  RipDeckDataSource,
  TrayBayResultKind,
  TrayCommandReport,
} from "../types"
import { useTrayCommand } from "./useTrayCommand"

const DRIVE_ID = "usb-2-1-1-2-4-4-7"

const buildReport = (
  overrides: Partial<TrayCommandReport> = {},
): TrayCommandReport => ({
  request_id: null,
  command: "open_bay",
  is_accepted: true,
  message: "Opened 1 drive: slot 7.",
  started_at: 1_780_000_000_000,
  finished_at: 1_780_000_001_240,
  counts: {
    opened: 1,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
  },
  bays: [
    {
      drive_id: DRIVE_ID,
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      result: "opened",
      detail: "the tray is open",
    },
  ],
  ...overrides,
})

const buildBayReport = (input: {
  result: TrayBayResultKind
  detail: string
}): TrayCommandReport =>
  buildReport({
    bays: [
      {
        drive_id: DRIVE_ID,
        slot: 7,
        label: "07 - Pioneer BDR-211M",
        result: input.result,
        detail: input.detail,
      },
    ],
  })

const buildDataSource = (
  runTrayCommand: RipDeckDataSource["runTrayCommand"],
): RipDeckDataSource => ({
  fetchState: () =>
    Promise.reject(new Error("not used in this test")),
  fetchLog: () => Promise.resolve(""),
  runBayAction: () =>
    Promise.reject(new Error("not used in this test")),
  fetchLeftovers: () =>
    Promise.reject(new Error("not used in this test")),
  deleteLeftover: () =>
    Promise.reject(new Error("not used in this test")),
  fetchHistory: () =>
    Promise.reject(new Error("not used in this test")),
  renameLeftover: () =>
    Promise.reject(new Error("not used in this test")),
  runTrayCommand,
})

const renderTrayCommand = (dataSource: RipDeckDataSource) =>
  renderHook(() => useTrayCommand(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppProviders
        queryClient={createQueryClient()}
        dataSource={dataSource}
      >
        {children}
      </AppProviders>
    ),
  })

describe("useTrayCommand", () => {
  it("sends one bay's command and keeps its report", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(buildReport()),
    )
    const { result } = renderTrayCommand(
      buildDataSource(runTrayCommand),
    )

    await act(async () => {
      result.current.run({
        command: "open_bay",
        driveId: DRIVE_ID,
      })
    })

    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "open_bay",
      driveId: DRIVE_ID,
    })

    await waitFor(() => {
      expect(result.current.lastReport?.message).toBe(
        "Opened 1 drive: slot 7.",
      )
    })
    expect(result.current.pendingDriveIds.size).toBe(0)
    expect(result.current.lastError).toBeNull()
  })

  it("marks the bay pending only while it is in flight", async () => {
    let release: (report: TrayCommandReport) => void =
      () => {}

    const { result } = renderTrayCommand(
      buildDataSource(
        () =>
          new Promise<TrayCommandReport>((resolve) => {
            release = resolve
          }),
      ),
    )

    act(() => {
      result.current.run({
        command: "open_bay",
        driveId: DRIVE_ID,
      })
    })

    // The ⏏ toggle reads this to disable itself and show a
    // spinner on ONE card — the whole rack must not go grey
    // because one drawer is moving.
    expect(
      result.current.pendingDriveIds.has(DRIVE_ID),
    ).toBe(true)
    expect(result.current.isBulkPending).toBe(false)

    await act(async () => {
      release(buildReport())
    })

    await waitFor(() => {
      expect(
        result.current.pendingDriveIds.has(DRIVE_ID),
      ).toBe(false)
    })
  })

  it("omits the drive id for a bulk command", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(
        buildReport({ command: "open_trays" }),
      ),
    )
    const { result } = renderTrayCommand(
      buildDataSource(runTrayCommand),
    )

    await act(async () => {
      result.current.run({ command: "open_trays" })
    })

    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "open_trays",
      driveId: undefined,
    })

    await waitFor(() => {
      expect(result.current.isBulkPending).toBe(false)
    })
    // A bulk press is not a per-bay press: the header button
    // waits, the nine cards do not.
    expect(result.current.pendingDriveIds.size).toBe(0)
  })

  /**
   * ⚠️ The assertion a green suite would otherwise skip.
   *
   * A refusal arrives as a RESOLVED report with `is_accepted:
   * true` — the daemon heard the command and said no — and the
   * only text explaining why is the bay's own `detail`. If that
   * sentence does not survive the trip to the caller, the owner
   * sees a control that did nothing and never learns that it was
   * protecting a 90 GB rip in progress.
   */
  it("delivers a refused bay's detail intact", async () => {
    const detail =
      "REFUSED — this bay is ripping. Opening the tray now " +
      "would destroy the rip in progress. Nothing was touched."

    const { result } = renderTrayCommand(
      buildDataSource(() =>
        Promise.resolve(
          buildBayReport({
            result: "refused_ripping",
            detail,
          }),
        ),
      ),
    )

    await act(async () => {
      result.current.run({
        command: "open_bay",
        driveId: DRIVE_ID,
      })
    })

    await waitFor(() => {
      expect(result.current.lastReport).not.toBeNull()
    })

    const bay = result.current.lastReport?.bays[0]

    expect(bay?.result).toBe("refused_ripping")
    expect(bay?.detail).toBe(detail)
    // Not an error: there was nothing wrong with the request.
    expect(result.current.lastError).toBeNull()
  })

  it("reports a dead endpoint as an error, not a silent nothing", async () => {
    const { result } = renderTrayCommand(
      buildDataSource(() =>
        Promise.reject(
          new Error("/api/tray failed: 503 no watcher"),
        ),
      ),
    )

    await act(async () => {
      result.current.run({ command: "close_trays" })
    })

    await waitFor(() => {
      expect(result.current.lastError).toContain(
        "/api/tray failed: 503",
      )
    })
    expect(result.current.lastReport).toBeNull()
    expect(result.current.isBulkPending).toBe(false)
  })

  /**
   * Two clicks in one tick both see the pre-update state, so the
   * guard is a ref rather than the rendered set. Without it, an
   * impatient double-press is a drawer that opens, shuts under
   * the operator's hand, and opens again.
   */
  it("ignores a second press while the first is still moving", async () => {
    let release: (report: TrayCommandReport) => void =
      () => {}
    const runTrayCommand = vi.fn(
      () =>
        new Promise<TrayCommandReport>((resolve) => {
          release = resolve
        }),
    )

    const { result } = renderTrayCommand(
      buildDataSource(runTrayCommand),
    )

    act(() => {
      result.current.run({
        command: "open_bay",
        driveId: DRIVE_ID,
      })
      result.current.run({
        command: "open_bay",
        driveId: DRIVE_ID,
      })
    })

    expect(runTrayCommand).toHaveBeenCalledTimes(1)

    await act(async () => {
      release(buildReport())
    })

    // ...and the bay is pressable again once it has answered.
    await act(async () => {
      result.current.run({
        command: "close_bay",
        driveId: DRIVE_ID,
      })
    })

    expect(runTrayCommand).toHaveBeenCalledTimes(2)
  })
})
