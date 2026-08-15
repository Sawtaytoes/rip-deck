import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  TrayBayReport,
  TrayCommandReport,
} from "../types"
import { httpDataSource } from "./httpDataSource"

/**
 * The one place this package touches the network, tested with a
 * stubbed `fetch` rather than MSW.
 *
 * The owner asked for MSW, and HANDOFF §8 records what an audit
 * of the house found: mux-magic's "dry-run mode" is a
 * server-side `?fake=` in its Hono API, its Storybook mocks are
 * a Vite middleware written to REPLACE the service worker, and
 * its node harness calls `setupServer` with an empty handler
 * list. The only working MSW here is castkit's, and it is
 * WebSocket-only. Adopting it in `rip-deck` would be introducing
 * it, not following a precedent.
 *
 * It is not introduced, for one reason that is about this app
 * rather than about MSW: the thing worth mocking is a DATA
 * SOURCE, not a network. `RipDeckDataSource` is a first-class
 * seam the app already selects at build time, so component tests
 * inject a fake through context and get the real fixture
 * scenarios with no interception at all. Adding MSW would put a
 * second mocking mechanism underneath a working one, and leave
 * the browser-mode `msw/browser` / `msw/core/ws` subpath trap
 * armed for whoever flips browser mode on later.
 *
 * That leaves exactly this file — how four functions build a URL,
 * a POST body and a status branch — as MSW's whole remit, and a
 * stubbed `fetch` covers it without a dependency, a service
 * worker or a `setupServer` lifecycle to leak between suites.
 *
 * ⚠️ Two of the three things this comment named as the moment to
 * revisit that have now landed: `/logs` serves a capture and
 * `POST /api/tray` is a real write endpoint. It is still not the
 * moment, and the reason is unchanged rather than stale — the
 * seam worth faking is `RipDeckDataSource`, and the branching
 * that arrived (a 400 that carries a report, a 405 that does
 * not) is a handful of statuses, not a protocol. Streaming
 * updates would be the genuine trigger.
 */

const stubFetch = (
  response: Partial<Response> & { ok: boolean },
) => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(response as Response),
  )

  vi.stubGlobal("fetch", fetchMock)

  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchState", () => {
  it("asks for a live, uncached snapshot", async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: () => Promise.resolve({ hosts: [] }),
    })

    await httpDataSource.fetchState()

    // `/json` is a live snapshot of a nine-bay tower. A cached
    // one is a lie with a timestamp on it.
    expect(fetchMock).toHaveBeenCalledWith("/json", {
      cache: "no-store",
    })
  })

  it("forwards a fixture name as the daemon's ?fake=", async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: () => Promise.resolve({ hosts: [] }),
    })

    await httpDataSource.fetchState("hub-fault")

    // Same spelling as the mock and the router, so one URL means
    // one thing whichever source answers it.
    expect(fetchMock).toHaveBeenCalledWith(
      "/json?fake=hub-fault",
      { cache: "no-store" },
    )
  })

  it("throws with the status when the daemon refuses", async () => {
    stubFetch({ ok: false, status: 503 })

    await expect(
      httpDataSource.fetchState(),
    ).rejects.toThrow("/json failed: 503")
  })
})

describe("fetchLog", () => {
  it("asks for a tail by default, never the whole 3 MB file", async () => {
    const fetchMock = stubFetch({
      ok: true,
      text: () => Promise.resolve("PRGV:1,2,3"),
    })

    const body =
      await httpDataSource.fetchLog("fixture-job-7")

    expect(fetchMock).toHaveBeenCalledWith(
      "/logs?job=fixture-job-7&lines=600",
    )
    expect(body).toBe("PRGV:1,2,3")
  })

  it("swaps `lines` for `all=1` rather than sending both", async () => {
    // Both together would ask for the last 600 lines of the
    // whole file — a contradiction the daemon would have to pick
    // a winner for.
    const fetchMock = stubFetch({
      ok: true,
      text: () => Promise.resolve(""),
    })

    await httpDataSource.fetchLog("fixture-job-7", "all")

    expect(fetchMock).toHaveBeenCalledWith(
      "/logs?job=fixture-job-7&all=1",
    )
  })

  it("surfaces the daemon's body, not just its status", async () => {
    // A non-2xx is the daemon SAYING something — which job has
    // no capture, or that there is no such job. Swallowing it
    // would turn an explanation into a bare number.
    stubFetch({
      ok: false,
      status: 404,
      text: () =>
        Promise.resolve(
          "no capture for job fixture-job-7.",
        ),
    })

    await expect(
      httpDataSource.fetchLog("fixture-job-7"),
    ).rejects.toThrow("no capture for job")
  })
})

const DRIVE_ID = "usb-2-1-1-2-4-4-7"

/** A `resp/drive` report with one bay in it. */
const buildReport = (
  bay: Partial<TrayBayReport> = {},
): TrayCommandReport => ({
  request_id: null,
  command: "open_bay",
  is_accepted: true,
  message: "Opened 1 drive: slot 7.",
  started_at: 1_780_000_000_000,
  finished_at: 1_780_000_001_240,
  counts: {
    opened: 1,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
  },
  bays: [
    {
      drive_id: DRIVE_ID,
      slot: 7,
      label: "07 - Pioneer BDR-211M",
      result: "opened",
      detail: "the tray is open",
      ...bay,
    },
  ],
})

