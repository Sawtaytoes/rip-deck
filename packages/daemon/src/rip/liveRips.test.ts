import { describe, expect, it } from "vitest"
import {
  type BayClaim,
  createLiveRipsReader,
  liveJobUuidsFromBays,
} from "./liveRips.ts"

/**
 * ⚠️ **What this pins is the answer everything else fails closed
 * on.** `leftovers.ts` refuses to delete or rename on this set,
 * and `reaper.ts` refuses to reap on it. A wrong `true` here is a
 * rip nobody can clear up; a wrong `false` is 40 GB deleted while
 * `makemkvcon` is still writing it.
 *
 * The two that matter most:
 *
 *  - a bay that has FINISHED keeps its `jobUuid`, so the phase
 *    filter is the whole function, and
 *  - a failure to read is UNKNOWN, never an empty set.
 */

const bay = (overrides: Partial<BayClaim>): BayClaim => ({
  phase: "idle",
  jobUuid: null,
  ...overrides,
})

describe("reading live rips off the bay table", () => {
  it("counts a ripping bay", () => {
    expect([
      ...liveJobUuidsFromBays([
        bay({ phase: "ripping", jobUuid: "uuid-1" }),
      ]),
    ]).toEqual(["uuid-1"])
  })

  it("⚠️ counts a STARTING bay too", () => {
    // `prepareDestination` makes the incomplete directory before
    // the ripper child is spawned, so the window between them is
    // a real folder for a real rip with no process behind it.
    expect([
      ...liveJobUuidsFromBays([
        bay({ phase: "starting", jobUuid: "uuid-2" }),
      ]),
    ]).toEqual(["uuid-2"])
  })

  it("⚠️ ignores a FINISHED bay that still remembers its job", () => {
    // `BayState.jobUuid` survives the outcome latch on purpose,
    // so the disc's card can still offer its robot log. Reading
    // it unfiltered would lock the panel against the one folder
    // the operator most wants to clear — the leftover of the rip
    // that just failed in that very bay.
    expect([
      ...liveJobUuidsFromBays([
        bay({ phase: "done", jobUuid: "uuid-3" }),
        bay({ phase: "quarantined", jobUuid: "uuid-4" }),
        bay({ phase: "idle", jobUuid: "uuid-5" }),
      ]),
    ]).toEqual([])
  })

  it("ignores a claimed bay that has no job id yet", () => {
    expect([
      ...liveJobUuidsFromBays([
        bay({ phase: "starting", jobUuid: null }),
      ]),
    ]).toEqual([])
  })

  it("reads all nine bays at once", () => {
    const bays = Array.from({ length: 9 }, (_, index) =>
      bay({ phase: "ripping", jobUuid: `uuid-${index}` }),
    )

    expect(liveJobUuidsFromBays(bays).size).toBe(9)
  })
})

describe("the reader the API is handed", () => {
  it("unions the bay table with the running argv", async () => {
    const read = createLiveRipsReader(
      {
        readBays: () => [
          bay({ phase: "ripping", jobUuid: "from-bay" }),
        ],
      },
      {
        readRunningArgvUuids: async () =>
          new Set(["from-proc"]),
      },
    )

    const live = await read()

    expect(live.isKnown).toBe(true)
    if (live.isKnown) {
      expect([...live.jobUuids].sort()).toEqual([
        "from-bay",
        "from-proc",
      ])
    }
  })

  it("⚠️ answers UNKNOWN before the watcher exists", async () => {
    // The API server is up before the watcher is. A request in
    // that window has no bay table to read, and "no table" must
    // not be answered as "no rips".
    const read = createLiveRipsReader(
      { readBays: () => null },
      {
        readRunningArgvUuids: async () => new Set<string>(),
      },
    )

    const live = await read()

    expect(live.isKnown).toBe(false)
    if (!live.isKnown) {
      expect(live.reason).toContain("watcher")
    }
  })

  it("⚠️ answers UNKNOWN when /proc cannot be listed", async () => {
    // `readRunningArgvUuidsFromProc` throws rather than
    // returning an empty set for exactly this reason: an empty
    // set would look identical to "nothing is running", which is
    // the one wrong answer it can give.
    const read = createLiveRipsReader(
      { readBays: () => [] },
      {
        readRunningArgvUuids: () =>
          Promise.reject(
            new Error("EACCES: permission denied, scandir"),
          ),
      },
    )

    const live = await read()

    expect(live.isKnown).toBe(false)
    if (!live.isKnown) {
      expect(live.reason).toContain("EACCES")
    }
  })

  it("an idle rack is KNOWN and empty, not unknown", async () => {
    const read = createLiveRipsReader(
      { readBays: () => [bay({ phase: "idle" })] },
      {
        readRunningArgvUuids: async () => new Set<string>(),
      },
    )

    const live = await read()

    expect(live).toEqual({
      isKnown: true,
      jobUuids: new Set<string>(),
    })
  })
})
