import { describe, expect, it } from "vitest"
import {
  countLine,
  createHeartbeat,
  formatHeartbeat,
  HEARTBEAT_FLUSH_INTERVAL_MS,
  type Heartbeat,
} from "./heartbeat.ts"

const heartbeat = (): Heartbeat =>
  createHeartbeat({ stateDir: "/state", jobUuid: "abc" })

describe("the heartbeat file", () => {
  it("lives outside the rip's output directory", () => {
    // The output directory gets renamed into the media library
    // on success; a heartbeat riding along would be permanent
    // litter in every folder.
    expect(heartbeat().path).toBe("/state/abc.heartbeat")
  })

  it("is greppable and human readable", () => {
    expect(
      formatHeartbeat({ atMs: 0, lineCount: 42 }),
    ).toBe("1970-01-01T00:00:00.000Z line=42\n")
  })
})

describe("counting lines", () => {
  it("keeps the count exact even when not flushing", () => {
    // The two numbers answer different questions: the timestamp
    // says whether anything is happening, the counter says
    // whether it is progress. Only the flushing is throttled.
    let current = heartbeat()

    for (let index = 0; index < 100; index += 1) {
      current = countLine({
        heartbeat: current,
        atMs: index,
      }).heartbeat
    }

    expect(current.lineCount).toBe(100)
  })

  it("flushes at most once per interval", () => {
    let current = heartbeat()
    let flushCount = 0

    // makemkvcon emits several lines a second; over a three-hour
    // rip that is six figures of one-line writes.
    for (let ms = 0; ms < 10_000; ms += 100) {
      const counted = countLine({
        heartbeat: current,
        atMs: ms,
      })

      current = counted.heartbeat
      if (counted.isFlushDue) flushCount += 1
    }

    expect(flushCount).toBe(
      10_000 / HEARTBEAT_FLUSH_INTERVAL_MS,
    )
  })

  it("flushes the very first line immediately", () => {
    // A rip that dies in its first second must still have left
    // evidence that it started.
    const counted = countLine({
      heartbeat: heartbeat(),
      atMs: HEARTBEAT_FLUSH_INTERVAL_MS,
    })

    expect(counted.isFlushDue).toBe(true)
  })
})
