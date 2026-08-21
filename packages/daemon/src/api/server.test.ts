import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_TOPIC_CONFIG } from "../mqtt/topics.ts"
import {
  buildTrayCommandResponse,
  decideTrayBayAction,
  type TrayCommandResponsePayload,
} from "../rip/trayCommand.ts"
import type {
  BayObservation,
  BayState,
} from "../rip/watcher.ts"
import type { RipDeckJsonDocument } from "./jsonDocument.ts"
import { logCaptureFilename } from "./logCapture.ts"
import {
  createApiServer,
  DEFAULT_API_PORT,
  readApiPort,
} from "./server.ts"
import {
  createBaySnapshot,
  createTowerStore,
} from "./snapshot.ts"
import type { TrayCommandRunner } from "./trayEndpoint.ts"
import type { WebAssets } from "./webAssets.ts"

/**
 * One real socket, on an ephemeral port.
 *
 * Everything above this is pure, so this test exists only to
 * prove the last inch: that `node:http` is wired up, that a
 * browser's `fetch("/json")` gets JSON with the right headers,
 * that `GET /` gets the dashboard's actual bytes, and that the
 * process can let go of the port again. Until a real request has
 * been made against it, nothing here is verified.
 *
 * Nothing here talks to a broker or a drive. The SNAPSHOT path
 * does no I/O at all, which is the point — a drive wedged in
 * D-state must not be able to freeze the API — and the tray
 * suite below proves that promise survived the arrival of a
 * write endpoint that can wedge.
 */

const NOW_MS = 1_800_000_000_000

const JOB_UUID = "6f1b2c3d-0000-4000-8000-000000000001"

const INDEX_HTML =
  '<!doctype html><html><body><div id="root"></div>' +
  '<script type="module" src="/assets/index-abc123.js">' +
  "</script></body></html>"

/**
 * A dashboard described rather than built.
 *
 * The suite must pass whether or not `packages/web/dist` exists
 * — CI runs `yarn install` and the tests, not `vite build` — so
 * asserting against the real bundle here would make this file
 * green or red for a reason that has nothing to do with the
 * server. Loading the real `dist/` is `loadWebAssets`' job and is
 * covered in `webAssets.test.ts`.
 */
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
        body: Buffer.from("console.log('rip-deck')"),
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

let close: (() => Promise<void>) | null = null

afterEach(async () => {
  await close?.()
  close = null
})

const startServer = async ({
  webAssets = buildWebAssets(),
  readTrayRunner,
  stateDir,
}: {
  webAssets?: WebAssets
  readTrayRunner?: () => TrayCommandRunner | null
  stateDir?: string
} = {}) => {
  const store = createTowerStore()

  store.setBay({
    bay: createBaySnapshot({
      driveId: "usb-2-1-1-2-4-4-2",
      label: "02 - Pioneer BDR-211M",
      slot: 2,
      devPath: "/dev/sr7",
    }),
  })

  const server = createApiServer({
    readSnapshot: store.readSnapshot,
    // Port 0 — the OS picks a free one, so a developer already
    // running the daemon does not fail the suite.
    port: 0,
    host: "127.0.0.1",
    readNowMs: () => NOW_MS,
    topicConfig: DEFAULT_TOPIC_CONFIG,
    webAssets,
    readTrayRunner,
    // Somewhere with no captures in it, so a test that forgets
    // to ask for one reads an empty directory rather than the
    // developer's real `/var/lib/rip-deck`.
    stateDir:
      stateDir ?? join(tmpdir(), "rip-deck-no-such"),
  })

  const { port } = await server.listen()

  close = server.close

  return { port, store }
}

describe("the API server", () => {
  it("serves /json over HTTP with no-store", async () => {
    const { port } = await startServer()

    const response = await fetch(
      `http://127.0.0.1:${port}/json`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )
    expect(response.headers.get("cache-control")).toBe(
      "no-store",
    )

    const document =
      (await response.json()) as RipDeckJsonDocument

    expect(document.hosts[0].host).toBe("tower")
    expect(document.ripDeck.bays).toHaveLength(1)
  })

  it("reflects a bay added after it started listening", async () => {
    const { port, store } = await startServer()

    store.setBay({
      bay: createBaySnapshot({
        driveId: "usb-2-1-1-2-4-4-3",
        label: "03 - Pioneer BDR-211M",
        slot: 3,
      }),
    })

    const document = (await (
      await fetch(`http://127.0.0.1:${port}/json`)
    ).json()) as RipDeckJsonDocument

    expect(document.ripDeck.bays).toHaveLength(2)
  })

  it("answers a health check under both names", async () => {
    // `/health` is the name — the owner asked what the `z` was
    // for and there is no answer that is not "Kubernetes", which
    // this is not on. `/healthz` stays because the Homepage
    // tile's siteMonitor points at it and a rename would take
    // the tile red for a reason that has nothing to do with the
    // tower.
    const { port } = await startServer()

    const [health, healthz] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`),
      fetch(`http://127.0.0.1:${port}/healthz`),
    ])

    expect(health.status).toBe(200)
    expect(healthz.status).toBe(200)
    expect(await healthz.text()).toBe(await health.text())
  })
})

