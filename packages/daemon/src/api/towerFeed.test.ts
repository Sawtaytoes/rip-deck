import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EMPTY_PROGRESS,
  isAnnounceable,
  makeVerdict,
  type Verdict,
} from "@rip-deck/contracts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { ProbedDrive } from "../drives/sysfs.ts"
import {
  refreshHealthGate,
  resetHealthGate,
} from "../health/publish.ts"
import {
  type ComputedVerdictStore,
  createNullComputedVerdictStore,
} from "../health/verdictStore.ts"
import {
  createNullPosterStore,
  createPosterStoreFromEnv,
  type PosterMatch,
  type PosterStore,
} from "../metadata/posterStore.ts"
import { BAY_LEDGER_VERSION } from "../rip/bayLedger.ts"
import { createGovernor } from "../rip/governor.ts"
import {
  type BayOutcome,
  type BayPhase,
  type BaySighting,
  type BayState,
  createBayState,
  startWatcher,
  type WatcherHandlers,
} from "../rip/watcher.ts"
import { buildArmState } from "./armView.ts"
import type { RipDeckJsonDocument } from "./jsonDocument.ts"
import { createApiServer } from "./server.ts"
import { createTowerStore } from "./snapshot.ts"
import {
  createTowerFeed,
  hasBayReArmed,
  toJobState,
} from "./towerFeed.ts"
import { buildTowerView } from "./towerView.ts"

/**
 * The wiring `main.ts` was missing.
 *
 * `createApiServer` and `createTowerStore` were both built,
 * tested and then called by nobody, so `GET /json` had never been
 * served once. These tests are about the seam between them and
 * the watcher, and about the one thing that seam must not do:
 * invent facts it does not have.
 *
 * No watcher runs here and no socket is opened except in the last
 * test. The handlers are called by hand exactly as
 * `startWatcher` calls them, which is the point — nine bays'
 * worth of behaviour, and no drive.
 */

const NOW_MS = 1_800_000_000_000
const DRIVE_ID = "usb-2-1-1-2-4-4-2"
const JOB_UUID = "9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6071"

/** The watcher's own bay table, as `getBays()` returns it. */
const fakeBays = (
  input: {
    driveId?: string
    phase?: BayPhase
    jobUuid?: string | null
    outcome?: BayOutcome
    sizeSectors?: number
    discName?: string
    destinationPath?: string
    isAdopted?: boolean
    latchedAtMs?: number
  }[],
): BayState[] =>
  input.map((bay) => ({
    ...createBayState({
      driveId: bay.driveId ?? DRIVE_ID,
      atMs: NOW_MS,
    }),
    phase: bay.phase ?? "starting",
    jobUuid:
      bay.jobUuid === undefined ? JOB_UUID : bay.jobUuid,
    outcome: bay.outcome ?? null,
    sizeSectors: bay.sizeSectors ?? null,
    discName: bay.discName ?? null,
    destinationPath: bay.destinationPath ?? null,
    isAdopted: bay.isAdopted ?? false,
    latchedAtMs: bay.latchedAtMs ?? null,
  }))

/** The watcher's sighting table, as `getBaySightings()` has it. */
const fakeSightings = (
  input: Partial<BaySighting>[],
): BaySighting[] =>
  input.map((sighting) => ({
    driveId: DRIVE_ID,
    isDrivePresent: true,
    slot: 2,
    label: "02 - Pioneer BDR-211M",
    devPath: "/dev/sr3",
    vendor: "Pioneer",
    model: "BDR-211M",
    serial: "EXAMPLE00007",
    ...sighting,
  }))

const createHarness = (
  input: {
    bays?: BayState[]
    sightings?: BaySighting[]
    isAttached?: boolean
    poster?: PosterStore
    verdicts?: ComputedVerdictStore
  } = {},
) => {
  const store = createTowerStore()
  const calls: string[] = []

  let bays = input.bays ?? fakeBays([{ phase: "starting" }])
  let sightings = input.sightings ?? []

  const feed = createTowerFeed({
    store,
    now: () => NOW_MS,
    // Never the default store: a test must not reach the real
    // OMDb API, and it would if this machine happened to have
    // `RIP_DECK_OMDB_API_KEY` exported.
    poster: input.poster ?? createNullPosterStore(),
    // Same rule as the poster store, for the same reason: the
    // default reads `$RIP_DECK_STATE_DIR`, so a test that took
    // it would pass or fail on whatever the tower had ripped.
    verdicts:
      input.verdicts ?? createNullComputedVerdictStore(),
    handlers: {
      onNote: () => calls.push("onNote"),
      onBayNote: () => calls.push("onBayNote"),
      onBayProgress: () => calls.push("onBayProgress"),
      onBayOutcome: () => calls.push("onBayOutcome"),
      onTickComplete: () => calls.push("onTickComplete"),
    },
  })

  if (input.isAttached !== false) {
    feed.attachWatcher({
      getBays: () => bays,
      getSightings: () => sightings,
    })
  }

  return {
    store,
    calls,
    handlers: feed.handlers,
    setBays: (next: BayState[]) => {
      bays = next
    },
    setSightings: (next: BaySighting[]) => {
      sightings = next
    },
    readBay: (driveId = DRIVE_ID) =>
      store
        .readSnapshot()
        .bays.find((bay) => bay.driveId === driveId),
  }
}

const bayEvent = {
  driveId: DRIVE_ID,
  slot: 2,
  name: "02 - Pioneer BDR-211M",
}

const POSTER_URL = "https://example.invalid/troy.jpg"

/** A disc held across a restart, named, with its rip done. */
const heldDisc = (discName: string) => ({
  phase: "done" as const,
  jobUuid: null,
  isAdopted: true,
  latchedAtMs: NOW_MS - 7_200_000,
  discName,
  destinationPath: "/media/Disc-Rips/[BACKUP]",
  outcome: {
    kind: "completed" as const,
    detail: "/media/Disc-Rips/[BACKUP]",
  },
})

/** A poster store that has already answered, keyed by label. */
const fakePoster = (
  answers: Record<string, PosterMatch>,
): PosterStore => ({
  request: () => {},
  get: ({ discName }) => answers[discName] ?? null,
})

const outcome = (
  kind: BayOutcome["kind"],
  detail: string,
  warnings?: string[],
): BayOutcome =>
  warnings === undefined
    ? { kind, detail }
    : { kind, detail, warnings }

