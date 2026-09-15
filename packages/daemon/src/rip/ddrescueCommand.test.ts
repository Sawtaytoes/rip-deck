import { describe, expect, it } from "vitest"
import {
  buildDdrescueArgs,
  buildDdrescueInvocation,
  buildDdrescueKillArgs,
  parseDiscImageMap,
  resolveDdrescueCommand,
} from "./ddrescueCommand.ts"

/**
 * A mapfile GNU ddrescue 1.29 actually wrote.
 *
 * Captured on 2026-09-15 by running the invocation
 * `buildDdrescueArgs` produces, unaltered, against a 5,000,000
 * byte input. Pasted rather than hand-written on purpose: a
 * parser tested against its author's idea of a format passes
 * every time and proves nothing.
 */
const COMPLETE_MAPFILE = `# Mapfile. Created by GNU ddrescue version 1.29
# Command line: ddrescue --sector-size 2048 --retry-passes 1 --timeout 300s infile out.iso out.iso.map
# Start time:   2026-09-15 07:07:11
# Current time: 2026-09-15 07:07:11
# Finished
# current_pos  current_status  current_pass
0x004C0000     +               1
#      pos        size  status
0x00000000  0x004C4B40  +
`

/**
 * The same run, interrupted three seconds in.
 *
 * ⚠️ **Look at the status line.** Its SECOND field is `?`, a
 * real status character, and its third is a pass number. A
 * parser that keyed on the second column would count this line
 * as a 5 MB block of nothing and report a rip that recovered
 * 393 KB as having recovered none. That is the trap this
 * fixture exists to hold shut.
 */
const INTERRUPTED_MAPFILE = `# Mapfile. Created by GNU ddrescue version 1.29
# Command line: ddrescue --sector-size 2048 --retry-passes 1 --timeout 300s --max-read-rate 100k infile out.iso out.iso.map
# Start time:   2026-09-15 07:07:43
# Current time: 2026-09-15 07:07:46
# Copying non-tried blocks... Pass 1 (forwards)
# current_pos  current_status  current_pass
0x00060000     ?               1
#      pos        size  status
0x00000000  0x00060000  +
0x00060000  0x00464B40  ?
`

describe("the ddrescue invocation", () => {
  it("names the input, the image and the mapfile in that order", () => {
    // ddrescue takes `infile outfile mapfile` positionally and
    // means something very different if two are swapped —
    // `outfile` as the input would read the half-written image.
    expect(
      buildDdrescueArgs({
        devPath: "/dev/sr3",
        imagePath:
          "/media/x/.rip-deck-incomplete-a/Disc.iso",
        mapfilePath:
          "/media/x/.rip-deck-incomplete-a/Disc.iso.map",
      }).slice(-3),
    ).toEqual([
      "/dev/sr3",
      "/media/x/.rip-deck-incomplete-a/Disc.iso",
      "/media/x/.rip-deck-incomplete-a/Disc.iso.map",
    ])
  })

  it("sets the sector size to a data disc's 2048 bytes", () => {
    // ddrescue defaults to 512. At that size one failed CD
    // sector is recorded as four bad blocks and every retry
    // re-reads the same physical sector four times.
    const args = buildDdrescueArgs({
      devPath: "/dev/sr0",
      imagePath: "/x/Disc.iso",
      mapfilePath: "/x/Disc.iso.map",
    })

    expect(args).toContain("--sector-size")
    expect(args[args.indexOf("--sector-size") + 1]).toBe(
      "2048",
    )
  })

  it("bounds the run with a timeout since the last good read", () => {
    // The liveness guard, and the reason this path needs no
    // watchdog of its own.
    const args = buildDdrescueArgs({
      devPath: "/dev/sr0",
      imagePath: "/x/Disc.iso",
      mapfilePath: "/x/Disc.iso.map",
    })

    expect(args).toContain("--timeout")
    expect(args[args.indexOf("--timeout") + 1]).toBe("300s")
  })

  it("never preallocates the image", () => {
    // ⚠️ The flag that matters by its absence. The outcome is
    // decided by the image's LENGTH, so a preallocated file is
    // full-length from the first second and a rip that died
    // after 4 MB would verify as a complete disc.
    const args = buildDdrescueArgs({
      devPath: "/dev/sr0",
      imagePath: "/x/Disc.iso",
      mapfilePath: "/x/Disc.iso.map",
    })

    expect(args).not.toContain("-p")
    expect(args).not.toContain("--preallocate")
  })

  it("never writes the image sparsely", () => {
    // A sparse image reads back as zeroes in its holes, which
    // is the `dd conv=sync` failure this whole module rejects,
    // only harder to see.
    const args = buildDdrescueArgs({
      devPath: "/dev/sr0",
      imagePath: "/x/Disc.iso",
      mapfilePath: "/x/Disc.iso.map",
    })

    expect(args).not.toContain("-S")
    expect(args).not.toContain("--sparse")
  })

  it("never skips the scraping phase", () => {
    // Scraping is how a marginal sector is eventually
    // recovered. Skipping it reports a readable disc as
    // damaged.
    const args = buildDdrescueArgs({
      devPath: "/dev/sr0",
      imagePath: "/x/Disc.iso",
      mapfilePath: "/x/Disc.iso.map",
    })

    expect(args).not.toContain("-n")
    expect(args).not.toContain("--no-scrape")
  })
})

