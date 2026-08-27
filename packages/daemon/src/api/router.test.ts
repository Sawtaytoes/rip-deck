import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_TOPIC_CONFIG } from "../mqtt/topics.ts"
import type { TrayCommandResponsePayload } from "../rip/trayCommand.ts"
import { FIXTURE_NAMES } from "./fixtures.ts"
import type { RipDeckJsonDocument } from "./jsonDocument.ts"
import type { LogCaptureReader } from "./logCapture.ts"
import {
  type ApiRequest,
  type ApiResponse,
  type ApiRouter,
  createApiRouter,
  SERVER_PATHNAMES,
} from "./router.ts"
import {
  createBaySnapshot,
  createTowerSnapshot,
} from "./snapshot.ts"
import type { TrayCommandRunner } from "./trayEndpoint.ts"
import type { WebAssets } from "./webAssets.ts"

/**
 * The HTTP surface, tested without a socket.
 *
 * The endpoints the ARM viewer calls but rip-deck does not serve
 * matter as much as the ones it does: answering them with a
 * legible JSON "not yet" is the difference between a button the
 * owner can see is unfinished and one that silently does
 * nothing.
 *
 * The dashboard is described here rather than read off disk. The
 * question this file answers is which path wins, and a stub makes
 * "an asset can never shadow /json" provable without a build.
 *
 * The tray runner and the capture reader are stubs for the same
 * reason: what is under test here is routing, status codes and
 * the traversal gate. That a REFUSED bay stays refused over a
 * real socket is proved in `server.test.ts` against the real
 * `decideTrayBayAction`.
 */

const NOW_MS = 1_800_000_000_000

const INDEX_HTML = '<!doctype html><div id="root"></div>'

const JOB_UUID = "6f1b2c3d-0000-4000-8000-000000000001"

const buildWebAssets = (): WebAssets => {
  const assets = new Map(
    Object.entries({
      "/index.html": {
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(INDEX_HTML),
        isImmutable: false,
      },
      "/assets/index-abc123.js": {
        contentType: "text/javascript; charset=utf-8",
        body: Buffer.from("console.log(1)"),
        isImmutable: true,
      },
    }),
  )

  return {
    readAsset: ({ pathname }) =>
      assets.get(pathname) ?? null,
    readIndexHtml: () => assets.get("/index.html") ?? null,
    fileCount: assets.size,
    totalBytes: 0,
    root: "/app/packages/web/dist",
  }
}

const buildRouter = (
  webAssets?: WebAssets,
  extras: {
    readTrayRunner?: () => TrayCommandRunner | null
    readLogCapture?: LogCaptureReader | null
  } = {},
) =>
  createApiRouter({
    readSnapshot: () =>
      createTowerSnapshot({
        bays: [
          createBaySnapshot({
            driveId: "usb-2-1-1-2-4-4-2",
            label: "02 - Pioneer BDR-211M",
            slot: 2,
            devPath: "/dev/sr7",
          }),
        ],
      }),
    readNowMs: () => NOW_MS,
    topicConfig: DEFAULT_TOPIC_CONFIG,
    webAssets,
    ...extras,
  })

/**
 * A response the router produced WITHOUT yielding.
 *
 * This is an assertion, not a type narrowing. The parent process
 * supervises nine bays, so `/json`, `/health`, `/fixtures` and
 * every asset path must answer from memory in the tick they were
 * routed in — if one of them ever starts awaiting something, a
 * wedged drive can put itself between a browser and the
 * snapshot, and every test routed through here fails loudly the
 * day that happens.
 *
 * `POST /api/tray` and `GET /logs` are the two paths that may
 * return a promise, and they go through `handleAsync` below.
 */
const handleSync = (
  router: ApiRouter,
  request: ApiRequest,
): ApiResponse => {
  const result = router.handle(request)

  if (result instanceof Promise) {
    throw new Error(
      `${request.method} ${request.url} answered ` +
        "asynchronously. Only /api/tray and /logs may.",
    )
  }

  return result
}

const handleAsync = async (
  router: ApiRouter,
  request: ApiRequest,
): Promise<ApiResponse> => await router.handle(request)

