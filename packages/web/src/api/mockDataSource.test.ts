import { beforeEach, describe, expect, it } from "vitest"

import { FIXTURE_NAMES } from "../fixture"
import type { BayView, Rip, RipDeckState } from "../types"
import {
  createFixtureState,
  mockDataSource,
  resetMockDrift,
} from "./mockDataSource"

/**
 * The scenarios that are the REASON rip-deck exists.
 *
 * HANDOFF §8 names the states that must be in the fixture set,
 * and this file is where each of them is pinned. Every one is
 * something the tower has done or is expected to do, and every
 * one is a case where a plausible-looking UI would tell the
 * owner the wrong thing.
 */

const bayOf = (
  state: RipDeckState,
  slot: number,
): BayView => {
  const bay = state.ripDeck.bays.find(
    (candidate) => candidate.slot === slot,
  )

  if (!bay) throw new Error(`no bay in slot ${slot}`)

  return bay
}

const ripOf = (state: RipDeckState, slot: number): Rip => {
  const rip = state.hosts[0]?.rips.find(
    (candidate) => candidate.slot === slot,
  )

  if (!rip) throw new Error(`no rip in slot ${slot}`)

  return rip
}

beforeEach(() => {
  resetMockDrift()
})

describe("every scenario", () => {
  it("covers exactly the daemon's fixture names", () => {
    for (const name of FIXTURE_NAMES) {
      const state = createFixtureState(name)

      expect(state.ripDeck.fixture).toBe(name)
      // Stamped on every response so a fixture can never be
      // mistaken for the rack, in either data source.
      expect(state.ripDeck.is_fake).toBe(true)
      expect(state.ripDeck.schema_version).toBe(1)
    }
  })

  it("keeps the two halves of the document on one instant", () => {
    // `hosts` and `rip-deck` ship together deliberately: two
    // endpoints polled independently would show a nine-bay
    // tower at two different moments, and the disagreement
    // would look like a bug in the rips.
    const state = createFixtureState("nine-rips")
    const ripDriveIds = new Set(
      state.hosts[0]?.rips.map((rip) => rip.drive_id),
    )

    for (const bay of state.ripDeck.bays) {
      expect(ripDriveIds.has(bay.drive_id)).toBe(true)
    }
  })
})

describe("zero drives present", () => {
  // F3. The owner powers the tower independently of the host, so
  // an empty rack means "switched off". It is a normal state,
  // not an error, and painting it red trains him to ignore red.
  it("is a healthy tower with nothing in it", () => {
    const state = createFixtureState("empty")

    expect(state.ripDeck.is_tower_present).toBe(false)
    expect(state.ripDeck.drive_count).toBe(0)
    expect(state.ripDeck.error).toBe("")
    expect(state.hosts[0]?.ok).toBe(true)
    expect(state.hosts[0]?.err).toBe("")
    expect(state.ripDeck.alerts).toEqual([])
  })
})

describe("nine concurrent rips", () => {
  it("is nine bays, all active", () => {
    const state = createFixtureState("nine-rips")

    expect(state.ripDeck.drive_count).toBe(9)
    expect(state.ripDeck.active_count).toBe(9)
    expect(state.hosts[0]?.rips).toHaveLength(9)
  })

  it("hands every card a stable, distinct key", () => {
    // `job_id` is a surrogate hashed from the UUID. Two bays
    // colliding would remount both cards on every poll.
    const state = createFixtureState("nine-rips")
    const ids = new Set(
      state.hosts[0]?.rips.map((rip) => rip.job_id),
    )

    expect(ids.size).toBe(9)
  })
})

describe("each verdict kind", () => {
  it("renders one bay per kind, ok included", () => {
    const state = createFixtureState("verdicts")

    expect(state.ripDeck.bays).toHaveLength(9)

    const kinds = state.ripDeck.bays.map(
      (bay) => bay.state.verdict,
    )

    expect(new Set(kinds).size).toBe(9)
  })

  // The pair this whole project turns on: identical symptoms,
  // opposite advice. Getting it backwards costs a disc.
  it("gives dirty and scratched opposite advice", () => {
    const state = createFixtureState("verdicts")
    const dirty = ripOf(state, 2)
    const scratched = ripOf(state, 3)

    expect(dirty.verdict).toBe("disc_dirty")
    expect(dirty.verdict_message).toContain("Clean it")
    expect(scratched.verdict).toBe("disc_scratched")
    expect(scratched.verdict_message).toContain(
      "cleaning will not help",
    )
    expect(scratched.verdict_message).toContain(
      "Source another copy",
    )
  })

  it("carries read errors on the two disc-surface verdicts", () => {
    const state = createFixtureState("verdicts")

    expect(ripOf(state, 2).read_error_count).toBe(12)
    expect(ripOf(state, 3).read_error_count).toBe(12)
    expect(ripOf(state, 1).read_error_count).toBe(0)
  })

  it("raises no alert for the ok bay", () => {
    const state = createFixtureState("verdicts")

    // `ok` is the default verdict and carries no news.
    expect(bayOf(state, 1).alert).toBeNull()
    expect(
      state.ripDeck.alerts.some(
        (alert) => alert.verdict === "ok",
      ),
    ).toBe(false)
  })
})

