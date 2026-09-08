import { realpath, writeFile } from "node:fs/promises"

export const USB_UNBIND_PATH = "/run/rip-deck-usb/unbind"
export const USB_BIND_PATH = "/run/rip-deck-usb/bind"

type UsbResetDeps = {
  resolvePath: (path: string) => Promise<string>
  write: (path: string, value: string) => Promise<void>
  wait: (milliseconds: number) => Promise<void>
}

const defaultDeps: UsbResetDeps = {
  resolvePath: realpath,
  write: writeFile,
  wait: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds)
      timer.unref()
    })
  },
}

/**
 * Disconnect and reconnect one optical drive at its exact USB port.
 * The stable drive id must occur as a USB interface in its sysfs path.
 * This prevents a caller from resetting a parent hub or another bay.
 */
export const resetUsbDrive = async (
  input: { driveId: string; kernelName: string },
  deps: UsbResetDeps = defaultDeps,
): Promise<void> => {
  if (!/^\d+-\d+(?:\.\d+)*$/.test(input.driveId)) {
    throw new Error("The bay has an invalid USB drive id.")
  }

  const devicePath = await deps.resolvePath(
    `/sys/block/${input.kernelName}/device`,
  )
  const interfaceSegment = devicePath
    .split("/")
    .find((segment) =>
      segment.startsWith(`${input.driveId}:`),
    )

  if (interfaceSegment === undefined) {
    throw new Error(
      "The current device path does not match this bay's stable USB id.",
    )
  }

  await deps.write(USB_UNBIND_PATH, input.driveId)
  await deps.wait(1_500)
  await deps.write(USB_BIND_PATH, input.driveId)
  await deps.wait(1_500)
}