describe("the bay-phase to job-state mapping", () => {
  it("resolves an ambiguous phase downwards", () => {
    // `starting` is settle AND type AND identify. Claiming the
    // last of those would put a disc in a step it has not
    // reached; the earliest one cannot.
    expect(
      toJobState({
        phase: "starting",
        outcome: null,
        hasSeenProgress: false,
      }),
    ).toBe("settling")
  })

  it("gives an idle or latched bay no job at all", () => {
    // A card is better absent than invented.
    for (const phase of ["idle", "done"] as const) {
      expect(
        toJobState({
          phase,
          outcome: null,
          hasSeenProgress: false,
        }),
      ).toBeNull()
    }
  })

  it("shows a disc that left before the rip as nothing", () => {
    // `no_media` re-arms the bay rather than latching it, so
    // there was never a job to show.
    expect(
      toJobState({
        phase: "idle",
        outcome: outcome("no_media", "the disc was gone"),
        hasSeenProgress: false,
      }),
    ).toBeNull()
  })

  it("keeps a warning-bearing rip COMPLETED, not needs_attention", () => {
    // A warning is not a state. The disc IS backed up, so the
    // bay is done with it — routing this to `needs_attention`
    // would put a finished rip in the queue of bays waiting on
    // the owner, which is the opposite of what he asked for.
    expect(
      toJobState({
        phase: "done",
        outcome: outcome(
          "completed_with_warnings",
          "/media/Disc-Rips/x.iso — 4 read errors",
        ),
        hasSeenProgress: true,
      }),
    ).toBe("completed")
  })

  it("treats a quarantined bay as needing a human", () => {
    expect(
      toJobState({
        phase: "quarantined",
        outcome: null,
        hasSeenProgress: false,
      }),
    ).toBe("needs_attention")
  })
})