describe("a hub fault across several bays", () => {
  // ONE problem — "several drives on the same USB hub stopped
  // responding together" — not four bad discs. Telling the owner
  // to clean four discs because a hub lost power is the
  // confidently-wrong alert the verdict model exists to prevent.
  it("suppresses per-disc verdicts in favour of one hub alert", () => {
    const state = createFixtureState("hub-fault")
    const faulted = [4, 5, 6, 7]

    for (const slot of faulted) {
      expect(bayOf(state, slot).state.verdict).toBe(
        "hub_fault",
      )
    }

    expect(state.ripDeck.alerts).toHaveLength(1)

    const alert = state.ripDeck.alerts[0]

    expect(alert?.verdict).toBe("hub_fault")
    expect(alert?.subject).toBe("hub")
    expect(alert?.drive_ids).toHaveLength(4)
    expect(alert?.message).toContain("this is the hub")
  })

  it("gives a stalled bay no ETA at all", () => {
    // A bay that has stopped answering must not carry a
    // confident "~15m left". The scenario sets these to null
    // explicitly, and an absent-vs-null slip here would restore
    // the default 900s to a drive that is not moving.
    const rip = ripOf(createFixtureState("hub-fault"), 4)

    expect(rip.eta_seconds).toBeNull()
    expect(rip.eta_trend).toBeNull()
    expect(rip.status).toBe("ripping")
    // …which is exactly why the card reads the native state
    // instead: `toArmStatus` flattens stalled into ripping.
    expect(
      bayOf(createFixtureState("hub-fault"), 4).state.state,
    ).toBe("stalled")
  })

  it("leaves the unaffected bays alone", () => {
    const state = createFixtureState("hub-fault")

    for (const slot of [1, 2, 3, 8, 9]) {
      expect(bayOf(state, slot).state.verdict).toBe("ok")
      expect(bayOf(state, slot).alert).toBeNull()
    }
  })
})

describe("suspected vs confirmed", () => {
  // The two-drive rule made visible. A disc verdict from one
  // drive shows and offers a retry; two drives agreeing is what
  // upgrades it, and only the upgrade may announce.
  it("offers a retry on the suspected bay and none on the confirmed one", () => {
    const state = createFixtureState("confidence")
    const suspected = bayOf(state, 2)
    const confirmed = bayOf(state, 8)

    expect(suspected.verdict_confidence).toBe("suspected")
    expect(suspected.actions).toContain(
      "retry_in_another_drive",
    )
    expect(suspected.is_announceable).toBe(false)

    expect(confirmed.verdict_confidence).toBe("confirmed")
    expect(confirmed.actions).not.toContain(
      "retry_in_another_drive",
    )
    expect(confirmed.is_announceable).toBe(true)
  })

  it("groups both bays under one confirmed alert", () => {
    const state = createFixtureState("confidence")

    expect(state.ripDeck.alerts).toHaveLength(1)

    const alert = state.ripDeck.alerts[0]

    // One bay's confirmation is enough to confirm the trouble;
    // the other bay is more evidence for it, not against it.
    expect(alert?.confidence).toBe("confirmed")
    expect(alert?.is_announceable).toBe(true)
    expect(alert?.drive_ids).toHaveLength(2)
  })
})

describe("a rising ETA", () => {
  // A signal in its own right (C6), not a cosmetic annoyance —
  // and deliberately not an alarm: the bay is neither failed nor
  // alarmed, because a rising ETA on a healthy disc happens.
  it("shows the trend while the verdict stays ok", () => {
    const state = createFixtureState("rising-eta")
    const rip = ripOf(state, 3)

    expect(rip.eta_trend).toBe("rising")
    expect(rip.eta_seconds).toBe(5_400)
    expect(rip.verdict).toBe("ok")
    expect(rip.active).toBe(true)
    expect(state.ripDeck.alerts).toEqual([])
  })

  it("reports the throughput that explains it", () => {
    const state = createFixtureState("rising-eta")

    // The drive genuinely slowed from 22.7 to 15.5 MB/s on the
    // real disc this fixture is drawn from.
    expect(
      ripOf(state, 3).throughput_bytes_per_sec,
    ).toBeCloseTo(15.5 * 1024 * 1024, 0)
  })
})

