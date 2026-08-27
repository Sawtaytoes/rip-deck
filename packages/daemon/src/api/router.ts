import type { TopicConfig } from "../mqtt/topics.ts"
import {
  createFixtureSnapshot,
  FIXTURE_NAMES,
  isFixtureName,
} from "./fixtures.ts"
import { handleHistoryList } from "./historyEndpoint.ts"
import { buildJsonDocument } from "./jsonDocument.ts"
import {
  handleLeftoversList,
  handleLeftoversWrite,
} from "./leftoversEndpoint.ts"
import {
  isSafeJobUuid,
  LOG_CAPTURE_TUNING,
  type LogCaptureReader,
} from "./logCapture.ts"
import type { TowerSnapshot } from "./snapshot.ts"
import {
  handleTrayCommandRequest,
  type TrayCommandRunner,
} from "./trayEndpoint.ts"
import {
  EMPTY_WEB_ASSETS,
  HASHED_PREFIX,
  WEB_INDEX_PATHNAME,
  type WebAsset,
  type WebAssets,
} from "./webAssets.ts"

/**
 * The HTTP surface, as a function of a request.
 *
 * Routing and body-building are separated from the socket so the
 * whole surface is testable without listening on a port, and so
 * swapping `node:http` for a framework later is a change in one
 * file. This needs no framework: one JSON view, a handful of
 * static files, a log tail and one write endpoint.
 *
 * ## The blocking rule, stated precisely
 *
 * The parent process supervises nine bays. Anything that blocks
 * it blocks all nine bays' monitoring AND this API at once, which
 * is the exact failure the child-per-drive architecture exists to
 * prevent. So:
 *
 *  - **`/json`, `/fixtures`, `/health` and every asset path are
 *    strictly synchronous reads of memory.** They touch no
 *    device, no child process and no disk. The dashboard's files
 *    were read once at startup by `loadWebAssets`, so serving
 *    them is a map lookup, not a `readFileSync`. Nothing may be
 *    added to those paths that awaits anything.
 *  - **`POST /api/tray` and `GET /logs` are allowed to be
 *    async**, and are the only two that are. `handle` therefore
 *    returns `ApiResponse | Promise<ApiResponse>` — a union, not
 *    a blanket `Promise`, so the synchronous paths stay provably
 *    synchronous rather than merely usually fast.
 *  - A tray command is neither synchronous nor a read: it spawns
 *    a child per bay, and `runTrayCommand` already races each one
 *    against a 20 s watchdog (`TRAY_TUNING.commandTimeoutMs`).
 *    That watchdog is what makes a wedged drive cost one bay's
 *    line in one report — it can never delay a concurrent
 *    `/json`, because `/json` never awaits it.
 *  - `/logs` reads a 1–3 MB capture off disk, so it reads only
 *    the tail and only through `node:fs/promises`. Never
 *    `readFileSync`. See `logCapture.ts`.
 *
 * ## Why a write endpoint is not the MQTT rule being broken
 *
 * The house rule is *"services talk to each other over MQTT — not
 * new REST/shell bridges"*, and it governs service-to-service
 * integration. Rip Deck's own dashboard calling Rip Deck's own
 * daemon is one application talking to its own backend on the
 * same origin. The reasoning, and the refusal it replaces, is in
 * `trayEndpoint.ts`. `cmd/drive` is unchanged and still the path
 * the physical button uses; both callers end up in the same
 * `watcher.runTrayCommand`.
 */

export type ApiRequest = {
  method: string
  /** Path plus query, as `node:http` gives it. */
  url: string
  /**
   * The request body, read on demand and never eagerly.
   *
   * A function rather than a string so the synchronous paths
   * cost nothing: `/json` never calls this, so no snapshot
   * request ever waits on a socket that has more to send.
   * Absent for every reader that has no body to offer.
   */
  readBody?: () => Promise<string>
}

/**
 * How long a body may be reused, if at all.
 *
 * Two honest answers rather than one guessed max-age. `/json` is
 * a live snapshot of a nine-bay tower, so a cached copy is a lie
 * with a timestamp on it and it is `no-store` forever. The
 * dashboard's `assets/` are content-hashed by Vite, so new bytes
 * are always a new URL and `immutable` is a fact about the file
 * rather than a bet on how fast it changes.
 */
export type CachePolicy = "no-store" | "immutable"