describe("the dashboard, over the same socket", () => {
  it("serves the built HTML at /", async () => {
    const { port } = await startServer()

    const response = await fetch(
      `http://127.0.0.1:${port}/`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    )
    // Never cached: it names the hashed bundle, and a cached
    // copy pins a browser to one that no longer exists.
    expect(response.headers.get("cache-control")).toBe(
      "no-store",
    )
    expect(await response.text()).toBe(INDEX_HTML)
  })

  it("serves the hashed bundle the HTML asks for", async () => {
    const { port } = await startServer()

    const response = await fetch(
      `http://127.0.0.1:${port}/assets/index-abc123.js`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    )
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    )
    expect(await response.text()).toBe(
      "console.log('rip-deck')",
    )
  })

  it("still serves /json from the same origin", async () => {
    // The whole reason the dashboard lives here: one origin, so
    // the page's `fetch("/json")` needs no base URL and no CORS.
    const { port } = await startServer()

    const [page, json] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/json`),
    ])

    expect(page.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    )
    expect(json.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )

    const document =
      (await json.json()) as RipDeckJsonDocument

    expect(document.ripDeck.bays).toHaveLength(1)
  })

  it("forwards ?fake= to the API, not to the page", async () => {
    // The page is the same bytes either way; what makes it say
    // it is not looking at the rack is `is_fake` on the reply.
    const { port } = await startServer()

    const page = await fetch(
      `http://127.0.0.1:${port}/?fake=verdicts`,
    )

    expect(await page.text()).toBe(INDEX_HTML)

    const document = (await (
      await fetch(
        `http://127.0.0.1:${port}/json?fake=verdicts`,
      )
    ).json()) as RipDeckJsonDocument

    expect(document.ripDeck.is_fake).toBe(true)
    expect(document.ripDeck.fixture).toBe("verdicts")
  })

  it("explains itself when nothing was built", async () => {
    const { port } = await startServer({
      webAssets: {
        readAsset: () => null,
        readIndexHtml: () => null,
        fileCount: 0,
        totalBytes: 0,
        root: "/app/packages/web/dist",
      },
    })

    const response = await fetch(
      `http://127.0.0.1:${port}/`,
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    )
    expect(await response.text()).toContain(
      "yarn workspace @rip-deck/web build",
    )
  })
})

describe("the port", () => {
  it("falls back rather than binding port NaN", () => {
    expect(readApiPort({})).toBe(DEFAULT_API_PORT)
    expect(
      readApiPort({ RIP_DECK_API_PORT: "not-a-port" }),
    ).toBe(DEFAULT_API_PORT)
    expect(readApiPort({ RIP_DECK_API_PORT: "9123" })).toBe(
      9123,
    )
  })
})

/**
 * The tray command, end to end, over a real socket.
 *
 * The runner here is not a stub of the DECISION: it runs the
 * real `decideTrayBayAction` and the real
 * `buildTrayCommandResponse` over a described bay table, so the
 * question "can HTTP open a ripping bay" is answered by the same
 * function `cmd/drive` is answered by. Only the spawning and the
 * bus probe are absent, and those need hardware.
 */
