/**
 * Turn MakeMKV's complete robot capture into the operator log.
 *
 * The raw capture remains on disk. The browser needs events, not the
 * thousands of PRGV counter samples used to draw the progress bar.
 */
export const buildOperatorLog = (
  capture: string,
): string => {
  const unimportantMessageCodes = new Set([
    "1005", // MakeMKV started
    "1011", // LibreDrive mode
    "3007", // direct disc access
    "5085", // content hash table loaded
  ])

  const events: string[] = []
  let previousStage: string | null = null

  for (const line of capture.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue

    if (
      trimmed.startsWith("PRGV:") ||
      trimmed.startsWith("DRV:") ||
      trimmed.startsWith("CINFO:") ||
      trimmed.startsWith("TINFO:") ||
      trimmed.startsWith("SINFO:") ||
      trimmed.startsWith("TCOUNT:")
    ) {
      continue
    }

    if (trimmed.startsWith("PRGC:")) continue

    if (trimmed.startsWith("PRGT:")) {
      const stage = quotedMessage(trimmed) ?? trimmed
      if (stage === previousStage) continue
      previousStage = stage
      events.push(`Stage: ${stage}`)
      continue
    }

    if (trimmed.startsWith("MSG:")) {
      const code = trimmed.slice(4).split(",", 1)[0]
      if (unimportantMessageCodes.has(code)) continue
    }

    events.push(trimmed)
  }

  return collapseRepeated(events).join("\n")
}

const quotedMessage = (line: string): string | null => {
  const match = line.match(/,"((?:[^"\\]|\\.)*)"(?:,|$)/)
  return match?.[1]?.replaceAll('\\"', '"') ?? null
}

const collapseRepeated = (lines: string[]): string[] => {
  const collapsed: string[] = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ""
    let next = index + 1
    while (lines[next] === line) next += 1

    const count = next - index
    collapsed.push(
      count === 1
        ? line
        : `${line}\n[repeated ${String(count)} times]`,
    )
    index = next
  }

  return collapsed
}
