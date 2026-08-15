import type {
  MakemkvEvent,
  MalformedEvent,
} from "@rip-deck/contracts"
import { scanLine } from "./scanFields.ts"

/**
 * Turn one line of `makemkvcon -r` output into a typed event.
 *
 * Design rules, each of which exists because getting it wrong
 * is a known failure mode:
 *
 *  - NEVER index a field without checking the length first. A
 *    truncated line (we kill rips mid-write routinely) would
 *    otherwise produce `undefined` where a string is typed, and
 *    the failure surfaces far away from the cause.
 *  - An unparseable line becomes a MALFORMED event, never an
 *    exception. One weird line must not kill a 3-hour rip.
 *  - Field counts come from real output, not the docs. TINFO
 *    and SINFO carry index prefixes the docs omit, and DRV has
 *    seven fields where the docs imply six.
 */

const malformed = (
  prefix: string,
  raw: string,
  reason: string,
): MalformedEvent => ({
  type: "MALFORMED",
  prefix,
  raw,
  reason,
})

/** Parse a field as an integer, or null if absent/not numeric. */
const intAt = (
  fields: string[],
  index: number,
): number | null => {
  if (index >= fields.length) return null

  const parsed = Number.parseInt(fields[index].trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** Read a field as a string, or "" if absent. */
const strAt = (fields: string[], index: number): string =>
  index < fields.length ? fields[index] : ""

export const parseMakemkvLine = (
  line: string,
): MakemkvEvent => {
  const scanned = scanLine(line)

  if (scanned === null) {
    return { type: "UNKNOWN", raw: line }
  }

  const { prefix, fields } = scanned

  switch (prefix) {
    case "DRV": {
      // index,visible,enabled,flags,name,discName,devicePath
      if (fields.length < 7) {
        return malformed(
          prefix,
          line,
          `DRV needs 7 fields, got ${fields.length}`,
        )
      }

      const index = intAt(fields, 0)
      if (index === null) {
        return malformed(
          prefix,
          line,
          "DRV index not numeric",
        )
      }

      return {
        type: "DRV",
        index,
        visible: intAt(fields, 1) ?? 0,
        enabled: intAt(fields, 2) ?? 0,
        flags: intAt(fields, 3) ?? 0,
        driveName: strAt(fields, 4),
        discName: strAt(fields, 5),
        devicePath: strAt(fields, 6),
      }
    }

    case "MSG": {
      // code,flags,count,message,format,param0..paramN
      if (fields.length < 5) {
        return malformed(
          prefix,
          line,
          `MSG needs >=5 fields, got ${fields.length}`,
        )
      }

      const code = intAt(fields, 0)
      if (code === null) {
        return malformed(
          prefix,
          line,
          "MSG code not numeric",
        )
      }

      return {
        type: "MSG",
        code,
        flags: intAt(fields, 1) ?? 0,
        count: intAt(fields, 2) ?? 0,
        message: strAt(fields, 3),
        format: strAt(fields, 4),
        // Trust the actual field count over the declared one:
        // `count` has been seen disagreeing with reality.
        params: fields.slice(5),
      }
    }

    case "TCOUNT": {
      const count = intAt(fields, 0)
      if (count === null) {
        return malformed(prefix, line, "TCOUNT not numeric")
      }

      return { type: "TCOUNT", count }
    }

    case "CINFO": {
      // id,code,value
      if (fields.length < 3) {
        return malformed(
          prefix,
          line,
          `CINFO needs 3 fields, got ${fields.length}`,
        )
      }

      const id = intAt(fields, 0)
      const code = intAt(fields, 1)
      if (id === null || code === null) {
        return malformed(
          prefix,
          line,
          "CINFO ids not numeric",
        )
      }

      return {
        type: "CINFO",
        id,
        code,
        value: strAt(fields, 2),
      }
    }

    case "TINFO": {
      // title,id,code,value  <- the leading title index is the
      // field the docs omit. Without it every attribute lands
      // on the wrong title, which is the classic MakeMKV
      // "global index" parsing bug.
      if (fields.length < 4) {
        return malformed(
          prefix,
          line,
          `TINFO needs 4 fields, got ${fields.length}`,
        )
      }

      const title = intAt(fields, 0)
      const id = intAt(fields, 1)
      const code = intAt(fields, 2)
      if (title === null || id === null || code === null) {
        return malformed(
          prefix,
          line,
          "TINFO ids not numeric",
        )
      }

      return {
        type: "TINFO",
        title,
        id,
        code,
        value: strAt(fields, 3),
      }
    }

    case "SINFO": {
      // title,stream,id,code,value
      if (fields.length < 5) {
        return malformed(
          prefix,
          line,
          `SINFO needs 5 fields, got ${fields.length}`,
        )
      }

      const title = intAt(fields, 0)
      const stream = intAt(fields, 1)
      const id = intAt(fields, 2)
      const code = intAt(fields, 3)
      if (
        title === null ||
        stream === null ||
        id === null ||
        code === null
      ) {
        return malformed(
          prefix,
          line,
          "SINFO ids not numeric",
        )
      }

      return {
        type: "SINFO",
        title,
        stream,
        id,
        code,
        value: strAt(fields, 4),
      }
    }

    case "PRGC":
    case "PRGT": {
      // code,id,name
      if (fields.length < 3) {
        return malformed(
          prefix,
          line,
          `${prefix} needs 3 fields, got ${fields.length}`,
        )
      }

      const code = intAt(fields, 0)
      const id = intAt(fields, 1)
      if (code === null || id === null) {
        return malformed(
          prefix,
          line,
          `${prefix} ids not numeric`,
        )
      }

      return {
        type: prefix,
        code,
        id,
        name: strAt(fields, 2),
      }
    }

    case "PRGV": {
      // current,total,max
      if (fields.length < 3) {
        return malformed(
          prefix,
          line,
          `PRGV needs 3 fields, got ${fields.length}`,
        )
      }

      const current = intAt(fields, 0)
      const total = intAt(fields, 1)
      const max = intAt(fields, 2)
      if (
        current === null ||
        total === null ||
        max === null
      ) {
        return malformed(prefix, line, "PRGV not numeric")
      }

      return { type: "PRGV", current, total, max }
    }

    default:
      return { type: "UNKNOWN", raw: line }
  }
}