describe("the feed", () => {
  it("puts a bay on the dashboard the moment it speaks", () => {
    const harness = createHarness()

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })

    const bay = harness.readBay()

    expect(bay?.label).toBe("02 - Pioneer BDR-211M")
    expect(bay?.slot).toBe(2)
    expect(bay?.job?.state).toBe("settling")
    expect(bay?.job?.startedAt).toBe(NOW_MS)
    expect(bay?.job?.finishedAt).toBeNull()
  })

  it("carries a finished rip's warnings onto its job", () => {
    // The third state, end to end through the feed: the bay
    // table holds the sentences `buildRipWarnings` wrote, the
    // job carries them, and the state stays `completed`.
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          latchedAtMs: NOW_MS - 60_000,
          destinationPath: "/media/Disc-Rips/x.iso",
          outcome: outcome(
            "completed_with_warnings",
            "/media/Disc-Rips/x.iso — 4 read errors",
            ["4 read errors at 3.20 GB."],
          ),
        },
      ]),
    })

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "ripping -> x",
    })

    const job = harness.readBay()?.job

    expect(job?.state).toBe("completed")
    expect(job?.warnings).toEqual([
      "4 read errors at 3.20 GB.",
    ])
    // A warning is not a failure, and nothing here may turn it
    // into one.
    expect(job?.failureReason).toBeNull()
  })

  it("gives a clean finished rip an empty warning list", () => {
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          latchedAtMs: NOW_MS - 60_000,
          outcome: outcome(
            "completed",
            "/media/Disc-Rips/x.iso",
          ),
        },
      ]),
    })

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "ripping -> x",
    })

    expect(harness.readBay()?.job?.warnings).toEqual([])
  })

  it("carries the watcher's REAL job uuid", () => {
    // `job_uuid` names `$RIP_DECK_STATE_DIR/<uuid>.robot.log`. A
    // freshly minted uuid here would name a capture that does not
    // exist, which is worse than no id.
    const harness = createHarness()

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: 'identified as "[BACKUP] Ivanhoe (1952)"',
    })

    expect(harness.readBay()?.job?.id).toBe(JOB_UUID)
  })

  it("follows the job uuid when a HELD bay is ripped", () => {
    // The 2026-07-30 defect, and it is not about the Rip button:
    // ANY bay held at startup that later rips hit it.
    //
    // A held bay emits a "held on startup" NOTE and deliberately
    // never an outcome (an outcome would announce rips that did not
    // just happen, on every restart). So the note created the
    // record and stamped the uuid the LEDGER was carrying — the
    // PREVIOUS daemon's job. `outcome` stayed null, nothing
    // recreated the record, and the id was read only once. Slot 9
    // then ripped 84 GB clean while its card pointed at a
    // `<uuid>.robot.log` that does not exist, so Logs answered 404.
    const STALE = "3387a174-b316-414e-bd78-05e65e528fd5"
    const REAL = "e7d95e40-ec0f-449f-8b1b-7a63e77b68d5"

    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: STALE,
          isAdopted: true,
          latchedAtMs: NOW_MS - 7_200_000,
          outcome: outcome(
            "needs_attention",
            "could not read a name off this disc.",
          ),
        },
      ]),
    })

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "held on startup — could not read a name",
    })

    expect(harness.readBay()?.job?.id).toBe(STALE)

    // The operator presses Rip. The watcher clears the outcome and
    // mints a new job; nothing about this bay emits an OUTCOME, so
    // the record is reused.
    harness.setBays(
      fakeBays([{ phase: "starting", jobUuid: REAL }]),
    )

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: 'identified as "SOYLENT GREEN - UHD"',
    })

    expect(harness.readBay()?.job?.id).toBe(REAL)
  })

  it("does not pass a fake uuid off as a real one", () => {
    // Unattached, the uuid is unreadable. The id is then visibly
    // not a uuid rather than plausibly one.
    const harness = createHarness({ isAttached: false })

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })

    expect(harness.readBay()?.job?.id).toBe(
      `${DRIVE_ID}@${String(NOW_MS)}`,
    )
  })

  it("hands progress through untouched", () => {
    const harness = createHarness({
      bays: fakeBays([{ phase: "ripping" }]),
    })

    harness.handlers.onBayProgress?.({
      ...bayEvent,
      progress: {
        ...EMPTY_PROGRESS,
        totalFraction: 0.43,
        bytesWritten: 14_000_000_000,
        throughputBytesPerSec: 21 * 1024 ** 2,
        etaSeconds: 900,
        etaTrend: "rising",
      },
    })

    const job = harness.readBay()?.job

    expect(job?.state).toBe("ripping")
    expect(job?.progress.totalFraction).toBe(0.43)
    expect(job?.progress.etaTrend).toBe("rising")
  })

  it("never claims a verdict nothing computed", () => {
    // The health engine does not run inside `rip-deck watch`, so
    // there is no verdict for any of these rips. `ok` would not
    // be a default here, it would be an assertion that a rip we
    // never measured is reading normally.
    const harness = createHarness()

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "completed",
        "/media/Disc-Rips/[BACKUP] Ivanhoe",
      ),
    })

    const verdict = harness.readBay()?.job?.verdict

    expect(verdict?.kind).toBe("unknown")
    // Never `confirmed`: only a confirmed verdict may announce,
    // and an announcement carrying an uncomputed verdict is the
    // confidently-wrong alert the model exists to prevent.
    expect(verdict?.confidence).toBe("suspected")
    // The outcome's own sentence is the evidence, so the fact is
    // kept without being dressed up as structure.
    expect(verdict?.evidence[0]).toContain("Ivanhoe")
  })

  it("says a failure is a failure without guessing why", () => {
    const harness = createHarness()

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "failed",
        "read_errors (exit 0 — the silent-success case)",
      ),
    })

    const job = harness.readBay()?.job

    expect(job?.state).toBe("failed")
    // `unknown` rather than null: null reads as "nothing went
    // wrong". The real reason is in the evidence, as prose.
    expect(job?.failureReason).toBe("unknown")
    expect(job?.verdict.evidence[0]).toContain(
      "read_errors",
    )
    expect(job?.finishedAt).toBe(NOW_MS)
  })

  it("records a finished rip as the last rip", () => {
    const harness = createHarness()

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "completed",
        "/mnt/…/[BACKUP] Ivanhoe",
      ),
    })

    const lastRip = harness.store.readSnapshot().lastRip

    expect(lastRip?.driveLabel).toBe(
      "02 - Pioneer BDR-211M",
    )
    expect(lastRip?.job.state).toBe("completed")
    expect(lastRip?.verdict.kind).toBe("unknown")
  })

  it("keeps a disc that never ripped out of the last rip", () => {
    // `last_rip` is what the HA sensors read as "what happened
    // most recently". A flagged disc never became a rip, and an
    // absent disc certainly did not.
    const harness = createHarness()

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "needs_attention",
        "could not read a name off this disc",
      ),
    })

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome("no_media", "the disc was gone"),
    })

    expect(harness.store.readSnapshot().lastRip).toBeNull()
  })

  it("shows a flagged disc as needing a human", () => {
    const harness = createHarness()

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "needs_attention",
        "the disc never settled — it is still in the drive",
      ),
    })

    expect(harness.readBay()?.job?.state).toBe(
      "needs_attention",
    )
  })

  it("leaves no job behind when the disc left", () => {
    const harness = createHarness()

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })

    harness.setBays(
      fakeBays([{ phase: "idle", jobUuid: null }]),
    )

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "no_media",
        "the disc was gone before it settled",
      ),
    })

    const bay = harness.readBay()

    expect(bay).toBeDefined()
    expect(bay?.job).toBeNull()
  })

  it("marks a quarantined bay out of service, with why", () => {
    const harness = createHarness({
      bays: fakeBays([
        { phase: "quarantined", jobUuid: null },
      ]),
    })

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "needs_attention",
        "Started 3 times without the tray ever reading empty.",
      ),
    })

    const supervision = harness.readBay()?.supervision

    expect(supervision?.isQuarantined).toBe(true)
    expect(supervision?.quarantineReason).toContain(
      "3 times",
    )
  })

  it("starts a new run for the next disc in the bay", () => {
    const harness = createHarness()

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })
    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome("completed", "/mnt/…/first"),
    })

    const secondUuid =
      "11111111-2222-4333-8444-555555555555"

    harness.setBays(
      fakeBays([
        { phase: "starting", jobUuid: secondUuid },
      ]),
    )

    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })

    const job = harness.readBay()?.job

    expect(job?.id).toBe(secondUuid)
    expect(job?.state).toBe("settling")
    // The finished rip's numbers must not bleed into the new one.
    expect(job?.finishedAt).toBeNull()
    expect(job?.progress.totalFraction).toBe(0)
  })

  it("shows nine idle bays rather than an empty rack", () => {
    // Idle bays emit no per-bay events at all, so without the
    // roster sync a fully loaded tower would render as zero
    // drives — which is itself a meaningful state (F3) and must
    // not be confused with this one.
    const harness = createHarness({
      bays: fakeBays(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => ({
          driveId: `usb-2-1-1-2-4-4-${String(slot)}`,
          phase: "idle" as const,
          jobUuid: null,
        })),
      ),
    })

    harness.handlers.onTickComplete?.()

    const snapshot = harness.store.readSnapshot()

    expect(snapshot.bays).toHaveLength(9)
    expect(
      snapshot.bays.every((bay) => bay.job === null),
    ).toBe(true)
    // No sighting and no handler has told us a house name, so
    // the stable id stands in. Never `/dev/srN`, which
    // reshuffles.
    expect(snapshot.bays[0].label).toBe("usb-2-1-1-2-4-4-1")
  })

  it("does not take a bus note for a roster", () => {
    // `onNote` is emitted at the TOP of the tick, before the
    // per-bay loop has put anything in the watcher's table, and
    // only when the drive COUNT changes. Syncing the roster
    // there is what served three bays of nine: on the first tick
    // there was nothing to read, and there was never a second
    // note.
    const harness = createHarness({ bays: [] })

    harness.handlers.onNote?.("9 drive(s) present.")

    harness.setBays(
      fakeBays(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => ({
          driveId: `usb-2-1-1-2-4-4-${String(slot)}`,
          phase: "idle" as const,
          jobUuid: null,
        })),
      ),
    )

    // The note has been and gone; the tower is steady, so there
    // will never be another one.
    expect(harness.store.readSnapshot().bays).toHaveLength(
      0,
    )

    harness.handlers.onTickComplete?.()

    expect(harness.store.readSnapshot().bays).toHaveLength(
      9,
    )
  })

  it("shows a disc held from the last daemon as held", () => {
    // The defect that mattered most. `adoptBayAtStartup` latched
    // three real Troy discs `done` + `needs_attention` and saved
    // 225 GB of duplicate rips — and `/json` rendered all three
    // as `state: "idle", verdict: "ok"`. An adopted bay fires no
    // outcome event BY DESIGN (an outcome publishes `rip/event`
    // and would announce three rips that did not just happen),
    // so the bay table is the only witness there is.
    const heldAtMs = NOW_MS - 3_600_000

    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: null,
          isAdopted: true,
          latchedAtMs: heldAtMs,
          sizeSectors: 48_000_000,
          outcome: outcome(
            "needs_attention",
            "There was already a disc in this drive when " +
              "rip-deck started",
          ),
        },
      ]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    const bay = harness.readBay()

    expect(bay?.job?.state).toBe("needs_attention")
    // Adopted, because no handler ever spoke for it: its disc
    // belongs to the daemon that ran before this one.
    expect(bay?.job?.isAdopted).toBe(true)
    // The ledger's own instant, never `now()` — a card that says
    // the rip started this second, every second, is a lie
    // repeated forever.
    expect(bay?.job?.startedAt).toBe(heldAtMs)
    // Why it is held, in the owner's own words, where the card
    // can read it as prose.
    expect(bay?.job?.verdict.evidence[0]).toContain(
      "already a disc in this drive",
    )
    // Still unknown: no health engine judged this rip. A held
    // disc and an unjudged rip share a verdict and differ in
    // state, which is the distinction the card needs.
    expect(bay?.job?.verdict.kind).toBe("unknown")
    // A disc IS in the tray, which `is_present` — a fact about
    // the drive — cannot say.
    expect(bay?.discSizeSectors).toBe(48_000_000)
  })

  it("shows a disc finished by the last daemon as finished", () => {
    // The owner marked tonight's three discs finished, so the
    // ledger now latches them `completed` rather than
    // `needs_attention`. A finished disc sitting in a tray must
    // read as finished: `open_completed` — the eject button —
    // turns on exactly this distinction.
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: null,
          isAdopted: true,
          latchedAtMs: NOW_MS - 7_200_000,
          outcome: outcome(
            "completed",
            "/media/Disc-Rips/[BACKUP] TROY",
          ),
        },
      ]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    const bay = harness.readBay()

    expect(bay?.job?.state).toBe("completed")
    expect(bay?.job?.isAdopted).toBe(true)
    expect(bay?.job?.verdict.evidence[0]).toContain("TROY")
  })

  it("names the disc, from the bay and not the sentence", () => {
    // Stage 7 §8. The card fell back to the BAY's label — the
    // owner's three Troy discs read as "07 - Pioneer BDR-211M"
    // — because the only copy of the name was inside the
    // outcome's English sentence, and scraping that is
    // forbidden here. The bay carries it as a field now.
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: null,
          isAdopted: true,
          latchedAtMs: NOW_MS - 7_200_000,
          discName: "TROY - DIRECTOR'S CUT",
          destinationPath: "/media/Disc-Rips/[BACKUP] TROY",
          outcome: outcome(
            "completed",
            "/media/Disc-Rips/[BACKUP] TROY",
          ),
        },
      ]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    const job = harness.readBay()?.job

    expect(job?.identity?.title).toBe(
      "TROY - DIRECTOR'S CUT",
    )
    expect(job?.identity?.volumeLabel).toBe(
      "TROY - DIRECTOR'S CUT",
    )
    // `identifyDisc`'s read of the media, which is what the new
    // `"disc"` source means. Never `manual` (nobody typed it)
    // and never `tmdb` (nothing was looked up).
    expect(job?.identity?.source).toBe("disc")
    // Nothing recorded a disc type or looked the title up, so
    // the rest of `DiscIdentity` stays honest.
    expect(job?.identity?.discType).toBe("unknown")
    expect(job?.identity?.year).toBeNull()
    expect(job?.identity?.posterUrl).toBeNull()
    // A field, not health evidence. §5 of the eject doc exists
    // because this path used to render inside the verdict.
    expect(job?.destinationPath).toBe(
      "/media/Disc-Rips/[BACKUP] TROY",
    )
  })

  it("puts the poster on the card, and says who found it", () => {
    // B1 — the owner's single favourite ARM feature, and item
    // 3 on his ranked card list. The render path already
    // existed end to end; only this was missing.
    const harness = createHarness({
      bays: fakeBays([heldDisc("TROY - BONUS DISC")]),
      sightings: fakeSightings([{}]),
      poster: fakePoster({
        "TROY - BONUS DISC": {
          title: "Troy",
          year: 2004,
          posterUrl: POSTER_URL,
          provider: "omdb",
        },
      }),
    })

    harness.handlers.onTickComplete?.()

    const identity = harness.readBay()?.job?.identity

    expect(identity?.posterUrl).toBe(POSTER_URL)
    expect(identity?.year).toBe(2004)
    // Where the metadata actually came from. `tmdb` would be a
    // lie — there is no TMDB key in this house and that
    // provider never ran.
    expect(identity?.source).toBe("omdb")
    // And the disc keeps its own name: three Troy discs sat in
    // slots 7-9 of the real tower, and rewriting all three
    // cards to "Troy" would take away the only thing that told
    // them apart.
    expect(identity?.title).toBe("TROY - BONUS DISC")
    expect(identity?.volumeLabel).toBe("TROY - BONUS DISC")
  })

  it("asks about a disc without waiting for the answer", () => {
    // The `/json` contract is that handlers are synchronous
    // memory reads, so the lookup is kicked off here and read
    // back on a later poll. A store that has not answered
    // yet reports no poster rather than delaying the page.
    const asked: string[] = []

    const harness = createHarness({
      bays: fakeBays([heldDisc("TROY - BONUS DISC")]),
      sightings: fakeSightings([{}]),
      poster: {
        request: ({ discName }) => asked.push(discName),
        get: () => null,
      },
    })

    harness.handlers.onTickComplete?.()

    expect(asked).toEqual(["TROY - BONUS DISC"])
    expect(
      harness.readBay()?.job?.identity?.posterUrl,
    ).toBeNull()
    expect(harness.readBay()?.job?.identity?.source).toBe(
      "disc",
    )
  })

  it("renders a card with no poster and no complaint", () => {
    // No `RIP_DECK_OMDB_API_KEY` is a supported state, exactly
    // as no `RIP_DECK_MQTT_URL` is: the bay rips, the card
    // renders, and nothing is logged as an error.
    const errors: unknown[] = []
    const realError = console.error

    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      const harness = createHarness({
        bays: fakeBays([heldDisc("TROY - BONUS DISC")]),
        sightings: fakeSightings([{}]),
        poster: createPosterStoreFromEnv({}),
      })

      harness.handlers.onTickComplete?.()

      const identity = harness.readBay()?.job?.identity

      expect(identity?.posterUrl).toBeNull()
      expect(identity?.title).toBe("TROY - BONUS DISC")
      expect(harness.readBay()?.job?.state).toBe(
        "completed",
      )
      expect(errors).toEqual([])
    } finally {
      console.error = realError
    }
  })

  it("numbers a disc from its own label", () => {
    // Which disc of a set this is exists only in the label —
    // no lookup can know it, and the owner's three-disc sets
    // are the reason it is worth carrying.
    const harness = createHarness({
      bays: fakeBays([heldDisc("THE_MATRIX_D2")]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    expect(harness.readBay()?.job?.identity).toMatchObject({
      title: "THE_MATRIX_D2",
      discNumber: 2,
      discTotal: null,
    })
  })

  it("invents no name for a disc nothing has read", () => {
    // The other half of the same rule. A bay held before
    // identify ever ran has no name, and the honest answer is
    // no identity at all — the UI falls back to the bay label
    // deliberately, rather than being handed a fabricated one.
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: null,
          isAdopted: true,
          latchedAtMs: NOW_MS,
          outcome: outcome(
            "needs_attention",
            "There was already a disc in this drive when " +
              "rip-deck started",
          ),
        },
      ]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    const job = harness.readBay()?.job

    expect(job?.identity).toBeNull()
    // And no destination either: nothing was published, so a
    // path here would claim bytes that do not exist.
    expect(job?.destinationPath).toBeNull()
  })

  it("names the drive the dashboard is pointing at", () => {
    // Every drive in 0.4.0's `/json` was `name: null,
    // mount: null, maker: null, model: null, serial_id: null`.
    // The ARM viewer keys its per-drive controls on `mount`, so
    // the dashboard had no drive identity at all.
    const harness = createHarness({
      bays: fakeBays([{ phase: "idle", jobUuid: null }]),
      sightings: fakeSightings([
        {
          slot: 3,
          label: "03 - LG WH14NS40",
          devPath: "/dev/sr5",
          // The registry's TRUE maker and model: this bay is an
          // LG whose OmniDrive firmware reports it as ASUS.
          vendor: "LG",
          model: "WH14NS40",
          serial: "EXAMPLE00001",
        },
      ]),
    })

    harness.handlers.onTickComplete?.()

    const bay = harness.readBay()

    expect(bay?.label).toBe("03 - LG WH14NS40")
    expect(bay?.slot).toBe(3)
    expect(bay?.devPath).toBe("/dev/sr5")
    expect(bay?.vendor).toBe("LG")
    expect(bay?.model).toBe("WH14NS40")
    expect(bay?.serial).toBe("EXAMPLE00001")
  })

  it("stops calling a bay present once the tower is off", () => {
    // `isPresent` was hardcoded true and meant "the watcher has
    // seen this bay", so after the owner switched the tower off
    // the bays lingered as present forever.
    const harness = createHarness({
      bays: fakeBays([{ phase: "idle", jobUuid: null }]),
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onTickComplete?.()

    expect(harness.readBay()?.isPresent).toBe(true)

    harness.setSightings(
      fakeSightings([
        { isDrivePresent: false, devPath: null },
      ]),
    )

    harness.handlers.onTickComplete?.()

    const bay = harness.readBay()

    expect(bay?.isPresent).toBe(false)
    // The bay is still NAMED — a drive that vanished is worth
    // showing as gone rather than dropping off the rack.
    expect(bay?.label).toBe("02 - Pioneer BDR-211M")
    // But not addressed: `/dev/sr3` now belongs to whatever
    // inherits the name at the next re-enumeration.
    expect(bay?.devPath).toBeNull()
  })

  it("still calls the console handlers it wraps", () => {
    const harness = createHarness()

    harness.handlers.onNote?.("9 drive(s) present.")
    harness.handlers.onBayNote?.({
      ...bayEvent,
      message: "ripping",
    })
    harness.handlers.onBayProgress?.({
      ...bayEvent,
      progress: EMPTY_PROGRESS,
    })
    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome("completed", "/mnt/…/Ivanhoe"),
    })

    expect(harness.calls).toEqual([
      "onNote",
      "onBayNote",
      "onBayProgress",
      "onBayOutcome",
    ])
  })

  it("writes the store BEFORE it prints", () => {
    // A console formatter that throws must not cost the
    // dashboard its update.
    const store = createTowerStore()
    let bayCountAtPrint = -1

    const feed = createTowerFeed({
      store,
      now: () => NOW_MS,
      poster: createNullPosterStore(),
      handlers: {
        onBayNote: () => {
          bayCountAtPrint = store.readSnapshot().bays.length
        },
      },
    })

    feed.attachWatcher({
      getBays: () => fakeBays([{ phase: "starting" }]),
    })

    feed.handlers.onBayNote?.({
      ...bayEvent,
      message: "waiting for the disc to settle…",
    })

    expect(bayCountAtPrint).toBe(1)
  })
})