export type ApiResponse = {
  status: number
  /** Full `content-type`, charset included where it applies. */
  contentType: string
  /**
   * Bytes for the dashboard's fonts and images, a string for
   * everything the daemon generates.
   */
  body: string | Uint8Array
  cachePolicy: CachePolicy
}

/** The one write endpoint. See `trayEndpoint.ts`. */
const TRAY_PATHNAME = "/api/tray"

/**
 * The folders a rip left behind, and the button that clears one.
 *
 * `GET` lists; `POST` deletes or renames, by the `command` in
 * its body. On its own path rather than on `/json` because
 * listing means walking each leftover's tree to size it — see
 * `leftoversEndpoint.ts`.
 */
const LEFTOVERS_PATHNAME = "/api/leftovers"

/**
 * Every rip this tower has finished, filterable by date.
 *
 * On its own path for the same reason `/api/leftovers` is: it
 * reads a log off disk and then joins two small files per row it
 * returns, and `/json` is a synchronous memory read that a
 * browser polls every five seconds. See `historyEndpoint.ts`.
 */
const HISTORY_PATHNAME = "/api/history"

/** The tower snapshot the dashboard polls. */
const JSON_PATHNAME = "/json"

/** The fixture names `?fake=` accepts. */
const FIXTURES_PATHNAME = "/fixtures"

/** The robot-mode log tail behind the logs modal. */
const LOGS_PATHNAME = "/logs"

/**
 * Liveness, under both spellings.
 *
 * `/health` is the name, because the owner asked what the `z`
 * was for and there is no good answer: `/healthz` is a
 * Kubernetes/Go convention chosen to avoid colliding with real
 * routes, and Rip Deck is not on Kubernetes.
 *
 * `/healthz` stays as an alias rather than being renamed away,
 * and it is not free to break — the Homepage tile's `siteMonitor`
 * points at `https://example.com/healthz`, as may an
 * NPM/TrueNAS healthcheck nobody has found yet. Both spellings
 * answer identically and always will.
 * (`docs/HANDOFF-stage7-ui-and-naming.md` §6)
 */
const HEALTH_PATHNAMES = ["/health", "/healthz"]

/**
 * Endpoints the ARM viewer calls that rip-deck does NOT serve.
 *
 * Answered with a JSON `{ok:false,msg}` and 501 rather than an
 * HTML 404: the viewer parses the body of a drive action either
 * way, so this turns a silent broken button into a legible "not
 * yet".
 *
 * These are the VIEWER's URLs, not rip-deck's, which is the only
 * reason they are still 501. This comment previously asserted
 * that drive commands were never coming back as REST because
 * "the house rule is MQTT" — that read of the rule was wrong and
 * it shipped as a dashboard button that refused the owner
 * (`trayEndpoint.ts` has the argument). Tray commands ARE served,
 * at `POST /api/tray`, so the message says where to go rather
 * than that there is nowhere.
 */
const UNIMPLEMENTED_ACTION_PATHS = [
  "/stop",
  "/eject",
  "/close",
  "/hide",
  "/unhide",
]

/**
 * The paths the dashboard's HTML answers outright.
 */
const INDEX_PATHNAMES = ["/", WEB_INDEX_PATHNAME]

/**
 * Every exact pathname this server answers itself.
 *
 * Built from the same constants the dispatch chain matches on, so
 * the two cannot drift: add a route above and it is covered here
 * automatically, provided it is added as a constant rather than
 * as an inline string. `router.test.ts` asserts this list and the
 * dispatch chain agree.
 */
export const SERVER_PATHNAMES = [
  JSON_PATHNAME,
  FIXTURES_PATHNAME,
  LOGS_PATHNAME,
  TRAY_PATHNAME,
  LEFTOVERS_PATHNAME,
  HISTORY_PATHNAME,
  ...HEALTH_PATHNAMES,
  ...UNIMPLEMENTED_ACTION_PATHS,
]

/**
 * Namespaces the server owns whole, bare segment included.
 *
 * `/api` is the API's and `/assets` is Vite's content-hashed
 * output. Stored WITHOUT the trailing slash and matched as
 * "equals, or starts with the slash", because both boundaries
 * bite:
 *
 * - `startsWith("/api/")` alone lets bare `/api` fall through to
 *   the extension test, which sees no dot and serves the
 *   dashboard — 200 HTML where the API answered a JSON 404
 *   before the router existed.
 * - `startsWith("/api")` alone over-matches and would swallow a
 *   real client route like `/apiary`.
 */
