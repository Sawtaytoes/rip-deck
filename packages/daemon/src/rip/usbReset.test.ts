import { describe, expect, it, vi } from "vitest"

import {
  resetUsbDrive,
  USB_BIND_PATH,
  USB_UNBIND_PATH,
} from "./usbReset.ts"

describe("resetUsbDrive", () => {
  it("unbinds and rebinds only the exact drive id", async () => {
    const write = vi.fn(async () => {})
    const wait = vi.fn(async () => {})

    await resetUsbDrive(
      { driveId: "2-2.3.4.1", kernelName: "sr3" },
      {
        resolvePath: async () =>
          "/sys/devices/pci/usb2/2-2/2-2.3/2-2.3.4/2-2.3.4.1/2-2.3.4.1:1.0/host25/target25:0:0/25:0:0:0/block/sr3",
        write,
        wait,
      },
    )

    expect(write.mock.calls).toEqual([
      [USB_UNBIND_PATH, "2-2.3.4.1"],
      [USB_BIND_PATH, "2-2.3.4.1"],
    ])
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("refuses a drive id that does not own the kernel device", async () => {
    const write = vi.fn(async () => {})

    await expect(
      resetUsbDrive(
        { driveId: "2-2.3.4.1", kernelName: "sr3" },
        {
          resolvePath: async () =>
            "/sys/devices/pci/usb2/2-2.3.4.2:1.0/host25/block/sr3",
          write,
          wait: async () => {},
        },
      ),
    ).rejects.toThrow("does not match")
    expect(write).not.toHaveBeenCalled()
  })
})
