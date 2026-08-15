import { describe, expect, it } from "vitest"
import {
  buildInnerKillArgs,
  buildIsolatedMakemkvCommand,
  buildRipArgs,
  buildRipContainerName,
  buildRipInvocation,
  hashArgv,
  ISOLATED_DISC_INDEX,
  type RipIsolation,
  resolveMakemkvCommand,
  resolveRipIsolation,
} from "./ripCommand.ts"

describe("the rip command", () => {
  const args = buildRipArgs({
    discIndex: 5,
    outputPath: "/dest/.rip-deck-incomplete-abc",
  })

  it("passes --noscan", () => {
    // Kept for the info paths, where it IS the fix for the
    // 17-minute "Scanning CD-ROM devices" hang at 0% CPU.
    // Measured 2026-07-25: `backup` ignores it and scans anyway.
    expect(args).toContain("--noscan")
  })

  it("addresses the drive by disc index, not device", () => {
    // Not a preference. `backup` rejects a device source
    // outright — "Backup source must start with \"disc:\"",
    // exit 10 — which is why ripJob has to verify the index
    // against MakeMKV's own DRV table before writing.
    expect(args).toContain("disc:5")
    expect(
      args.filter((a) => a.startsWith("dev:")),
    ).toHaveLength(0)
  })

  it("bounds the cache", () => {
    // Nine default caches would exhaust RAM on a host that is
    // also a NAS (E4).
    expect(args).toContain("--cache=128")
  })

  it("keeps progress on stdout", () => {
    // Robot mode swallows progress entirely without this, which
    // is a silent way to lose every PRGV event.
    expect(args).toContain("--progress=-same")
    expect(args).toContain("--messages=-stdout")
  })

  it("backs up rather than transcoding", () => {
    // A2: backup-only is the default, not an override.
    expect(args).toContain("backup")
    expect(args).toContain("--decrypt")
  })

  it("writes to the incomplete directory, last", () => {
    expect(args[args.length - 1]).toBe(
      "/dest/.rip-deck-incomplete-abc",
    )
  })
})

describe("resolving how to invoke makemkvcon", () => {
  it("defaults to a bare binary name", () => {
    expect(resolveMakemkvCommand(undefined)).toEqual({
      command: "makemkvcon",
      prefixArgs: [],
      wrapperArgs: null,
    })
  })

  it("accepts a wrapper command vector", () => {
    // makemkvcon is not installed on this host — it lives inside
    // a container, so the Stage 3 hardware test needs this.
    expect(
      resolveMakemkvCommand("docker exec arm makemkvcon"),
    ).toEqual({
      command: "docker",
      prefixArgs: ["exec", "arm", "makemkvcon"],
      wrapperArgs: ["exec", "arm"],
    })
  })

  it("tolerates padding", () => {
    expect(
      resolveMakemkvCommand("  /usr/bin/makemkvcon  "),
    ).toEqual({
      command: "/usr/bin/makemkvcon",
      prefixArgs: [],
      wrapperArgs: null,
    })
  })
})

describe("killing a rip that a wrapper put elsewhere", () => {
  it("peels the binary off to get a general exec prefix", () => {
    // Measured on the real host: SIGTERM to a `docker exec`
    // client kills the client and leaves the process inside
    // running. Without reaching in, the cancel path orphans a
    // makemkvcon that still holds the drive (E5).
    expect(
      resolveMakemkvCommand("docker exec arm makemkvcon")
        .wrapperArgs,
    ).toEqual(["exec", "arm"])
  })

  it("needs no knowledge of a wrapper's flags", () => {
    // Scanning forward for the container name breaks the moment
    // a flag takes a value: in `-u arm -i prod`, the first
    // non-flag token is `arm`, the argument to `-u`.
    expect(
      resolveMakemkvCommand(
        "docker exec -u arm -i rip-deck-makemkv makemkvcon",
      ).wrapperArgs,
    ).toEqual([
      "exec",
      "-u",
      "arm",
      "-i",
      "rip-deck-makemkv",
    ])
  })

  it("handles a wrapper that is not docker at all", () => {
    // rip-deck's own container has no docker CLI, so reaching
    // makemkvcon may mean going through ssh first. Peeling the
    // binary off works for that unchanged.
    expect(
      resolveMakemkvCommand(
        "ssh root@tower.example.com docker exec arm makemkvcon",
      ).wrapperArgs,
    ).toEqual([
      "root@tower.example.com",
      "docker",
      "exec",
      "arm",
    ])
  })

  it("is null for a plain binary, so nothing extra runs", () => {
    expect(
      resolveMakemkvCommand("makemkvcon").wrapperArgs,
    ).toBeNull()
  })

  it("targets the job uuid, never the process name", () => {
    const args = buildInnerKillArgs({
      wrapperArgs: ["exec", "arm"],
      jobUuid: "1f0e-uuid",
      signal: "TERM",
    })

    expect(args).toEqual([
      "exec",
      "arm",
      "pkill",
      "-TERM",
      "-f",
      "1f0e-uuid",
    ])

    // `pkill -f makemkvcon` would be a disaster while we are
    // borrowing ARM's container: it is ripping eight other discs.
    expect(args).not.toContain("makemkvcon")
  })
})

