import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { verifyDiscImage } from "./verifyDiscImage.ts"

const temporaryDirs: string[] = []

afterAll(async () => {
  for (const path of temporaryDirs) {
    await rm(path, { recursive: true, force: true })
  }
})

/** One disc's worth of files, on a real filesystem. */
const writeRip = async (input: {
  imageBytes: Buffer
  mapfile: string | null
}): Promise<{
  imagePath: string
  mapfilePath: string
}> => {
  const dir = await mkdtemp(
    join(tmpdir(), "rip-deck-data-disc-"),
  )

  temporaryDirs.push(dir)

  const imagePath = join(dir, "Disc.iso")
  const mapfilePath = `${imagePath}.map`

  await writeFile(imagePath, input.imageBytes)

  if (input.mapfile !== null) {
    await writeFile(mapfilePath, input.mapfile)
  }

  return { imagePath, mapfilePath }
}

const DISC_BYTES = 64 * 1024

/** A mapfile in the shape GNU ddrescue 1.29 writes. */
const mapfileFor = (
  blocks: readonly (readonly [number, number, string])[],
): string =>
  [
    "# Mapfile. Created by GNU ddrescue version 1.29",
    "# current_pos  current_status  current_pass",
    "0x00000000     +               1",
    "#      pos        size  status",
    ...blocks.map(
      ([position, size, status]) =>
        `0x${position.toString(16).padStart(8, "0")}  ` +
        `0x${size.toString(16).padStart(8, "0")}  ${status}`,
    ),
  ].join("\n")

/** An image with no ISO 9660 filesystem — a sampler disc. */
const rawImage = (bytes: number): Buffer =>
  Buffer.alloc(bytes, 0x41)

/**
 * The same image with a plausible primary volume descriptor.
 *
 * `CD001` at byte 32769, the volume space size at descriptor
 * byte 80 and the logical block size at byte 128, each written
 * little-endian first — the halves this code reads.
 */
const isoImage = (input: {
  bytes: number
  volumeSpaceSize: number
}): Buffer => {
  const image = rawImage(input.bytes)

  image.write("CD001", 32_769, "latin1")
  image.writeUInt32LE(input.volumeSpaceSize, 32_768 + 80)
  image.writeUInt16LE(2048, 32_768 + 128)

  return image
}

describe("verifying a data-disc image", () => {
  it("passes a disc whose every sector was read", async () => {
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES),
      mapfile: mapfileFor([[0, DISC_BYTES, "+"]]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(true)
    expect(verification.unrecoveredBytes).toBe(0)
    expect(verification.warnings).toEqual([])
    expect(verification.reason).toContain(
      "every sector read",
    )
  })

  it("⚠️ passes an image with NO ISO 9660 filesystem", async () => {
    // The rule most likely to be "tidied up" into agreement
    // with `verifyBackup.ts`, which treats a missing `CD001` as
    // proof that nothing produced a disc image. A sampler
    // library carries the sampler's own on-disc format and no
    // filesystem at all, so requiring the signature would fail
    // every one of those discs — and the failure would read as
    // "the drive could not read this disc".
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES),
      mapfile: mapfileFor([[0, DISC_BYTES, "+"]]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(true)
    expect(verification.markerFound).toBeNull()
    // And it says so on the success line, because an absent
    // filesystem looks alarming everywhere else in this repo.
    expect(verification.reason).toContain("sampler")
  })

  it("records the ISO 9660 marker when there is one", async () => {
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: isoImage({
        bytes: DISC_BYTES,
        volumeSpaceSize: DISC_BYTES / 2048,
      }),
      mapfile: mapfileFor([[0, DISC_BYTES, "+"]]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.markerFound).toBe("ISO")
    expect(verification.warnings).toEqual([])
  })

  it("warns when the filesystem is longer than the image", async () => {
    // The only check that catches a drive reporting a smaller
    // capacity than the disc holds. A warning and not a
    // failure: the part that was read is still useful.
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: isoImage({
        bytes: DISC_BYTES,
        volumeSpaceSize: (DISC_BYTES / 2048) * 2,
      }),
      mapfile: mapfileFor([[0, DISC_BYTES, "+"]]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(true)
    expect(
      verification.warnings.some((warning) =>
        warning.includes("ISO 9660 filesystem says"),
      ),
    ).toBe(true)
  })

  it("warns about unread sectors but still publishes", async () => {
    // A read error on an otherwise complete image is a warning,
    // not a failure — the same three-state rule the video path
    // settled on 2026-08-27.
    const badBytes = 4096

    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES),
      mapfile: mapfileFor([
        [0, DISC_BYTES - badBytes, "+"],
        [DISC_BYTES - badBytes, badBytes, "-"],
      ]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(true)
    expect(verification.unrecoveredBytes).toBe(badBytes)
    // Sectors, because that is the unit a recovery tool and the
    // mapfile itself talk in.
    expect(
      verification.warnings.some((warning) =>
        warning.includes("2 sectors"),
      ),
    ).toBe(true)
  })

  it("fails a disc the drive barely read", async () => {
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(1024),
      mapfile: mapfileFor([
        [0, 1024, "+"],
        [1024, DISC_BYTES - 1024, "-"],
      ]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(false)
    expect(verification.reason).toContain("gave up")
  })

  it("⚠️ refuses an image whose mapfile is missing", async () => {
    // A refusal rather than a fallback to "the file looks big
    // enough". The mapfile IS the evidence; without it nothing
    // can say whether those bytes are the disc's.
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES),
      mapfile: null,
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(false)
    expect(verification.unrecoveredBytes).toBeNull()
    expect(verification.reason).toContain("mapfile")
  })

  it("refuses a mapfile that holds no blocks", async () => {
    // ddrescue created it and died before writing one. Totalling
    // that to zero unrecovered bytes would be a clean bill of
    // health for a rip that never happened.
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES),
      mapfile: "# Mapfile. Created by GNU ddrescue 1.29\n",
    })

    expect(
      (
        await verifyDiscImage({
          imagePath,
          mapfilePath,
          discBytes: DISC_BYTES,
        })
      ).isVerified,
    ).toBe(false)
  })

  it("says so when there is no image at all", async () => {
    const { mapfilePath } = await writeRip({
      imageBytes: rawImage(16),
      mapfile: mapfileFor([[0, 16, "+"]]),
    })

    const verification = await verifyDiscImage({
      imagePath: join(
        tmpdir(),
        "rip-deck-absent-image.iso",
      ),
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(verification.isVerified).toBe(false)
    expect(verification.bytesOnDisk).toBe(0)
    expect(verification.reason).toContain("no image file")
  })

  it("warns when the image stops short of the disc", async () => {
    // ddrescue seeks and writes, so a tail it never reached is
    // simply absent from the file rather than zero-filled.
    const { imagePath, mapfilePath } = await writeRip({
      imageBytes: rawImage(DISC_BYTES - 2048),
      mapfile: mapfileFor([
        [0, DISC_BYTES - 2048, "+"],
        [DISC_BYTES - 2048, 2048, "?"],
      ]),
    })

    const verification = await verifyDiscImage({
      imagePath,
      mapfilePath,
      discBytes: DISC_BYTES,
    })

    expect(
      verification.warnings.some((warning) =>
        warning.includes("its tail was never written"),
      ),
    ).toBe(true)
  })
})
