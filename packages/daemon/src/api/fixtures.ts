import {
  createSupervisionState,
  type DiscType,
  EMPTY_PROGRESS,
  type Job,
  type JobProgress,
  type JobState,
  makeVerdict,
  type VerdictConfidence,
  type VerdictKind,
} from "@rip-deck/contracts"
import { UNKNOWN_AT_STARTUP_DETAIL } from "../rip/bayLedger.ts"
import {
  type BaySnapshot,
  createBaySnapshot,
  createTowerSnapshot,
  type TowerSnapshot,
} from "./snapshot.ts"

/**
 * Server-side fixtures for `GET /json?fake=<name>`.
 *
 * Resolved in the API, following the house precedent: mux-magic's
 * dry-run is a server-side `?fake=` in its Hono API, not a
 * browser mock. This deliberately does NOT settle the open
 * question of whether the eventual UI uses MSW — it is a backend
 * the dashboard can point at today, with `is_fake: true` on every
 * response so a fixture can never be mistaken for the rack.
 *
 * The scenarios are not decoration. They are the states that are
 * the REASON rip-deck exists, and every one of them is something
 * the tower has actually done or is expected to do:
 *
 *  - `disc_dirty` vs `disc_scratched` — the same symptom with
 *    opposite advice ("clean it" vs "source another copy"), and
 *    getting that wrong is how a tool loses the owner's trust.
 *  - a `hub_fault` across several bays, which must read as ONE
 *    problem with the hub rather than several bad discs.
 *  - `suspected` vs `confirmed`, the two-drive rule made visible.
 *  - a RISING ETA, which is a signal and not a cosmetic annoyance.
 *  - a quarantined drive with its clear control, because
 *    quarantine is never self-healing.
 *  - ZERO drives present, which is a normal state (F3) — the
 *    tower is switched off — and must not paint the rack red.
 *  - discs HELD at startup beside a genuinely failed rip, which
 *    is the state the owner's tower woke up in on 2026-07-26 and
 *    the pair the dashboard most has to keep apart.
 */

const bayLabel = (slot: number): string =>
  `${String(slot).padStart(2, "0")} - Pioneer BDR-211M`

const bayDriveId = (slot: number): string =>
  `usb-2-1-1-2-4-4-${slot}`

const buildFixtureJob = (input: {
  slot: number
  nowMs: number
  state?: JobState
  title?: string
  discType?: DiscType
  verdictKind?: VerdictKind
  confidence?: VerdictConfidence
  evidence?: string[]
  progress?: Partial<JobProgress>
  readErrorCount?: number
  /** Sentences a `completed` rip carries anyway. */
  warnings?: string[]
  elapsedMs?: number
  /**
   * Adopted from the bay ledger rather than watched.
   *
   * It DOES have a name and a destination: the bay ledger (v2)
   * carries `discName` and `destinationPath` as fields, so
   * `towerFeed.buildJob` passes both through for a held disc.
   * What it does not have is a disc TYPE — nothing recorded
   * one — so the identity here is shaped exactly as `buildJob`
   * builds it, `source: "disc"` and `discType: "unknown"`
   * included. A fixture that gave an adopted bay a `bluray` and
   * a poster would be testing a rack that does not exist.
   */
  isAdopted?: boolean
}): Job => {
  const {
    slot,
    nowMs,
    state = "ripping",
    title = "Ivanhoe",
    discType = "bluray",
    verdictKind = "ok",
    confidence = "suspected",
    evidence = [],
    progress = {},
    readErrorCount = 0,
    warnings = [],
    elapsedMs = 8 * 60_000,
    isAdopted = false,
  } = input

  return {
    id: `fixture-job-${slot}`,
    driveId: bayDriveId(slot),
    state,
    startedAt: nowMs - elapsedMs,
    finishedAt:
      state === "completed" ||
      state === "failed" ||
      state === "cancelled"
        ? nowMs
        : null,
    identity: isAdopted
      ? {
          title,
          // Nothing looked this disc up: the ledger kept the
          // volume label and no more.
          year: null,
          discType: "unknown",
          source: "disc",
          posterUrl: null,
          volumeLabel: title,
          discNumber: null,
          discTotal: null,
        }
      : {
          title,
          year: 1952,
          discType,
          source: "tmdb",
          posterUrl: null,
          volumeLabel: title
            .toUpperCase()
            .replace(/ /g, "_"),
          discNumber: null,
          discTotal: null,
        },
    progress: {
      ...EMPTY_PROGRESS,
      totalFraction: 0.43,
      currentFraction: 0.61,
      totalLabel: "Backing up disc",
      currentLabel: "Saving file 3 of 78",
      bytesWritten: 14_000_000_000,
      throughputBytesPerSec: 21 * 1024 * 1024,
      etaSeconds: 900,
      etaTrend: "falling",
      ...progress,
    },
    verdict: makeVerdict(verdictKind, confidence, evidence),
    failureReason:
      state === "failed" ? "read_errors" : null,
    // Set for an adopted bay too, like `towerFeed.buildJob`:
    // the ledger records where the previous daemon's rip
    // landed, folder marker and all.
    destinationPath: isAdopted
      ? `/media/Disc-Rips/[BACKUP] ${title}`
      : `/media/Disc-Rips/${title}`,
    readErrorCount,
    warnings,
    isAdopted,
    isKeepTryingRequested: false,
  }
}