describe("resolving the ddrescue command", () => {
  it("defaults to the binary in the image", () => {
    expect(resolveDdrescueCommand(undefined)).toEqual({
      command: "ddrescue",
      prefixArgs: [],
      wrapperArgs: null,
    })
  })

  it("splits a wrapper from its trailing binary", () => {
    // The wrapper is what a cancel has to reach: SIGTERM to a
    // `docker exec` client kills the client and leaves the
    // ripper inside the container holding the drive (E5).
    expect(
      resolveDdrescueCommand("docker exec rescue ddrescue"),
    ).toEqual({
      command: "docker",
      prefixArgs: ["exec", "rescue", "ddrescue"],
      wrapperArgs: ["exec", "rescue"],
    })
  })

  it("puts the wrapper's args before ddrescue's own", () => {
    expect(
      buildDdrescueInvocation({
        ddrescue: resolveDdrescueCommand(
          "docker exec rescue ddrescue",
        ),
        rip: {
          devPath: "/dev/sr0",
          imagePath: "/x/Disc.iso",
          mapfilePath: "/x/Disc.iso.map",
        },
      }).args.slice(0, 3),
    ).toEqual(["exec", "rescue", "ddrescue"])
  })
})

describe("killing a wrapped ddrescue", () => {
  it("anchors the device so /dev/sr1 cannot match /dev/sr10", () => {
    // `pkill -f` matches an extended regular expression against
    // the whole command line. Unanchored, cancelling bay 1
    // would kill bay 10's rip — and `srN` numbering follows
    // enumeration order, so two-digit names are normal.
    const args = buildDdrescueKillArgs({
      wrapperArgs: ["exec", "rescue"],
      devPath: "/dev/sr1",
      signal: "TERM",
    })

    expect(args).toEqual([
      "exec",
      "rescue",
      "pkill",
      "-TERM",
      "-f",
      "(^| )/dev/sr1( |$)",
    ])

    const pattern = new RegExp(args[args.length - 1])

    expect(
      pattern.test("ddrescue -b 2048 /dev/sr10 a b"),
    ).toBe(false)
    expect(
      pattern.test("ddrescue -b 2048 /dev/sr1 a b"),
    ).toBe(true)
  })
})

describe("reading a ddrescue mapfile", () => {
  it("totals a finished rip as wholly recovered", () => {
    expect(parseDiscImageMap(COMPLETE_MAPFILE)).toEqual({
      recoveredBytes: 5_000_000,
      unrecoveredBytes: 0,
    })
  })

  it("does not mistake the status line for a block", () => {
    // The status line's second field is a status character and
    // its third is a pass number. Counting it would report this
    // interrupted rip as having recovered nothing.
    expect(parseDiscImageMap(INTERRUPTED_MAPFILE)).toEqual({
      recoveredBytes: 393_216,
      unrecoveredBytes: 4_606_784,
    })
  })

  it("counts every not-finished status as unrecovered", () => {
    // Non-tried, non-trimmed, non-scraped and bad-sector differ
    // to a resume and not to an outcome: each one is a hole in
    // the image.
    expect(
      parseDiscImageMap(
        [
          "# current_pos  current_status  current_pass",
          "0x00000000     +               1",
          "#      pos        size  status",
          "0x00000000  0x00000800  +",
          "0x00000800  0x00000800  ?",
          "0x00001000  0x00000800  *",
          "0x00001800  0x00000800  /",
          "0x00002000  0x00000800  -",
        ].join("\n"),
      ),
    ).toEqual({
      recoveredBytes: 2048,
      unrecoveredBytes: 2048 * 4,
    })
  })

  it("returns null for a mapfile with no blocks in it", () => {
    // The state of a mapfile ddrescue created and died before
    // writing. Answering "0 bytes unrecovered" here would be a
    // clean bill of health for a rip that never happened.
    expect(
      parseDiscImageMap(
        [
          "# Mapfile. Created by GNU ddrescue version 1.29",
          "# Start time:   2026-09-15 07:07:11",
        ].join("\n"),
      ),
    ).toBeNull()
  })

  it("returns null for an empty file", () => {
    expect(parseDiscImageMap("")).toBeNull()
  })
})
