import {
  act,
  renderHook,
  waitFor,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AppProviders,
  createQueryClient,
} from "../components/AppProviders"
import type { RipDeckDataSource } from "../types"
import { useBayActions } from "./useBayActions"

const DRIVE_ID = "usb-2-1-1-2-4-4-5"

const buildDataSource = (
  runBayAction: RipDeckDataSource["runBayAction"],
): RipDeckDataSource => ({
  fetchState: () =>
    Promise.reject(new Error("not used in this test")),
  fetchLog: () => Promise.resolve(""),
  runBayAction,
  // `useBayActions` never calls this — the tray pair has its own
  // hook (`useTrayCommand`) and its own transport.
  runTrayCommand: () =>
    Promise.reject(new Error("not used in this test")),
})

const renderBayActions = (dataSource: RipDeckDataSource) =>
  renderHook(() => useBayActions(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppProviders
        queryClient={createQueryClient()}
        dataSource={dataSource}
      >
        {children}
      </AppProviders>
    ),
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useBayActions", () => {
  it("runs an action and reports success against the bay", async () => {
    const runBayAction = vi.fn(() =>
      Promise.resolve({ ok: true, msg: "(mock) cleared" }),
    )
    const { result } = renderBayActions(
      buildDataSource(runBayAction),
    )

    await act(async () => {
      await result.current.runAction({
        driveId: DRIVE_ID,
        label: "05 - Pioneer BDR-211M",
        action: "clear_quarantine",
      })
    })

    expect(runBayAction).toHaveBeenCalledWith({
      driveId: DRIVE_ID,
      action: "clear_quarantine",
    })

    await waitFor(() => {
      expect(result.current.actionFor(DRIVE_ID)).toEqual({
        action: "clear_quarantine",
        status: "ok",
        msg: "(mock) cleared",
      })
    })
  })

  // Clearing a quarantine IS the human decision quarantine is
  // waiting for, so a dialog asking whether the human meant to
  // be the human is noise.
  it("does not interrogate the operator about clearing a quarantine", async () => {
    const confirmMock = vi.fn(() => true)

    vi.stubGlobal("confirm", confirmMock)

    const { result } = renderBayActions(
      buildDataSource(() =>
        Promise.resolve({ ok: true, msg: "" }),
      ),
    )

    await act(async () => {
      await result.current.runAction({
        driveId: DRIVE_ID,
        label: "05 - Pioneer BDR-211M",
        action: "clear_quarantine",
      })
    })

    expect(confirmMock).not.toHaveBeenCalled()
  })

  it("asks before throwing away a running rip", async () => {
    const confirmMock = vi.fn(() => false)
    const runBayAction = vi.fn(() =>
      Promise.resolve({ ok: true, msg: "" }),
    )

    vi.stubGlobal("confirm", confirmMock)

    const { result } = renderBayActions(
      buildDataSource(runBayAction),
    )

    await act(async () => {
      await result.current.runAction({
        driveId: DRIVE_ID,
        label: "05 - Pioneer BDR-211M",
        action: "cancel",
      })
    })

    expect(confirmMock).toHaveBeenCalled()
    // Declining means nothing happened at all — no request, no
    // feedback state left on the card.
    expect(runBayAction).not.toHaveBeenCalled()
    expect(
      result.current.actionFor(DRIVE_ID),
    ).toBeUndefined()
  })

  it("surfaces a refusal rather than swallowing it", async () => {
    // The live source refuses locally, naming MQTT `cmd/drive`.
    // A control that silently does nothing is worse than one
    // that says why it cannot.
    const { result } = renderBayActions(
      buildDataSource(() =>
        Promise.resolve({
          ok: false,
          msg: "goes over MQTT (cmd/drive)",
        }),
      ),
    )

    await act(async () => {
      await result.current.runAction({
        driveId: DRIVE_ID,
        label: "05 - Pioneer BDR-211M",
        action: "clear_quarantine",
      })
    })

    await waitFor(() => {
      expect(
        result.current.actionFor(DRIVE_ID)?.status,
      ).toBe("fail")
    })
    expect(
      result.current.actionFor(DRIVE_ID)?.msg,
    ).toContain("cmd/drive")
  })

  it("reports a thrown transport error as a failure", async () => {
    const { result } = renderBayActions(
      buildDataSource(() =>
        Promise.reject(new Error("network down")),
      ),
    )

    await act(async () => {
      await result.current.runAction({
        driveId: DRIVE_ID,
        label: "05 - Pioneer BDR-211M",
        action: "clear_quarantine",
      })
    })

    await waitFor(() => {
      expect(
        result.current.actionFor(DRIVE_ID)?.msg,
      ).toContain("network down")
    })
  })
})
