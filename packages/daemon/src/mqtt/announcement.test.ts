import {
  EMPTY_PROGRESS,
  type Job,
  makeVerdict,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  buildRipEventPayload,
  toLegacyHealth,
} from "./announcement.ts"

/**
 * These tests exist to protect a CONTRACT that lives outside
 * this repo: `automation.job_status_announcement` in Home
 * Assistant. Its spec says that replacing the disc pipeline
 * changes only the source topic — so if any of these fail, the
 * house speakers say the wrong thing.
 */

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  driveId: "usb-2-1-1-2-3",
  state: "completed",
  startedAt: 0,
  finishedAt: 1,
  identity: {
    title: "The Prestige",
    year: 2006,
    discType: "bluray",
    source: "tmdb",
    posterUrl: null,
    volumeLabel: "THE_PRESTIGE",
    discNumber: null,
    discTotal: null,
  },
  progress: EMPTY_PROGRESS,
  verdict: makeVerdict("ok", "confirmed", []),
  failureReason: null,
  destinationPath: null,
  readErrorCount: 0,
  warnings: [],
  isAdopted: false,
  isKeepTryingRequested: false,
  ...overrides,
})

describe("buildRipEventPayload — the HA contract", () => {
  it("emits every field the automation reads", () => {
    const payload = buildRipEventPayload({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    // The automation reads exactly these.
    expect(payload.title).toBe("The Prestige")
    expect(payload.result).toBe("success")
    expect(payload.ok).toBe(true)
    expect(payload.disctype).toBe("bluray")
    expect(payload.drive).toBe("07 - Pioneer BDR-211M")
    expect(payload.health).toBe("ok")
  })

  it("marks a failed rip as fail, triggering priority 1", () => {
    const payload = buildRipEventPayload({
      job: job({ state: "failed" }),
      verdict: makeVerdict(
        "disc_scratched",
        "confirmed",
        [],
      ),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    expect(payload.result).toBe("fail")
    expect(payload.ok).toBe(false)
  })

  it("never claims success for a cancelled job", () => {
    const payload = buildRipEventPayload({
      job: job({ state: "cancelled" }),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    expect(payload.ok).toBe(false)
  })

  it("falls back rather than emitting an empty title", () => {
    const payload = buildRipEventPayload({
      job: job({ identity: null, state: "failed" }),
      verdict: makeVerdict("unknown", "confirmed", []),
      driveLabel: "07 - Pioneer BDR-211M",
    })

    expect(payload.title).toBe("Unknown disc")
    expect(payload.disctype).toBe("unknown")
  })
})

describe("toLegacyHealth", () => {
  it("maps a healthy rip to ok", () => {
    expect(toLegacyHealth("ok")).toBe("ok")
  })

  it("maps slow-but-clean to slow", () => {
    expect(toLegacyHealth("disc_marginal_slow")).toBe(
      "slow",
    )
  })

  it("maps real disc-surface faults to very_slow", () => {
    // These are the ones where "the disc may need cleaning" is
    // the correct thing for the house to say.
    expect(toLegacyHealth("disc_dirty")).toBe("very_slow")
    expect(toLegacyHealth("disc_scratched")).toBe(
      "very_slow",
    )
  })

  it("never blames the disc for a hardware fault", () => {
    // very_slow makes the automation say "the disc may need
    // cleaning". Saying that because a USB hub lost power is
    // exactly the confidently-wrong alert that makes the owner
    // stop trusting the feature.
    expect(toLegacyHealth("hub_fault")).toBe("unknown")
    expect(toLegacyHealth("drive_failing")).toBe("unknown")
    expect(toLegacyHealth("enumeration_flap")).toBe(
      "unknown",
    )
    expect(toLegacyHealth("key_expired")).toBe("unknown")
  })

  it("only ever emits the four legacy values", () => {
    const kinds = [
      "ok",
      "hub_fault",
      "key_expired",
      "drive_failing",
      "enumeration_flap",
      "disc_scratched",
      "disc_dirty",
      "disc_marginal_slow",
      "unknown",
    ] as const

    for (const kind of kinds) {
      expect([
        "ok",
        "slow",
        "very_slow",
        "unknown",
      ]).toContain(toLegacyHealth(kind))
    }
  })
})

/**
 * The spoken half of the same contract.
 *
 * The written fields above are what a dashboard and a log read;
 * these are what the house speakers SAY, and the two failed
 * differently. The owner heard a drive model read out as a part
 * number, and heard "a rip failed" about a disc that never
 * failed — rip-deck had simply declined to name it
 * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)).
 */
describe("spoken_message — what the speakers say", () => {
  it("says the slot, never the drive model", () => {
    const payload = buildRipEventPayload({
      job: job(),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "09 - Pioneer BDR-211M",
      slot: 9,
    })

    // "zero nine dash Pioneer B D R two one one M" is what the
    // old line put through TTS.
    expect(payload.spoken_message).not.toContain("Pioneer")
    expect(payload.spoken_message).not.toContain("BDR")
    expect(payload.slot).toBe(9)
  })

  it("does not call a held disc a failure", () => {
    // The whole reason this field exists. `result` has only two
    // values, so a hold reports `fail` — and the automation used
    // to turn that into "a rip failed", sending the owner to look
    // for a damaged disc that does not exist. `HeldBayCard` draws
    // this distinction in amber; the spoken half never did.
    const payload = buildRipEventPayload({
      job: job({ state: "needs_attention" }),
      verdict: makeVerdict("unknown", "suspected", []),
      driveLabel: "09 - Pioneer BDR-211M",
      slot: 9,
    })

    expect(payload.result).toBe("fail")
    expect(payload.spoken_message).toBe(
      "Slot 9 needs attention. Rip Deck did not rip that disc.",
    )
  })

  it("says a real failure is a failure", () => {
    const payload = buildRipEventPayload({
      job: job({ state: "failed" }),
      verdict: makeVerdict(
        "disc_scratched",
        "confirmed",
        [],
      ),
      driveLabel: "09 - Pioneer BDR-211M",
      slot: 9,
    })

    expect(payload.spoken_message).toBe(
      "The Prestige failed to rip in slot 9. It may need a look.",
    )
  })

  it("names the disc, not 'Unknown disc', on a success", () => {
    expect(
      buildRipEventPayload({
        job: job(),
        verdict: makeVerdict("ok", "confirmed", []),
        driveLabel: "09 - Pioneer BDR-211M",
        slot: 9,
      }).spoken_message,
    ).toBe("The Prestige finished ripping.")

    // `title` defaults to "Unknown disc" for the sensors. Spoken,
    // that is a sentence nobody can act on.
    const nameless = buildRipEventPayload({
      job: job({ identity: null }),
      verdict: makeVerdict("ok", "confirmed", []),
      driveLabel: "09 - Pioneer BDR-211M",
      slot: 9,
    })

    expect(nameless.title).toBe("Unknown disc")
    expect(nameless.spoken_message).toBe(
      "A disc finished ripping.",
    )
  })

  it("asks for a clean when the drive struggled", () => {
    expect(
      buildRipEventPayload({
        job: job(),
        verdict: makeVerdict("disc_dirty", "confirmed", []),
        driveLabel: "09 - Pioneer BDR-211M",
        slot: 9,
      }).spoken_message,
    ).toBe(
      "Slot 9 struggled with The Prestige. The disc may need " +
        "cleaning.",
    )
  })

  it("stays a sentence when the bay has no slot", () => {
    // A drive missing from `config/drives.json` has no slot, and
    // the fallback must not be the model number this field exists
    // to keep out of the speakers.
    const payload = buildRipEventPayload({
      job: job({ state: "needs_attention" }),
      verdict: makeVerdict("unknown", "suspected", []),
      driveLabel: "2-1.3.2",
      slot: null,
    })

    expect(payload.spoken_message).toBe(
      "A disc needs attention. Rip Deck did not rip it.",
    )
    expect(payload.spoken_message).not.toContain("2-1.3")
  })

  it("carries no backtick or CLI syntax, whatever happened", () => {
    const states = [
      "completed",
      "failed",
      "cancelled",
      "needs_attention",
    ] as const

    for (const state of states) {
      const spoken = buildRipEventPayload({
        job: job({ state }),
        verdict: makeVerdict("unknown", "suspected", []),
        driveLabel: "09 - Pioneer BDR-211M",
        slot: 9,
      }).spoken_message

      expect(spoken).not.toContain("`")
      expect(spoken).not.toContain("--")
      expect(spoken).not.toContain("rip-deck rip")
    }
  })
})