const buildBayState = (
  overrides: Partial<BayState> = {},
): BayState => ({
  driveId: "usb-2-1-1-2-4-4-2",
  phase: "done",
  sizeSectors: 24_000_000,
  outcome: {
    kind: "completed",
    detail: "/media/Disc-Rips/Ivanhoe",
  },
  // Both are ledger fields now rather than prose in `detail`
  // (unit B), and both are required on `BayState` — so a
  // partial-override helper has to spell them out or every
  // caller silently drops to `undefined`.
  discName: "IVANHOE",
  discType: "bluray",
  destinationPath: "/media/Disc-Rips/Ivanhoe",
  isAdopted: false,
  latchedAtMs: NOW_MS - 60_000,
  jobUuid: JOB_UUID,
  // Nothing has moved this drawer yet, which is what the ⏏
  // toggle reads as "the next press opens it".
  lastTrayCommand: null,
  startCount: 1,
  emptyObservationCount: 0,
  hasSettledEmpty: false,
  lastFinished: null,
  isLoadedDismissed: false,
  updatedAtMs: NOW_MS,
  ...overrides,
})

const OBSERVATION: BayObservation = {
  isDrivePresent: true,
  hasMedia: true,
  sizeSectors: 24_000_000,
}

/** One bay, decided by the daemon's own rules. */
const createRealDecisionRunner =
  (bay: BayState): TrayCommandRunner =>
  ({ request, requestId }) => {
    const decision = decideTrayBayAction({
      request,
      bay,
      observation: OBSERVATION,
    })

    return Promise.resolve(
      buildTrayCommandResponse({
        request,
        requestId: requestId ?? null,
        results: [
          {
            driveId: bay.driveId,
            slot: 4,
            label: "04 - Pioneer BDR-211M",
            resultKind:
              decision.action === "open"
                ? "opened"
                : decision.action === "close"
                  ? "closed"
                  : decision.action === "rip"
                    ? "rip_started"
                    : decision.resultKind,
            detail:
              decision.action === "open" ||
              decision.action === "close" ||
              decision.action === "rip"
                ? "moved"
                : decision.detail,
          },
        ],
        startedAtMs: NOW_MS,
        finishedAtMs: NOW_MS + 800,
      }),
    )
  }

const postTray = async (input: {
  port: number
  body: unknown
}): Promise<Response> =>
  await fetch(`http://127.0.0.1:${input.port}/api/tray`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
  })