const parseBody = <Body>(body: string | Uint8Array): Body =>
  JSON.parse(String(body)) as Body

const postTray = async (input: {
  body: string
  readTrayRunner?: () => TrayCommandRunner | null
}) =>
  await handleAsync(
    buildRouter(undefined, {
      readTrayRunner: input.readTrayRunner,
    }),
    {
      method: "POST",
      url: "/api/tray",
      readBody: () => Promise.resolve(input.body),
    },
  )

/** A report shaped like one `resp/drive` would publish. */
const buildTrayReport = (
  overrides: Partial<TrayCommandResponsePayload> = {},
): TrayCommandResponsePayload => ({
  request_id: null,
  command: "open_bay",
  is_accepted: true,
  message: "Opened 1 drive: slot 4.",
  spoken_message: "Opened 1 tray.",
  started_at: NOW_MS,
  finished_at: NOW_MS + 900,
  counts: {
    opened: 1,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    rip_started: 0,
  },
  bays: [],
  ...overrides,
})

describe("GET /json", () => {
  it("serves both readers from one instant", () => {
    const response = handleSync(buildRouter(), {
      method: "GET",
      url: "/json",
    })

    expect(response.status).toBe(200)

    const document = parseBody<RipDeckJsonDocument>(
      response.body,
    )

    // The viewer's half…
    expect(document.hosts).toHaveLength(1)
    expect(document.hosts[0].ok).toBe(true)
    // …and rip-deck's.
    expect(document.ripDeck.schema_version).toBe(1)
    expect(document.ripDeck.bays).toHaveLength(1)
    expect(document.ripDeck.generated_at).toBe(NOW_MS)
    expect(document.ripDeck.is_fake).toBe(false)
  })

  it("is never cached — it is a live snapshot", () => {
    expect(
      handleSync(buildRouter(), {
        method: "GET",
        url: "/json",
      }).cachePolicy,
    ).toBe("no-store")
  })

  it("serves a named fixture, and says it is one", () => {
    const response = handleSync(buildRouter(), {
      method: "GET",
      url: "/json?fake=nine-rips",
    })

    const document = parseBody<RipDeckJsonDocument>(
      response.body,
    )

    expect(response.status).toBe(200)
    expect(document.ripDeck.is_fake).toBe(true)
    expect(document.ripDeck.fixture).toBe("nine-rips")
    expect(document.ripDeck.bays).toHaveLength(9)
  })

  it("names the fixtures it knows when given a bad one", () => {
    const response = handleSync(buildRouter(), {
      method: "GET",
      url: "/json?fake=everything-is-fine",
    })

    const body = parseBody<{
      ok: boolean
      fixtures: string[]
    }>(response.body)

    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.fixtures).toEqual([...FIXTURE_NAMES])
  })

  it("refuses anything but GET", () => {
    expect(
      handleSync(buildRouter(), {
        method: "POST",
        url: "/json",
      }).status,
    ).toBe(405)
  })
})