const buildFixtureBay = (input: {
  slot: number
  job?: Job | null
  isQuarantined?: boolean
  quarantineReason?: string | null
}): BaySnapshot => {
  const supervision = createSupervisionState(
    bayDriveId(input.slot),
  )

  return createBaySnapshot({
    driveId: bayDriveId(input.slot),
    label: bayLabel(input.slot),
    slot: input.slot,
    devPath: `/dev/sr${9 - input.slot}`,
    vendor: "PIONEER",
    model: "BD-RW BDR-211M",
    serial: `FIXTURE00${input.slot}`,
    job: input.job ?? null,
    supervision: input.isQuarantined
      ? {
          ...supervision,
          restartCount: 3,
          isQuarantined: true,
          quarantineReason:
            input.quarantineReason ??
            "Crashed 3 times without staying up.",
        }
      : supervision,
  })
}

/** Every bay idle, so a scenario only has to name its outliers. */
const buildIdleBays = (slots: number[]): BaySnapshot[] =>
  slots.map((slot) => buildFixtureBay({ slot }))

const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

const buildEmptyTower = (): TowerSnapshot =>
  // F3. Not an error, not an empty-state apology: the owner
  // switched the tower off, which is how he uses it.
  createTowerSnapshot({ isMqttEnabled: true })

const buildNineRips = (nowMs: number): TowerSnapshot =>
  createTowerSnapshot({
    isMqttEnabled: true,
    bays: ALL_SLOTS.map((slot) =>
      buildFixtureBay({
        slot,
        job: buildFixtureJob({
          slot,
          nowMs,
          title: `Fixture Disc ${slot}`,
          elapsedMs: slot * 90_000,
          progress: {
            totalFraction: slot / 10,
            etaSeconds: 3_600 - slot * 300,
          },
        }),
      }),
    ),
  })

/** One bay per verdict kind, every card the UI must render. */
const buildVerdicts = (nowMs: number): TowerSnapshot => {
  const kinds: VerdictKind[] = [
    "ok",
    "disc_dirty",
    "disc_read_error",
    "disc_scratched",
    "disc_marginal_slow",
    "drive_failing",
    "enumeration_flap",
    "key_expired",
    "hub_fault",
    "unknown",
  ]

  return createTowerSnapshot({
    isMqttEnabled: true,
    bays: kinds.map((kind, index) =>
      buildFixtureBay({
        slot: index + 1,
        job: buildFixtureJob({
          slot: index + 1,
          nowMs,
          title: `Fixture ${kind}`,
          verdictKind: kind,
          confidence:
            kind === "ok" ? "suspected" : "confirmed",
          evidence:
            kind === "ok"
              ? []
              : [`Fixture evidence for ${kind}`],
          readErrorCount:
            kind === "disc_read_error"
              ? 1
              : kind === "disc_dirty" ||
                  kind === "disc_scratched"
                ? 12
                : 0,
        }),
      }),
    ),
  })
}