/* ------------------------------------------------------------ *
 * The whole seam, driven by the real watcher.
 * ------------------------------------------------------------ */

/**
 * Tonight's tower, as the daemon actually found it.
 *
 * Nine drives on the bus, discs in slots 7-9, and a ledger that
 * latched those three as finished by the daemon that ran before
 * this one. The live 0.4.0 answer to this exact state was
 * `drive_count: 3` with all three reading `idle`/`ok`, which no
 * amount of handler-level testing caught — the handlers were
 * never the problem.
 */
const BLURAY_SECTORS = 23_000_000

const nineBayTower = (input: { isPoweredOn: boolean }) =>
  input.isPoweredOn
    ? Array.from({ length: 9 }, (_unused, index) => {
        const slot = index + 1
        const isLoaded = slot >= 7

        return {
          address: {
            kernelName: `sr${String(index)}`,
            devPath: `/dev/sr${String(index)}`,
            scsiHost: 29,
            scsiAddress: "29:0:0:0",
          },
          identity: {
            usbPortPath: `2-1.1.2.${String(slot)}`,
            bridgeSerial: null,
            hubPath: "2-1.1.2",
            hubChain: [],
            // What the drive says about ITSELF, which the
            // registry overrules — slots 2-4 are the reflashed
            // LGs.
            vendor: "ASUS",
            model: "BW-16D1HT",
            revision: "3.02",
            linkSpeed: 5_000,
          },
          media: {
            sizeSectors: isLoaded ? BLURAY_SECTORS : 0,
            hasMedia: isLoaded,
            capacityBytes: isLoaded
              ? BLURAY_SECTORS * 512
              : 0,
            discType: isLoaded
              ? ("bluray" as const)
              : ("none" as const),
          },
        }
      })
    : []

