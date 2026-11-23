import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

// Loaded by `vitest.config.ts` before each test file. Code that
// spawns makemkvcon first writes `$HOME/.MakeMKV/settings.conf`
// (`rip/makemkvPrivacySettings.ts`), and `os.homedir()` reads
// HOME, so this keeps every test away from the real home folder.
const originalHome = process.env.HOME
const testHome = mkdtempSync(
  join(tmpdir(), "rip-deck-test-home-"),
)

process.env.HOME = testHome

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  rmSync(testHome, { recursive: true, force: true })
})