describe("a quarantined drive", () => {
  // Never self-healing: an automatic un-quarantine re-enters the
  // same crash loop later, at night, with nobody watching.
  it("is out of service and offers its clear control", () => {
    const state = createFixtureState("quarantined")
    const bay = bayOf(state, 5)

    expect(bay.is_quarantined).toBe(true)
    expect(bay.quarantine_reason).toContain(
      "Taken out of service",
    )
    expect(bay.actions).toContain("clear_quarantine")
    expect(bay.state.state).toBe("idle")
  })

  it("clears only when a human asks", async () => {
    expect(
      bayOf(createFixtureState("quarantined"), 5)
        .is_quarantined,
    ).toBe(true)

    const result = await mockDataSource.runBayAction({
      driveId: "usb-2-1-1-2-4-4-5",
      action: "clear_quarantine",
    })

    expect(result.ok).toBe(true)
    expect(
      bayOf(createFixtureState("quarantined"), 5)
        .is_quarantined,
    ).toBe(false)
  })

  it("leaves the ripping bay beside it untouched", () => {
    const state = createFixtureState("quarantined")

    expect(bayOf(state, 6).is_quarantined).toBe(false)
    expect(ripOf(state, 6).active).toBe(true)
  })
})

describe("discs held at startup", () => {
  /**
   * The state the owner's tower is in RIGHT NOW: three Troy
   * discs in slots 7–9, held by `adoptBayAtStartup`'s
   * fail-closed branch because there was no `bays.json` yet.
   * Slot 1 is a genuinely failed rip in the same document,
   * because these two are the pair the dashboard most has to
   * keep apart.
   */
  it("holds three discs and rips none of them", () => {
    const state = createFixtureState("held-at-startup")

    for (const slot of [7, 8, 9]) {
      const bay = bayOf(state, slot)

      expect(bay.state.state).toBe("needs_attention")
      expect(bay.state.title).toContain("TROY")
      expect(ripOf(state, slot).active).toBe(false)
    }

    expect(state.ripDeck.active_count).toBe(0)
  })

  it("gives a held bay no numbers to misread", () => {
    // A held bay showing 43% and "~15m left" would be a card
    // describing a rip that never started — the same
    // absent-vs-null slip that put a confident ETA on a stalled
    // bay (HANDOFF §4).
    const rip = ripOf(
      createFixtureState("held-at-startup"),
      8,
    )

    expect(rip.percent).toBe(0)
    expect(rip.eta_seconds).toBeNull()
    expect(rip.eta_trend).toBeNull()
    expect(rip.throughput_bytes_per_sec).toBeNull()
    expect(rip.read_error_count).toBe(0)
    expect(rip.stage).toBe("")
  })

  it("carries the sentence a human is meant to read", () => {
    // `UNKNOWN_AT_STARTUP_DETAIL`, transcribed from
    // `rip/bayLedger.ts`. It names the physical next step, which
    // is the whole reason it is worth showing on the card.
    const evidence =
      bayOf(createFixtureState("held-at-startup"), 7).alert
        ?.evidence ?? []

    expect(evidence.join(" ")).toContain(
      "There was already a disc in this drive when Rip Deck " +
        "started",
    )
    // ⚠️ NOT "open the tray and close it again" — that advice
    // was wrong on this hardware for as long as it was printed:
    // these drives keep reporting their disc after the tray
    // opens, so the bay never reads empty and never re-arms.
    expect(evidence.join(" ")).toContain(
      "Press Rip to rip it anyway",
    )
  })

  it("puts a real failure beside them for contrast", () => {
    const state = createFixtureState("held-at-startup")
    const failed = ripOf(state, 1)

    expect(failed.status).toBe("fail")
    expect(failed.read_error_count).toBe(41)
    expect(failed.verdict).toBe("disc_scratched")
    // Opposite advice from a held disc: this one wants another
    // copy, not a button press.
    expect(failed.verdict_message).toContain(
      "Source another copy",
    )
  })

  it("releases a held disc when its tray is opened", async () => {
    // The documented manual override: open the tray, the bay
    // reads empty and re-arms
    // (`docs/eject-and-durable-bay-state.md` §4).
    expect(
      bayOf(createFixtureState("held-at-startup"), 7).state
        .state,
    ).toBe("needs_attention")

    // A tray command is answered against the scenario this
    // source last SERVED — the mock has no other memory of which
    // rack the caller is looking at, and slot 7 is mid-rip in the
    // default one. The app always polls before it can offer a
    // control, so this is the app's own ordering.
    await mockDataSource.fetchState("held-at-startup")

    const result = await mockDataSource.runBayAction({
      driveId: "usb-2-1-1-2-4-4-7",
      action: "open_bay",
    })

    expect(result.ok).toBe(true)
    expect(
      bayOf(createFixtureState("held-at-startup"), 7).state
        .state,
    ).toBe("idle")
  })
})