describe("the rest of the surface", () => {
  it("lists the fixtures", () => {
    const response = handleSync(buildRouter(), {
      method: "GET",
      url: "/fixtures",
    })

    expect(response.status).toBe(200)
    expect(
      parseBody<{ fixtures: string[] }>(response.body)
        .fixtures,
    ).toEqual([...FIXTURE_NAMES])
  })

  it("answers a health check about the process only", () => {
    // Emphatically not about the tower: an empty rack is normal.
    const response = handleSync(
      createApiRouter({
        readSnapshot: () => createTowerSnapshot(),
        readNowMs: () => NOW_MS,
      }),
      { method: "GET", url: "/health" },
    )

    expect(response.status).toBe(200)
    expect(
      parseBody<{ ok: boolean }>(response.body).ok,
    ).toBe(true)
  })

  it("answers /healthz identically, byte for byte", () => {
    // The owner asked what the `z` was for and there is no good
    // answer, so `/health` is the name. The alias is NOT free to
    // drop: the Homepage tile's siteMonitor points at /healthz.
    const router = buildRouter()

    const health = handleSync(router, {
      method: "GET",
      url: "/health",
    })

    const healthz = handleSync(router, {
      method: "GET",
      url: "/healthz",
    })

    expect(healthz).toEqual(health)
    expect(String(healthz.body)).toBe(String(health.body))
  })

  it("points a viewer drive action at the endpoint that works", () => {
    const response = handleSync(buildRouter(), {
      method: "POST",
      url: "/stop",
    })

    const body = parseBody<{ ok: boolean; msg: string }>(
      response.body,
    )

    // Still 501 — these are the ARM VIEWER's URLs, not
    // rip-deck's. What changed is that the message no longer
    // claims drive commands are never coming back as REST; they
    // came back, at POST /api/tray.
    expect(response.status).toBe(501)
    expect(body.ok).toBe(false)
    expect(body.msg).toContain("/api/tray")
    expect(body.msg).toContain("cmd/drive")
  })

  /**
   * This used to assert that `/nope` was a JSON 404. It is the dashboard now:
   * the app gained a client router on 2026-08-16, and `router.ts` said what to
   * do when one arrived — widen the index fallback, keeping the API paths above
   * it. An extension-less path is a deep link rather than a typo from here on.
   *
   * The half worth keeping is the OTHER half, and it is the reason the widened
   * rule is extension-less-only: a missing bundle must still fail as a 404 the
   * browser reports. Answer `/assets/index-abc123.js` with 200 + HTML and the
   * browser tries to execute HTML as JavaScript, which fails in a way that says
   * nothing at all about the real problem.
   */
  it("serves the dashboard for an extension-less path — it is a client route", () => {
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/nope",
      },
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toContain("text/html")
  })

  it("404s in JSON, never in HTML, for a path that names a FILE", () => {
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/assets/index-deadbeef.js",
      },
    )

    expect(response.status).toBe(404)
    expect(response.contentType).toBe(
      "application/json; charset=utf-8",
    )
  })

  /**
   * The extension test alone would hand these to the client router, and
   * both are namespaces the dashboard does not route in.
   *
   * `/api/` matters most: every API path that EXISTS is matched above the
   * fallback, so what lands here is a typo or an endpoint that has not
   * shipped, and a JSON client wants the 404 it can act on rather than a
   * page it will fail to parse. `/assets/` makes "a missing bundle 404s"
   * true because of WHERE it is, not merely because Vite happens to put an
   * extension on every file it emits.
   */
  it.each([
    "/api/unknown",
    "/api/tray/open",
    "/api/",
    "/assets/no-extension",
  ])(
    "404s in JSON for %s — a reserved namespace is never a client route",
    (url) => {
      const response = handleSync(
        buildRouter(buildWebAssets()),
        {
          method: "GET",
          url,
        },
      )

      expect(response.status).toBe(404)
      expect(response.contentType).toBe(
        "application/json; charset=utf-8",
      )
    },
  )

  it("still serves a real asset under a reserved prefix", () => {
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/assets/index-abc123.js",
      },
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toContain(
      "text/javascript",
    )
  })
})

