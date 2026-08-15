import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { verifyBackupStructure } from "./verifyBackup.ts"

const GB = 1024 ** 3
const created: string[] = []

const makeBackup = async (input: {
  marker?: string
  fileBytes?: number
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rip-deck-"))
  created.push(root)

  if (input.marker !== undefined) {
    const streamDir = join(root, input.marker, "STREAM")
    await mkdir(streamDir, { recursive: true })

    if (input.fileBytes !== undefined) {
      await writeFile(
        join(streamDir, "00000.m2ts"),
        Buffer.alloc(input.fileBytes),
      )
    }
  }

  return root
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(
    created
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
  )
})

describe("proving a backup produced a disc", () => {
  // backup mode emits no title count, so completion is proven by
  // what is on the dataset rather than by anything makemkvcon
  // said about itself. A message describes a belief; this
  // describes bytes.

  it("accepts a Blu-ray structure of plausible size", async () => {
    const path = await makeBackup({
      marker: "BDMV",
      fileBytes: 8 * 1024,
    })

    const result = await verifyBackupStructure({
      path,
      discBytes: 10 * 1024,
    })

    expect(result.isVerified).toBe(true)
    expect(result.markerFound).toBe("BDMV")
  })

  it("accepts a DVD structure too", async () => {
    const path = await makeBackup({
      marker: "VIDEO_TS",
      fileBytes: 8 * 1024,
    })

    const result = await verifyBackupStructure({
      path,
      discBytes: 10 * 1024,
    })

    expect(result.isVerified).toBe(true)
    expect(result.markerFound).toBe("VIDEO_TS")
  })

  it("rejects an empty output directory", async () => {
    // Exit 0 and nothing written is the backup-mode equivalent
    // of "0 titles saved", and it must not read as success.
    const path = await makeBackup({})

    const result = await verifyBackupStructure({
      path,
      discBytes: 25 * GB,
    })

    expect(result.isVerified).toBe(false)
    expect(result.reason).toContain("no BDMV or VIDEO_TS")
  })

  it("rejects a structure holding only stubs", async () => {
    // The directory tree exists but the content does not — a
    // rip killed early enough to have created the skeleton.
    const path = await makeBackup({
      marker: "BDMV",
      fileBytes: 1024,
    })

    const result = await verifyBackupStructure({
      path,
      discBytes: 25 * GB,
    })

    expect(result.isVerified).toBe(false)
    expect(result.reason).toContain("content is not")
  })

  it("tolerates the real size disagreeing with sysfs", async () => {
    // Measured on the first real rip: sysfs said 32.2 GB and the
    // finished backup was 33 GB. `du` counts ZFS allocation, and
    // the backup omits some structures while adding MakeMKV's
    // own AACS/CMAP data. A strict equality check would fail
    // every good rip.
    const path = await makeBackup({
      marker: "BDMV",
      fileBytes: 33 * 1024,
    })

    const result = await verifyBackupStructure({
      path,
      discBytes: 32 * 1024,
    })

    expect(result.isVerified).toBe(true)
  })
})
