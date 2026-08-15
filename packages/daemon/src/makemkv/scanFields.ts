/**
 * Field scanner for MakeMKV robot-mode lines.
 *
 * Hand-rolled on purpose. A CSV library is the obvious reach
 * and it is wrong here, because makemkvcon does not emit CSV:
 *
 *  - Quoted fields escape a literal quote TWO different ways —
 *    CSV-style `""` and C-style `\"`. The backslash form is not
 *    hypothetical: `MSG:5072` ("Backing up disc into folder
 *    \"file:///…\"") uses it on every single backup, and it was
 *    the one malformed line in a 57,483-line real capture.
 *    Handling only `""` ends the field at the first `\"`,
 *    undercounts the fields, and the whole message is discarded.
 *  - UNQUOTED fields may contain a bare `"` (disc volume labels
 *    routinely do), which makes a strict CSV parser throw or,
 *    worse, silently swallow the rest of the line.
 *  - Quoted fields contain commas (`"Alien, Aliens & Alien 3"`),
 *    so naive `.split(",")` is equally wrong.
 *
 * The rule that keeps this simple: quoting is only significant
 * when a field STARTS with `"`. Anywhere else a quote is just a
 * character.
 */

export type ScannedLine = {
  prefix: string
  fields: string[]
}

/**
 * Split the payload of a robot-mode line into raw fields.
 *
 * Exported separately from `scanLine` so it can be tested
 * against pathological values directly.
 */
export const scanFields = (payload: string): string[] => {
  const fields: string[] = []
  let index = 0
  let isDone = false

  while (!isDone) {
    // Reaching the end here means the previous field was
    // followed by a separator, so a final empty field is real.
    if (index >= payload.length) {
      fields.push("")
      break
    }

    if (payload[index] === '"') {
      const { value, nextIndex, hasSeparator } = readQuoted(
        payload,
        index,
      )

      fields.push(value)
      index = nextIndex

      // A quoted field that ended the line is the LAST field.
      // Without this check a trailing quoted field invents a
      // spurious empty field after it — which silently turned
      // a 6-field DRV into an apparently-valid 7-field one and
      // shifted the disc name into the device path.
      if (!hasSeparator) isDone = true
    } else {
      const comma = payload.indexOf(",", index)

      if (comma === -1) {
        fields.push(payload.slice(index))
        isDone = true
      } else {
        fields.push(payload.slice(index, comma))
        index = comma + 1
      }
    }
  }

  return fields
}

/**
 * Read a quoted field starting at `start` (which must be `"`).
 *
 * An unterminated quote is tolerated rather than thrown: a
 * truncated log line (killed mid-write, which happens every
 * time we kill a rip) should degrade to a best-effort value,
 * not take down the parser.
 */
const readQuoted = (
  payload: string,
  start: number,
): {
  value: string
  nextIndex: number
  /** False when the field ended the line rather than a comma. */
  hasSeparator: boolean
} => {
  let index = start + 1
  let value = ""

  while (index < payload.length) {
    const char = payload[index]

    // A backslash escape. MakeMKV emits `\"` inside quoted
    // fields — every `MSG:5072` does — and `\\` for a literal
    // backslash. Consuming both characters together is what
    // stops the `"` being mistaken for the end of the field.
    //
    // Any other `\x` is left alone rather than unescaped:
    // inventing escape sequences MakeMKV does not emit would
    // corrupt Windows-style paths, which are full of lone
    // backslashes.
    if (char === "\\") {
      const next = payload[index + 1]

      if (next === '"' || next === "\\") {
        value += next
        index += 2
        continue
      }

      value += char
      index += 1
      continue
    }

    if (char !== '"') {
      value += char
      index += 1
      continue
    }

    // A doubled quote is an escaped literal quote.
    if (payload[index + 1] === '"') {
      value += '"'
      index += 2
      continue
    }

    // Closing quote. Skip it and the following separator.
    index += 1
    const hasSeparator = payload[index] === ","
    if (hasSeparator) index += 1

    return { value, nextIndex: index, hasSeparator }
  }

  // Unterminated — take what we have.
  return {
    value,
    nextIndex: payload.length,
    hasSeparator: false,
  }
}

/**
 * Split a full line into its prefix and fields.
 *
 * Returns null when the line has no `PREFIX:` shape at all, so
 * callers can classify it as UNKNOWN rather than guessing.
 * Only the FIRST colon is a separator — message text is full of
 * them ("Error: ...", timecodes, device paths).
 */
export const scanLine = (
  line: string,
): ScannedLine | null => {
  const trimmed = line.replace(/\r$/, "")
  const colon = trimmed.indexOf(":")

  if (colon <= 0) return null

  const prefix = trimmed.slice(0, colon)

  // Robot-mode prefixes are short and uppercase. Anything else
  // is prose that happens to contain a colon.
  if (!/^[A-Z]{3,6}$/.test(prefix)) return null

  return {
    prefix,
    fields: scanFields(trimmed.slice(colon + 1)),
  }
}