const SERVER_PREFIXES = [
  "/api",
  HASHED_PREFIX.replace(/\/$/, ""),
]

/**
 * Is this path the SERVER's rather than the client router's?
 *
 * The fallback consults this instead of testing prefixes inline,
 * so a new top-level route has one obvious place to be declared.
 * Everything the dispatch chain matches above the fallback is
 * here, which matters for the paths it does NOT match: a typo or
 * an endpoint that has not shipped under a namespace the server
 * owns still wants the JSON 404 its caller can act on, rather
 * than a page it will fail to parse.
 *
 * This is the same failure the extension test guards, one client
 * along: `GET /api/rips` answering 200 + HTML every day until
 * that endpoint ships is a JSON client being handed a document,
 * exactly as a moved bundle hash is the browser's script loader
 * being handed one.
 */
const isServerRoutePathname = (pathname: string): boolean =>
  SERVER_PATHNAMES.includes(pathname) ||
  SERVER_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`),
  )

/**
 * Does this path belong to the dashboard's client router?
 *
 * The previous rule was "these two paths and nothing else", because the app had
 * no client-side router — every bit of its state was in the query string
 * (`?fake=`) — so an extension-less `/bay/3` was a mistake rather than a deep
 * link. It has a router as of 2026-08-16 (fleet decision
 * `2026-08-16-owned-web-apps-use-react-router-with-path-urls`), and that comment
 * said what to do when one arrived: widen the fallback HERE, keeping every API
 * path above it.
 *
 * Two guards, in order:
 *
 * 1. **The server's own paths and namespaces win outright** —
 *    `isServerRoutePathname`. Anything the server owns keeps
 *    answering as the caller that asked expects, whether or not
 *    that exact path exists yet.
 * 2. **Extension-less only, for everything else.** A path with a
 *    dot in its last segment is asking for a FILE, so a missing
 *    `/assets/index-abc123.js` stays a 404 the browser reports —
 *    never 200 + HTML, which the browser would try to execute as
 *    JavaScript and fail on in a way that says nothing about the
 *    real problem.
 *
 * The residual cost is a mistyped `/jsonn` rendering the
 * dashboard instead of returning a JSON 404. That is the price of
 * a client router, and it is the same trade every other app in
 * the fleet makes.
 *
 * A real file still wins over both — `readAsset` is consulted
 * before this function is, so every asset that exists is served
 * as itself.
 */
const isClientRoutePathname = (
  pathname: string,
): boolean => {
  if (INDEX_PATHNAMES.includes(pathname)) return true

  if (isServerRoutePathname(pathname)) return false

  const lastSegment = pathname.slice(
    pathname.lastIndexOf("/") + 1,
  )

  return !lastSegment.includes(".")
}

/**
 * What `GET /` says when the dashboard is not in this image.
 *
 * Plain text and legible, not a 404 and not a crash. A 404 would
 * read as "wrong URL" when the URL is right and the image is
 * short a build step, and the daemon's actual job — ripping — is
 * entirely unaffected either way, so it must not fall over.
 */
const DASHBOARD_NOT_BUILT_BODY = (root: string): string =>
  "The Rip Deck dashboard is not in this build.\n\n" +
  `Nothing was found at ${root}, so \`packages/web\` was ` +
  "never built here.\n\n" +
  "Fix: rebuild the container image (its Dockerfile runs\n" +
  "`yarn workspace @rip-deck/web build`), or run that command\n" +
  "yourself if you are working from a checkout.\n\n" +
  "The JSON API is unaffected — /json, /fixtures and /health\n" +
  "all still answer.\n"

const jsonResponse = (input: {
  status: number
  payload: unknown
}): ApiResponse => ({
  status: input.status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(input.payload),
  cachePolicy: "no-store",
})

const assetResponse = (asset: WebAsset): ApiResponse => ({
  status: 200,
  contentType: asset.contentType,
  body: asset.body,
  cachePolicy: asset.isImmutable ? "immutable" : "no-store",
})

const textResponse = (input: {
  status: number
  body: string
}): ApiResponse => ({
  status: input.status,
  contentType: "text/plain; charset=utf-8",
  body: input.body,
  cachePolicy: "no-store",
})