/**
 * A hub fault across four bays.
 *
 * Every affected bay carries the SAME hub verdict — not four
 * disc verdicts. Telling the owner to clean four discs because
 * a hub lost power is the confidently-wrong alert the verdict
 * model exists to prevent, and the tower view must group these
 * into one alert.
 */
const buildHubFault = (nowMs: number): TowerSnapshot => {
  const faultedSlots = [4, 5, 6, 7]

  return createTowerSnapshot({
    isMqttEnabled: true,
    bays: ALL_SLOTS.map((slot) =>
      faultedSlots.includes(slot)
        ? buildFixtureBay({
            slot,
            job: buildFixtureJob({
              slot,
              nowMs,
              state: "stalled",
              title: `Fixture Disc ${slot}`,
              verdictKind: "hub_fault",
              confidence: "confirmed",
              evidence: [
                "4 drives under hub 2-1.1.2.4 stopped " +
                  "together within 60s",
              ],
              progress: {
                etaSeconds: null,
                etaTrend: null,
              },
            }),
          })
        : buildFixtureBay({ slot }),
    ),
  })
}

/**
 * The two-drive rule, made visible.
 *
 * Bay 2 saw a dirty disc once — `suspected`, so it renders a
 * card and offers "retry in another drive". Bay 8 is the second
 * drive that agreed, so the same verdict is `confirmed` there,
 * and only that one may announce.
 */
const buildConfidence = (nowMs: number): TowerSnapshot =>
  createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      ...buildIdleBays([1]),
      buildFixtureBay({
        slot: 2,
        job: buildFixtureJob({
          slot: 2,
          nowMs,
          title: "Ivanhoe",
          verdictKind: "disc_dirty",
          confidence: "suspected",
          evidence: ["Errors scattered across 9 regions"],
          readErrorCount: 9,
        }),
      }),
      ...buildIdleBays([3, 4, 5, 6, 7]),
      buildFixtureBay({
        slot: 8,
        job: buildFixtureJob({
          slot: 8,
          nowMs,
          title: "Ivanhoe",
          verdictKind: "disc_dirty",
          confidence: "confirmed",
          evidence: [
            "Errors scattered across 11 regions",
            "Second drive agrees — the disc, not the drive",
          ],
          readErrorCount: 11,
        }),
      }),
      ...buildIdleBays([9]),
    ],
  })

/**
 * A rising ETA.
 *
 * A signal in its own right (C6): the same d(progress)/dt
 * collapse the health engine watches, visible to the owner
 * before the rip fails. The bay is NOT failed and NOT alarmed —
 * a rising ETA on a healthy disc happens, so the card shows the
 * trend and the verdict stays `ok`.
 */
const buildRisingEta = (nowMs: number): TowerSnapshot =>
  createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      ...buildIdleBays([1, 2]),
      buildFixtureBay({
        slot: 3,
        job: buildFixtureJob({
          slot: 3,
          nowMs,
          title: "Ivanhoe",
          progress: {
            totalFraction: 0.11,
            etaSeconds: 5_400,
            etaTrend: "rising",
            throughputBytesPerSec: 15.5 * 1024 * 1024,
          },
        }),
      }),
      ...buildIdleBays([4, 5, 6, 7, 8, 9]),
    ],
  })