describe("the dashboard", () => {
  it("serves the built index.html at /", () => {
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/",
      },
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toBe(
      "text/html; charset=utf-8",
    )
    expect(String(response.body)).toBe(INDEX_HTML)
  })

  it("keeps the query string out of the lookup", () => {
    // `?fake=verdicts` is the page's own state and is read by
    // the app from `window.location.search`, then forwarded to
    // `/json?fake=`. It must not turn `/` into a miss.
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/?fake=verdicts",
      },
    )

    expect(response.status).toBe(200)
    expect(String(response.body)).toBe(INDEX_HTML)
  })

  it("serves a hashed asset, cacheable forever", () => {
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/assets/index-abc123.js",
      },
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toBe(
      "text/javascript; charset=utf-8",
    )
    expect(response.cachePolicy).toBe("immutable")
  })

  it("never caches index.html, which names the hashes", () => {
    expect(
      handleSync(buildRouter(buildWebAssets()), {
        method: "GET",
        url: "/",
      }).cachePolicy,
    ).toBe("no-store")
  })

  it("cannot shadow the API, whatever it holds", async () => {
    // The reason the static branch is last. If a `dist/json`
    // ever existed, `/json` would still be the live document.
    const router = buildRouter({
      ...buildWebAssets(),
      readAsset: () => ({
        contentType: "text/html; charset=utf-8",
        body: Buffer.from("<h1>not the API</h1>"),
        isImmutable: false,
      }),
    })

    for (const url of [
      "/json",
      "/fixtures",
      "/health",
      "/healthz",
      "/logs",
      "/api/tray",
      "/eject",
    ]) {
      expect(
        (await handleAsync(router, { method: "GET", url }))
          .contentType,
      ).not.toBe("text/html; charset=utf-8")
    }
  })

  it("404s an unknown path rather than falling back to HTML", () => {
    // The app has no client-side router, so an extension-less
    // path is a typo, not a deep link — and an API client that
    // mistypes `/json` must get a status it can act on, not a
    // 200 with a page in it.
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "GET",
        url: "/assets/index-stale.js",
      },
    )

    expect(response.status).toBe(404)
    expect(response.contentType).toBe(
      "application/json; charset=utf-8",
    )
  })

  it("says the dashboard is missing rather than 404ing", () => {
    // The state of every image built before this change. A 404
    // would read as "wrong URL" when the URL is right.
    const response = handleSync(buildRouter(), {
      method: "GET",
      url: "/",
    })

    expect(response.status).toBe(503)
    expect(response.contentType).toBe(
      "text/plain; charset=utf-8",
    )
    expect(String(response.body)).toContain(
      "yarn workspace @rip-deck/web build",
    )
    // And it points at the JSON API, which still works.
    expect(String(response.body)).toContain("/json")
  })

  it("answers HEAD, because that is how people check", () => {
    // `curl -I http://tower.example.com:3007/` must not report a
    // missing dashboard that is in fact there.
    const response = handleSync(
      buildRouter(buildWebAssets()),
      {
        method: "HEAD",
        url: "/",
      },
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toBe(
      "text/html; charset=utf-8",
    )
  })

  it("does not answer a POST to /", () => {
    expect(
      handleSync(buildRouter(buildWebAssets()), {
        method: "POST",
        url: "/",
      }).status,
    ).toBe(404)
  })
})