const handleTrayRequest = async (input: {
  readBody: (() => Promise<string>) | undefined
  runTrayCommand: TrayCommandRunner | null
  nowMs: number
}): Promise<ApiResponse> => {
  // A caller with no body reader sends the empty payload, which
  // `parseTrayCommand` already rejects in better words than
  // anything invented here would.
  const body =
    input.readBody === undefined
      ? ""
      : await input.readBody()

  const result = await handleTrayCommandRequest({
    body,
    runTrayCommand: input.runTrayCommand,
    nowMs: input.nowMs,
  })

  return jsonResponse({
    status: result.status,
    payload: result.payload,
  })
}

/**
 * How many lines `?lines=` asks for, or why it makes no sense.
 *
 * `?all=1` wins outright — it is the explicit "load the whole
 * capture" the tail default exists to avoid doing by accident.
 */
const readRequestedLines = (
  params: URLSearchParams,
):
  | { isValid: true; lines: number | "all" }
  | { isValid: false; msg: string } => {
  const all = params.get("all")

  if (all === "1" || all === "true") {
    return { isValid: true, lines: "all" }
  }

  const raw = params.get("lines")

  if (raw === null) {
    return {
      isValid: true,
      lines: LOG_CAPTURE_TUNING.defaultLines,
    }
  }

  const lines = Number.parseInt(raw, 10)

  if (Number.isNaN(lines) || lines < 1) {
    return {
      isValid: false,
      msg: `\`lines\` must be a positive integer, not "${raw}"`,
    }
  }

  if (lines > LOG_CAPTURE_TUNING.maxLines) {
    return {
      isValid: false,
      msg:
        `\`lines\` tops out at ` +
        `${String(LOG_CAPTURE_TUNING.maxLines)}. Ask for ` +
        "`all=1` if you want the whole capture.",
    }
  }

  return { isValid: true, lines }
}

const handleLogsRequest = async (input: {
  params: URLSearchParams
  readLogCapture: LogCaptureReader | null
}): Promise<ApiResponse> => {
  const jobUuid = input.params.get("job")

  if (jobUuid === null) {
    return jsonResponse({
      status: 400,
      payload: {
        ok: false,
        msg:
          "/logs needs a `job` — the `job_uuid` /json reports " +
          "for that bay.",
      },
    })
  }

  // ⚠️ The traversal gate, and it comes BEFORE anything joins a
  // path. `?job=../../etc/passwd` is a 400 here, not a file.
  if (!isSafeJobUuid(jobUuid)) {
    return jsonResponse({
      status: 400,
      payload: {
        ok: false,
        msg:
          "`job` is not a job id. Captures are named for a " +
          "UUID; nothing else is looked up.",
      },
    })
  }

  const requested = readRequestedLines(input.params)

  if (!requested.isValid) {
    return jsonResponse({
      status: 400,
      payload: { ok: false, msg: requested.msg },
    })
  }

  if (input.readLogCapture === null) {
    return jsonResponse({
      status: 404,
      payload: {
        ok: false,
        msg:
          "this process serves no captures — it was started " +
          "without a state directory to read them from.",
      },
    })
  }

  const result = await input.readLogCapture({
    jobUuid,
    lines: requested.lines,
  })

  if (!result.isFound) {
    return jsonResponse({
      status: 404,
      payload: {
        ok: false,
        msg: `no capture on disk for job ${jobUuid}`,
      },
    })
  }

  // Raw, byte-for-byte, `text/plain`. A robot-mode log is a
  // parsed format and summarising it by string-matching is how
  // the `MSG:5072` bug happened; the modal renders it, nothing
  // here interprets it.
  return textResponse({ status: 200, body: result.text })
}

export type ApiRouter = {
  /**
   * A response, or a promise of one.
   *
   * The union is the invariant, not an inconvenience: only
   * `POST /api/tray` and `GET /logs` return the promise arm, and
   * every snapshot and asset path still returns synchronously —
   * see the header. Callers must handle both.
   */
  handle: (
    request: ApiRequest,
  ) => ApiResponse | Promise<ApiResponse>
}

