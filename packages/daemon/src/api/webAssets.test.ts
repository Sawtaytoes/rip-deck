import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_WEB_DIST_ROOT,
  loadWebAssets,
  readWebDistRoot,
} from "./webAssets.ts"

/**
 * The dashboard's files, loaded from a directory that stands in
 * for `packages/web/dist`.
 *
 * A real temp directory rather than a mocked `fs`, because the
 * three things worth proving here are all about real files: that
 * a nested `assets/` directory is walked, that a font survives
 * the trip as bytes rather than as a mangled string, and — most
 * of all — that a missing `dist/` is an ordinary state and not an
 * exception. That last one is what stands between an image built
 * before this change and a daemon that will not start.
 */

const buildDist = (
  files: Record<string, string | Uint8Array>,
): string => {
  const root = mkdtempSync(join(tmpdir(), "rip-deck-web-"))

  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)

    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, contents)
  }

  return root
}

describe("loadWebAssets", () => {
  it("walks assets/ and types every file it finds", () => {
    const assets = loadWebAssets({
      root: buildDist({
        "index.html":
          "<!doctype html><title>rip-deck</title>",
        "assets/index-abc123.js": "console.log(1)",
        "assets/index-abc123.css": "body{color:red}",
      }),
    })

    expect(assets.fileCount).toBe(3)

    expect(
      assets.readAsset({
        pathname: "/assets/index-abc123.js",
      })?.contentType,
    ).toBe("text/javascript; charset=utf-8")

    expect(
      assets.readAsset({
        pathname: "/assets/index-abc123.css",
      })?.contentType,
    ).toBe("text/css; charset=utf-8")

    expect(assets.readIndexHtml()?.contentType).toBe(
      "text/html; charset=utf-8",
    )
  })

  it("caches assets/ forever and index.html never", () => {
    // The one that bites: index.html NAMES the hashes, so a
    // cached copy pins a browser to a bundle that is gone.
    const assets = loadWebAssets({
      root: buildDist({
        "index.html": "<!doctype html>",
        "assets/index-abc123.js": "0",
      }),
    })

    expect(assets.readIndexHtml()?.isImmutable).toBe(false)
    expect(
      assets.readAsset({
        pathname: "/assets/index-abc123.js",
      })?.isImmutable,
    ).toBe(true)
  })

  it("keeps a font as bytes, with no charset on it", () => {
    // A woff2 round-tripped through a JS string is a font the
    // browser silently refuses, and a charset on it is a lie.
    const font = new Uint8Array([
      0x77, 0x4f, 0x46, 0x32, 0x00,
    ])

    const asset = loadWebAssets({
      root: buildDist({
        "assets/inter-abc123.woff2": font,
      }),
    }).readAsset({
      pathname: "/assets/inter-abc123.woff2",
    })

    expect(asset?.contentType).toBe("font/woff2")
    expect([...(asset?.body ?? [])]).toEqual([...font])
  })

  it("refuses to guess at an extension it does not know", () => {
    const asset = loadWebAssets({
      root: buildDist({ "assets/thing-abc123.bin": "x" }),
    }).readAsset({ pathname: "/assets/thing-abc123.bin" })

    expect(asset?.contentType).toBe(
      "application/octet-stream",
    )
  })

  it("treats a missing dist/ as empty, not as a failure", () => {
    // An image built before the dashboard shipped, or a checkout
    // that has not run `vite build`. Ripping is unaffected and
    // the daemon must still start.
    const assets = loadWebAssets({
      root: join(tmpdir(), "rip-deck-web-does-not-exist"),
    })

    expect(assets.fileCount).toBe(0)
    expect(assets.readIndexHtml()).toBeNull()
    expect(
      assets.readAsset({ pathname: "/assets/anything.js" }),
    ).toBeNull()
  })

  it("cannot be walked out of — there is no path to escape", () => {
    // Not a normalisation test: request paths are looked up in a
    // map built from a directory walk, so `..` is simply a key
    // that was never inserted.
    const assets = loadWebAssets({
      root: buildDist({ "index.html": "<!doctype html>" }),
    })

    expect(
      assets.readAsset({
        pathname: "/../../../etc/passwd",
      }),
    ).toBeNull()
  })
})

describe("readWebDistRoot", () => {
  it("resolves next to the daemon, not next to the cwd", () => {
    // `rip-deck` is invoked from several directories; a
    // cwd-relative default would serve the dashboard from only
    // one of them.
    expect(DEFAULT_WEB_DIST_ROOT).toContain(
      join("packages", "web", "dist"),
    )
    expect(readWebDistRoot({})).toBe(DEFAULT_WEB_DIST_ROOT)
  })

  it("takes an override for an unusual layout", () => {
    expect(
      readWebDistRoot({
        RIP_DECK_WEB_DIST: "/srv/dashboard",
      }),
    ).toBe("/srv/dashboard")
  })
})