describe("runBayAction", () => {
  it("says the job actions have nowhere to go — including MQTT", async () => {
    const fetchMock = stubFetch({ ok: true })

    const result = await httpDataSource.runBayAction({
      driveId: "usb-2-1-1-2-4-4-5",
      action: "clear_quarantine",
    })

    // The five job actions genuinely have no transport: no
    // endpoint, and `cmd/drive` takes only the four tray words.
    // The message this replaced claimed they "go over MQTT",
    // which would have sent an operator to publish something the
    // daemon explicitly rejects.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.msg).toContain("no transport yet")
  })

  /**
   * The tray pair is the half that now works.
   *
   * This used to assert a REFUSAL — that a tray command had no
   * endpoint "by design" — and that refusal is the red box the
   * owner hit on the live page. Pressing ⏏ now sends a request.
   */
  it("routes a tray word to the endpoint instead of refusing", async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve(buildReport()),
    })

    const result = await httpDataSource.runBayAction({
      driveId: DRIVE_ID,
      action: "open_bay",
    })

    expect(fetchMock).toHaveBeenCalledWith("/api/tray", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The daemon's own `cmd/drive` JSON, so what the UI sends
      // and what an operator would publish are one payload.
      body: `{"command":"open_bay","drive_id":"${DRIVE_ID}"}`,
    })
    expect(result.ok).toBe(true)
  })

  /**
   * ⚠️ The case a green suite would otherwise miss.
   *
   * `is_accepted: true` with a `refused_ripping` bay means "I
   * heard you, and no". Reporting that as success is how a
   * control ends up claiming it opened the drive it correctly
   * protected — and the bay's own sentence is the only text that
   * explains why, so it has to survive the flattening intact.
   */
  it("reports a refused bay as a failure, in the daemon's words", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          buildReport({
            result: "refused_ripping",
            detail:
              "REFUSED — this bay is ripping. Opening the " +
              "tray now would destroy the rip in progress. " +
              "Nothing was touched.",
          }),
        ),
    })

    const result = await httpDataSource.runBayAction({
      driveId: DRIVE_ID,
      action: "open_bay",
    })

    expect(result.ok).toBe(false)
    expect(result.msg).toContain(
      "would destroy the rip in progress",
    )
  })
})

describe("runTrayCommand", () => {
  it("omits drive_id for a bulk command", async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ...buildReport(),
          command: "open_trays",
        }),
    })

    await httpDataSource.runTrayCommand({
      command: "open_trays",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tray",
      expect.objectContaining({
        body: '{"command":"open_trays"}',
      }),
    )
  })

  it("sends the operator's name on a rip, and omits a blank one", async () => {
    // Two presses of one button: "Rip as this" carries a name,
    // "Try again" carries none and the daemon re-reads the disc.
    // A blank name must not travel as `"name":""` — the wire form
    // should be byte-identical to what an operator would publish
    // on `cmd/drive` by hand.
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ...buildReport(),
          command: "rip_bay",
        }),
    })

    await httpDataSource.runTrayCommand({
      command: "rip_bay",
      driveId: DRIVE_ID,
      name: "Soylent Green - UHD",
    })

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tray",
      expect.objectContaining({
        body: JSON.stringify({
          command: "rip_bay",
          drive_id: DRIVE_ID,
          name: "Soylent Green - UHD",
        }),
      }),
    )

    await httpDataSource.runTrayCommand({
      command: "rip_bay",
      driveId: DRIVE_ID,
      name: "",
    })

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tray",
      expect.objectContaining({
        body: JSON.stringify({
          command: "rip_bay",
          drive_id: DRIVE_ID,
        }),
      }),
    )
  })

  /**
   * A 400 is a REPORT, not an error.
   *
   * `buildTrayCommandRejection` answers on the same shape with
   * `is_accepted: false`, so a caller branches on the field
   * rather than the status code — and a thrown rejection would
   * strand the daemon's explanation in a catch block as a
   * stringified Error.
   */
  it("resolves a 400 rejection rather than throwing it", async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          request_id: null,
          command: null,
          is_accepted: false,
          message:
            "Tray command refused: `open` is not a command.",
          started_at: 1_780_000_000_000,
          finished_at: 1_780_000_000_000,
          counts: {
            opened: 0,
            opened_not_ripped: 0,
            closed: 0,
            refused: 0,
            failed: 0,
            skipped: 0,
          },
          bays: [],
        }),
    })

    const report = await httpDataSource.runTrayCommand({
      command: "open_bay",
      driveId: DRIVE_ID,
    })

    expect(report.is_accepted).toBe(false)
    expect(report.message).toContain("is not a command")
  })

  it("throws when the endpoint itself is not there", async () => {
    // 405 from a daemon too old to serve it, 503 while the
    // watcher is not up. Neither carries a report, so there is
    // nothing to render and the caller wants an error.
    stubFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () =>
        Promise.resolve({
          ok: false,
          msg: "the watcher is not running",
        }),
    })

    await expect(
      httpDataSource.runTrayCommand({
        command: "close_trays",
      }),
    ).rejects.toThrow(
      "/api/tray failed: 503 the watcher is not running",
    )
  })

  it("survives a body that is not JSON at all", async () => {
    // A proxy's HTML error page must not arrive as a report with
    // every field undefined.
    stubFetch({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: () => Promise.reject(new Error("not json")),
    })

    await expect(
      httpDataSource.runTrayCommand({
        command: "close_trays",
      }),
    ).rejects.toThrow("/api/tray failed: 502 Bad Gateway")
  })
})