export const createApiRouter = ({
  readSnapshot,
  readNowMs = () => Date.now(),
  topicConfig,
  // Defaulting to none rather than loading `dist/` here: this
  // factory is called from tests and from the server, and a
  // constructor that reads a directory is one nobody expects to.
  // `createApiServer` does the loading, once, at startup.
  webAssets = EMPTY_WEB_ASSETS,
  // Both default to "this process cannot do that", which is a
  // real runtime state rather than a missing argument: an API
  // served without `rip-deck watch` has no watcher to command and
  // no state directory to read. Defaulting them also means every
  // existing caller — and every existing test — constructs a
  // router with no new argument and gets the honest answer.
  readTrayRunner = () => null,
  readLogCapture = null,
  readLogExists = null,
  destinationRoot = null,
  historyStateDir = null,
}: {
  readSnapshot: () => TowerSnapshot
  readNowMs?: () => number
  topicConfig?: TopicConfig
  webAssets?: WebAssets
  /**
   * The watcher's tray command, read at REQUEST time.
   *
   * A getter rather than the function itself because `main.ts`
   * brings the API up BEFORE the watcher exists — deliberately,
   * so a port already in use is reported before nine bays start
   * moving. A POST that lands in that window gets a legible 503
   * instead of a handler bound to nothing.
   */
  readTrayRunner?: () => TrayCommandRunner | null
  readLogCapture?: LogCaptureReader | null
  /**
   * Does a capture exist for this job? See `logCapture.ts`.
   *
   * Separate from `readLogCapture` because the question is
   * different: `/logs` reads a tail, and `/api/history` only asks
   * whether a row's Logs button has anything behind it. Null
   * means this process serves no captures, and every history row
   * then reports `has_log: false` — which is exactly true of it.
   */
  readLogExists?:
    | ((jobUuid: string) => Promise<boolean>)
    | null
  /**
   * Where finished rips land, so leftovers can be found in it.
   *
   * Null means this process was not told — a fixture server, or
   * an API brought up without `rip-deck watch`. The endpoint then
   * answers 503 rather than guessing a path, because the one
   * thing worse than not listing leftovers is deleting inside a
   * directory nobody named.
   */
  destinationRoot?: string | null
  /**
   * Where `history.jsonl` and the per-job files live.
   *
   * Null means this process was not told, and `/api/history`
   * then answers 503 rather than reading a directory nobody
   * named — the same shape `destinationRoot` uses one field up,
   * and for the same reason: a fixture server and an API brought
   * up without `rip-deck watch` are both real states.
   */
  historyStateDir?: string | null
}): ApiRouter => ({
  handle: ({ method, url, readBody }) => {
    // A relative URL needs a base; the host is irrelevant to
    // routing and never read back out.
    const parsed = new URL(url, "http://rip-deck.invalid")
    const { pathname } = parsed
    const nowMs = readNowMs()

    if (pathname === JSON_PATHNAME) {
      if (method !== "GET") {
        return jsonResponse({
          status: 405,
          payload: { ok: false, msg: "GET only" },
        })
      }

      const fixture = parsed.searchParams.get("fake")

      if (fixture !== null && !isFixtureName(fixture)) {
        return jsonResponse({
          status: 400,
          payload: {
            ok: false,
            msg: `unknown fixture "${fixture}"`,
            fixtures: FIXTURE_NAMES,
          },
        })
      }

      return jsonResponse({
        status: 200,
        payload: buildJsonDocument({
          snapshot:
            fixture === null
              ? readSnapshot()
              : createFixtureSnapshot({
                  name: fixture,
                  nowMs,
                }),
          nowMs,
          isFake: fixture !== null,
          fixture,
          topicConfig,
        }),
      })
    }

    if (
      pathname === FIXTURES_PATHNAME &&
      method === "GET"
    ) {
      return jsonResponse({
        status: 200,
        payload: { fixtures: FIXTURE_NAMES },
      })
    }

    if (
      HEALTH_PATHNAMES.includes(pathname) &&
      method === "GET"
    ) {
      // Liveness of the API process only. It says nothing about
      // the tower, and an empty rack is not unhealthy (F3).
      // Byte-identical under both spellings, so a monitor cannot
      // tell which one it asked for.
      return jsonResponse({
        status: 200,
        payload: { ok: true, at: nowMs },
      })
    }

    // ⚠️ ASYNC FROM HERE, and only here. See the header: this
    // spawns a child per bay behind a 20 s watchdog, and it sits
    // BELOW every synchronous path so a wedged drive can never
    // be between a browser and `/json`.
    if (pathname === TRAY_PATHNAME) {
      if (method !== "POST") {
        return jsonResponse({
          status: 405,
          payload: { ok: false, msg: "POST only" },
        })
      }

      return handleTrayRequest({
        readBody,
        runTrayCommand: readTrayRunner(),
        nowMs,
      })
    }

    // Also async, and also below every synchronous path: a list
    // walks each leftover's tree.
    if (pathname === LEFTOVERS_PATHNAME) {
      if (destinationRoot === null) {
        return jsonResponse({
          status: 503,
          payload: {
            ok: false,
            msg:
              "this process was not told where rips land, so " +
              "it cannot list or clear leftovers. That needs " +
              "`rip-deck watch`.",
          },
        })
      }

      if (method === "GET" || method === "HEAD") {
        return handleLeftoversList({
          destinationRoot,
        }).then(jsonResponse)
      }

      if (method === "POST") {
        // A caller with no body reader sends the empty payload,
        // which `readLeftoversCommand` refuses by name — the
        // same shape `handleTrayRequest` uses one route above.
        //
        // `handleLeftoversWrite` picks the verb out of the
        // body's `command`, so this route knows about delete and
        // rename without naming either.
        return (
          readBody === undefined
            ? Promise.resolve("")
            : readBody()
        )
          .then((body) =>
            handleLeftoversWrite({
              body,
              destinationRoot,
            }),
          )
          .then(jsonResponse)
      }

      return jsonResponse({
        status: 405,
        payload: { ok: false, msg: "GET or POST only" },
      })
    }

    // Async, and below every synchronous path for the same
    // reason the two above it are: it reads a log off disk and
    // joins a file pair per row.
    if (pathname === HISTORY_PATHNAME) {
      if (method !== "GET" && method !== "HEAD") {
        return jsonResponse({
          status: 405,
          payload: { ok: false, msg: "GET only" },
        })
      }

      return handleHistoryList({
        stateDir: historyStateDir,
        params: parsed.searchParams,
        readLogExists,
      }).then(jsonResponse)
    }

    if (pathname === LOGS_PATHNAME) {
      if (method !== "GET" && method !== "HEAD") {
        return jsonResponse({
          status: 405,
          payload: { ok: false, msg: "GET only" },
        })
      }

      return handleLogsRequest({
        params: parsed.searchParams,
        readLogCapture,
      })
    }

    if (UNIMPLEMENTED_ACTION_PATHS.includes(pathname)) {
      return jsonResponse({
        status: 501,
        payload: {
          ok: false,
          msg:
            `${pathname} is the ARM viewer's URL and rip-deck ` +
            "does not serve it. The tray commands Rip Deck DOES " +
            "serve are at POST /api/tray (open_trays, " +
            "close_trays, open_bay, close_bay), and the same " +
            "commands go over MQTT at cmd/drive.",
        },
      })
    }

    // The dashboard comes LAST, strictly below every API path, so
    // no static file can ever shadow `/json` or turn a 501 into a
    // page.
    //
    // HEAD as well as GET, because `curl -I http://host:3007/` is
    // the first thing anyone reaches for to check this is up, and
    // a 404 there would say the dashboard is missing when it is
    // not. `node:http` drops the body for a HEAD response by
    // itself, so returning the full asset here is correct.
    if (method === "GET" || method === "HEAD") {
      // A real file wins over the router: `/index.html` is both an asset and an
      // index path, and an asset that EXISTS should be served as itself.
      const asset =
        webAssets.readAsset({ pathname }) ??
        (isClientRoutePathname(pathname)
          ? webAssets.readIndexHtml()
          : null)

      if (asset !== null) return assetResponse(asset)

      if (isClientRoutePathname(pathname)) {
        return {
          status: 503,
          contentType: "text/plain; charset=utf-8",
          body: DASHBOARD_NOT_BUILT_BODY(webAssets.root),
          cachePolicy: "no-store",
        }
      }
    }

    // Still JSON, and still never HTML. An asset that is missing
    // because the bundle moved on must fail as a 404 a browser
    // reports, not as an HTML page it tries to execute as JS.
    return jsonResponse({
      status: 404,
      payload: {
        ok: false,
        msg: `no route for ${pathname}`,
      },
    })
  },
})
