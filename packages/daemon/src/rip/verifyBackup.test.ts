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

/**
 * ⚠️ The 2026-08-26 shape discovery, pinned.
 *
 * `makemkvcon backup` produces a DIRECTORY for a Blu-ray and a
 * single decrypted ISO FILE for a DVD, and says nothing about
 * which. Slot 6 rode to `MSG:5070 "Backup done"` and left an
 * 8,203,894,784-byte file that loop-mounts with an intact
 * `VIDEO_TS` — and this function reported `empty_output`,
 * because it looked for a directory inside something that was
 * not one.
 */
describe("a DVD backup, which is an ISO file", () => {
  /** `CD001` at byte 32769 — sector 16, offset 1. */
  const writeIsoImage = async (input: {
    path: string
    sizeBytes: number
  }) => {
    const image = Buffer.alloc(input.sizeBytes)
    image.write("CD001", 32_769, "latin1")
    await writeFile(input.path, image)
  }

  it("verifies a file carrying the ISO9660 signature", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rip-deck-iso-"),
    )
    const path = join(root, "backup")

    await writeIsoImage({ path, sizeBytes: 200_000 })

    const result = await verifyBackupStructure({
      path,
      discBytes: 200_000,
    })

    expect(result.isVerified).toBe(true)
    expect(result.markerFound).toBe("ISO")
    expect(result.bytesOnDisk).toBe(200_000)
  })

  it("⚠️ refuses a file with no ISO9660 signature", async () => {
    // Size alone would bless a truncated or garbage file, and
    // MakeMKV writes no extension to key on instead.
    const root = await mkdtemp(
      join(tmpdir(), "rip-deck-iso-"),
    )
    const path = join(root, "backup")

    await writeFile(path, Buffer.alloc(200_000))

    const result = await verifyBackupStructure({
      path,
      discBytes: 200_000,
    })

    expect(result.isVerified).toBe(false)
    expect(result.markerFound).toBeNull()
    expect(result.reason).toContain("ISO9660")
  })

  it("holds an image to the same size floor as a directory", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rip-deck-iso-"),
    )
    const path = join(root, "backup")

    await writeIsoImage({ path, sizeBytes: 100_000 })

    const result = await verifyBackupStructure({
      path,
      discBytes: 1_000_000,
    })

    expect(result.isVerified).toBe(false)
    expect(result.markerFound).toBe("ISO")
    expect(result.reason).toContain("the content is not")
  })

  it("says so when nothing was written at all", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rip-deck-iso-"),
    )

    const result = await verifyBackupStructure({
      path: join(root, "never-created"),
      discBytes: 1_000_000,
    })

    expect(result.isVerified).toBe(false)
    expect(result.reason).toContain("nothing was written")
  })
})
