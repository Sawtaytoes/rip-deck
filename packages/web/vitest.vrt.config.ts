import { resolve } from "node:path"

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
 * Kept out of `yarn test` on purpose: the plain suite matches
 * `*.test.{ts,tsx}` only, so a normal run never writes screenshots.
 *
 * Run from the repo root: `yarn vrt:capture`.
 */
const actualDirectory =
  process.env.VRT_ACTUAL_DIR ??
  resolve(import.meta.dirname, "../../.vrt-actual")

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
      // The runner SCALES the test iframe down to fit this window, so
      // a 1280x800 route in the default 1280x720 page came out at 0.9
      // and blurred. A window larger than every viewport the shots
      // ask for keeps them at 1:1 — and it is tall because a shot
      // grows the iframe to the page's full height (see `shoot`). `deviceScaleFactor` and the locale
      // are pinned so a runner's defaults cannot move a pixel.
      provider: playwright({
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
