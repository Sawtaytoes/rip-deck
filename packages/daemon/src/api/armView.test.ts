import {
  EMPTY_PROGRESS,
  type Job,
  makeVerdict,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  buildArmState,
  formatLocalTimestamp,
  toArmJobId,
  toArmKind,
  toArmPercent,
} from "./armView.ts"
import {
  createBaySnapshot,
  createTowerSnapshot,
} from "./snapshot.ts"

/**
 * The ARM viewer is the only UI that exists, and Stage 4's whole
 * point is that it can be pointed at rip-deck with a base-URL
 * change. So these tests are about the SHAPE its
 * `httpDataSource.fetchState()` expects, field for field —
 * including the two places rip-deck's model does not fit it
 * (UUID job ids, and a tray we refuse to poke).
 */

const NOW_MS = 1_800_000_000_000

const buildJob = (overrides: Partial<Job> = {}): Job => ({
  id: "6f1b2c3d-0000-4000-8000-000000000001",
  driveId: "usb-2-1-1-2-4-4-2",
  state: "ripping",
  startedAt: NOW_MS - 600_000,
  finishedAt: null,
  identity: {
    title: "Ivanhoe",
    year: 1952,
    discType: "bluray",
    source: "tmdb",
    posterUrl: "https://example.invalid/ivanhoe.jpg",
    volumeLabel: "IVANHOE",
    discNumber: null,
    discTotal: null,
  },
  progress: {
    ...EMPTY_PROGRESS,
    totalFraction: 0.4312,
    totalLabel: "Backing up disc",
    currentLabel: "Saving file 3 of 78",
    etaSeconds: 900,
    etaTrend: "falling",
  },
  verdict: makeVerdict("ok", "suspected", []),
  failureReason: null,
  destinationPath: "/media/Disc-Rips/Ivanhoe",
  readErrorCount: 0,
  isAdopted: false,
  isKeepTryingRequested: false,
  ...overrides,
})

const buildBay = (input: {
  slot: number
  job?: Job | null
}) =>
  createBaySnapshot({
    driveId: `usb-2-1-1-2-4-4-${input.slot}`,
    label: `0${input.slot} - Pioneer BDR-211M`,
    slot: input.slot,
    devPath: `/dev/sr${9 - input.slot}`,
    vendor: "PIONEER",
    model: "BD-RW BDR-211M",
    serial: `SERIAL00${input.slot}`,
    job: input.job ?? null,
  })

const armState = (bays: ReturnType<typeof buildBay>[]) =>
  buildArmState({
    snapshot: createTowerSnapshot({ bays }),
  })

describe("the ARM-viewer projection", () => {
  it("emits one host with the fields the viewer reads", () => {
    const state = armState([
      buildBay({ slot: 2, job: buildJob() }),
    ])

    expect(state.hosts).toHaveLength(1)

    const rip = state.hosts[0].rips[0]

    expect(rip.status).toBe("ripping")
    expect(rip.kind).toBe("bluray")
    expect(rip.label).toBe("Ivanhoe")
    expect(rip.drive).toBe("/dev/sr7")
    expect(rip.drive_name).toBe("02 - Pioneer BDR-211M")
    expect(rip.path).toBe(
      "/media/Disc-Rips/Ivanhoe",
    )
    expect(rip.percent).toBe(43.1)
    expect(rip.stage).toBe("Saving file 3 of 78")
    expect(rip.active).toBe(true)
    expect(rip.poster).toBe(
      "https://example.invalid/ivanhoe.jpg",
    )
  })

  it("carries the real id beside the numeric surrogate", () => {
    const job = buildJob()
    const rip = armState([buildBay({ slot: 2, job })])
      .hosts[0].rips[0]

    // The viewer types job_id as a number and joins on it, so a
    // UUID cannot go there — but the UUID is the truth.
    expect(typeof rip.job_id).toBe("number")
    expect(rip.job_id).toBeGreaterThan(0)
    expect(Number.isInteger(rip.job_id)).toBe(true)
    expect(rip.job_uuid).toBe(job.id)
    expect(rip.drive_id).toBe("usb-2-1-1-2-4-4-2")
  })

  it("keeps the surrogate stable across calls", () => {
    expect(toArmJobId("job-a")).toBe(toArmJobId("job-a"))
    expect(toArmJobId("job-a")).not.toBe(
      toArmJobId("job-b"),
    )
  })

  it("joins a drive to its rip through that surrogate", () => {
    const state = armState([
      buildBay({ slot: 2, job: buildJob() }),
    ])

    expect(state.hosts[0].drives[0].current).toBe(
      state.hosts[0].rips[0].job_id,
    )
    expect(state.hosts[0].drives[0].name).toBe("sr7")
    expect(state.hosts[0].drives[0].serial_id).toBe(
      "SERIAL002",
    )
  })

  it("moves a finished job from current to previous", () => {
    const state = armState([
      buildBay({
        slot: 2,
        job: buildJob({
          state: "completed",
          finishedAt: NOW_MS,
        }),
      }),
    ])

    expect(state.hosts[0].drives[0].current).toBeNull()
    expect(state.hosts[0].drives[0].previous).not.toBeNull()
  })

  it("treats an empty rack as OK, not as a collector failure", () => {
    const state = armState([])

    // F3: the tower is powered independently. Zero drives is a
    // normal state and must not paint the dashboard red.
    expect(state.hosts[0].ok).toBe(true)
    expect(state.hosts[0].err).toBe("")
    expect(state.hosts[0].rips).toEqual([])
    expect(state.hosts[0].drives).toEqual([])
  })

  it("reports a real collector failure as not OK", () => {
    const state = buildArmState({
      snapshot: createTowerSnapshot({
        collectorError: "state directory unreadable",
      }),
    })

    expect(state.hosts[0].ok).toBe(false)
    expect(state.hosts[0].err).toBe(
      "state directory unreadable",
    )
  })

  it("orders rips newest first", () => {
    const state = armState([
      buildBay({
        slot: 1,
        job: buildJob({
          id: "older",
          startedAt: NOW_MS - 3_600_000,
        }),
      }),
      buildBay({
        slot: 2,
        job: buildJob({
          id: "newer",
          startedAt: NOW_MS - 60_000,
        }),
      }),
    ])

    expect(
      state.hosts[0].rips.map((rip) => rip.job_uuid),
    ).toEqual(["newer", "older"])
  })

  it("never eject-loops, and never pokes the tray", () => {
    const rip = armState([
      buildBay({ slot: 2, job: buildJob() }),
    ]).hosts[0].rips[0]

    // A disc we cannot identify stays in the drive; the eject
    // flap-storm is what killed valid rips on other drives.
    expect(rip.ejected).toBe(false)
    // Tray state is an ioctl, and the parent never touches a
    // device — a wedged drive would freeze all nine bays.
    expect(rip.tray).toBe("unknown")
  })
})

