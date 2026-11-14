import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { playwright } from "@vitest/browser-playwright"
import { searchForWorkspaceRoot } from "vite"
import { defineConfig } from "vitest/config"

import baseConfig from "./vitest.config.ts"

/**
 * The visual-regression capture, NOT a test suite.
 *
 * It reuses the component suite's browser setup (chromium through
 * `@vitest/browser-playwright`, the same plugins, the same
 * `optimizeDeps` list) and swaps the `include` for the `*.vrt.tsx`
 * files, which render whole routes on fixture data and write one PNG
 * per route, width and scheme into `VRT_ACTUAL_DIR`. The shared
 * `vrt` workflow in Charcuterie compares that directory against the
 * baseline in this repo's bucket.
 *
 * Kept out of `pnpm test` on purpose: the plain suite matches
 * `*.test.{ts,tsx}` only, so a normal run never writes screenshots.
 *
 * Run from the repo root: `pnpm vrt:capture`.
 */
const actualDirectory =
  process.env.VRT_ACTUAL_DIR ??
  resolve(import.meta.dirname, "../../.vrt-actual")

interface SharedMemoryChoice {
  ignoreDefaultArgs: string[]
  message: string
}

interface SharedMemoryModule {
  chooseSharedMemory: (
    availableBytes: number | null,
  ) => SharedMemoryChoice
  readAvailableSharedMemory: () => Promise<number | null>
}

/**
 * Where Chromium keeps its shared memory. Playwright's default launch flag,
 * `--disable-dev-shm-usage`, puts it in deleted files under `/tmp`, which on
 * the VRT runner is the container's overlay on a ZFS pool, so every frame
 * was written to disk. The shared workflow's tools (`$VRT_TOOLS`) have a
 * `sharedMemory.js` that drops the flag when `/dev/shm` has at least
 * 512 MiB free (the runner has a 2 GiB tmpfs) and says which one it chose;
 * the pixels do not change. Outside CI, Playwright's default stays.
 */
const chooseVrtSharedMemory = async (): Promise<
  string[]
> => {
  const tools = process.env.VRT_TOOLS

  if (!tools) {
    return []
  }

  let sharedMemory: SharedMemoryModule

  try {
    sharedMemory = (await import(
      pathToFileURL(join(tools, "sharedMemory.js")).href
    )) as SharedMemoryModule
  } catch {
    console.log(
      "[vrt] Chromium shared memory: temp files, because the shared tools have no sharedMemory.js.",
    )

    return []
  }

  const choice = sharedMemory.chooseSharedMemory(
    await sharedMemory.readAvailableSharedMemory(),
  )

  console.log(choice.message)

  return choice.ignoreDefaultArgs
}

// Spread, not `mergeConfig`: `mergeConfig` CONCATENATES arrays, so
// the suite's `include` would survive beside ours and every capture
// would run the whole component suite first.
export default defineConfig({
  ...baseConfig,
  // `page.screenshot` writes through the Vite server, which refuses
  // any path outside the workspace. The workflow's directory is
  // inside it; a local run pointed at `/tmp` is not.
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(import.meta.dirname),
        actualDirectory,
      ],
    },
  },
  test: {
    ...baseConfig.test,
    name: "web-vrt",
    include: ["src/**/*.vrt.tsx"],
    provide: { vrtActualDirectory: actualDirectory },
    browser: {
      ...baseConfig.test?.browser,
      // ONE capture, not the suite's four windows: each shot sets its
      // own size (see `sizeViewport`), and four instances would write every
      // PNG four times over the same file names.
      instances: [{ browser: "chromium" }],
      // The runner SCALES the test iframe down to fit this window, so
      // a 1280x800 route in the default 1280x720 page came out at 0.9
      // and blurred. A window larger than every viewport the shots
      // ask for keeps them at 1:1 — and it is tall because a shot
      // grows the iframe to the page's full height (see `shoot`). `deviceScaleFactor` and the locale
      // are pinned so a runner's defaults cannot move a pixel.
      provider: playwright({
        launchOptions: {
          ignoreDefaultArgs: await chooseVrtSharedMemory(),
        },
        contextOptions: {
          viewport: { width: 1400, height: 8000 },
          deviceScaleFactor: 1,
          locale: "en-US",
          timezoneId: "UTC",
          colorScheme: "dark",
          reducedMotion: "reduce",
        },
      }),
    },
  },
})