describe("POST /api/tray", () => {
  it("hands the parsed command to the watcher, verbatim", async () => {
    const runTrayCommand = vi
      .fn<TrayCommandRunner>()
      .mockResolvedValue(buildTrayReport())

    const response = await postTray({
      body: JSON.stringify({
        command: "open_bay",
        slot: 4,
        request_id: "dash-1",
      }),
      readTrayRunner: () => runTrayCommand,
    })

    // The API decides NOTHING about which bay moves. It parses
    // and hands over; `decideTrayBayAction` is authoritative and
    // is reached through this call, never around it.
    expect(runTrayCommand).toHaveBeenCalledWith({
      request: { kind: "open_bay", target: { slot: 4 } },
      requestId: "dash-1",
    })

    expect(response.status).toBe(200)
    // Byte-identical to what `resp/drive` publishes: one payload
    // shape serves the dashboard and Home Assistant alike.
    expect(
      parseBody<TrayCommandResponsePayload>(response.body),
    ).toEqual(buildTrayReport())
  })

  it("accepts a drive_id as well as a slot", async () => {
    const runTrayCommand = vi
      .fn<TrayCommandRunner>()
      .mockResolvedValue(buildTrayReport())

    await postTray({
      body: JSON.stringify({
        command: "close_bay",
        drive_id: "2-1.1.2.3",
      }),
      readTrayRunner: () => runTrayCommand,
    })

    expect(runTrayCommand).toHaveBeenCalledWith({
      request: {
        kind: "close_bay",
        target: { driveId: "2-1.1.2.3" },
      },
      requestId: null,
    })
  })

  it("takes the bulk commands the RODRET sends", async () => {
    const runTrayCommand = vi
      .fn<TrayCommandRunner>()
      .mockResolvedValue(buildTrayReport())

    for (const command of ["open_trays", "close_trays"]) {
      await postTray({
        body: JSON.stringify({ command }),
        readTrayRunner: () => runTrayCommand,
      })
    }

    expect(
      runTrayCommand.mock.calls.map(
        ([call]) => call.request.kind,
      ),
    ).toEqual(["open_trays", "close_trays"])
  })

  it("passes a refusal straight through, unedited", async () => {
    // The load-bearing one. When the daemon refuses a ripping
    // bay, HTTP reports the refusal as the daemon worded it —
    // the API has no opinion to add and no way to override it.
    const refusal = buildTrayReport({
      message: "Refused to open slot 4: still ripping.",
      counts: {
        opened: 0,
        opened_not_ripped: 0,
        closed: 0,
        refused: 1,
        failed: 0,
        skipped: 0,
        rip_started: 0,
      },
      bays: [
        {
          drive_id: "usb-2-1-1-2-4-4-2",
          slot: 4,
          label: "04 - Pioneer BDR-211M",
          result: "refused_ripping",
          detail: "REFUSED — this bay is ripping.",
        },
      ],
    })

    const response = await postTray({
      body: JSON.stringify({
        command: "open_bay",
        slot: 4,
      }),
      readTrayRunner: () => () => Promise.resolve(refusal),
    })

    // 200: the command was accepted, understood and answered.
    // The refusal is IN the report, which is where an operator
    // and an automation both already look for it.
    expect(response.status).toBe(200)
    expect(
      parseBody<TrayCommandResponsePayload>(response.body),
    ).toEqual(refusal)
  })

  it("rejects a body cmd/drive would also reject", async () => {
    const runTrayCommand = vi.fn<TrayCommandRunner>()

    const response = await postTray({
      body: JSON.stringify({ command: "open_the_pod_bay" }),
      readTrayRunner: () => runTrayCommand,
    })

    const payload = parseBody<TrayCommandResponsePayload>(
      response.body,
    )

    expect(response.status).toBe(400)
    // Never reached a drive.
    expect(runTrayCommand).not.toHaveBeenCalled()
    // The same rejection shape `resp/drive` publishes, so one
    // reader handles both transports.
    expect(payload.is_accepted).toBe(false)
    expect(payload.command).toBeNull()
    expect(payload.message).toContain("open_the_pod_bay")
  })

  it("rejects an open_bay with no bay named", async () => {
    const response = await postTray({
      body: JSON.stringify({ command: "open_bay" }),
      readTrayRunner: () => () =>
        Promise.resolve(buildTrayReport()),
    })

    expect(response.status).toBe(400)
    expect(
      parseBody<TrayCommandResponsePayload>(response.body)
        .message,
    ).toContain("slot")
  })

  it("says 503 when no watcher is attached", async () => {
    // `rip-deck serve` without `watch`: a real runtime state, not
    // a bug. There is no bay table and nothing here may touch a
    // drive, and the message says which.
    const response = await postTray({
      body: JSON.stringify({ command: "open_trays" }),
    })

    const payload = parseBody<TrayCommandResponsePayload>(
      response.body,
    )

    expect(response.status).toBe(503)
    expect(payload.is_accepted).toBe(false)
    expect(payload.message).toContain("rip-deck watch")
  })

  it("answers even when the command path throws", async () => {
    // A tray command that reports NOTHING is the bug this
    // feature exists to prevent: an operator who pressed a
    // button and saw nothing cannot tell a broken button from a
    // broken daemon.
    const response = await postTray({
      body: JSON.stringify({ command: "close_trays" }),
      readTrayRunner: () => () =>
        Promise.reject(new Error("sysfs went away")),
    })

    expect(response.status).toBe(500)
    expect(
      parseBody<TrayCommandResponsePayload>(response.body)
        .message,
    ).toContain("sysfs went away")
  })

  it("is POST only", async () => {
    const response = await handleAsync(buildRouter(), {
      method: "GET",
      url: "/api/tray",
    })

    expect(response.status).toBe(405)
    expect(
      parseBody<{ ok: boolean; msg: string }>(
        response.body,
      ),
    ).toEqual({ ok: false, msg: "POST only" })
  })
})

