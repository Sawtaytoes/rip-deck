import { describe, expect, it } from "vitest"
import {
  ADOPTION_MIN_FRACTION,
  type AdoptionDeps,
  canAdoptOrphan,
  type OrphanClaim,
  parseProcCmdline,
  parseProcStartTime,
} from "./orphan.ts"
import { hashArgv } from "./ripCommand.ts"

/**
 * A restart mid-rip must not throw away an hour of reading, and
 * must not adopt a stranger's process either. All three guards
 * have to agree — the tests below each break exactly one.
 */

const ARGV = ["makemkvcon", "-r", "--noscan", "backup"]

const claim = (
  overrides: Partial<OrphanClaim> = {},
): OrphanClaim => ({
  pid: 4242,
  startTimeTicks: 987_654,
  argvHash: hashArgv(ARGV),
  lastTotalFraction: 0.8,
  ...overrides,
})

const deps = (input: {
  stat?: string | null
  cmdline?: string | null
}): AdoptionDeps => ({
  readProcFile: async (_pid, file) =>
    file === "stat"
      ? (input.stat ?? null)
      : (input.cmdline ?? null),
})

/**
 * A realistic `/proc/<pid>/stat`.
 *
 * Fields 1 and 2 are the pid and the parenthesised comm; every
 * token after the closing paren starts at field 3, so field 22 —
 * the start time — is index 19 of that tail. Each token is
 * labelled with its real field number so a future reader can see
 * the offset is right by inspection.
 */
const procStat = (
  comm: string,
  startTimeTicks: number,
): string => {
  const tail = Array.from({ length: 40 }, (_, index) =>
    String(index + 3),
  )

  const START_TIME_INDEX = 19
  tail[START_TIME_INDEX] = String(startTimeTicks)

  return `4242 (${comm}) ${tail.join(" ")}`
}

describe("the fake /proc/<pid>/stat is built correctly", () => {
  it("puts the start time at field 22", () => {
    // Guards the guard: a mis-built fixture here would make the
    // PID-reuse test pass for the wrong reason.
    const tokens = procStat("x", 999)
      .split(") ")[1]
      .split(" ")

    expect(tokens[0]).toBe("3")
    expect(tokens[19]).toBe("999")
  })
})

describe("parsing /proc/<pid>/stat field 22", () => {
  it("reads the start time", () => {
    expect(
      parseProcStartTime(procStat("makemkvcon", 987_654)),
    ).toBe(987_654)
  })

  it("survives a comm containing spaces and parens", () => {
    // Splitting on whitespace is the classic bug here: it shifts
    // every subsequent field and silently returns the wrong one.
    expect(
      parseProcStartTime(procStat("my (weird) name", 555)),
    ).toBe(555)
  })

  it("returns null for junk rather than a wrong number", () => {
    expect(parseProcStartTime("nonsense")).toBeNull()
    expect(
      parseProcStartTime("4242 (x) S 1 2 3"),
    ).toBeNull()
  })
})

describe("parsing /proc/<pid>/cmdline", () => {
  it("splits on NUL and drops the trailing empty", () => {
    expect(
      parseProcCmdline("makemkvcon\0-r\0--noscan\0"),
    ).toEqual(["makemkvcon", "-r", "--noscan"])
  })
})

describe("adopting an orphan needs all three guards", () => {
  it("adopts when everything agrees", async () => {
    const verdict = await canAdoptOrphan(
      claim(),
      deps({
        stat: procStat("makemkvcon", 987_654),
        cmdline: ARGV.join("\0"),
      }),
    )

    expect(verdict.isAdoptable).toBe(true)
  })

  it("refuses when the process is gone", async () => {
    const verdict = await canAdoptOrphan(
      claim(),
      deps({ stat: null }),
    )

    expect(verdict.isAdoptable).toBe(false)
  })

  it("refuses a recycled PID", async () => {
    // The guard that actually matters. Same PID, different
    // process — adopting it would hand us a stranger's process
    // to later kill on the operator's behalf.
    const verdict = await canAdoptOrphan(
      claim(),
      deps({
        stat: procStat("makemkvcon", 111_111),
        cmdline: ARGV.join("\0"),
      }),
    )

    expect(verdict.isAdoptable).toBe(false)
    if (!verdict.isAdoptable) {
      expect(verdict.reason).toContain("reused")
    }
  })

  it("refuses a different command on the same PID", async () => {
    const verdict = await canAdoptOrphan(
      claim(),
      deps({
        stat: procStat("makemkvcon", 987_654),
        cmdline: ["makemkvcon", "-r", "info"].join("\0"),
      }),
    )

    expect(verdict.isAdoptable).toBe(false)
  })

  it("refuses below the halfway mark", async () => {
    // Cheaper and safer to re-rip than to nurse a process whose
    // telemetry died with the old daemon's stdout pipe.
    const verdict = await canAdoptOrphan(
      claim({
        lastTotalFraction: ADOPTION_MIN_FRACTION - 0.01,
      }),
      deps({
        stat: procStat("makemkvcon", 987_654),
        cmdline: ARGV.join("\0"),
      }),
    )

    expect(verdict.isAdoptable).toBe(false)
  })

  it("checks progress before touching /proc at all", async () => {
    let hasReadProc = false

    await canAdoptOrphan(
      claim({ lastTotalFraction: 0.1 }),
      {
        readProcFile: async () => {
          hasReadProc = true
          return null
        },
      },
    )

    expect(hasReadProc).toBe(false)
  })
})
