import { MAX_READ_OFFSET_SAMPLES } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  buildCyanripArgs,
  buildCyanripInvocation,
  buildCyanripKillArgs,
  resolveCyanripAlbumDir,
  resolveCyanripCommand,
} from "./cyanripCommand.ts"

/**
 * ⚠️ Every assertion here is about the command we CONSTRUCT.
 * None of it has been run against a CD. Contrast
 * `ripCommand.test.ts`, where each flag is a fix for a failure
 * someone watched happen on hardware.
 *
 * The tower is no longer off, though, and cyanrip is no longer
 * absent: 2026-07-27 put cyanrip 0.9.3 in the image and ran it
 * against slot 1's real drive. So the OPTION LETTERS below are
 * now checked against the binary's own help rather than against
 * its README — see the last test in the first block.
 */

const args = buildCyanripArgs({ devPath: "/dev/sr3" })

/**
 * Every option cyanrip 0.9.3 accepts, transcribed from
 * `cyanrip -h` run inside `rip-deck:stage8-cyanrip-test` on
 * Tower, 2026-07-27.
 *
 * This exists because the whole file is a set of claims about
 * ANOTHER program's interface, and a claim about someone else's
 * interface is the kind that rots without anything failing. A
 * flag cyanrip drops in 0.10 would otherwise surface as a rip
 * that dies on a real CD at 3am rather than as a red test.
 *
 * It cannot notice a MEANING change — if upstream repurposed
 * `-s` from "offset in samples" to something else, this still
 * passes. Re-read the help on every version bump; that is the
 * point of pinning the version in the comment above.
 */
const CYANRIP_0_9_3_OPTIONS = new Set([
  "-A",
  "-C",
  "-D",
  "-E",
  "-F",
  "-G",
  "-H",
  "-I",
  "-K",
  "-L",
  "-M",
  "-N",
  "-O",
  "-P",
  "-Q",
  "-R",
  "-S",
  "-T",
  "-U",
  "-V",
  "-W",
  "-Z",
  "-a",
  "-b",
  "-c",
  "-d",
  "-f",
  "-h",
  "-l",
  "-m",
  "-o",
  "-p",
  "-r",
  "-s",
  "-t",
])