describe("GET /logs", () => {
  const buildLogRouter = (
    readLogCapture: LogCaptureReader | null,
  ) => buildRouter(undefined, { readLogCapture })

  const getLog = async (input: {
    url: string
    readLogCapture: LogCaptureReader | null
  }) =>
    await handleAsync(
      buildLogRouter(input.readLogCapture),
      { method: "GET", url: input.url },
    )

  it("serves the capture raw, as text", async () => {
    // Robot mode is a PARSED format, not prose. Served
    // byte-for-byte: summarising it by string-matching is how
    // the MSG:5072 bug happened.
    const capture =
      'MSG:5072,0,1,"Failed to open disc"\nPRGV:1,2,3\n'

    const response = await getLog({
      url: `/logs?job=${JOB_UUID}`,
      readLogCapture: () =>
        Promise.resolve({ isFound: true, text: capture }),
    })

    expect(response.status).toBe(200)
    expect(response.contentType).toBe(
      "text/plain; charset=utf-8",
    )
    expect(String(response.body)).toBe(capture)
    expect(response.cachePolicy).toBe("no-store")
  })

  it("tails 600 lines when nobody says otherwise", async () => {
    const readLogCapture = vi
      .fn<LogCaptureReader>()
      .mockResolvedValue({ isFound: true, text: "" })

    await getLog({
      url: `/logs?job=${JOB_UUID}`,
      readLogCapture,
    })

    expect(readLogCapture).toHaveBeenCalledWith({
      jobUuid: JOB_UUID,
      lines: 600,
    })
  })

  it("takes an explicit line count, and an explicit all", async () => {
    const readLogCapture = vi
      .fn<LogCaptureReader>()
      .mockResolvedValue({ isFound: true, text: "" })

    await getLog({
      url: `/logs?job=${JOB_UUID}&lines=25`,
      readLogCapture,
    })

    await getLog({
      url: `/logs?job=${JOB_UUID}&lines=25&all=1`,
      readLogCapture,
    })

    expect(
      readLogCapture.mock.calls.map(([call]) => call.lines),
    ).toEqual([25, "all"])
  })

  it("REFUSES a traversal before anything joins a path", async () => {
    // ⚠️ `job` comes from a URL and `join(stateDir, job)` on an
    // unvalidated string is a file read the caller chose. The
    // reader must not even be asked.
    const readLogCapture = vi.fn<LogCaptureReader>()

    for (const job of [
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      "bays.json",
      `${JOB_UUID}/../../etc/passwd`,
      `${JOB_UUID}.robot.log`,
      "",
    ]) {
      const response = await getLog({
        url: `/logs?job=${encodeURIComponent(job)}`,
        readLogCapture,
      })

      expect(response.status).toBe(400)
      expect(response.contentType).toBe(
        "application/json; charset=utf-8",
      )
    }

    expect(readLogCapture).not.toHaveBeenCalled()
  })

  it("needs a job at all", async () => {
    const response = await getLog({
      url: "/logs",
      readLogCapture: null,
    })

    expect(response.status).toBe(400)
    expect(
      parseBody<{ ok: boolean; msg: string }>(response.body)
        .msg,
    ).toContain("job_uuid")
  })

  it("refuses a line count that is not one", async () => {
    const readLogCapture = vi.fn<LogCaptureReader>()

    for (const lines of ["0", "-4", "abc", "999999999"]) {
      const response = await getLog({
        url: `/logs?job=${JOB_UUID}&lines=${lines}`,
        readLogCapture,
      })

      expect(response.status).toBe(400)
    }

    expect(readLogCapture).not.toHaveBeenCalled()
  })

  it("404s a job with no capture on disk", async () => {
    // Raw capture can be off, and an adopted bay from an older
    // daemon may predate the file. Not an error — an absence.
    const response = await getLog({
      url: `/logs?job=${JOB_UUID}`,
      readLogCapture: () =>
        Promise.resolve({ isFound: false }),
    })

    expect(response.status).toBe(404)
    expect(response.contentType).toBe(
      "application/json; charset=utf-8",
    )
    expect(
      parseBody<{ ok: boolean }>(response.body).ok,
    ).toBe(false)
  })

  it("is GET only", async () => {
    const response = await handleAsync(buildRouter(), {
      method: "DELETE",
      url: `/logs?job=${JOB_UUID}`,
    })

    expect(response.status).toBe(405)
  })
})

