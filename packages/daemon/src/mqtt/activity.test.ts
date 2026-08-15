import { describe, expect, it } from "vitest"
import {
  type BayState,
  createBayState,
} from "../rip/watcher.ts"
import {
  buildActivityPayload,
  createActivityMemory,
  foldActivity,
  summariseBayActivity,
} from "./activity.ts"

/**
 * These tests are the safety argument for cutting mains power to
 * a rack of drives, so they are written as refusals: every one of
 * them asks "could this make the tower look idle when it is
 * not?".
 */

const NOW_MS = 1_780_000_000_000

const bay = (input: Partial<BayState>): BayState => ({
  ...createBayState({
    driveId: input.driveId ?? "usb-2-1.1.2.4.4.2",
    atMs: NOW_MS,
  }),
  ...input,
})

describe("summariseBayActivity", () => {
  it("counts starting and ripping bays as active", () => {
    // `starting` is settle + type + identify: the drive is
    // claimed and spinning even though no ripper child exists
    // yet. Counting only `ripping` would cut power during the
    // two-minute settle window.
    const snapshot = summariseBayActivity([
      bay({ driveId: "a", phase: "starting" }),
      bay({ driveId: "b", phase: "ripping" }),
      bay({ driveId: "c", phase: "idle" }),
      bay({ driveId: "d", phase: "done" }),
      bay({ driveId: "e", phase: "quarantined" }),
    ])

    expect(snapshot.activeRipCount).toBe(2)
    expect(snapshot.driveCount).toBe(5)
  })

  it("is stable under bay ordering", () => {
    const one = summariseBayActivity([
      bay({ driveId: "a" }),
      bay({ driveId: "b" }),
    ])
    const other = summariseBayActivity([
      bay({ driveId: "b" }),
      bay({ driveId: "a" }),
    ])

    expect(one.driveSignature).toBe(other.driveSignature)
  })

  it("changes when a disc arrives in an idle bay", () => {
    const empty = summariseBayActivity([
      bay({ driveId: "a", sizeSectors: null }),
    ])
    const loaded = summariseBayActivity([
      bay({ driveId: "a", sizeSectors: 23_000_000 }),
    ])

    expect(empty.driveSignature).not.toBe(
      loaded.driveSignature,
    )
  })
})

describe("foldActivity", () => {
  it("treats a running rip as activity even when nothing changes", () => {
    // The failure this exists to prevent: a 90 GB UHD rip moves
    // no bay state for an hour, so a signature-only rule would
    // call the tower idle and power it off mid-copy.
    const snapshot = summariseBayActivity([
      bay({ driveId: "a", phase: "ripping" }),
    ])

    const first = foldActivity({
      memory: createActivityMemory({ nowMs: NOW_MS }),
      snapshot,
      nowMs: NOW_MS,
    })

    const anHourLater = foldActivity({
      memory: first.memory,
      snapshot,
      nowMs: NOW_MS + 3_600_000,
    })

    expect(anHourLater.memory.lastActivityAtMs).toBe(
      NOW_MS + 3_600_000,
    )
  })

  it("lets the idle clock run once every bay is quiet", () => {
    const snapshot = summariseBayActivity([
      bay({ driveId: "a", phase: "done" }),
    ])

    const first = foldActivity({
      memory: createActivityMemory({ nowMs: NOW_MS }),
      snapshot,
      nowMs: NOW_MS,
    })

    const later = foldActivity({
      memory: first.memory,
      snapshot,
      nowMs: NOW_MS + 600_000,
    })

    expect(later.memory.lastActivityAtMs).toBe(NOW_MS)
  })

  it("restarts the idle clock when a disc is swapped", () => {
    const before = foldActivity({
      memory: createActivityMemory({ nowMs: NOW_MS }),
      snapshot: summariseBayActivity([
        bay({ driveId: "a", phase: "done" }),
      ]),
      nowMs: NOW_MS,
    })

    const after = foldActivity({
      memory: before.memory,
      snapshot: summariseBayActivity([
        bay({ driveId: "a", phase: "idle" }),
      ]),
      nowMs: NOW_MS + 600_000,
    })

    expect(after.memory.lastActivityAtMs).toBe(
      NOW_MS + 600_000,
    )
  })

  it("starts a fresh daemon's idle clock at now, not zero", () => {
    // A daemon that has just restarted knows nothing about the
    // minutes before it. Inheriting a zero would publish
    // "last active in 1970" and read as idle forever.
    const memory = createActivityMemory({ nowMs: NOW_MS })

    expect(memory.lastActivityAtMs).toBe(NOW_MS)
  })

  it("publishes on the first fold, on change, and on the heartbeat", () => {
    const quiet = summariseBayActivity([
      bay({ driveId: "a", phase: "done" }),
    ])

    const first = foldActivity({
      memory: createActivityMemory({ nowMs: NOW_MS }),
      snapshot: quiet,
      nowMs: NOW_MS,
      heartbeatMs: 60_000,
    })
    expect(first.isPublishDue).toBe(true)

    const unchanged = foldActivity({
      memory: first.memory,
      snapshot: quiet,
      nowMs: NOW_MS + 5_000,
      heartbeatMs: 60_000,
    })
    expect(unchanged.isPublishDue).toBe(false)

    // The heartbeat is what makes silence distinguishable from
    // idleness downstream, so it must fire with nothing to say.
    const heartbeat = foldActivity({
      memory: first.memory,
      snapshot: quiet,
      nowMs: NOW_MS + 60_000,
      heartbeatMs: 60_000,
    })
    expect(heartbeat.isPublishDue).toBe(true)
  })
})

describe("buildActivityPayload", () => {
  it("reports idle only when no bay is ripping", () => {
    const snapshot = summariseBayActivity([
      bay({ driveId: "a", phase: "ripping" }),
      bay({ driveId: "b", phase: "idle" }),
    ])

    const payload = buildActivityPayload({
      snapshot,
      memory: {
        snapshot,
        lastActivityAtMs: NOW_MS,
        lastPublishedAtMs: NOW_MS,
      },
      nowMs: NOW_MS,
    })

    expect(payload).toEqual({
      active_rip_count: 1,
      drive_count: 2,
      is_idle: false,
      last_activity_at: NOW_MS,
      updated_at: NOW_MS,
    })
  })
})
