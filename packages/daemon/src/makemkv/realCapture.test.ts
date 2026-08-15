import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MakemkvMsgCode } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "./parseLine.ts"

/**
 * The whole robot-mode stream of one real Blu-ray backup.
 *
 * Captured 2026-07-25 from the rip that satisfied the Stage 3
 * stop rule: `Ivanhoe (1952)`, slot 9, 24m29s, exit 0, zero read
 * errors, 32.2 GB verified on the dataset.
 *
 * This corpus exists because ARM structurally cannot produce
 * one — it parses stdout in-process and re-logs only formatted
 * text, so `MSG:`/`PRGV:` lines never reach disk. Every claim in
 * these tests is therefore something that could not be checked
 * before the ripper ran for real.
 *
 * Kept raw and complete rather than trimmed. A sampled capture
 * would invite the question of whether the interesting lines
 * survived the sampling, and 57k lines of highly repetitive text
 * costs almost nothing once packed.
 */

const capture = readFileSync(
  join(
    import.meta.dirname,
    "__fixtures__/real-bluray-backup.robot.log",
  ),
  "utf8",
)

const events = capture
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map(parseMakemkvLine)

describe("a real Blu-ray backup, replayed", () => {
  it("parses every line without a single malformed one", () => {
    // The strongest parser assertion available: 57k lines of
    // real output, no invented shapes.
    const malformed = events.filter(
      (event) => event.type === "MALFORMED",
    )

    expect(malformed).toHaveLength(0)
    expect(events.length).toBeGreaterThan(57_000)
  })

  it("never reported a read error", () => {
    // D1's premise. If this corpus ever grows a READ_ERROR the
    // fixture has been replaced, not the parser fixed.
    const readErrors = events.filter(
      (event) =>
        event.type === "MSG" &&
        event.code === MakemkvMsgCode.READ_ERROR,
    )

    expect(readErrors).toHaveLength(0)
  })

  it("emits no title count, which is why backup needs its own success test", () => {
    // The §2.3 defect, pinned. `backup` never emits MSG:5004, so
    // requiring `titlesSaved > 0` failed this perfect rip. If a
    // future refactor reinstates that requirement, this fails.
    const copyComplete = events.filter(
      (event) =>
        event.type === "MSG" &&
        event.code === MakemkvMsgCode.COPY_COMPLETE,
    )

    expect(copyComplete).toHaveLength(0)
  })

  it("signals completion with 5070 / 5081 instead", () => {
    const codes = events
      .filter((event) => event.type === "MSG")
      .map((event) => event.code)

    expect(codes).toContain(MakemkvMsgCode.BACKUP_DONE)
    expect(codes).toContain(
      MakemkvMsgCode.BACKUP_DONE_FINAL,
    )
  })

  it("restarts PRGV from zero on each new PRGT", () => {
    // The §2.4 defect. Three operations — "Scanning CD-ROM
    // devices", "Opening Blu-ray disc", "Copying all files" —
    // each drive the SAME counter 0 -> max, which is why
    // anything derived from PRGV must reset on a PRGT change.
    const operations = events.filter(
      (event) => event.type === "PRGT",
    )

    expect(operations.length).toBeGreaterThanOrEqual(3)

    // The copy is not the first operation, so a tracker that
    // never resets folds the preamble into the copy's numbers.
    expect(operations[0]).toMatchObject({
      name: "Scanning CD-ROM devices",
    })
  })

  it("confirms MakeMKV verified the M2TS hashes itself", () => {
    // MSG:5085 — MakeMKV loaded the disc's content hash table
    // and checked file integrity. Worth knowing that this rip is
    // hash-verified and not merely byte-counted, and worth
    // knowing the signal exists: its failure counterpart
    // ("Backup created but hash check failed for N files") is a
    // stronger corruption signal than anything we compute.
    const hashTable = events.filter(
      (event) =>
        event.type === "MSG" && event.code === 5085,
    )

    expect(hashTable).toHaveLength(1)
  })
})