/**
 * The list the SPA fallback consults, and the thing that keeps it honest.
 *
 * The fallback widened on 2026-08-16 so the dashboard's client router could
 * own deep links. A widened fallback's characteristic failure is silently
 * swallowing a route the SERVER owns: the path used to answer JSON, it now
 * answers 200 + HTML, and every status-code-only check calls that green.
 * A sibling app in the fleet hit exactly this — a top-level `/version` its
 * own frontend polled started returning `index.html`, and the frontend read
 * the unparseable body as "server unreachable, reload".
 *
 * So the surface is declared once, in `SERVER_PATHNAMES`, and these tests
 * fail when the dispatch chain and that list drift apart.
 */
describe("the server's own surface", () => {
  const routerSource = readFileSync(
    new URL("./router.ts", import.meta.url),
    "utf8",
  )

  it("compares pathnames against constants, never inline literals", () => {
    // An inline `pathname === "/version"` is invisible to the test below,
    // which is the whole way this drifts. Route through a constant so the
    // next reader has one obvious place to declare it.
    const inlineComparisons = [
      ...routerSource.matchAll(/pathname === "([^"]+)"/g),
    ].map((match) => match[1])

    expect(inlineComparisons).toEqual([])
  })

  it("declares every pathname the dispatch chain matches on", () => {
    // Fails when a new top-level route is added and NOT declared in
    // `SERVER_PATHNAMES` — add it there, and the fallback stops
    // swallowing it.
    const comparedNames = new Set(
      [
        ...routerSource.matchAll(
          /pathname === ([A-Z][A-Z0-9_]*)/g,
        ),
        ...routerSource.matchAll(
          /([A-Z][A-Z0-9_]*)\.includes\(pathname\)/g,
        ),
      ].map((match) => match[1]),
    )

    // The dashboard's own index, which is the client's by definition.
    comparedNames.delete("INDEX_PATHNAMES")
    // The declaration list itself, consulted by `isServerRoutePathname`.
    comparedNames.delete("SERVER_PATHNAMES")

    expect([...comparedNames].sort()).toEqual([
      "FIXTURES_PATHNAME",
      "HEALTH_PATHNAMES",
      "HISTORY_PATHNAME",
      "JSON_PATHNAME",
      "LEFTOVERS_PATHNAME",
      "LOGS_PATHNAME",
      "TRAY_PATHNAME",
      "UNIMPLEMENTED_ACTION_PATHS",
    ])
  })

  it.each(SERVER_PATHNAMES)(
    "answers %s itself rather than handing it to the client router",
    async (pathname) => {
      // Awaited rather than `handleSync`d, because `/logs` and
      // `/api/tray` are the two paths allowed to be async and this
      // list covers the whole surface. What is being pinned is the
      // content type, not the blocking rule — `handleSync` guards
      // that everywhere else.
      const response = await buildRouter(
        buildWebAssets(),
      ).handle({
        method: "GET",
        url: pathname,
      })

      expect(response.contentType).not.toContain(
        "text/html",
      )
    },
  )

  /**
   * The prefix boundary, which bites from both sides.
   *
   * `startsWith("/api/")` alone lets bare `/api` through to the extension
   * test, which sees no dot and serves the dashboard — 200 HTML where a
   * JSON 404 stood before the router. `startsWith("/api")` alone
   * over-matches and eats `/apiary`, a perfectly good client route.
   */
  it.each(["/api", "/assets"])(
    "404s in JSON for bare %s — the namespace includes its own root",
    (pathname) => {
      const response = handleSync(
        buildRouter(buildWebAssets()),
        {
          method: "GET",
          url: pathname,
        },
      )

      expect(response.status).toBe(404)
      expect(response.contentType).toBe(
        "application/json; charset=utf-8",
      )
    },
  )

  it.each(["/apiary", "/assetsomething"])(
    "still serves the dashboard for %s — the prefix must not over-match",
    (pathname) => {
      const response = handleSync(
        buildRouter(buildWebAssets()),
        {
          method: "GET",
          url: pathname,
        },
      )

      expect(response.status).toBe(200)
      expect(response.contentType).toContain("text/html")
    },
  )
})