/**
 * A quarantined drive.
 *
 * Out of service until a human clears it — deliberately not
 * self-healing, because an automatic un-quarantine re-enters the
 * same crash loop later, at night, with nobody watching. The bay
 * therefore always offers `clear_quarantine`.
 */
const buildQuarantined = (nowMs: number): TowerSnapshot =>
  createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      ...buildIdleBays([1, 2, 3, 4]),
      buildFixtureBay({
        slot: 5,
        isQuarantined: true,
        quarantineReason:
          "Crashed 3 times without staying up. Taken out of " +
          "service — clear it once the drive has been looked " +
          "at.",
      }),
      buildFixtureBay({
        slot: 6,
        job: buildFixtureJob({
          slot: 6,
          nowMs,
          title: "Fixture Disc 6",
        }),
      }),
      ...buildIdleBays([7, 8, 9]),
    ],
  })

/**
 * Three discs held at startup, and one that actually failed.
 *
 * ⚠️ This is not a hypothetical. It is the exact state of the
 * owner's tower on 2026-07-26: `rip-deck:0.4.0` came up with the
 * three Troy discs still in slots 7–9, found no `bays.json`, and
 * took `adoptBayAtStartup`'s fail-closed branch on all three —
 * `phase: "done"`, `outcome.kind: "needs_attention"`, carrying
 * `UNKNOWN_AT_STARTUP_DETAIL`. That is the intended outcome; it
 * is what stopped 225 GB of duplicate ripping
 * (`docs/eject-and-durable-bay-state.md` §5).
 *
 * Slot 1 carries a genuinely FAILED rip on purpose. The two
 * states are the pair the dashboard most has to keep apart, and
 * a fixture that only contains one of them proves nothing about
 * whether they read differently: "this disc failed to rip" wants
 * another copy of the disc, while "rip-deck does not know whether
 * this was ripped, so it did not" wants a button press.
 *
 * The verdict on a held bay is `unknown` / `suspected` because
 * that is what `towerFeed.buildVerdict` stamps on a bay no
 * health engine judged — never `confirmed`, since only a
 * confirmed verdict may announce, and announcing a verdict
 * nothing computed is the confidently-wrong alert the whole
 * model exists to prevent.
 */
const buildHeldAtStartup = (
  nowMs: number,
): TowerSnapshot => {
  const heldDiscs: {
    slot: number
    title: string
    discType: DiscType
  }[] = [
    {
      slot: 7,
      title: "TROY - BONUS DISC",
      discType: "bluray",
    },
    {
      slot: 8,
      title: "TROY - DIRECTOR'S CUT",
      discType: "uhd",
    },
    {
      slot: 9,
      title: "TROY - THEATRICAL CUT",
      discType: "uhd",
    },
  ]

  return createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      buildFixtureBay({
        slot: 1,
        job: buildFixtureJob({
          slot: 1,
          nowMs,
          state: "failed",
          title: "Fixture Scratched Disc",
          verdictKind: "disc_scratched",
          confidence: "confirmed",
          evidence: [
            "Errors concentrated in one continuous band",
          ],
          readErrorCount: 41,
          progress: {
            totalFraction: 0.62,
            etaSeconds: null,
            etaTrend: null,
            throughputBytesPerSec: null,
          },
        }),
      }),
      ...buildIdleBays([2, 3, 4, 5, 6]),
      ...heldDiscs.map(({ slot, title, discType }) =>
        buildFixtureBay({
          slot,
          job: buildFixtureJob({
            slot,
            nowMs,
            state: "needs_attention",
            title,
            discType,
            verdictKind: "unknown",
            confidence: "suspected",
            evidence: [UNKNOWN_AT_STARTUP_DETAIL],
            // Nothing ran, so there are no numbers. A held bay
            // showing 43% and "~15m left" would be a card
            // describing a rip that never started.
            progress: {
              totalFraction: 0,
              currentFraction: 0,
              totalLabel: null,
              currentLabel: null,
              bytesWritten: 0,
              throughputBytesPerSec: null,
              etaSeconds: null,
              etaTrend: null,
            },
            elapsedMs: 0,
          }),
        }),
      ),
    ],
  })
}