const towerRegistry = {
  towerRootPortPath: "2-1.1.2",
  entries: Array.from({ length: 9 }, (_unused, index) => {
    const slot = index + 1

    return {
      slot,
      // Prefixed, exactly as `config/drives.json` writes it.
      name: `0${String(slot)} - Pioneer BDR-211M`,
      firmwareSerial: `EXAMPLE97${String(slot)}WL`,
      trueModel: "Pioneer BDR-211M",
      reportedModel: "BW-16D1HT",
      usbPortPath: `2-1.1.2.${String(slot)}`,
      bridgeSerial: "",
      isUhdCapable: true,
      // Nobody has measured an offset on this tower yet.
      readOffsetSamples: null,
    }
  }),
}

/** Slots 7-9, held by the daemon that ran before this one. */
const heldLedger = {
  version: BAY_LEDGER_VERSION,
  records: [7, 8, 9].map((slot) => ({
    driveId: `2-1.1.2.${String(slot)}`,
    phase: "done" as const,
    sizeSectors: BLURAY_SECTORS,
    // v2 fields. The previous daemon read this name off the
    // disc and published the rip to this path, and the ledger
    // is the only thing that still knows either.
    discName: `TROY ${String(slot)}`,
    discType: "bluray" as const,
    destinationPath: `/media/Disc-Rips/[BACKUP] TROY ${String(slot)}`,
    // The capture id of the rip the PREVIOUS daemon ran. It is
    // what keeps the held card's log button after a restart.
    jobUuid: `0b1e5c7a-4d3f-42a8-9e6b-00000000000${String(slot)}`,
    outcome: {
      kind: "completed" as const,
      detail: `/media/Disc-Rips/[BACKUP] TROY ${String(slot)}`,
    },
    isLoadedDismissed: false,
    updatedAtMs: NOW_MS - 7_200_000,
  })),
  trayCommands: [],
  hasPriorState: true,
}