describe("resolving whether a rip is isolated", () => {
  it("is off when no image is configured", () => {
    // A deployment without a docker socket must keep ripping the
    // way Stage 3 did, not fail every job.
    expect(resolveRipIsolation({})).toBeNull()
    expect(
      resolveRipIsolation({
        RIP_DECK_RIP_ISOLATION_IMAGE: "   ",
      }),
    ).toBeNull()
  })

  it("defaults to a plain local docker", () => {
    expect(
      resolveRipIsolation({
        RIP_DECK_RIP_ISOLATION_IMAGE: "rip-deck:0.1.0",
      }),
    ).toEqual({
      image: "rip-deck:0.1.0",
      dockerArgs: ["docker"],
      extraArgs: [],
    })
  })

  it("takes a runtime that is not local docker", () => {
    // Same shape as RIP_DECK_MAKEMKVCON, for the same reason: the
    // process that wants a container is not always sitting on the
    // socket that can make one.
    expect(
      resolveRipIsolation({
        RIP_DECK_RIP_ISOLATION_IMAGE: "rip-deck:0.1.0",
        RIP_DECK_RIP_ISOLATION_DOCKER:
          "ssh root@tower.example.com docker",
        RIP_DECK_RIP_ISOLATION_ARGS:
          "  -v /a:/a   -v /b:/config  ",
      }),
    ).toEqual({
      image: "rip-deck:0.1.0",
      dockerArgs: [
        "ssh",
        "root@tower.example.com",
        "docker",
      ],
      extraArgs: ["-v", "/a:/a", "-v", "/b:/config"],
    })
  })
})

/** Every `--device` value on a `docker run` vector. */
const devicesOf = (prefixArgs: string[]): string[] =>
  prefixArgs.flatMap((arg, index) =>
    prefixArgs[index - 1] === "--device" ? [arg] : [],
  )