describe("drift", () => {
  // A mock that returns the identical document every poll cannot
  // show that the bar moves, and "the bar moves" is most of what
  // a rip dashboard has to get right.
  it("advances the lead rip on each poll", async () => {
    const first =
      await mockDataSource.fetchState("nine-rips")
    const second =
      await mockDataSource.fetchState("nine-rips")

    const percentOf = (state: RipDeckState) =>
      state.hosts[0]?.rips.find((rip) => rip.slot === 1)
        ?.percent ?? 0

    expect(percentOf(second)).toBeGreaterThan(
      percentOf(first),
    )
  })

  it("falls back to the default scenario for an unknown name", async () => {
    const state =
      await mockDataSource.fetchState("nonsense")

    expect(state.ripDeck.fixture).toBe("nine-rips")
  })

  it("cancels a bay when the operator asks", async () => {
    await mockDataSource.runBayAction({
      driveId: "usb-2-1-1-2-4-4-3",
      action: "cancel",
    })

    const state = createFixtureState("nine-rips")

    expect(ripOf(state, 3).status).toBe("cancelled")
    expect(ripOf(state, 3).active).toBe(false)
  })
})

describe("tray commands", () => {
  const HELD_BAY = "usb-2-1-1-2-4-4-7"

  /**
   * ⚠️ The behaviour the UI most has to render, and the one a
   * mock where every press succeeds would hide.
   *
   * The default scenario is nine bays mid-rip, so the toggle can
   * be developed against a real refusal — with the daemon's own
   * sentence, which is the only text that explains why nothing
   * moved.
   */
  it("refuses a ripping bay, and says so in full", async () => {
    await mockDataSource.fetchState("nine-rips")

    const report = await mockDataSource.runTrayCommand({
      command: "open_bay",
      driveId: HELD_BAY,
    })

    // Accepted AND refused: the daemon heard the command and
    // answered it. Whether a tray moved is the per-bay result.
    expect(report.is_accepted).toBe(true)
    expect(report.counts.refused).toBe(1)
    expect(report.bays[0]?.result).toBe("refused_ripping")
    expect(report.bays[0]?.detail).toContain(
      "would destroy the rip in progress",
    )
    expect(report.message).toContain("Refused")
  })

  it("opens every finished bay on the bulk command", async () => {
    await mockDataSource.fetchState("unmeasured")

    const report = await mockDataSource.runTrayCommand({
      command: "open_trays",
    })

    // Three finished Troy discs; the other six are idle and have
    // nothing to take out.
    expect(report.counts.opened).toBe(3)
    expect(report.counts.skipped).toBe(6)
    expect(report.bays).toHaveLength(9)
  })

  /**
   * The field the ⏏ toggle infers from, kept honest.
   *
   * Tray POSITION is unknowable — sysfs reports media, not the
   * door — so `last_tray_command` is rip-deck's memory of its own
   * act, and a mock that did not record it could never show the
   * toggle flipping.
   */
  it("remembers what it last did to a bay", async () => {
    await mockDataSource.fetchState("held-at-startup")

    expect(
      bayOf(createFixtureState("held-at-startup"), 7)
        .last_tray_command,
    ).toBeNull()

    await mockDataSource.runTrayCommand({
      command: "open_bay",
      driveId: HELD_BAY,
    })

    const opened = bayOf(
      createFixtureState("held-at-startup"),
      7,
    )

    expect(opened.last_tray_command).toBe("open_bay")
    // The disc is in the operator's hand now, so the bay reads
    // empty — which is what makes the next press a close.
    expect(opened.disc_size_sectors).toBeNull()

    await mockDataSource.runTrayCommand({
      command: "close_bay",
      driveId: HELD_BAY,
    })

    expect(
      bayOf(createFixtureState("held-at-startup"), 7)
        .last_tray_command,
    ).toBe("close_bay")
  })

  it("rejects a bay that is not in the rack", async () => {
    await mockDataSource.fetchState("nine-rips")

    const report = await mockDataSource.runTrayCommand({
      command: "open_bay",
      driveId: "usb-not-a-bay",
    })

    // A rejection, not an empty success — the same shape a 400
    // carries, so a caller has one place to look.
    expect(report.is_accepted).toBe(false)
    expect(report.command).toBeNull()
    expect(report.bays).toHaveLength(0)
  })
})

describe("timestamps", () => {
  // ARM — and the daemon's `formatLocalTimestamp` after it —
  // writes LOCAL wall-clock. A `toISOString()` here would read
  // hours into the future and every elapsed figure would clamp.
  it("emits local wall-clock, not UTC", () => {
    const state = createFixtureState("nine-rips")
    const start = ripOf(state, 5).start ?? ""

    expect(start).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    )
    expect(start).not.toContain("Z")
    expect(
      Date.parse(start.replace(" ", "T")),
    ).toBeLessThan(Date.now() + 1_000)
  })
})