describe("the log capture", () => {
  it("names the capture, so the card shows its button", () => {
    // `/logs` answers now, so `logfile: null` — which is what
    // HIDES the button — would be hiding a working feature.
    const rip = armState([
      buildBay({ slot: 2, job: buildJob() }),
    ]).hosts[0].rips[0]

    expect(rip.logfile).toBe(
      "6f1b2c3d-0000-4000-8000-000000000001.robot.log",
    )
    // The modal fetches by `job_uuid`, not by this name.
    expect(rip.job_uuid).toBe(
      "6f1b2c3d-0000-4000-8000-000000000001",
    )
  })

  it("offers no button for a bay that never had a job", () => {
    // `towerFeed` writes a `<driveId>@<ms>` placeholder when no
    // watcher could name the job, precisely so it cannot name a
    // file. A button pointing at a capture that cannot exist is
    // worse than no button.
    const rip = armState([
      buildBay({
        slot: 2,
        job: buildJob({
          id: "usb-2-1-1-2-4-4-2@1800000000000",
        }),
      }),
    ]).hosts[0].rips[0]

    expect(rip.logfile).toBeNull()
  })
})

describe("timestamps", () => {
  it("writes local wall-clock, not UTC", () => {
    const formatted = formatLocalTimestamp(NOW_MS)

    expect(formatted).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    )
    // ARM writes local time and the viewer parses these as
    // local; an ISO string would read hours into the future and
    // the elapsed/ETA text would go nonsense. Round-tripping
    // through a local parse is the timezone-independent proof.
    expect(new Date(formatted).getTime()).toBe(
      Math.floor(NOW_MS / 1000) * 1000,
    )
  })
})

describe("percent", () => {
  it("is null during the preamble, for an indeterminate bar", () => {
    // A Blu-ray decrypts and processes BD+ before copying a
    // byte. Zero percent there is not progress information.
    expect(
      toArmPercent(
        buildJob({ progress: { ...EMPTY_PROGRESS } }),
      ),
    ).toBeNull()
  })

  it("is exactly 100 for a completed rip", () => {
    expect(
      toArmPercent(
        buildJob({
          state: "completed",
          finishedAt: NOW_MS,
          progress: {
            ...EMPTY_PROGRESS,
            totalFraction: 0.999,
          },
        }),
      ),
    ).toBe(100)
  })

  it("keeps how far a failed rip got", () => {
    expect(
      toArmPercent(
        buildJob({
          state: "failed",
          progress: {
            ...EMPTY_PROGRESS,
            totalFraction: 0.137,
          },
        }),
      ),
    ).toBe(13.7)
  })
})

describe("media kind", () => {
  it("calls an audio disc what ARM calls it", () => {
    expect(toArmKind("cd")).toBe("music")
  })

  it("refuses to call a 4K disc a Blu-ray", () => {
    // The viewer tolerates unknown kinds with a generic icon.
    // A prettier glyph is not worth a wrong label on the card.
    expect(toArmKind("uhd")).toBe("uhd")
    expect(toArmKind("bluray")).toBe("bluray")
  })

  it("carries the house label for a rip-deck-aware UI", () => {
    const rip = armState([
      buildBay({
        slot: 2,
        job: buildJob({
          identity: {
            title: "Dune",
            year: 2021,
            discType: "uhd",
            source: "tmdb",
            posterUrl: null,
            volumeLabel: "DUNE",
            discNumber: null,
            discTotal: null,
          },
        }),
      }),
    ]).hosts[0].rips[0]

    expect(rip.disctype).toBe("uhd")
    expect(rip.disctype_label).toBe("4K")
  })
})
