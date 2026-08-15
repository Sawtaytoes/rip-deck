import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

import { optimizeDepsInclude } from "./optimizeDeps.js"

/**
 * Component tests run in a real headless chromium, driven through
 * `@vitest/browser-playwright` — the same vitest browser mode
 * mux-magic, castkit and charcuterie all use.
 *
 * This REPLACES the earlier jsdom setup. Two reasons it changed:
 *
 *   1. The owner's standing preference: "I dunno why rip-deck
 *      uses jsdom when we're using Playwright everywhere else."
 *      The fleet convention for component/DOM tests is vitest
 *      browser mode with the Playwright provider; jsdom was the
 *      odd one out.
 *   2. jsdom's tooling is not Node-26-ready — the suite died on
 *      Node 26 with `TypeError: Cannot read properties of
 *      undefined (reading 'clear')`, which pinned CI to Node 24.
 *      A real browser has no such coupling, so the suite runs on
 *      Node 26 and CI is back on the fleet-standard version.
 *
 * The CI cost the old comment worried about (a ~170 MB chromium
 * plus system libs) is paid the fleet's way: `.forgejo/
 * workflows/ci.yml` runs `yarn install-playwright-browser`
 * (`playwright install chromium --with-deps`) before the tests,
 * exactly as mux-magic's `unit-tests` job does.
 *
 * NOTE: deliberately NO react-compiler babel pass here, unlike
 * mux-magic. This is a port of the ARM viewer, which does not
 * run the compiler (see `vite.config.ts`) — so the plugin list
 * stays `react()` + `tailwindcss()`.
 *
 * `.spec.ts` stays reserved for Playwright Test e2e and is not
 * matched by `include` below, so adding real e2e later needs no
 * change here.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  /**
   * The same reason as `vite.config.ts`, and this file is where it
   * was FOUND: 57 tests went red at once with `Cannot read
   * properties of null (reading 'useRef')` the moment a
   * `@charcuterie/ui` component with a hook first rendered. That
   * was the `portal:` era — a `portal:` is a symlink, both
   * resolvers follow the real path, and the shared component
   * picked up charcuterie's own React while this app's tree
   * rendered with rip-deck's. It is a registry install now; the
   * line stays because `react` is only a *peer* of the library.
   */
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    name: "web",
    include: ["src/**/*.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: ["./vitest.setup.ts"],
  },
  /**
   * The list itself lives in `./optimizeDeps.js`, and the reason it
   * is a separate file is the CI check that now guards it:
   * `charcuterie-check-optimize-deps` runs AFTER the suite in a plain
   * Node process, which cannot load this TypeScript config — so the
   * array has to be importable on its own.
   *
   * That file carries the full explanation of why the list is
   * load-bearing. The short version: Vite discovers dependencies
   * lazily, an undeclared one re-optimises mid-run and reloads the
   * page under the tests, and it is a race that passes until it
   * doesn't. This repo was silently short four entries.
   */
  optimizeDeps: { include: [...optimizeDepsInclude] },
})
