import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "daemon",
    include: ["src/**/*.test.ts"],
    // Every makemkvcon spawn first writes MakeMKV's privacy
    // settings into `$HOME/.MakeMKV/settings.conf`. Each test
    // file gets its own empty HOME, so no test writes to the
    // real one.
    setupFiles: ["./src/isolateHomeForTests.ts"],
  },
})
