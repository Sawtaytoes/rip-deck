import { describe, expect, it } from "vitest"

import {
  DEFAULT_FIXTURE,
  FIXTURE_NAMES,
  isFixtureName,
  readFixtureName,
} from "./fixture"

describe("readFixtureName", () => {
  it("asks for the RACK when no fake is named", () => {
    // The whole point. The daemon serves this page and `/json`
    // on one origin, so a bare `/` is somebody standing at the
    // tower asking what it is doing — answering with nine
    // invented rips is the failure this project keeps having.
    expect(readFixtureName("")).toBeNull()
    expect(readFixtureName("?poll=1")).toBeNull()

    // The default did not disappear, it moved to the only place
    // it is true: with no backend there is nothing else to draw.
    expect(DEFAULT_FIXTURE).toBe("nine-rips")
  })

  it("returns a named scenario", () => {
    expect(readFixtureName("?fake=hub-fault")).toBe(
      "hub-fault",
    )
    expect(readFixtureName("?fake=empty")).toBe("empty")
  })

  // A mistyped URL should show the dashboard, not a stack
  // trace — the person typing it is standing at the rack. And
  // the rack is exactly what it should fall back to.
  it("falls back rather than throwing on an unknown name", () => {
    expect(readFixtureName("?fake=nonsense")).toBeNull()
  })

  it("recognises exactly the daemon's fixture names", () => {
    // Mirrors `FIXTURE_NAMES` in
    // `packages/daemon/src/api/fixtures.ts`. Spelled out here
    // rather than derived so that adding a scenario on one side
    // and not the other is a red test.
    expect([...FIXTURE_NAMES]).toEqual([
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
    ])
    expect(isFixtureName("verdicts")).toBe(true)
    expect(isFixtureName("Verdicts")).toBe(false)
  })
})