describe("the cyanrip command", () => {
  it("rips to FLAC", () => {
    // A3. Passed explicitly even though it is cyanrip's default:
    // a hard constraint that rests on an upstream default is one
    // release away from being violated silently.
    expect(args).toContain("-o")
    expect(args[args.indexOf("-o") + 1]).toBe("flac")
  })

  it("is scoped to one device", () => {
    // Nine of these run at once, and unlike `makemkvcon backup`
    // — which is forced onto a bus-enumeration disc index —
    // cyanrip addresses the drive directly, so no CD rip waits
    // on a wedged sibling being enumerated.
    expect(args).toContain("-d")
    expect(args[args.indexOf("-d") + 1]).toBe("/dev/sr3")
  })

  it("leaves AccurateRip on, by not disabling it", () => {
    // The inverted flag, and the reason this test exists: `-A`
    // DISABLES the AccurateRip query. A3 asks for v1+v2, which
    // cyanrip does by default — so the requirement is met by an
    // absence, which is invisible in a diff.
    expect(args).not.toContain("-A")
  })

  it("leaves MusicBrainz and cover art on, by default", () => {
    // B5: tagging via MusicBrainz plus embedded cover art. `-N`
    // kills the lookup, `-U` kills the art query and `-G` kills
    // the embedding.
    expect(args).not.toContain("-N")
    expect(args).not.toContain("-U")
    expect(args).not.toContain("-G")
  })

  it("can be told to skip the lookup, for an offline rip", () => {
    // H4 wants a rip that survives with no internet.
    expect(
      buildCyanripArgs({
        devPath: "/dev/sr3",
        isMetadataLookupEnabled: false,
      }),
    ).toContain("-N")
  })

  it("never ejects the tray", () => {
    // `-Q` ejects on success. Nothing in rip-deck ejects:
    // auto-eject is the root cause of the flap-storm that killed
    // valid rips in other bays, and "only on success" is exactly
    // how a flap starts when a disc is re-read.
    expect(args).not.toContain("-Q")
  })

  it("never turns the paranoia level down", () => {
    // `-P 0` disables read checking entirely. D1 says a rip with
    // read errors is not a success; making rips finish by not
    // looking is the same bug in a different hat.
    expect(args).not.toContain("-P")
  })

  it("passes the drive read offset when one is known", () => {
    // Not cosmetic. AccurateRip compares checksums of samples
    // aligned to a reference offset, so the wrong offset means
    // the verification A3 asks for reports "not in database" on
    // every disc forever, looking like a metadata problem.
    const withOffset = buildCyanripArgs({
      devPath: "/dev/sr3",
      driveOffsetSamples: 6,
    })

    expect(withOffset).toContain("-s")
    expect(withOffset[withOffset.indexOf("-s") + 1]).toBe(
      "6",
    )
  })

  it("omits the offset entirely when it is unknown", () => {
    // Slots 2-4 are LG drives whose firmware reports them as
    // ASUS, so no offset can be looked up from the model string.
    // Passing a made-up 0 would look like a measured value.
    expect(args).not.toContain("-s")
  })

  it("passes a NEGATIVE offset, which is the normal kind", () => {
    // Read offsets are signed and plenty of real drives read
    // early. A validator that only accepted positives would
    // silently drop half the tower's measurements.
    const early = buildCyanripArgs({
      devPath: "/dev/sr3",
      driveOffsetSamples: -472,
    })

    expect(early[early.indexOf("-s") + 1]).toBe("-472")
  })

  it("passes a measured zero, which is not the same as none", () => {
    // A drive whose offset really is 0 has been measured. Only
    // an unmeasured drive omits the flag.
    expect(
      buildCyanripArgs({
        devPath: "/dev/sr3",
        driveOffsetSamples: 0,
      }),
    ).toContain("-s")
  })

  it("refuses garbage rather than handing it to -s", () => {
    // Fails toward OMITTING the flag. A rip with no offset is
    // an unverified rip; a rip with a nonsense offset is a
    // sample-shifted one that no AccurateRip lookup can ever
    // match, which is strictly worse and looks like neither.
    for (const bad of [
      6.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_READ_OFFSET_SAMPLES + 1,
      -MAX_READ_OFFSET_SAMPLES - 1,
      // A units mix-up: samples pasted as bytes, or an offset
      // typed with one digit too many.
      1_568_000,
    ]) {
      expect(
        buildCyanripArgs({
          devPath: "/dev/sr3",
          driveOffsetSamples: bad,
        }),
      ).not.toContain("-s")
    }
  })

  it("emits only options cyanrip 0.9.3 accepts", () => {
    // Checked against the real binary, which is new: until
    // 2026-07-27 there was no cyanrip on this rig to check
    // against, and the image could not have run one.
    //
    // Every variant, because the optional flags are the ones a
    // fixed `args` never exercises — an offline rip's `-N` and a
    // known-offset rip's `-s` are exactly where a typo would
    // hide until a real CD hit that branch.
    const everyFlag = [
      ...buildCyanripArgs({ devPath: "/dev/sr3" }),
      ...buildCyanripArgs({
        devPath: "/dev/sr3",
        driveOffsetSamples: 6,
        isMetadataLookupEnabled: false,
      }),
    ].filter((arg) => arg.startsWith("-"))

    // Guards the filter itself: a builder that emitted no flags
    // at all would satisfy the assertion below vacuously.
    expect(everyFlag.length).toBeGreaterThan(0)

    for (const flag of everyFlag) {
      expect(CYANRIP_0_9_3_OPTIONS).toContain(flag)
    }
  })
})

describe("resolving how to invoke cyanrip", () => {
  it("defaults to a bare binary name", () => {
    expect(resolveCyanripCommand(undefined)).toEqual({
      command: "cyanrip",
      prefixArgs: [],
      wrapperArgs: null,
    })
  })

  it("accepts a wrapper command vector", () => {
    // The image ships cyanrip now, so this is no longer the only
    // way to reach one — it is how a rip reaches a cyanrip
    // somewhere ELSE: `rip-deck` run outside the image, or a
    // newer build than trixie's while it soaks. The kill path
    // below exists only for this case.
    expect(
      resolveCyanripCommand("docker exec cyanrip cyanrip"),
    ).toEqual({
      command: "docker",
      prefixArgs: ["exec", "cyanrip", "cyanrip"],
      wrapperArgs: ["exec", "cyanrip"],
    })
  })

  it("tolerates padding", () => {
    expect(
      resolveCyanripCommand("  /usr/bin/cyanrip  "),
    ).toEqual({
      command: "/usr/bin/cyanrip",
      prefixArgs: [],
      wrapperArgs: null,
    })
  })

  it("is null for a plain binary, so nothing extra runs", () => {
    expect(
      resolveCyanripCommand("cyanrip").wrapperArgs,
    ).toBeNull()
  })
})