describe("POST /api/tray", () => {
  it("opens a finished bay the owner asked for", async () => {
    // The feature. The owner pressed Open tray and got a red box
    // saying there was no REST endpoint "by design"; there is
    // one now, and it is not a new transport — it is the same
    // `runTrayCommand` `cmd/drive` calls, on the same origin and
    // the same port that already serves /json.
    const { port } = await startServer({
      readTrayRunner: () =>
        createRealDecisionRunner(buildBayState()),
    })

    const response = await postTray({
      port,
      body: { command: "open_bay", slot: 4 },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )

    const payload =
      (await response.json()) as TrayCommandResponsePayload

    expect(payload.is_accepted).toBe(true)
    expect(payload.counts.opened).toBe(1)
    expect(payload.bays[0].result).toBe("opened")
  })

  it("⚠️ REFUSES a ripping bay, in the daemon", async () => {
    // The one rule that outranks the feature. Opening a tray
    // mid-rip destroys 90 GB and an hour, so the refusal is the
    // FIRST branch of `decideTrayBayAction` and the HTTP path
    // goes through it — a dashboard bug cannot route around it,
    // because the dashboard never decides.
    const { port } = await startServer({
      readTrayRunner: () =>
        createRealDecisionRunner(
          buildBayState({
            phase: "ripping",
            outcome: null,
          }),
        ),
    })

    const payload = (await (
      await postTray({
        port,
        body: { command: "open_bay", slot: 4 },
      })
    ).json()) as TrayCommandResponsePayload

    expect(payload.counts.opened).toBe(0)
    expect(payload.counts.refused).toBe(1)
    expect(payload.bays[0].result).toBe("refused_ripping")
    // Loud, not silent: the refusal is the first sentence, and
    // it is the sentence a house speaker reads out.
    expect(payload.message).toContain("Refused")
    expect(payload.bays[0].detail).toContain("REFUSED")
  })

  it("refuses a `starting` bay too, not just a ripping one", async () => {
    // A bay whose child has been spawned but has not reported
    // yet is exactly as unsafe to open.
    const { port } = await startServer({
      readTrayRunner: () =>
        createRealDecisionRunner(
          buildBayState({
            phase: "starting",
            outcome: null,
          }),
        ),
    })

    const payload = (await (
      await postTray({
        port,
        body: { command: "open_bay", slot: 4 },
      })
    ).json()) as TrayCommandResponsePayload

    expect(payload.counts.refused).toBe(1)
  })

  it("never lets a wedged drive delay /json", async () => {
    // ⚠️ The invariant `router.ts`'s header states. A tray
    // command spawns a child and can hang for its full 20 s
    // watchdog; the parent process supervises nine bays, so if
    // that could sit in front of the snapshot path, one wedged
    // drive would take the dashboard down for all nine.
    let releaseTray = (): void => {}
    let announceTrayEntered = (): void => {}

    // Awaited before the snapshot is asked for, so the test
    // cannot pass by racing: the tray command is provably inside
    // the handler and provably not finished.
    const isTrayEntered = new Promise<void>((resolve) => {
      announceTrayEntered = resolve
    })

    const wedged = new Promise<TrayCommandResponsePayload>(
      (resolve) => {
        releaseTray = () => {
          resolve({
            request_id: null,
            command: "open_bay",
            is_accepted: true,
            message: "Opened 1 drive: slot 4.",
            spoken_message: "Opened 1 tray.",
            started_at: NOW_MS,
            finished_at: NOW_MS,
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
          })
        }
      },
    )

    const { port } = await startServer({
      readTrayRunner: () => () => {
        announceTrayEntered()
        return wedged
      },
    })

    const trayResponse = postTray({
      port,
      body: { command: "open_bay", slot: 4 },
    })

    await isTrayEntered

    // Not `Promise.race`: the snapshot must come back while the
    // tray command is STILL in flight, which is the whole claim.
    const snapshot = await fetch(
      `http://127.0.0.1:${port}/json`,
    )

    expect(snapshot.status).toBe(200)

    const document =
      (await snapshot.json()) as RipDeckJsonDocument

    expect(document.ripDeck.bays).toHaveLength(1)

    releaseTray()

    expect((await trayResponse).status).toBe(200)
  })

  it("says 503 rather than 500 with no watcher", async () => {
    const { port } = await startServer()

    const response = await postTray({
      port,
      body: { command: "open_completed" },
    })

    expect(response.status).toBe(503)

    const payload =
      (await response.json()) as TrayCommandResponsePayload

    expect(payload.is_accepted).toBe(false)
    expect(payload.message).toContain("rip-deck watch")
  })

  it("refuses a body big enough to be an attack", async () => {
    const { port } = await startServer({
      readTrayRunner: () =>
        createRealDecisionRunner(buildBayState()),
    })

    const response = await fetch(
      `http://127.0.0.1:${port}/api/tray`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(200_000),
      },
    ).catch(() => null)

    // Either a 500 naming the cap or a destroyed socket — what
    // must NOT happen is 200 KB being buffered in the process
    // that is supervising nine rips.
    expect(response?.status ?? 500).not.toBe(200)
  })
})

describe("GET /logs", () => {
  let logStateDir: string | null = null

  afterEach(async () => {
    if (logStateDir !== null) {
      await rm(logStateDir, {
        recursive: true,
        force: true,
      })
      logStateDir = null
    }
  })

  const startWithCapture = async (text: string) => {
    logStateDir = await mkdtemp(
      join(tmpdir(), "rip-deck-server-logs-"),
    )

    await writeFile(
      join(logStateDir, logCaptureFilename(JOB_UUID)),
      text,
      "utf8",
    )

    return await startServer({ stateDir: logStateDir })
  }

  it("serves the capture the card's Logs button asks for", async () => {
    const capture = `${Array.from(
      { length: 2_000 },
      (_unused, index) => `PRGV:${String(index)},0,65536`,
    ).join("\n")}\n`

    const { port } = await startWithCapture(capture)

    const response = await fetch(
      `http://127.0.0.1:${port}/logs?job=${JOB_UUID}&lines=10`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    )

    const lines = (await response.text())
      .trimEnd()
      .split("\n")

    expect(lines).toHaveLength(10)
    // The END of the log, which is where a MakeMKV robot log
    // says what actually happened.
    expect(lines[9]).toBe("PRGV:1999,0,65536")
  })

  it("⚠️ refuses ?job=../../etc/passwd", async () => {
    const { port } = await startWithCapture("PRGV:0,0,1\n")

    const response = await fetch(
      `http://127.0.0.1:${port}/logs?job=` +
        encodeURIComponent("../../etc/passwd"),
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )
  })

  it("404s a job with no capture", async () => {
    const { port } = await startServer()

    const response = await fetch(
      `http://127.0.0.1:${port}/logs?job=${JOB_UUID}`,
    )

    expect(response.status).toBe(404)
  })
})