describe("the watcher, feeding the store", () => {
  const startFedWatcher = (input: {
    probeDrives: () => Promise<ProbedDrive[]>
  }) => {
    const store = createTowerStore()
    const feed = createTowerFeed({
      store,
      poster: createNullPosterStore(),
    })

    const watcher = startWatcher(
      {
        config: {
          destinationRoot: "/dev/null/dest",
          stateDir: "/dev/null/state",
          registryPath: "/dev/null/drives.json",
          makemkv: {
            command: "true",
            prefixArgs: [],
            wrapperArgs: null,
          },
          cyanrip: {
            command: "true",
            prefixArgs: [],
            wrapperArgs: null,
          },
          eject: { command: "true", prefixArgs: [] },
          isolation: null,
        },
        governor: createGovernor({ maxConcurrentRips: 9 }),
        // Long enough that only the ticks this test asks for
        // ever run.
        pollIntervalMs: 3_600_000,
        handlers: feed.handlers,
      },
      {
        probeDrives: input.probeDrives,
        loadRegistry: async () => towerRegistry,
        runBayRip: async () => {
          throw new Error(
            "a held disc must never start a rip",
          )
        },
        readLedger: async () => heldLedger,
        writeLedger: async () => {},
        appendHistory: async () => {},
        runTray: async () => ({
          isSuccessful: true,
          isCommandMissing: false,
          isTimedOut: false,
          exitCode: 0,
          detail: "opened",
        }),
        now: () => NOW_MS,
      },
    )

    feed.attachWatcher({
      getBays: watcher.getBays,
      getSightings: watcher.getBaySightings,
    })

    return { store, watcher }
  }

  it("serves the ⏏ toggle what it needs after a removal", async () => {
    // The whole chain, daemon-side: press ⏏ on a held bay, take
    // the disc out, and `/json` must still say rip-deck opened
    // that drawer. Those two fields together —
    // `disc_size_sectors: null` plus
    // `last_tray_command: "open_bay"` — are exactly what the
    // browser's `nextTrayCommandFor` turns into `close_bay`, and
    // serving neither is why the button only ever opened.
    let isLoaded = true

    const { store, watcher } = startFedWatcher({
      probeDrives: async () =>
        nineBayTower({ isPoweredOn: true }).map((drive) =>
          drive.identity.usbPortPath === "2-1.1.2.7" &&
          !isLoaded
            ? {
                ...drive,
                media: {
                  sizeSectors: 0,
                  hasMedia: false,
                  capacityBytes: 0,
                  discType: "none" as const,
                },
              }
            : drive,
        ),
    })

    await watcher.tickNow()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "open_bay",
        target: { driveId: "2-1.1.2.7" },
      },
    })

    expect(report.counts.opened).toBe(1)

    // The owner lifts the disc out; two empty readings re-arm
    // the bay, which rebuilds everything about the DISC.
    isLoaded = false
    await watcher.tickNow()
    await watcher.tickNow()

    const bay = buildTowerView({
      snapshot: store.readSnapshot(),
      nowMs: NOW_MS,
    }).bays[6]

    expect(bay.disc_size_sectors).toBeNull()
    expect(bay.last_tray_command).toBe("open_bay")
    // The other eight were never touched, and say so rather
    // than claiming a drawer state nobody asked for.
    expect(
      buildTowerView({
        snapshot: store.readSnapshot(),
        nowMs: NOW_MS,
      }).bays[0].last_tray_command,
    ).toBeNull()

    await watcher.stop()
  })

  it("⚠️ serves the new tray memory with NO tick in between", async () => {
    // The defect, and it is a race rather than a wrong value:
    // the roster only reached the store on `onTickComplete`, so
    // for up to a whole poll `/json` described the tray memory
    // from BEFORE the press. The dashboard refetches the instant
    // its POST resolves — always inside that window — so the ⏏
    // toggle kept offering `open_bay` on a drawer rip-deck had
    // just opened, and pressing it opened an already-open tray:
    // the owner, 2026-08-20, "I clicked eject, and it should
    // close it, but it's not."
    const { store, watcher } = startFedWatcher({
      probeDrives: async () =>
        nineBayTower({ isPoweredOn: true }),
    })

    await watcher.tickNow()

    const report = await watcher.runTrayCommand({
      request: {
        kind: "open_bay",
        target: { driveId: "2-1.1.2.7" },
      },
    })

    expect(report.counts.opened).toBe(1)

    // ⚠️ NO `tickNow()` here, deliberately. This is the state the
    // browser reads a few milliseconds after the button press.
    expect(
      buildTowerView({
        snapshot: store.readSnapshot(),
        nowMs: NOW_MS,
      }).bays[6].last_tray_command,
    ).toBe("open_bay")

    // And the second press closes, which is the whole of the
    // toggle: same absence of a tick, opposite answer.
    await watcher.runTrayCommand({
      request: {
        kind: "close_bay",
        target: { driveId: "2-1.1.2.7" },
      },
    })

    expect(
      buildTowerView({
        snapshot: store.readSnapshot(),
        nowMs: NOW_MS,
      }).bays[6].last_tray_command,
    ).toBe("close_bay")

    await watcher.stop()
  })

  it("retires a dismissed finished card even when the drive says it has media", async () => {
    const { store, watcher } = startFedWatcher({
      probeDrives: async () =>
        nineBayTower({ isPoweredOn: true }),
    })

    await watcher.tickNow()

    await watcher.runTrayCommand({
      request: { kind: "clear_loaded" },
    })

    const view = buildTowerView({
      snapshot: store.readSnapshot(),
      nowMs: NOW_MS,
    })

    // The drives keep reporting the old disc after the operator has taken it
    // out. The card must respect the explicit operator action instead of
    // leaving an unremovable failed rip on the dashboard.
    expect(
      view.bays.filter((bay) => bay.state.state !== "idle"),
    ).toHaveLength(0)

    await watcher.stop()
  })

  it("renders nine bays for a nine-bay tower", async () => {
    // Live 0.4.0: `drive_count: 3`, against a console that had
    // just printed "9 drive(s) present."
    let isPoweredOn = true

    const { store, watcher } = startFedWatcher({
      probeDrives: async () =>
        nineBayTower({ isPoweredOn }),
    })

    await watcher.tickNow()

    const snapshot = store.readSnapshot()

    expect(snapshot.bays).toHaveLength(9)
    expect(snapshot.bays.map((bay) => bay.slot)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])

    // Every one of them named and addressable, from the
    // registry — never the drive's self-reported ASUS.
    expect(snapshot.bays[6]).toMatchObject({
      label: "07 - Pioneer BDR-211M",
      devPath: "/dev/sr6",
      vendor: "Pioneer",
      model: "BDR-211M",
      serial: "EXAMPLE977WL",
      isPresent: true,
    })

    // The three held discs, as held discs.
    for (const bay of snapshot.bays.slice(6)) {
      expect(bay.job?.state).toBe("completed")
      expect(bay.job?.isAdopted).toBe(true)
      expect(bay.discSizeSectors).toBe(BLURAY_SECTORS)
      expect(bay.job?.verdict.evidence[0]).toContain("TROY")
    }

    // Named, and pointing at their folders. Both come off the
    // ledger as FIELDS — nothing here parses the outcome
    // sentence, which is the `MSG:5072` mistake.
    expect(snapshot.bays[6].job?.identity).toMatchObject({
      title: "TROY 7",
      volumeLabel: "TROY 7",
      // Read off the media, not looked up anywhere.
      source: "disc",
      // `decideDiscType`'s answer, carried by the ledger — the
      // same decision that chose MakeMKV over cyanrip for it.
      // Still never a guess: a bay nothing typed reads
      // `"unknown"`.
      discType: "bluray",
      year: null,
      posterUrl: null,
    })
    expect(snapshot.bays[6].job?.destinationPath).toBe(
      "/media/Disc-Rips/[BACKUP] TROY 7",
    )

    // The capture the previous daemon wrote. Without it this
    // adopted bay falls back to `<driveId>@<ms>`, `armView`
    // refuses to name a file from that, and the card loses its
    // log button on every restart.
    expect(snapshot.bays[6].job?.id).toBe(
      "0b1e5c7a-4d3f-42a8-9e6b-000000000007",
    )

    // Which is the point, said at the surface the dashboard
    // actually reads. `isSafeJobUuid` is structural — a real
    // capture is named for a UUID and the placeholder
    // deliberately is not — so nothing in the API had to change
    // for this to start working.
    const armRips = buildArmState({ snapshot }).hosts[0]
      .rips

    expect(armRips).toHaveLength(3)
    expect(
      armRips.every((rip) => rip.logfile !== null),
    ).toBe(true)

    // And the tray half of `/json`, which is the same builder
    // MQTT publishes: a held disc must not read as an empty bay.
    const view = buildTowerView({ snapshot, nowMs: NOW_MS })

    expect(view.bays[6].state).toMatchObject({
      has_disc: true,
      is_holding_finished_disc: true,
      is_adopted: true,
      disc_name: "TROY 7",
      destination_path: "/media/Disc-Rips/[BACKUP] TROY 7",
    })
    // Nothing has moved this drawer, so the ⏏ toggle opens.
    expect(view.bays[6].last_tray_command).toBeNull()

    // And the six empty ones are empty, not held.
    for (const bay of snapshot.bays.slice(0, 6)) {
      expect(bay.job).toBeNull()
      expect(bay.discSizeSectors).toBeNull()
    }

    // The tower goes off, which the owner does independently of
    // this service (F3).
    isPoweredOn = false
    await watcher.tickNow()

    expect(
      store
        .readSnapshot()
        .bays.every((bay) => bay.isPresent),
    ).toBe(false)

    await watcher.stop()
  })
})