/**
 * Three rips that FINISHED, and that nothing measured.
 *
 * ⚠️ This is the live rack, 2026-07-26, `rip-deck:0.5.0`. The
 * owner's three Troy discs are 225 GB of successful, verified
 * backups adopted from the bay ledger, and the dashboard
 * presented them as a fault: a full-width red banner, a yellow
 * "needs attention" heading, and a **Retry in another drive**
 * button on each — an invitation to re-rip the exact discs the
 * ledger exists to protect.
 *
 * The conflation was `verdict !== "ok"` meaning trouble.
 * `towerFeed` stamps `unknown` on every bay it did not measure,
 * and its header explains at length why `ok` there would be a
 * lie. `unknown` means "nothing judged this rip" — a statement
 * about rip-deck's instrumentation, not about the disc.
 *
 * So this scenario exists to hold that line. A `completed` job
 * must read as completed whatever its verdict: calm, out of the
 * attention bucket, no banner, no re-rip control.
 *
 * These bays are `isAdopted` and they are NAMED. That is the
 * second half of the same defect: the cards used to fall back to
 * the bay label because `identity` was null, so the owner's
 * three Troy discs read as "07 - Pioneer BDR-211M". The bay
 * ledger carries the disc name and the destination as fields
 * now, so an adopted bay has both — with no disc type, no year
 * and no poster, because nothing looked this disc up.
 */
const buildUnmeasured = (nowMs: number): TowerSnapshot => {
  const adoptedDiscs = [
    { slot: 7, title: "TROY - BONUS DISC" },
    { slot: 8, title: "TROY - DIRECTOR'S CUT" },
    { slot: 9, title: "TROY - THEATRICAL CUT" },
  ]

  return createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      ...buildIdleBays([1, 2, 3, 4, 5, 6]),
      ...adoptedDiscs.map(({ slot, title }) =>
        buildFixtureBay({
          slot,
          job: buildFixtureJob({
            slot,
            nowMs,
            state: "completed",
            title,
            isAdopted: true,
            verdictKind: "unknown",
            confidence: "suspected",
            // The bay's own outcome sentence, and nothing
            // else. The second line here used to explain that
            // the health engine did not run — it does, and its
            // answer is shown once `health/publish.ts` counts
            // enough corpus to allow it. A note about
            // rip-deck's build state was never a fact about
            // these discs.
            evidence: [
              "held on startup: the bay ledger already had " +
                "this disc",
            ],
            progress: {
              totalFraction: 1,
              // An adopted bay's progress is whatever the
              // ledger recorded, and it recorded no stage.
              // Leaving the default in would put "Saving file
              // 3 of 78" on a rip that finished last night.
              currentLabel: null,
              totalLabel: null,
              throughputBytesPerSec: null,
              etaSeconds: null,
              etaTrend: null,
            },
          }),
        }),
      ),
    ],
  })
}

/**
 * A flapping USB bus, with the two discs it held.
 *
 * The banner has to show ABOVE the held cards, so this fixture
 * pairs an unstable `usbStability` with two held bays — the exact
 * shape that would otherwise let the flap hide behind its own
 * symptom if it rode the per-bay `alerts` list. `buildTowerView`
 * turns `usbStability` into the `usb_alert` banner; the held bays
 * come from the same path as `held-at-startup`.
 */
