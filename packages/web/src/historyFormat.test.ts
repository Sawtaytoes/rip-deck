import { describe, expect, it } from "vitest"

import {
  hasHistoryTitle,
  historyBayText,
  historyDurationText,
  historyFinishedText,
  historyOutcomeIntent,
  historyOutcomeText,
  historyReadErrorText,
  historySizeText,
  historyThroughputText,
  historyTitle,
} from "./historyFormat"
import type { HistoryRip } from "./types"

const rip = (
  overrides: Partial<HistoryRip> = {},
): HistoryRip => ({
  job_uuid: "a1659124-308c-4f16-be4f-e0be021fee87",
  drive_id: "2-1.1.2.4.2",
  slot: 5,
  bay_name: "05 - Pioneer BDR-212U",
  disc_name: "THE MUMMY",
  is_named: true,
  disctype: "bluray",
  destination_path: "/media/Disc-Rips/The Mummy - Blu-ray",
  size_bytes: 45_400_000_000,
  started_at_ms: 0,
  finished_at_ms: 1_830_000,
  duration_ms: 1_830_000,
  outcome_kind: "completed",
  outcome_detail: "Backup at …",
  is_successful: true,
  failure_reason: null,
  verdict: "unknown",
  verdict_message: null,
  read_error_count: 0,
  throughput_bytes_per_sec: 24_800_000,
  has_log: true,
  source: "live",
  ...overrides,
})

describe("what a finished rip is called", () => {
  it("uses the disc's own name when there is one", () => {
    expect(historyTitle(rip())).toBe("THE MUMMY")
    expect(hasHistoryTitle(rip())).toBe(true)
  })

  it("⚠️ separates 'the disc had no name' from 'nobody recorded one'", () => {
    // The first is a fact about the DISC — rip-deck was there and
    // could not read a label. The second is a limit of ours: the
    // row was rebuilt from measurements that never held a name,
    // and none can be recovered. A blank for both would let a
    // reader assume the disc was unlabelled, which nobody checked.
    expect(
      historyTitle(
        rip({ disc_name: null, is_named: true }),
      ),
    ).toBe("Disc not identified")

    expect(
      historyTitle(
        rip({ disc_name: null, is_named: false }),
      ),
    ).toBe("Name not recorded")
  })

  it("treats an empty name as no name", () => {
    expect(hasHistoryTitle(rip({ disc_name: "" }))).toBe(
      false,
    )
  })
})

describe("the outcome chip", () => {
  it("calls a completed rip finished, in green", () => {
    expect(historyOutcomeText(rip())).toBe("Finished")
    expect(historyOutcomeIntent(rip())).toBe("success")
  })

  it("calls a failed rip failed, in red", () => {
    const failed = rip({ outcome_kind: "failed" })

    expect(historyOutcomeText(failed)).toBe("Failed")
    expect(historyOutcomeIntent(failed)).toBe("danger")
  })

  it("⚠️ gives a flagged bay its own word, never green", () => {
    // `needs_attention` is a bay a human still has to look at.
    // Folding it into "Finished" is the silent-success report
    // this project exists to stop making (ARM #1298).
    const flagged = rip({ outcome_kind: "needs_attention" })

    expect(historyOutcomeText(flagged)).toBe("Flagged")
    expect(historyOutcomeIntent(flagged)).toBe("warning")
  })
})

describe("the measurements", () => {
  it("writes a duration under an hour in minutes", () => {
    expect(
      historyDurationText(rip({ duration_ms: 1_830_000 })),
    ).toBe("31m")
  })

  it("writes a long rip in hours and minutes", () => {
    expect(
      historyDurationText(rip({ duration_ms: 5_120_000 })),
    ).toBe("1h25m")
  })

  it("drops the minutes on a whole number of hours", () => {
    expect(
      historyDurationText(rip({ duration_ms: 7_200_000 })),
    ).toBe("2h")
  })

  it("says nothing when nothing timed the rip", () => {
    // Blank rather than "0m": a row with no recorded duration is
    // one that says nothing about duration, not one claiming zero.
    expect(
      historyDurationText(rip({ duration_ms: null })),
    ).toBe("")
  })

  it("writes the disc size in GB", () => {
    expect(historySizeText(rip())).toBe("42.3 GB")
  })

  it("writes the measured rate in MB/s", () => {
    // MB/s and not GB/s: real rips run at 15–25 MB/s, so a GB/s
    // figure would read "0.0" for every disc on this tower.
    //
    // ⚠️ No "average" in the text. What the daemon sends is the
    // MEDIAN of the kernel's per-sample rates, and calling that
    // an average is a small untrue claim about a number somebody
    // might hold against a drive's spec sheet.
    expect(historyThroughputText(rip())).toBe("23.7 MB/s")
  })

  it("says nothing about a rate it does not have", () => {
    expect(
      historyThroughputText(
        rip({ throughput_bytes_per_sec: null }),
      ),
    ).toBe("")
  })
})

describe("read errors", () => {
  it("says nothing when the disc read cleanly", () => {
    expect(historyReadErrorText(rip())).toBe("")
  })

  it("counts one in the singular", () => {
    expect(
      historyReadErrorText(rip({ read_error_count: 1 })),
    ).toBe("1 read error")
  })

  it("⚠️ still reports them on a SUCCESSFUL rip", () => {
    // The exact case ARM calls a clean success. The green chip
    // beside this must never be allowed to swallow it.
    expect(
      historyReadErrorText(
        rip({ is_successful: true, read_error_count: 14 }),
      ),
    ).toBe("14 read errors")
  })

  it("says nothing when nothing counted them", () => {
    expect(
      historyReadErrorText(rip({ read_error_count: null })),
    ).toBe("")
  })
})

describe("where the rip happened", () => {
  it("leads with the slot when the bay is mapped", () => {
    expect(historyBayText(rip())).toBe(
      "Slot 5 · 05 - Pioneer BDR-212U",
    )
  })

  it("⚠️ falls back to the raw drive id, never an invented slot", () => {
    // A row from before the tower was re-cabled has a port path
    // the registry no longer knows. The id is honest; a slot
    // number from a path that now belongs to a different bay
    // would not be.
    expect(
      historyBayText(
        rip({ bay_name: "2-2.3.4.2", slot: null }),
      ),
    ).toBe("2-2.3.4.2")
  })
})

describe("when it finished", () => {
  it("⚠️ writes an absolute date, never a relative one", () => {
    // The reason this page exists is matching a rip against a
    // stack of discs on the desk, and "3 days ago" cannot do
    // that. Pinned in one locale so the assertion is about the
    // FORMAT rather than about the test machine.
    const text = historyFinishedText(
      rip({ finished_at_ms: Date.UTC(2026, 7, 25, 12, 0) }),
      "en-US",
    )

    expect(text).toMatch(/Aug 2[45], 2026/)
    expect(text).not.toContain("ago")
  })
})
