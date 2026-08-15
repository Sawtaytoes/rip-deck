import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The built dashboard, read off disk ONCE and held in memory.
 *
 * `packages/web` is a Vite SPA. The daemon serves its `dist/` so
 * the tower's UI and `/json` share one origin — no second
 * container, no CORS, no second deploy, and no chance of the page
 * and the API drifting to different versions.
 *
 * Reading the files here rather than in the router is not a style
 * choice. AGENTS.md forbids blocking the parent process on a
 * device call, and `api/router.ts` promises that every handler is
 * a synchronous read of an in-memory snapshot — a per-request
 * `readFileSync` would quietly break that promise on the one code
 * path a wedged drive must never be able to freeze. `dist/` is
 * three files and ~260 KB, so loading all of it at startup keeps
 * the promise exactly: afterwards, serving the dashboard is a
 * `Map.get`.
 *
 * It also makes path traversal impossible by construction. The
 * router looks a request path up in a map of names THIS module
 * built by walking a directory, so there is no filesystem path to
 * escape from and no `..` to normalise away.
 */

/**
 * `content-type` in full, charset included where it applies.
 *
 * A charset on a font or a PNG is meaningless; a missing charset
 * on JS or CSS is worse than meaningless, because the browser
 * then guesses the encoding and a bundle containing a single
 * non-ASCII character renders as mojibake.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest":
    "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
}

/**
 * What an unknown extension gets.
 *
 * Not a guess at the real type: a wrong `content-type` makes a
 * browser do something confidently wrong, where
 * `application/octet-stream` makes it do nothing and say so.
 */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream"

/** Vite's content-hashed output directory, inside `dist/`. */
const HASHED_PREFIX = "/assets/"

export const WEB_INDEX_PATHNAME = "/index.html"

export type WebAsset = {
  /** Full `content-type`, charset included where it applies. */
  contentType: string
  /**
   * Bytes, never a decoded string. Fonts and images are not text
   * and a round-trip through a JS string would corrupt them; the
   * text files do not need decoding to be written to a socket.
   */
  body: Buffer
  /**
   * Vite content-hashes everything under `assets/`, so the name
   * changes whenever the bytes do and the file may be cached
   * forever. `index.html` keeps its name and NAMES those hashes,
   * so caching it is precisely how a browser pins itself to a
   * bundle that no longer exists.
   */
  isImmutable: boolean
}

export type WebAssets = {
  /** `null` when the path is not part of the built dashboard. */
  readAsset: (input: {
    pathname: string
  }) => WebAsset | null
  /** `null` when no dashboard was built into this image. */
  readIndexHtml: () => WebAsset | null
  /** 0 means "nothing was built" — the router says so out loud. */
  fileCount: number
  totalBytes: number
  /** Where it looked, so the "not built" page can name it. */
  root: string
}

/**
 * Where `packages/web/dist` sits relative to this file.
 *
 * Resolved from `import.meta.url` rather than `process.cwd()`
 * on purpose: `rip-deck` is invoked from several directories
 * (`yarn dev`, the container's `/usr/local/bin/rip-deck` wrapper,
 * a per-rip container's bare argv) and a cwd-relative default
 * would serve the dashboard from only one of them.
 */
export const DEFAULT_WEB_DIST_ROOT = fileURLToPath(
  new URL("../../../web/dist/", import.meta.url),
)

export const readWebDistRoot = (
  env: Record<string, string | undefined> = process.env,
): string => env.RIP_DECK_WEB_DIST || DEFAULT_WEB_DIST_ROOT

const walkFiles = (input: {
  directory: string
}): string[] =>
  readdirSync(input.directory, {
    withFileTypes: true,
  }).flatMap((entry) => {
    const full = join(input.directory, entry.name)

    return entry.isDirectory()
      ? walkFiles({ directory: full })
      : [full]
  })

/** `<root>/assets/index-abc.js` -> `/assets/index-abc.js`. */
const toPathname = (input: {
  root: string
  file: string
}): string =>
  `/${relative(input.root, input.file)
    .split(sep)
    .join("/")}`

const buildAsset = (input: {
  pathname: string
  file: string
}): WebAsset => ({
  contentType:
    CONTENT_TYPES[extname(input.file).toLowerCase()] ??
    UNKNOWN_CONTENT_TYPE,
  body: readFileSync(input.file),
  isImmutable: input.pathname.startsWith(HASHED_PREFIX),
})

/**
 * Named `load*` rather than the house's `create*` because it does
 * real filesystem I/O, and the whole design depends on a reader
 * noticing that and keeping the call at startup.
 */
export const loadWebAssets = ({
  root = readWebDistRoot(),
}: {
  root?: string
} = {}): WebAssets => {
  const files = (() => {
    try {
      return walkFiles({ directory: root })
    } catch (error) {
      // A missing `dist/` is an ordinary state, not a failure:
      // `yarn dev` before a build, or an image built before the
      // dashboard shipped. The router answers those with a page
      // saying exactly that, and ripping is unaffected either
      // way. Anything else — a permissions problem, say — is a
      // real fault and stays loud.
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error
      }

      return []
    }
  })()

  const assets = new Map<string, WebAsset>(
    files.map((file) => {
      const pathname = toPathname({ root, file })

      return [pathname, buildAsset({ pathname, file })]
    }),
  )

  return {
    readAsset: ({ pathname }) =>
      assets.get(pathname) ?? null,

    readIndexHtml: () =>
      assets.get(WEB_INDEX_PATHNAME) ?? null,

    fileCount: assets.size,

    totalBytes: [...assets.values()].reduce(
      (total, asset) => total + asset.body.byteLength,
      0,
    ),

    root,
  }
}

/** A router with no dashboard behind it, for tests and dev. */
export const EMPTY_WEB_ASSETS: WebAssets = {
  readAsset: () => null,
  readIndexHtml: () => null,
  fileCount: 0,
  totalBytes: 0,
  root: DEFAULT_WEB_DIST_ROOT,
}