describe("the fed store, served", () => {
  let close: (() => Promise<void>) | null = null

  afterEach(async () => {
    await close?.()
    close = null
  })

  it("reaches GET /json over a real socket", async () => {
    // The end of the wire this whole unit exists to connect: a
    // watcher event goes in, and the ARM viewer's document comes
    // out of a port.
    const harness = createHarness({
      bays: fakeBays([{ phase: "ripping" }]),
    })

    const server = createApiServer({
      readSnapshot: harness.store.readSnapshot,
      // Port 0 — the OS picks, so a developer already running
      // the daemon does not fail the suite.
      port: 0,
      host: "127.0.0.1",
      readNowMs: () => NOW_MS,
    })

    const { port } = await server.listen()
    close = server.close

    harness.handlers.onBayProgress?.({
      ...bayEvent,
      progress: { ...EMPTY_PROGRESS, totalFraction: 0.43 },
    })

    const document = (await (
      await fetch(`http://127.0.0.1:${port}/json`)
    ).json()) as RipDeckJsonDocument

    const rip = document.hosts[0].rips[0]

    expect(rip.job_uuid).toBe(JOB_UUID)
    expect(rip.status).toBe("ripping")
    expect(rip.percent).toBe(43)
    expect(rip.drive_name).toBe("02 - Pioneer BDR-211M")
    expect(rip.verdict).toBe("unknown")
    expect(document.ripDeck.bays).toHaveLength(1)
  })

  it("serves an adopted disc's name and folder", async () => {
    // End to end, over a socket, because that is where the
    // defect was visible: the owner's dashboard showed the BAY
    // label where the disc name belongs and rendered the
    // destination as health evidence. Both are ordinary fields
    // of the document now.
    const harness = createHarness({
      bays: fakeBays([
        {
          phase: "done",
          jobUuid: null,
          isAdopted: true,
          latchedAtMs: NOW_MS - 7_200_000,
          sizeSectors: 48_000_000,
          discName: "TROY - THEATRICAL CUT",
          destinationPath: "/media/Disc-Rips/[BACKUP] TROY",
          outcome: outcome(
            "completed",
            "/media/Disc-Rips/[BACKUP] TROY",
          ),
        },
      ]),
      sightings: fakeSightings([{}]),
    })

    const server = createApiServer({
      readSnapshot: harness.store.readSnapshot,
      port: 0,
      host: "127.0.0.1",
      readNowMs: () => NOW_MS,
    })

    const { port } = await server.listen()
    close = server.close

    harness.handlers.onTickComplete?.()

    const document = (await (
      await fetch(`http://127.0.0.1:${port}/json`)
    ).json()) as RipDeckJsonDocument

    const rip = document.hosts[0].rips[0]

    expect(rip.label).toBe("TROY - THEATRICAL CUT")
    expect(rip.volume_label).toBe("TROY - THEATRICAL CUT")
    expect(rip.path).toBe("/media/Disc-Rips/[BACKUP] TROY")
    // The bay label is still there, as the DRIVE's name. The
    // bug was the disc borrowing it.
    expect(rip.drive_name).toBe("02 - Pioneer BDR-211M")
  })
})

/**
 * The gate, from the dashboard's side.
 *
 * `health/corpus.test.ts` proves the counting. This proves the
 * consequence: what a card carries on each side of the switch,
 * and that opening it can never put an announceable verdict on
 * the wire.
 *
 * The corpus is a real temporary directory with a real feature
 * vector in it, and `minJobCount: 1` stands in for the production
 * 30. Faking the gate would have tested a mock of the one
 * mechanism these tests exist to check.
 */
describe("showing the health engine's answer", () => {
  let corpusDir = ""

  beforeEach(async () => {
    corpusDir = await mkdtemp(
      join(tmpdir(), "rip-deck-feed-corpus-"),
    )

    resetHealthGate()
  })

  afterEach(async () => {
    await rm(corpusDir, { recursive: true, force: true })

    resetHealthGate()
  })

  /** One rip that went badly — enough to earn the gate. */
  const seedCorpus = async (): Promise<void> => {
    await writeFile(
      join(corpusDir, "job-1.features.json"),
      JSON.stringify({
        schemaVersion: 1,
        readErrorCount: 4,
        ioErrorTotalDelta: 2,
        outcome: {
          isSuccessful: false,
          failureReason: "read_errors",
          exitCode: 1,
          verdictKind: null,
        },
      }),
      "utf8",
    )

    await refreshHealthGate({
      stateDir: corpusDir,
      minJobCount: 1,
    })
  }

  /** A store that already holds one answer, as if read. */
  const storeHolding = (
    verdict: Verdict,
  ): ComputedVerdictStore => ({
    request: () => {},
    get: () => verdict,
  })

  const finish = (harness: {
    handlers: WatcherHandlers
  }): void => {
    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "failed",
        "empty_output (makemkvcon exited 0)",
      ),
    })
  }

  it("keeps a saved verdict off the card while the gate is shut", () => {
    const harness = createHarness({
      verdicts: storeHolding(
        makeVerdict("disc_scratched", "suspected", [
          "Errors in one band.",
        ]),
      ),
    })

    finish(harness)

    const verdict = harness.readBay()?.job?.verdict

    // The engine judged this rip and the answer is on disk. With
    // three rips of corpus behind it, showing "source another
    // copy" would be a guess wearing a finding's clothes.
    expect(verdict?.kind).toBe("unknown")
    // The rip's own sentence survives either way — it is the one
    // line that names what actually happened.
    expect(verdict?.evidence).toEqual([
      "empty_output (makemkvcon exited 0)",
    ])
  })

  it("shows it once the corpus has earned it", async () => {
    await seedCorpus()

    const harness = createHarness({
      verdicts: storeHolding(
        makeVerdict("disc_dirty", "suspected", [
          "Errors scattered across the disc.",
        ]),
      ),
    })

    finish(harness)

    const verdict = harness.readBay()?.job?.verdict

    expect(verdict?.kind).toBe("disc_dirty")
    expect(verdict?.action).toBe("clean_disc")
    // The engine's reasoning first, then what the rip did. The
    // card prints the detail lines under the message, so the
    // other order would put the outcome above its own verdict's
    // reasons.
    expect(verdict?.evidence).toEqual([
      "Errors scattered across the disc.",
      "empty_output (makemkvcon exited 0)",
    ])
  })

  it("never lets an open gate produce an announceable verdict", async () => {
    await seedCorpus()

    const harness = createHarness({
      verdicts: storeHolding(
        makeVerdict("key_expired", "confirmed", [
          "MakeMKV reported D8.",
        ]),
      ),
    })

    finish(harness)

    const verdict = harness.readBay()?.job?.verdict

    // ⚠️ The load-bearing one. The gate opens on FILE COUNTS, so
    // the thresholds behind this verdict are still invented at
    // the instant it opens. `isAnnounceable` asks for exactly
    // one property, and `hedged` takes it away — so a verdict
    // published by the automatic gate can be read and can never
    // wake the house.
    expect(verdict?.kind).toBe("key_expired")
    expect(verdict?.confidence).toBe("suspected")
    expect(isAnnounceable(verdict as Verdict)).toBe(false)
  })

  it("falls back to unknown when no answer was saved", async () => {
    await seedCorpus()

    const harness = createHarness({
      verdicts: createNullComputedVerdictStore(),
    })

    finish(harness)

    // An open gate is permission, not an answer. A rip still
    // running, an adopted disc from before capture existed, or a
    // write that failed all land here.
    expect(harness.readBay()?.job?.verdict.kind).toBe(
      "unknown",
    )
  })

  it("asks for the file only once the bay has an outcome", () => {
    const request = vi.fn()

    const harness = createHarness({
      verdicts: { request, get: () => null },
    })

    harness.handlers.onBayProgress?.({
      ...bayEvent,
      progress: { ...EMPTY_PROGRESS, totalFraction: 0.2 },
    })

    // Nothing has been written yet, and nine bays asking every
    // five seconds for the length of every rip is nine misses a
    // poll for hours.
    expect(request).not.toHaveBeenCalled()

    finish(harness)

    expect(request).toHaveBeenCalled()
  })
})