const buildUsbFlap = (nowMs: number): TowerSnapshot => {
  const heldSlots = [7, 8]

  return createTowerSnapshot({
    isMqttEnabled: true,
    usbStability: {
      isUnstable: true,
      flappingDriveIds: heldSlots.map(bayDriveId),
      transitionCount: 11,
    },
    bays: [
      ...buildIdleBays([1, 2, 3, 4, 5, 6, 9]),
      ...heldSlots.map((slot) =>
        buildFixtureBay({
          slot,
          job: buildFixtureJob({
            slot,
            nowMs,
            state: "needs_attention",
            title: `Fixture Held Disc ${slot}`,
            verdictKind: "unknown",
            confidence: "suspected",
            evidence: [
              "could not read a name off this disc — the bus " +
                "was flapping when it was read.",
            ],
          }),
        }),
      ),
    ],
  })
}

/**
 * Pass, warning and fail, side by side.
 *
 * The three states of a finished rip, in one rack, because they
 * are only judgeable against each other: the question a reader
 * has is not "is amber legible" but "can I tell these three
 * apart at a glance from the doorway".
 *
 * Slot 5 is the rip this fixture was written for. A CSS DVD that
 * rode to `Backup done`, left an 8 GB ISO, and hit one bad
 * sector on the way. Before 2026-08-27 it wore slot 8's colours
 * — a `fail` badge saying there was no backup, over a backup
 * ([decision](../../../../docs/decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md)).
 */
const buildThreeOutcomes = (nowMs: number): TowerSnapshot =>
  createTowerSnapshot({
    isMqttEnabled: true,
    bays: [
      buildFixtureBay({
        slot: 1,
        job: buildFixtureJob({
          slot: 1,
          nowMs,
          state: "completed",
          title: "Fixture Disc 1",
          discType: "dvd",
        }),
      }),
      ...buildIdleBays([2, 3, 4]),
      buildFixtureBay({
        slot: 5,
        job: buildFixtureJob({
          slot: 5,
          nowMs,
          state: "completed",
          title: "Fixture Disc 5",
          discType: "dvd",
          readErrorCount: 4,
          warnings: [
            "4 read errors at 3.20 GB, 3.24 GB, 3.31 GB. " +
              "The backup finished and its structure " +
              "verified, so there IS a copy — it may have " +
              "damage in it. MakeMKV does not report whether " +
              "it re-read those sectors successfully or wrote " +
              "them off, and robot mode has no message that " +
              "would say — so Rip Deck cannot tell you which. " +
              "Play the disc through before you throw the " +
              "original away.",
          ],
        }),
      }),
      ...buildIdleBays([6, 7]),
      buildFixtureBay({
        slot: 8,
        job: buildFixtureJob({
          slot: 8,
          nowMs,
          state: "failed",
          title: "Fixture Disc 8",
          discType: "dvd",
          readErrorCount: 41,
        }),
      }),
      ...buildIdleBays([9]),
    ],
  })

export const FIXTURE_NAMES = [
  "empty",
  "nine-rips",
  "verdicts",
  "hub-fault",
  "confidence",
  "rising-eta",
  "quarantined",
  "held-at-startup",
  "unmeasured",
  "usb-flap",
  "three-outcomes",
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

export const isFixtureName = (
  name: string,
): name is FixtureName =>
  (FIXTURE_NAMES as readonly string[]).includes(name)

export const createFixtureSnapshot = (input: {
  name: FixtureName
  nowMs: number
}): TowerSnapshot => {
  const { name, nowMs } = input

  switch (name) {
    case "empty":
      return buildEmptyTower()
    case "nine-rips":
      return buildNineRips(nowMs)
    case "verdicts":
      return buildVerdicts(nowMs)
    case "hub-fault":
      return buildHubFault(nowMs)
    case "confidence":
      return buildConfidence(nowMs)
    case "rising-eta":
      return buildRisingEta(nowMs)
    case "quarantined":
      return buildQuarantined(nowMs)
    case "held-at-startup":
      return buildHeldAtStartup(nowMs)
    case "unmeasured":
      return buildUnmeasured(nowMs)
    case "usb-flap":
      return buildUsbFlap(nowMs)
    case "three-outcomes":
      return buildThreeOutcomes(nowMs)
  }
}
