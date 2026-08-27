import {
  makeVerdict,
  type Verdict,
} from "@rip-deck/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  createComputedVerdictStore,
  createNullComputedVerdictStore,
} from "./verdictStore.ts"

/**
 * Reading the engine's saved answer back for the dashboard.
 *
 * The properties that matter are all about WHEN it reads, not
 * what it parses: nine bays poll every five seconds, and a store
 * that read a file per bay per poll would put a disk read on the
 * path that must never have one.
 */

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

const document = (verdict: Verdict): string =>
  JSON.stringify({
    schemaVersion: 1,
    jobId: "job-1",
    driveId: "bay-09",
    computedAtMs: 1_000,
    isPublished: false,
    verdict,
    observation: {},
    thresholds: {},
  })

const dirty = makeVerdict("disc_dirty", "suspected", [
  "Errors scattered across the disc.",
])

describe("the null store", () => {
  it("answers null and reads nothing", () => {
    const store = createNullComputedVerdictStore()

    store.request({ jobUuid: "job-1" })

    expect(store.get({ jobUuid: "job-1" })).toBeNull()
  })
})

describe("reading a saved verdict", () => {
  it("is null until the read lands", async () => {
    const read = vi.fn().mockResolvedValue(document(dirty))

    const store = createComputedVerdictStore({
      stateDir: "/state",
      read,
    })

    store.request({ jobUuid: "job-1" })

    // `request` returns at once. The feed calls it on the
    // watcher's own poll and reads the answer on the next one.
    expect(store.get({ jobUuid: "job-1" })).toBeNull()

    await settle()

    expect(store.get({ jobUuid: "job-1" })).toEqual(dirty)
  })

  it("reads the file named for the job", async () => {
    const read = vi.fn().mockResolvedValue(document(dirty))

    const store = createComputedVerdictStore({
      stateDir: "/state",
      read,
    })

    store.request({ jobUuid: "job-1" })

    expect(read).toHaveBeenCalledWith(
      "/state/job-1.verdict.json",
    )
  })

  it("reads once however often it is asked", async () => {
    const read = vi.fn().mockResolvedValue(document(dirty))

    const store = createComputedVerdictStore({
      stateDir: "/state",
      read,
    })

    store.request({ jobUuid: "job-1" })
    store.request({ jobUuid: "job-1" })

    await settle()

    store.request({ jobUuid: "job-1" })

    // Nine bays at one poll every five seconds is what this
    // number protects.
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("ignores an empty job id", () => {
    const read = vi.fn()

    createComputedVerdictStore({
      stateDir: "/state",
      read,
    }).request({ jobUuid: "" })

    // A bay that has never had a job carries `""`, and
    // `/state/.verdict.json` is not a file anybody meant.
    expect(read).not.toHaveBeenCalled()
  })
})

describe("a verdict that is not there", () => {
  it("holds off before looking again", async () => {
    const read = vi
      .fn()
      .mockRejectedValue(new Error("ENOENT"))

    let nowMs = 1_000

    const store = createComputedVerdictStore({
      stateDir: "/state",
      now: () => nowMs,
      read,
    })

    store.request({ jobUuid: "job-1" })
    await settle()

    nowMs += 5_000
    store.request({ jobUuid: "job-1" })
    await settle()

    expect(read).toHaveBeenCalledTimes(1)
  })

  it("looks again once the cooldown is past", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(document(dirty))

    let nowMs = 1_000

    const store = createComputedVerdictStore({
      stateDir: "/state",
      now: () => nowMs,
      read,
    })

    store.request({ jobUuid: "job-1" })
    await settle()

    // The ordinary reason for a miss is a rip that has not
    // finished writing. Caching that answer forever would mean a
    // bay whose verdict never appeared until the daemon
    // restarted.
    nowMs += 60_000
    store.request({ jobUuid: "job-1" })
    await settle()

    expect(store.get({ jobUuid: "job-1" })).toEqual(dirty)
  })
})

describe("a document that is not a verdict", () => {
  it.each([
    ["is not JSON", "{ broken"],
    ["has no verdict", JSON.stringify({ jobId: "job-1" })],
    [
      "lost a field",
      JSON.stringify({
        verdict: { kind: "disc_dirty", message: "Dirty." },
      }),
    ],
    [
      "names a kind nothing knows",
      JSON.stringify({
        verdict: { ...dirty, kind: "disc_haunted" },
      }),
    ],
    [
      "carries a confidence nothing knows",
      JSON.stringify({
        verdict: { ...dirty, confidence: "certain" },
      }),
    ],
  ])("answers null when it %s", async (_name, text) => {
    // These files are written by builds that may be months
    // apart. A verdict missing its message would reach the card
    // as a blank alert with no way to tell it from a real one,
    // and an unknown kind has no `verdictTone` arm at all.
    const store = createComputedVerdictStore({
      stateDir: "/state",
      read: vi.fn().mockResolvedValue(text),
    })

    store.request({ jobUuid: "job-1" })
    await settle()

    expect(store.get({ jobUuid: "job-1" })).toBeNull()
  })
})
