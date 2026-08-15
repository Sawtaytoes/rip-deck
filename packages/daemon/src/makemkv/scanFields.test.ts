import { describe, expect, it } from "vitest"
import { scanFields } from "./scanFields.ts"

/**
 * The field scanner, against the shapes that actually broke it.
 *
 * `parseLine.test.ts` covers event shapes; this covers the
 * tokeniser underneath, where the failures are subtle and
 * silent — a miscounted field does not throw, it shifts every
 * later value one position left.
 */

describe("escaping inside a quoted field", () => {
  it("handles the backslash-escaped quotes MakeMKV really emits", () => {
    // The exact shape of MSG:5072, which every backup emits and
    // which was the single malformed line in a 57,483-line real
    // capture. Handling only CSV-style "" ends the field at the
    // first \" and silently drops the message.
    const fields = scanFields(
      '5072,131072,1,"Backing up disc into folder \\"file:///out\\"",' +
        '"Backing up disc into folder \\"%1\\"","file:///out"',
    )

    expect(fields).toHaveLength(6)
    expect(fields[3]).toBe(
      'Backing up disc into folder "file:///out"',
    )
    expect(fields[5]).toBe("file:///out")
  })

  it("still handles CSV-style doubled quotes", () => {
    // Both forms appear; fixing one must not break the other.
    const fields = scanFields('1,"say ""what"" now",2')

    expect(fields).toEqual(["1", 'say "what" now', "2"])
  })

  it("unescapes a doubled backslash", () => {
    const fields = scanFields('1,"C:\\\\path",2')

    expect(fields).toEqual(["1", "C:\\path", "2"])
  })

  it("leaves a lone backslash alone", () => {
    // Windows paths are full of single backslashes that are not
    // escapes. Inventing escape sequences MakeMKV does not emit
    // would corrupt them.
    const fields = scanFields('1,"C:\\Users\\example",2')

    expect(fields).toEqual(["1", "C:\\Users\\example", "2"])
  })

  it("reads an escaped quote as content, leaving the field open", () => {
    // `"ends with \"` has no closing quote once `\"` is
    // correctly read as a literal quote, so the field runs to
    // end-of-line. That is the honest reading of a truncated
    // line, and it degrades rather than throwing — but it does
    // mean an escape-aware scanner cannot also recover the
    // trailing `,2` as a separate field. Recorded because the
    // alternative (treating a trailing `\"` as a terminator) is
    // the tempting wrong fix.
    const fields = scanFields('1,"ends with \\",2')

    expect(fields).toEqual(["1", 'ends with ",2'])
  })
})

describe("the shapes that are not CSV", () => {
  it("keeps commas inside quoted fields", () => {
    expect(
      scanFields('1,"Alien, Aliens & Alien 3",2'),
    ).toEqual(["1", "Alien, Aliens & Alien 3", "2"])
  })

  it("tolerates a bare quote in an UNQUOTED field", () => {
    // Disc volume labels do this, and a strict CSV parser either
    // throws or swallows the remainder of the line.
    expect(scanFields('1,THE "BURBS,2')).toEqual([
      "1",
      'THE "BURBS',
      "2",
    ])
  })

  it("does not invent a field after a trailing quoted one", () => {
    // This turned a 6-field DRV into an apparently-valid
    // 7-field one and shifted the disc name into the device path.
    expect(scanFields('0,1,"last"')).toHaveLength(3)
  })

  it("keeps a genuinely empty trailing field", () => {
    expect(scanFields("0,1,")).toEqual(["0", "1", ""])
  })

  it("degrades on an unterminated quote rather than throwing", () => {
    // We kill rips mid-write routinely, so a truncated line is
    // normal input, not a corruption to reject.
    expect(scanFields('1,"never closed')).toEqual([
      "1",
      "never closed",
    ])
  })
})