describe("the full invocation", () => {
  const invocation = buildCyanripInvocation({
    cyanrip: resolveCyanripCommand(
      "docker exec cyanrip cyanrip",
    ),
    incompletePath:
      "/media/Disc-Rips/.rip-deck-incomplete-abc",
    rip: { devPath: "/dev/sr3" },
  })

  it("writes straight to the dataset (A7)", () => {
    // Through the working directory, not through a flag: `-D`
    // takes a NAMING SCHEME, and whether it tolerates an
    // absolute prefix is undocumented and unverified. A child's
    // cwd is not.
    //
    // Staging elsewhere is abcde's old wart, where a mid-rip
    // kill produced zero output.
    expect(invocation.cwd).toBe(
      "/media/Disc-Rips/.rip-deck-incomplete-abc",
    )
  })

  it("puts the wrapper's args ahead of cyanrip's own", () => {
    expect(invocation.command).toBe("docker")
    expect(invocation.args.slice(0, 3)).toEqual([
      "exec",
      "cyanrip",
      "cyanrip",
    ])
    expect(invocation.args).toContain("/dev/sr3")
  })
})

describe("finding what cyanrip produced", () => {
  it("returns the single album directory", () => {
    // cyanrip creates an album directory INSIDE its working
    // directory — makemkvcon writes its structure directly into
    // the directory it is handed. Renaming the incomplete
    // directory would nest the album one level too deep.
    expect(
      resolveCyanripAlbumDir([
        { name: "Kind of Blue [flac]", isDirectory: true },
        { name: "Kind of Blue.log", isDirectory: false },
      ]),
    ).toBe("Kind of Blue [flac]")
  })

  it("fails closed when nothing was written", () => {
    // A rip that produced no output is a failure a zero exit
    // code would otherwise hide — the audio-path twin of the
    // backup that reported success with an empty folder.
    expect(
      resolveCyanripAlbumDir([
        { name: "empty.log", isDirectory: false },
      ]),
    ).toBeNull()
  })

  it("fails closed on more than one directory", () => {
    // A multi-disc set, or leftovers from a previous attempt.
    // Picking one would file half an album under the other
    // half's name.
    expect(
      resolveCyanripAlbumDir([
        { name: "Disc 1 [flac]", isDirectory: true },
        { name: "Disc 2 [flac]", isDirectory: true },
      ]),
    ).toBeNull()
  })
})

describe("killing a cyanrip that a wrapper put elsewhere", () => {
  it("targets the device, because the uuid is not in argv", () => {
    // The makemkvcon twin matches the job UUID because the UUID
    // is in its output-path argument. cyanrip's UUID is only in
    // its working directory, and a cwd does not appear in
    // /proc/<pid>/cmdline.
    expect(
      buildCyanripKillArgs({
        wrapperArgs: ["exec", "cyanrip"],
        devPath: "/dev/sr3",
        signal: "TERM",
      }),
    ).toEqual([
      "exec",
      "cyanrip",
      "pkill",
      "-TERM",
      "-f",
      "(^| )/dev/sr3( |$)",
    ])
  })

  it("anchors so /dev/sr1 cannot match /dev/sr10", () => {
    // `pkill -f` matches an extended regex against the whole
    // space-joined command line, so a bare device path is a
    // substring of a two-digit one. srN is assigned by
    // enumeration order and is not bounded by the nine physical
    // drives, so two-digit names are a normal state.
    const pattern = buildCyanripKillArgs({
      wrapperArgs: [],
      devPath: "/dev/sr1",
      signal: "KILL",
    }).at(-1)

    expect(pattern).toBeDefined()
    const matcher = new RegExp(pattern as string)

    expect(
      matcher.test("cyanrip -d /dev/sr1 -o flac"),
    ).toBe(true)
    expect(
      matcher.test("cyanrip -d /dev/sr10 -o flac"),
    ).toBe(false)
  })

  it("never matches on the process name", () => {
    // `pkill -f cyanrip` would take out all nine CD rips at
    // once — the same disaster `pkill -f makemkvcon` would be.
    expect(
      buildCyanripKillArgs({
        wrapperArgs: [],
        devPath: "/dev/sr3",
        signal: "KILL",
      }),
    ).not.toContain("cyanrip")
  })
})
