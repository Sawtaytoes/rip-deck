import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http"
import type { AddressInfo } from "node:net"
import type { TopicConfig } from "../mqtt/topics.ts"
import type { LiveRipsReader } from "../rip/liveRips.ts"
import {
  createLogCaptureProbe,
  createLogCaptureReader,
  type LogCaptureReader,
  readStateDir,
} from "./logCapture.ts"
import {
  type ApiRouter,
  type CachePolicy,
  createApiRouter,
} from "./router.ts"
import type { TowerSnapshot } from "./snapshot.ts"
import type { TrayCommandRunner } from "./trayEndpoint.ts"
import {
  loadWebAssets,
  type WebAssets,
} from "./webAssets.ts"

/**
 * The tower's one origin: the dashboard and the JSON it reads.
 *
 * `node:http` on purpose — NO new dependency. This serves one
 * JSON document, a health check, three static files, a log tail
 * and one tray command; a framework would buy routing sugar and
 * cost a dependency in the daemon that has to run inside the
 * ripping container. `createApiRouter` is the seam if that ever
 * changes: it maps a method and a URL to a body with no knowledge
 * of the transport, so the framework swap is one file.
 *
 * The snapshot path does no I/O at all, and that is the whole
 * point of the child-per-drive architecture: a drive wedged in
 * D-state must not be able to freeze the API. `/json`, `/health`
 * and every asset are answered from memory — the dashboard's
 * files are read here, once, BEFORE anything is listening.
 * `POST /api/tray` and `GET /logs` are the two paths allowed to
 * await, which is why `router.handle` is awaited below; the
 * invariant that keeps them harmless is stated in `router.ts`'s
 * header.
 */

export const DEFAULT_API_PORT = 3007

/**
 * The most a request body may be.
 *
 * The only body this server reads is a tray command — four words
 * and a slot number, under 200 bytes. The cap exists because a
 * body read with no bound is an unbounded allocation in the
 * process that is supervising nine rips, and the socket is not
 * the daemon's to trust.
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * The `cache-control` each policy actually means.
 *
 * A year is what "forever" means in HTTP, and `immutable` stops
 * even a reload revalidating. That is safe only because Vite puts
 * a content hash in every `assets/` filename, so changed bytes
 * arrive at a changed URL and nothing can be served stale.
 */
const CACHE_CONTROL: Record<CachePolicy, string> = {
  "no-store": "no-store",
  immutable: "public, max-age=31536000, immutable",
}

export type ApiServer = {
  router: ApiRouter
  /** What it found to serve, so startup can say so out loud. */
  webAssets: WebAssets
  listen: () => Promise<{ port: number }>
  close: () => Promise<void>
}

export const readApiPort = (
  env: Record<string, string | undefined> = process.env,
): number => {
  const raw = env.RIP_DECK_API_PORT

  if (!raw) return DEFAULT_API_PORT

  const parsed = Number.parseInt(raw, 10)

  return Number.isNaN(parsed) ? DEFAULT_API_PORT : parsed
}

/**
 * Collect one request body, or refuse it for being absurd.
 *
 * Rejecting rather than truncating: half a JSON document parses
 * as a syntax error, and "the payload is not valid JSON" would
 * be a misleading thing to tell someone whose real mistake was
 * sending 4 MB at a tray endpoint.
 */
const readRequestBody = (
  request: IncomingMessage,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteCount = 0

    request.on("data", (chunk: Buffer) => {
      byteCount += chunk.length

      if (byteCount > MAX_REQUEST_BODY_BYTES) {
        request.destroy()
        reject(
          new Error(
            `request body exceeds ` +
              `${String(MAX_REQUEST_BODY_BYTES)} bytes`,
          ),
        )
        return
      }

      chunks.push(chunk)
    })

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })

    request.on("error", reject)
  })

export const createApiServer = ({
  readSnapshot,
  port = readApiPort(),
  host = "0.0.0.0",
  readNowMs,
  topicConfig,
  // The one place `packages/web/dist` is read, and it happens
  // during construction — i.e. before `listen()`, so no request
  // can ever be waiting on a disk. Injectable so tests describe
  // the dashboard they want rather than needing one on disk.
  webAssets = loadWebAssets(),
  readTrayRunner,
  // Reading captures needs only a directory name, so this one
  // CAN be defaulted honestly. `main.ts` passes the watcher's
  // own `config.stateDir` so the two can never diverge.
  stateDir = readStateDir(),
  readLogCapture = createLogCaptureReader({ stateDir }),
  // Same argument as `readLogCapture` one line up: a directory
  // name is all it needs, so it can be defaulted honestly.
  readLogExists = createLogCaptureProbe({ stateDir }),
  destinationRoot = null,
  readLiveRips,
}: {
  readSnapshot: () => TowerSnapshot
  port?: number
  host?: string
  readNowMs?: () => number
  topicConfig?: TopicConfig
  webAssets?: WebAssets
  readTrayRunner?: () => TrayCommandRunner | null
  stateDir?: string
  readLogCapture?: LogCaptureReader | null
  /** Does a capture exist for this job? See `logCapture.ts`. */
  readLogExists?:
    | ((jobUuid: string) => Promise<boolean>)
    | null
  /**
   * Where finished rips land. Null when this process was not
   * told, which makes `/api/leftovers` answer 503 rather than
   * guess a directory to delete inside.
   */
  destinationRoot?: string | null
  /**
   * Which rips are running — see `rip/liveRips.ts`.
   *
   * Undefined leaves the router on its UNKNOWN default, which
   * refuses to delete or rename an unfinished rip folder. That
   * is the right answer for a server brought up without a
   * watcher: it can see the folders and cannot see the rips.
   */
  readLiveRips?: LiveRipsReader
}): ApiServer => {
  const router = createApiRouter({
    readSnapshot,
    readNowMs,
    topicConfig,
    webAssets,
    readTrayRunner,
    readLogCapture,
    readLogExists,
    destinationRoot,
    readLiveRips,
    // The SAME directory `/logs` reads captures from, passed
    // rather than re-read, so the history log and the per-job
    // files it joins can never be looked for in two places.
    historyStateDir: stateDir,
  })

  const server: Server = createServer(
    (request, response) => {
      const send = (result: {
        status: number
        contentType: string
        body: string | Uint8Array
        cachePolicy: CachePolicy
      }): void => {
        response.writeHead(result.status, {
          "content-type": result.contentType,
          "cache-control":
            CACHE_CONTROL[result.cachePolicy],
        })
        response.end(result.body)
      }

      // A handler that throws must still answer. A hung request
      // is worse than a 500 here: the dashboard polls, and a
      // socket nobody closes is a tab that stops updating with
      // no error to show for it.
      const sendFailure = (error: unknown): void => {
        send({
          status: 500,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            ok: false,
            msg:
              error instanceof Error
                ? error.message
                : String(error),
          }),
          cachePolicy: "no-store",
        })
      }

      try {
        const result = router.handle({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          readBody: () => readRequestBody(request),
        })

        // Branched rather than `await`ed, and this is the
        // invariant made physical: a synchronous result is
        // written in the same tick it was routed in, so `/json`
        // does not even queue a microtask behind whatever
        // `/api/tray` is doing to a wedged drive.
        if (result instanceof Promise) {
          result.then(send).catch(sendFailure)
        } else {
          send(result)
        }
      } catch (error) {
        sendFailure(error)
      }
    },
  )

  return {
    router,
    webAssets,

    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          const address =
            server.address() as AddressInfo | null

          resolve({ port: address?.port ?? port })
        })
      }),

    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}
