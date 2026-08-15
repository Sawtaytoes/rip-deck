import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "daemon",
    include: ["src/**/*.test.ts"],
  },
})
