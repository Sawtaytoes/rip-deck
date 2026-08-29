import { describe, expect, it, vi } from "vitest"
import { handleBayActionRequest } from "./bayActionEndpoint.ts"

describe("POST /api/bay-action", () => {
  it("hands a valid control to the watcher", async () => {
    const runBayAction = vi.fn(() =>
      Promise.resolve({
        ok: true,
        msg: "Rip cancelled and tray opened.",
      }),
    )

    const result = await handleBayActionRequest({
      body: '{"action":"cancel","drive_id":"usb-2-1-1-2-4-4-4"}',
      runBayAction,
    })

    expect(runBayAction).toHaveBeenCalledWith({
      action: "cancel",
      driveId: "usb-2-1-1-2-4-4-4",
    })
    expect(result).toEqual({
      status: 200,
      payload: {
        ok: true,
        msg: "Rip cancelled and tray opened.",
      },
    })
  })

  it("rejects an action that does not have a drive id", async () => {
    const result = await handleBayActionRequest({
      body: '{"action":"cancel"}',
      runBayAction: vi.fn(),
    })

    expect(result).toEqual({
      status: 400,
      payload: {
        ok: false,
        msg: "Bay action needs a drive_id.",
      },
    })
  })
})
