import { EMPTY_PROGRESS } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { createRipObservations } from "./outcome.ts"
import type { RipJobResult } from "./ripJob.ts"
import { describeRipOutcome } from "./watcher.ts"

/**
 * The sentence the owner reads at the rack.
 *
 * It was composed inline inside `runBayRip`, which nothing can
 * reach — that function sits behind `waitForSettledMedia`,
 * `detectDiscType` and a `makemkvcon` spawn. So the one string
 * that says what happened to a disc had no assertion on it at
 * all, and on 2026-08-27 it said `empty_output` about a rip
 * that had produced a complete 8 GB ISO.
 */

const result = (
  overrides: Partial<RipJobResult> = {},
): RipJobResult => ({
  isSuccessful: true,
  failureReason: null,
  titlesSaved: null,
  readErrorCount: 0,
  warnings: [],
  termination: "exited",
  exitCode: 0,
  observations: createRipObservations(),
  progress: EMPTY_PROGRESS,
  destinationPath: "/media/Disc-Rips/Ivanhoe.iso",
  incompletePath: null,
  hasCollision: false,
  wrongDriveDevPath: null,
  verificationFailure: null,
  stderr: "",
  ...overrides,
})

const describe_ = (overrides: Partial<RipJobResult> = {}) =>
  describeRipOutcome({
    result: result(overrides),
    destinationPath: "/media/Disc-Rips/Ivanhoe.iso",
  })

describe("the three states of a finished rip", () => {
  it("a clean rip is completed and says where it landed", () => {
    const outcome = describe_()

    expect(outcome.kind).toBe("completed")
    expect(outcome.detail).toBe(
      "/media/Disc-Rips/Ivanhoe.iso",
    )
    expect(outcome.warnings).toEqual([])
  })

  it("a rip with warnings is its OWN kind, still a success", () => {
    // Not `failed` (there is a backup) and not plain
    // `completed` (it may be damaged). The third state.
    const outcome = describe_({
      warnings: [
        {
          kind: "read_errors",
          message: "4 read errors at 3.20 GB.",
        },
      ],
    })

    expect(outcome.kind).toBe("completed_with_warnings")
    expect(outcome.detail).toContain(
      "/media/Disc-Rips/Ivanhoe.iso",
    )
    expect(outcome.detail).toContain("4 read errors")
    expect(outcome.warnings).toEqual([
      "4 read errors at 3.20 GB.",
    ])
  })

  it("a failure still names the reason and the exit code", () => {
    const outcome = describe_({
      isSuccessful: false,
      failureReason: "empty_output",
      destinationPath: null,
    })

    expect(outcome.kind).toBe("failed")
    expect(outcome.detail).toContain("empty_output")
    expect(outcome.detail).toContain("makemkvcon exited 0")
  })
})

describe("what the structural check actually saw", () => {
  // ⚠️ The reason `verifyBackupStructure` writes was computed
  // and thrown away. `empty_output` is the same word for three
  // different situations wanting three different actions, and
  // on 2026-08-27 the bare reason cost a full investigation
  // before anybody could say which had happened.
  it("prints the verification failure beside the reason", () => {
    const outcome = describe_({
      isSuccessful: false,
      failureReason: "empty_output",
      destinationPath: null,
      verificationFailure:
        "the output is a file with no ISO9660 signature in " +
        "it, so whatever ran did not produce a disc image",
    })

    expect(outcome.detail).toContain("no ISO9660 signature")
  })

  it("says nothing when the check never ran", () => {
    // A rip we killed ourselves never reached the dataset
    // check, and "nothing was written" would be a claim about
    // a directory nobody looked at.
    const outcome = describe_({
      isSuccessful: false,
      failureReason: "cancelled_by_operator",
      termination: "cancelled_by_operator",
      exitCode: 143,
      destinationPath: null,
    })

    expect(outcome.detail).toContain("exit 143")
    expect(outcome.detail).not.toContain("—")
  })

  it("keeps the read errors on a failure too", () => {
    // They are the explanation for having nothing, so they
    // travel with the failure rather than being dropped for
    // not being a warning-shaped outcome.
    const outcome = describe_({
      isSuccessful: false,
      failureReason: "read_errors",
      destinationPath: null,
      warnings: [
        {
          kind: "read_errors",
          message: "41 read errors at 1.10 GB and 40 more.",
        },
      ],
    })

    expect(outcome.kind).toBe("failed")
    expect(outcome.warnings).toEqual([
      "41 read errors at 1.10 GB and 40 more.",
    ])
  })

  it("still points at partial output that was kept", () => {
    const outcome = describe_({
      isSuccessful: false,
      failureReason: "read_errors",
      destinationPath: null,
      incompletePath:
        "/media/Disc-Rips/.rip-deck-incomplete-x",
    })

    expect(outcome.detail).toContain(
      "Partial output KEPT at /media/Disc-Rips/.rip-deck-incomplete-x",
    )
  })
})