describe("running one rip in its own container", () => {
  const isolation: RipIsolation = {
    image: "rip-deck:0.1.0",
    dockerArgs: ["docker"],
    extraArgs: ["-v", "/media/Disc-Rips:/media/Disc-Rips"],
  }

  const command = buildIsolatedMakemkvCommand({
    scsiGenericPath: null,
    isolation,
    devPath: "/dev/sr3",
    jobUuid: "1f0e-uuid",
  })

  it("hands the container exactly one drive", () => {
    // The entire point. A container gets a minimal /dev, so the
    // bus scan `backup` insists on finds one drive instead of
    // nine — and a wedged sibling is invisible rather than merely
    // deprioritised.
    expect(devicesOf(command.prefixArgs)).toEqual([
      "/dev/sr3",
    ])
  })

  it("runs with an init, so a cancel is not swallowed", () => {
    // Without --init makemkvcon is PID 1, and the kernel drops
    // signals with a default disposition sent to PID 1. The
    // cancel path would silently do nothing — E5 failing in
    // exactly the way it was written to prevent.
    expect(command.prefixArgs).toContain("--init")
  })

  it("never allocates a TTY", () => {
    // A TTY merges stderr into stdout and appends CRs to lines
    // that get parsed field by field. Robot-mode output is
    // parsed, not read.
    expect(command.prefixArgs).not.toContain("-t")
    expect(command.prefixArgs).not.toContain("--tty")
  })

  it("names the container per job, never per drive", () => {
    // Nine at once, and a drive can be re-ripped while its last
    // container is still tearing down. `docker run --name` fails
    // outright on a duplicate.
    expect(command.prefixArgs).toContain(
      "rip-deck-rip-1f0e-uuid",
    )
    expect(
      buildRipContainerName({ jobUuid: "other" }),
    ).not.toBe(
      buildRipContainerName({ jobUuid: "1f0e-uuid" }),
    )
  })

  it("ends with the image and the binary", () => {
    // prefixArgs is spliced in front of the makemkvcon args, so
    // everything docker needs has to come before the image and
    // nothing may come after the binary.
    expect(command.prefixArgs.slice(-2)).toEqual([
      "rip-deck:0.1.0",
      "makemkvcon",
    ])
  })

  it("cleans up after itself", () => {
    // Nine rips a batch would otherwise leave nine dead
    // containers behind every time.
    expect(command.prefixArgs).toContain("--rm")
  })

  it("can still be reached to be killed", () => {
    // wrapperArgs keeps its documented meaning — how to run an
    // arbitrary command wherever makemkvcon ended up — which for
    // a per-rip container is `docker exec <name>`.
    expect(
      buildInnerKillArgs({
        wrapperArgs: command.wrapperArgs ?? [],
        jobUuid: "1f0e-uuid",
        signal: "KILL",
      }),
    ).toEqual([
      "exec",
      "rip-deck-rip-1f0e-uuid",
      "pkill",
      "-KILL",
      "-f",
      "1f0e-uuid",
    ])
  })

  it("carries a remote runtime through to the kill", () => {
    // `ssh host docker run …` must be killed by `ssh host docker
    // exec …`, not by a second `ssh host docker run`, which would
    // start a whole new container to run pkill in.
    const remote = buildIsolatedMakemkvCommand({
      scsiGenericPath: null,
      isolation: {
        ...isolation,
        dockerArgs: ["ssh", "tower", "docker"],
      },
      devPath: "/dev/sr3",
      jobUuid: "1f0e-uuid",
    })

    expect(remote.command).toBe("ssh")
    expect(remote.prefixArgs.slice(0, 3)).toEqual([
      "tower",
      "docker",
      "run",
    ])
    expect(remote.wrapperArgs).toEqual([
      "tower",
      "docker",
      "exec",
      "rip-deck-rip-1f0e-uuid",
    ])
  })

  it("keeps the operator's mounts", () => {
    expect(command.prefixArgs).toContain(
      "/media/Disc-Rips:/media/Disc-Rips",
    )
  })
})

describe("the SCSI generic node (measured 2026-07-26)", () => {
  it("passes sgN alongside srN", () => {
    // MEASURED ON HARDWARE. A container given only
    // `--device /dev/sr0` answers MSG:5042 "The program can't
    // find any usable optical drives." and emits a DRV table of
    // pure padding — MakeMKV talks SCSI through the generic node,
    // so srN alone is a drive it can see and cannot use. With
    // both, the same command reports exactly one drive at index 0.
    const command = buildIsolatedMakemkvCommand({
      isolation: {
        image: "rip-deck:0.1.0",
        dockerArgs: ["docker"],
        extraArgs: [],
      },
      devPath: "/dev/sr0",
      scsiGenericPath: "/dev/sg207",
      jobUuid: "1f0e-uuid",
    })

    const deviceFlags = command.prefixArgs.flatMap(
      (arg, index) =>
        arg === "--device"
          ? [command.prefixArgs[index + 1]]
          : [],
    )

    expect(deviceFlags).toEqual(["/dev/sr0", "/dev/sg207"])
  })

  it("does not invent one when it cannot be resolved", () => {
    // sg numbering does NOT follow srN — on this host sr0..sr8
    // are sg207..sg215, because the NAS's own pool disks hold the
    // low numbers. Guessing `sg0` would hand the rip container
    // somebody else's disk, so an unresolved node omits the flag
    // and lets the rip fail loudly instead.
    const command = buildIsolatedMakemkvCommand({
      isolation: {
        image: "rip-deck:0.1.0",
        dockerArgs: ["docker"],
        extraArgs: [],
      },
      devPath: "/dev/sr0",
      scsiGenericPath: null,
      jobUuid: "1f0e-uuid",
    })

    expect(command.prefixArgs).not.toContain("/dev/sg0")
    expect(
      command.prefixArgs.filter(
        (arg) => arg === "--device",
      ),
    ).toHaveLength(1)
  })
})