describe("an empty tray retires the finished card", () => {
  /**
   * Measured on the tower 2026-08-27, with every tray empty.
   *
   * the `size` attribute under `/sys/block` read the 2097151-sector empty
   * sentinel on all nine drives, and `/json` agreed —
   * `has_disc: false`, `disc_size_sectors: null`. Slots 1-4
   * still published `needs_attention` and slots 8-9 still
   * published `completed`, each with its job id, its progress,
   * and on slot 8 a health ALERT about a disc that had been
   * taken out of the building.
   *
   * The bays that behaved are the tell: slots 5-7 read `idle`,
   * and those are exactly the bays whose last outcome came from
   * startup ADOPTION, which emits a note and never an outcome.
   * No outcome event, no record left to go stale.
   */
  const ripAndEmptyTheTray = (harness: {
    handlers: WatcherHandlers
    setBays: (next: BayState[]) => void
  }): void => {
    // The rip lands. This is the event that creates the record
    // the whole defect lives in — adoption never fires it.
    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "completed",
        "/media/Disc-Rips/[BACKUP] TROY",
      ),
    })

    // The disc comes out, and the watcher re-arms: `rearm`
    // clears the bay's own outcome, so the record is the only
    // reader still claiming a disc.
    harness.setBays(
      fakeBays([
        {
          phase: "idle",
          jobUuid: null,
          outcome: undefined,
        },
      ]),
    )
  }

  it("clears a completed card once the disc is taken out", () => {
    const harness = createHarness({
      sightings: fakeSightings([{}]),
    })

    ripAndEmptyTheTray(harness)
    harness.handlers.onTickComplete?.()

    // No disc, so no job. This is the assertion the live tower
    // failed: it answered `completed` with the tray empty.
    expect(harness.readBay()?.job).toBeFalsy()
  })

  it("clears a needs_attention card the same way", () => {
    const harness = createHarness({
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "needs_attention",
        "could not read a name off this disc",
      ),
    })

    harness.setBays(
      fakeBays([{ phase: "idle", jobUuid: null }]),
    )
    harness.handlers.onTickComplete?.()

    // Four bays sat here for hours asking the owner to name a
    // disc that was not in the tower.
    expect(harness.readBay()?.job).toBeFalsy()
  })

  it("KEEPS the card while the finished disc is still in the tray", () => {
    // The reason the record outlives its outcome at all, and it
    // must survive this fix: a finished disc sitting in a tray
    // is what the eject button acts on.
    const harness = createHarness({
      sightings: fakeSightings([{}]),
    })

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "completed",
        "/media/Disc-Rips/[BACKUP] TROY",
      ),
    })

    harness.setBays(
      fakeBays([
        {
          phase: "done",
          jobUuid: null,
          sizeSectors: 48_000_000,
        },
      ]),
    )
    harness.handlers.onTickComplete?.()

    expect(harness.readBay()?.job?.state).toBe("completed")
  })

  it("KEEPS the card while the drive is off the bus", () => {
    // A powered-off tower must not wipe the rack. The poll loop
    // HOLDS a drive it cannot see rather than deciding about it,
    // so the phase never reaches `idle` — this asserts the feed
    // does not second-guess that.
    const harness = createHarness({
      sightings: fakeSightings([{ isDrivePresent: false }]),
    })

    harness.handlers.onBayOutcome?.({
      ...bayEvent,
      outcome: outcome(
        "completed",
        "/media/Disc-Rips/[BACKUP] TROY",
      ),
    })

    harness.setBays(
      fakeBays([
        {
          phase: "done",
          jobUuid: null,
          sizeSectors: 48_000_000,
        },
      ]),
    )
    harness.handlers.onTickComplete?.()

    expect(harness.readBay()?.job?.state).toBe("completed")
  })
})

describe("hasBayReArmed", () => {
  const bayWith = (input: Partial<BayState>): BayState => ({
    ...createBayState({ driveId: DRIVE_ID, atMs: NOW_MS }),
    ...input,
  })

  it("is true for an idle bay with no disc", () => {
    expect(
      hasBayReArmed(
        bayWith({ phase: "idle", sizeSectors: null }),
      ),
    ).toBe(true)
  })

  it("is false for a bay holding a finished disc", () => {
    expect(
      hasBayReArmed(
        bayWith({ phase: "done", sizeSectors: 48_000_000 }),
      ),
    ).toBe(false)
  })

  it("is false mid-rip", () => {
    expect(
      hasBayReArmed(
        bayWith({
          phase: "ripping",
          sizeSectors: 48_000_000,
        }),
      ),
    ).toBe(false)
  })

  it("is false for an idle bay that still reports a size", () => {
    // Belt and braces on the `no_media` latch instant, where
    // `applyBayOutcome` sets `phase: "idle"` itself. The size is
    // nulled in the same object, so this pairing should not
    // arise — and if it ever does, a disc the drive can still
    // measure is not an empty tray.
    expect(
      hasBayReArmed(
        bayWith({ phase: "idle", sizeSectors: 48_000_000 }),
      ),
    ).toBe(false)
  })
})
