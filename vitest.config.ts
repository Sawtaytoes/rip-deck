import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // `e2e/**` holds Playwright specs when there are any:
    // `.spec.ts` is Playwright and `.test.ts(x)` is vitest, and
    // the two runners' `describe`/`test` globals are not
    // compatible, so vitest must never pick those files up.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    projects: [
      "packages/contracts/vitest.config.ts",
      "packages/daemon/vitest.config.ts",
      "packages/web/vitest.config.ts",
    ],
  },
})