describe("choosing the invocation for one rip", () => {
  const base = {
    makemkv: resolveMakemkvCommand("makemkvcon"),
    devPath: "/dev/sr0",
    scsiGenericPath: "/dev/sg207",
    jobUuid: "1f0e-uuid",
    discIndex: 5,
  }

  it("leaves an unisolated rip exactly as it was", () => {
    // Isolation is opt-in; the Stage 3 path that ripped a real
    // disc twice must not change shape underneath it.
    expect(
      buildRipInvocation({ ...base, isolation: null }),
    ).toEqual({
      makemkv: base.makemkv,
      discIndex: 5,
      isIsolated: false,
    })
  })

  it("replaces the bus-wide index rather than passing it on", () => {
    // disc:5 was resolved against nine drives. Inside a container
    // holding one, it addresses nothing — and the same drive is
    // disc:0 there.
    const invocation = buildRipInvocation({
      ...base,
      isolation: {
        image: "rip-deck:0.1.0",
        dockerArgs: ["docker"],
        extraArgs: [],
      },
    })

    expect(invocation.discIndex).toBe(ISOLATED_DISC_INDEX)
    expect(invocation.discIndex).not.toBe(5)
    expect(invocation.isIsolated).toBe(true)

    // And that is what actually lands on the argv.
    expect(
      buildRipArgs({
        discIndex: invocation.discIndex,
        outputPath: "/dest/out",
      }),
    ).toContain("disc:0")
  })

  it("scopes each of nine concurrent rips to its own bay", () => {
    // The shape the owner asked for: nine discs in, nine rips
    // out. Each container sees one device and names itself after
    // its job, so nothing about one rip is addressable from
    // another.
    const jobs = Array.from({ length: 9 }, (_, slot) => ({
      devPath: `/dev/sr${slot}`,
      jobUuid: `uuid-${slot}`,
    }))

    const commands = jobs.map(({ devPath, jobUuid }) =>
      buildIsolatedMakemkvCommand({
        scsiGenericPath: null,
        isolation: {
          image: "rip-deck:0.1.0",
          dockerArgs: ["docker"],
          extraArgs: [],
        },
        devPath,
        jobUuid,
      }),
    )

    for (const [slot, command] of commands.entries()) {
      expect(devicesOf(command.prefixArgs)).toEqual([
        `/dev/sr${slot}`,
      ])
    }

    expect(
      new Set(commands.map((c) => c.wrapperArgs?.join(" ")))
        .size,
    ).toBe(9)
  })
})

describe("the argv hash", () => {
  it("is stable for the same command", () => {
    expect(hashArgv(["a", "b"])).toBe(hashArgv(["a", "b"]))
  })

  it("changes with the output directory", () => {
    // The output directory carries the job UUID, so a matching
    // hash cannot be a coincidence — which is what makes orphan
    // adoption safe.
    const one = hashArgv(
      buildRipArgs({
        discIndex: 5,
        outputPath: "/dest/.rip-deck-incomplete-aaa",
      }),
    )
    const two = hashArgv(
      buildRipArgs({
        discIndex: 5,
        outputPath: "/dest/.rip-deck-incomplete-bbb",
      }),
    )

    expect(one).not.toBe(two)
  })

  it("changes with the target drive", () => {
    const one = hashArgv(
      buildRipArgs({
        discIndex: 5,
        outputPath: "/dest/out",
      }),
    )
    const two = hashArgv(
      buildRipArgs({
        discIndex: 0,
        outputPath: "/dest/out",
      }),
    )

    expect(one).not.toBe(two)
  })
})
