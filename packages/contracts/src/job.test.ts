import { describe, expect, it } from "vitest"
import { isRipSuccessful } from "./job.ts"

/**
 * The success test, and specifically the line that was removed
 * from it on 2026-08-27.
 *
 * `isRipSuccessful` used to open `if (readErrorCount !== 0)
 * return false`, and that line badged a complete, mountable 8 GB
 * DVD backup as a failure. The owner's rule replaced it: *"This
 * should be a warning. It didn't fail because it made the ISO,
 * but the ISO is problematic, so I'd like to know that."*
 *
 * These assertions pin BOTH halves — the softening, and the
 * things that were never softened.
 */

const backup = (
  overrides: Partial<
    Parameters<typeof isRipSuccessful>[0]
  > = {},
) =>
  isRipSuccessful({
    mode: "backup",
    exitCode: 0,
    titlesSaved: null,
    readErrorCount: 0,
    hasVerifiedStructure: true,
    ...overrides,
  })

describe("read errors no longer fail a verified backup", () => {
  it("passes a verified backup that had read errors", () => {
    expect(backup({ readErrorCount: 4 })).toBe(true)
  })

  it("still fails read errors with nothing on the dataset", () => {
    expect(
      backup({
        readErrorCount: 4,
        hasVerifiedStructure: false,
      }),
    ).toBe(false)
  })
})

describe("what did NOT get softer", () => {
  it("a non-zero exit is still a failure", () => {
    expect(backup({ exitCode: 1 })).toBe(false)
  })

  it("a null exit code is still a failure", () => {
    // The child never ran, or we never saw it end.
    expect(backup({ exitCode: null })).toBe(false)
  })

  it("an unverified backup is still a failure", () => {
    expect(backup({ hasVerifiedStructure: false })).toBe(
      false,
    )
  })

  it("MakeMKV saying the backup failed still fails it", () => {
    // MSG:5069 / MSG:5080, against exit 0 and an output
    // directory that still holds the PREVIOUS run's bytes.
    // Nothing produced this input before 2026-08-27, and with
    // the read-error gate gone it is the message half of the
    // test.
    expect(backup({ hasFailureMessage: true })).toBe(false)
  })

  it("mkv mode still needs a non-zero title count", () => {
    expect(
      isRipSuccessful({
        mode: "mkv",
        exitCode: 0,
        titlesSaved: 0,
        readErrorCount: 0,
      }),
    ).toBe(false)

    expect(
      isRipSuccessful({
        mode: "mkv",
        exitCode: 0,
        titlesSaved: 3,
        readErrorCount: 9,
      }),
    ).toBe(true)
  })
})
