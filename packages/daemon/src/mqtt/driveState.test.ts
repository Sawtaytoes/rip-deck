import {
  EMPTY_PROGRESS,
  type Job,
  makeVerdict,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  type BayState,
  createBayState,
} from "../rip/watcher.ts"
import { buildDriveStatePayload } from "./driveState.ts"

const NOW_MS = 1_780_000_000_000

const bay = (overrides: Partial<BayState>): BayState => ({
  ...createBayState({
    driveId: "usb-2-1-1-2-3",
    atMs: NOW_MS,
  }),
  ...overrides,
})

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  driveId: "usb-2-1-1-2-3",
  state: "ripping",
  startedAt: 0,
  finishedAt: null,
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
  progress: {
    ...EMPTY_PROGRESS,
    totalFraction: 0.4237,
    etaSeconds: 900,
    etaTrend: "falling",
    throughputBytesPerSec: 21 * 1024 * 1024,
  },
  verdict: makeVerdict("ok", "suspected", []),
  failureReason: null,
  destinationPath: null,
  readErrorCount: 0,
  isAdopted: false,
  isKeepTryingRequested: false,
  ...overrides,
})

describe("buildDriveStatePayload", () => {
  it("reports an idle bay without inventing a job", () => {
    const payload = buildDriveStatePayload({
      job: null,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(payload.state).toBe("idle")
    expect(payload.job_id).toBeNull()
    expect(payload.title).toBeNull()
    expect(payload.progress_percent).toBe(0)
    expect(payload.verdict).toBe("ok")
  })

  it("rounds the whole-backup progress to a percent", () => {
    const payload = buildDriveStatePayload({
      job: job(),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(payload.progress_percent).toBe(42)
  })

  it("carries the ETA trend through", () => {
    // A rising ETA is a signal in its own right (C6), so it has
    // to survive the trip to the dashboard rather than being
    // recomputed from a percentage there.
    const payload = buildDriveStatePayload({
      job: job({
        progress: {
          ...EMPTY_PROGRESS,
          etaTrend: "rising",
        },
      }),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(payload.eta_trend).toBe("rising")
  })

  it("never hides a read error", () => {
    const payload = buildDriveStatePayload({
      job: job({ readErrorCount: 3 }),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(payload.read_error_count).toBe(3)
  })

  it("tolerates an unidentified disc", () => {
    const payload = buildDriveStatePayload({
      job: job({ identity: null }),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_000,
    })

    expect(payload.title).toBeNull()
    expect(payload.disctype).toBeNull()
  })

  it("stamps the reading so a stale card looks stale", () => {
    const payload = buildDriveStatePayload({
      job: job(),
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: 1_753_000_000_000,
    })

    expect(payload.updated_at).toBe(1_753_000_000_000)
  })
})

/**
 * The tray half. `state` answers "what job is this bay running",
 * and a bay holding a disc it has finished with is running none —
 * which is why these fields exist rather than a sixth `state`
 * word.
 */
describe("buildDriveStatePayload — the tray", () => {
  const payloadFor = (input: {
    bay: BayState
    isDrivePresent?: boolean
  }) =>
    buildDriveStatePayload({
      job: null,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: NOW_MS,
      disc: {
        bay: input.bay,
        isDrivePresent: input.isDrivePresent ?? true,
      },
    })

  it("says a finished disc is still in the tray", () => {
    const payload = payloadFor({
      bay: bay({
        phase: "done",
        sizeSectors: 22_468_608,
        discName: "TROY",
        destinationPath: "/Disc-Rips/TROY",
        outcome: { kind: "completed", detail: "backed up" },
        isAdopted: true,
      }),
    })

    expect(payload.state).toBe("idle")
    expect(payload.has_disc).toBe(true)
    expect(payload.is_holding_finished_disc).toBe(true)
    expect(payload.disc_size_sectors).toBe(22_468_608)
    expect(payload.disc_name).toBe("TROY")
    expect(payload.destination_path).toBe("/Disc-Rips/TROY")
    expect(payload.is_adopted).toBe(true)
  })

  it("says an empty tray is empty", () => {
    const payload = payloadFor({
      bay: bay({ phase: "idle" }),
    })

    expect(payload.has_disc).toBe(false)
    expect(payload.is_holding_finished_disc).toBe(false)
    expect(payload.disc_size_sectors).toBeNull()
    expect(payload.disc_name).toBeNull()
  })

  it("does not call a disc still being ripped finished", () => {
    // It is loaded, and nobody has to do anything about it.
    const payload = payloadFor({
      bay: bay({
        phase: "ripping",
        sizeSectors: 22_468_608,
      }),
    })

    expect(payload.has_disc).toBe(true)
    expect(payload.is_holding_finished_disc).toBe(false)
  })

  it("counts a quarantined bay as holding a disc", () => {
    // "Finished" means rip-deck will do nothing further with it,
    // not that the rip worked. A quarantined disc is trapped in
    // exactly the same way and needs the same human.
    const payload = payloadFor({
      bay: bay({
        phase: "quarantined",
        sizeSectors: 22_468_608,
        outcome: {
          kind: "needs_attention",
          detail:
            "started 4 times without the tray emptying",
        },
      }),
    })

    expect(payload.is_holding_finished_disc).toBe(true)
  })

  it("separates a missing drive from an empty one", () => {
    // A USB re-enumeration takes the drive off the bus and
    // leaves the disc exactly where it was.
    const payload = payloadFor({
      bay: bay({
        phase: "done",
        sizeSectors: 22_468_608,
        discName: "TROY",
        outcome: { kind: "completed", detail: "backed up" },
      }),
      isDrivePresent: false,
    })

    expect(payload.is_present).toBe(false)
    expect(payload.has_disc).toBe(true)
  })

  it("omits the tray rather than guessing at it", () => {
    // A caller that holds no bay table says nothing. Publishing
    // `has_disc: false` on its behalf would be the same false
    // "nothing loaded" these fields exist to correct.
    const payload = buildDriveStatePayload({
      job: null,
      driveLabel: "07 - Pioneer BDR-211M",
      slot: 7,
      nowMs: NOW_MS,
    })

    expect(payload).not.toHaveProperty("has_disc")
    expect(payload).not.toHaveProperty("is_present")
  })
})
