import {
  VERDICT_TEMPLATES,
  type VerdictKind,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { DEFAULT_TOPIC_CONFIG } from "../mqtt/topics.ts"
import {
  createFixtureSnapshot,
  FIXTURE_NAMES,
  type FixtureName,
  isFixtureName,
} from "./fixtures.ts"
import { buildTowerView } from "./towerView.ts"

/**
 * The fixture set is a checklist, not a demo. Every scenario
 * here is a state that is the REASON rip-deck exists, and if one
 * of them stops being representable the dashboard has quietly
 * lost the ability to show the thing that matters.
 */

const NOW_MS = 1_800_000_000_000

const viewOf = (name: FixtureName) =>
  buildTowerView({
    snapshot: createFixtureSnapshot({
      name,
      nowMs: NOW_MS,
    }),
    nowMs: NOW_MS,
    isFake: true,
    fixture: name,
    topicConfig: DEFAULT_TOPIC_CONFIG,
  })

describe("the fixture set", () => {
  it("resolves every advertised name", () => {
    for (const name of FIXTURE_NAMES) {
      expect(
        createFixtureSnapshot({ name, nowMs: NOW_MS }),
      ).toBeDefined()
    }
  })

  it("rejects a name it does not know", () => {
    expect(isFixtureName("nine-rips")).toBe(true)
    expect(isFixtureName("everything-is-fine")).toBe(false)
  })

  it("shows zero drives as a normal state", () => {
    const view = viewOf("empty")

    // F3. Not an error card, not an empty-state apology.
    expect(view.drive_count).toBe(0)
    expect(view.is_tower_present).toBe(false)
    expect(view.error).toBe("")
    expect(view.alerts).toEqual([])
  })

  it("shows nine bays ripping at once", () => {
    const view = viewOf("nine-rips")

    // The owner has asked for auto-rip across the whole tower,
    // so "the current job" is not a thing the UI may assume.
    expect(view.bays).toHaveLength(9)
    expect(view.active_count).toBe(9)
  })

  it("puts every verdict kind on a card", () => {
    const view = viewOf("verdicts")

    const kinds = new Set(
      view.bays.map((bay) => bay.state.verdict),
    )

    for (const kind of Object.keys(
      VERDICT_TEMPLATES,
    ) as VerdictKind[]) {
      expect(kinds).toContain(kind)
    }
  })

  it("keeps dirty and scratched apart, with opposite advice", () => {
    const view = viewOf("verdicts")

    const dirty = view.bays.find(
      (bay) => bay.state.verdict === "disc_dirty",
    )
    const scratched = view.bays.find(
      (bay) => bay.state.verdict === "disc_scratched",
    )

    expect(dirty?.alert?.action).toBe("clean_disc")
    // Cleaning a scratch never helps; saying so would waste the
    // owner's evening on a disc that needs replacing.
    expect(scratched?.alert?.action).toBe("replace_disc")
  })

  it("reads a hub fault as one problem across several bays", () => {
    const view = viewOf("hub-fault")

    expect(view.alerts).toHaveLength(1)
    expect(view.alerts[0].verdict).toBe("hub_fault")
    expect(
      view.alerts[0].drive_ids.length,
    ).toBeGreaterThanOrEqual(2)

    // No affected bay blames its disc — that is the whole point.
    const discVerdicts = view.bays.filter((bay) =>
      bay.state.verdict.startsWith("disc_"),
    )

    expect(discVerdicts).toEqual([])
  })

  it("shows suspected and confirmed side by side", () => {
    const view = viewOf("confidence")

    const troubled = view.bays.filter(
      (bay) => bay.alert !== null,
    )

    expect(troubled).toHaveLength(2)
    expect(
      troubled.map((bay) => bay.verdict_confidence).sort(),
    ).toEqual(["confirmed", "suspected"])
    // Only one of them may announce.
    expect(
      troubled.filter((bay) => bay.is_announceable),
    ).toHaveLength(1)
  })

  it("shows a rising ETA without calling it a failure", () => {
    const view = viewOf("rising-eta")

    const rising = view.bays.filter(
      (bay) => bay.state.eta_trend === "rising",
    )

    expect(rising).toHaveLength(1)
    // A rising ETA happens on healthy discs — an alarm that
    // fires 49 times during a good rip is not an alarm.
    expect(rising[0].state.verdict).toBe("ok")
    expect(rising[0].alert).toBeNull()
  })

  /**
   * The state the owner's tower woke up in on 2026-07-26.
   *
   * Three Troy discs still loaded, no `bays.json` yet, so
   * `adoptBayAtStartup` took its fail-closed branch on all
   * three — held, flagged, not ripped. Slot 1 is a genuinely
   * failed rip in the same document, because "this disc failed"
   * and "rip-deck does not know whether this was ripped, so it
   * did not" call for opposite actions and a fixture with only
   * one of them proves nothing about whether they read apart.
   */
  it("holds the loaded discs instead of ripping them", () => {
    const view = viewOf("held-at-startup")

    const held = view.bays.filter(
      (bay) => bay.state.state === "needs_attention",
    )

    expect(held).toHaveLength(3)
    expect(view.active_count).toBe(0)

    for (const bay of held) {
      // No numbers at all: nothing ran.
      expect(bay.state.progress_percent).toBe(0)
      expect(bay.state.eta_seconds).toBeNull()
      expect(bay.state.throughput_bytes_per_sec).toBeNull()
      // Never `confirmed` — only a confirmed verdict may
      // announce, and nothing judged this disc.
      expect(bay.verdict_confidence).toBe("suspected")
      expect(bay.is_announceable).toBe(false)
      expect(bay.alert?.evidence.join(" ")).toContain(
        "There was already a disc in this drive when " +
          "Rip Deck started",
      )
    }
  })

  it("puts a real failure beside the held discs", () => {
    const view = viewOf("held-at-startup")

    const failed = view.bays.filter(
      (bay) => bay.state.state === "failed",
    )

    expect(failed).toHaveLength(1)
    expect(failed[0].state.verdict).toBe("disc_scratched")
    expect(failed[0].state.read_error_count).toBe(41)
    // Opposite advice from a held disc: another copy, not a
    // button press.
    expect(failed[0].alert?.action).toBe("replace_disc")
  })

  /**
   * The live rack, 2026-07-26. Three finished 225 GB backups
   * adopted from the bay ledger, which the dashboard rendered as
   * a fault because nothing had measured them.
   */
  it("keeps a finished rip finished even with no verdict", () => {
    const view = viewOf("unmeasured")

    const finished = view.bays.filter(
      (bay) => bay.state.state === "completed",
    )

    expect(finished).toHaveLength(3)
    expect(view.active_count).toBe(0)

    for (const bay of finished) {
      // `unknown` is what `towerFeed` stamps on a bay it did not
      // measure. It is a statement about rip-deck, not the disc,
      // and the fixture carries it so the UI has to prove it
      // reads that way.
      expect(bay.state.verdict).toBe("unknown")
      expect(bay.verdict_confidence).toBe("suspected")
      // Never announced: nothing computed this.
      expect(bay.is_announceable).toBe(false)
      // NOT a measured zero — see `towerFeed`'s header.
      expect(bay.state.read_error_count).toBe(0)
      // Named from the bay ledger's `discName`, never from the
      // bay's own label — the second half of the same defect,
      // which had three Troy discs reading as "07 - Pioneer
      // BDR-211M".
      expect(bay.state.title).toContain("TROY")
      // And no disc TYPE, because nothing recorded one. An
      // adopted bay knows what the disc is called and not what
      // kind of disc it is.
      expect(bay.state.disctype).toBe("unknown")
    }
  })

  it("shows a quarantined drive with its clear control", () => {
    const view = viewOf("quarantined")

    const quarantined = view.bays.filter(
      (bay) => bay.is_quarantined,
    )

    expect(quarantined).toHaveLength(1)
    expect(quarantined[0].actions).toContain(
      "clear_quarantine",
    )
    expect(quarantined[0].quarantine_reason).not.toBeNull()
  })
})
