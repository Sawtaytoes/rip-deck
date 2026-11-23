import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { enumerateDrives } from "./discIndex.ts"
import { identifyDisc } from "./identifyDisc.ts"
import {
  applyMakemkvPrivacySettings,
  makemkvSettingsFilePath,
  setMakemkvSettingsInText,
} from "./makemkvPrivacySettings.ts"
import { runRipJob } from "./ripJob.ts"

/**
 * MakeMKV never phones home: its update check and its automatic
 * dump submission are set to "0" before every makemkvcon spawn
 * ([decision](../../../../docs/decisions/2026-11-23-makemkv-never-phones-home.md)).
 *
 * The file holds the registration key, so most of these cases
 * are about what must NOT change: every other line, the owner,
 * the mode, a symlinked layout, and the original text when a
 * write fails.
 */

// `rename` passes through unless a test arms a failure, so the
// "a failed write keeps the key" case can fail the one step that
// would replace the file.
const renameFailure = vi.hoisted(() => ({
  error: null as Error | null,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("node:fs/promises")
    >()

  return {
    ...original,
    rename: (from: string, to: string) => {
      const error = renameFailure.error
      renameFailure.error = null

      return error === null
        ? original.rename(from, to)
        : Promise.reject(error)
    },
  }
})

// The shape MakeMKV v1.18.4 writes. The key is a placeholder.
const settingsWrittenByMakemkv = [
  "#",
  "# MakeMKV settings file, written by MakeMKV v1.18.4 linux(x64-release)",
  "#",
  "",
  'app_DataDir = "/config/data"',
  'app_Key = "T-placeholder-key"',
  'dvd_MinimumTitleLength = "120"',
  "",
].join("\n")

const privacyLines =
  'app_AutoSubmitEnabled = "0"\napp_UpdateEnable = "0"\n'

const testState = {
  homePath: "",
  originalUmask: 0,
}

const settingsFilePath = () =>
  makemkvSettingsFilePath(testState.homePath)

const writeSettings = async (
  text: string,
  mode = 0o600,
) => {
  await mkdir(join(testState.homePath, ".MakeMKV"), {
    recursive: true,
  })
  await writeFile(settingsFilePath(), text)
  await chmod(settingsFilePath(), mode)
}

beforeEach(async () => {
  testState.homePath = await mkdtemp(
    join(tmpdir(), "rip-deck-makemkv-settings-"),
  )
  testState.originalUmask = process.umask()
})

afterEach(async () => {
  renameFailure.error = null
  process.umask(testState.originalUmask)
  await rm(testState.homePath, {
    recursive: true,
    force: true,
  })
})

describe("setMakemkvSettingsInText", () => {
  it("appends each missing setting and keeps every other line, the key included", () => {
    expect(
      setMakemkvSettingsInText({
        settings: {
          app_AutoSubmitEnabled: "0",
          app_UpdateEnable: "0",
        },
        settingsText: settingsWrittenByMakemkv,
      }),
    ).toBe(settingsWrittenByMakemkv.concat(privacyLines))
  })

  it("turns off a setting that is on, in the line where it is", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText:
          'app_UpdateEnable = "1"\napp_Key = "T-placeholder-key"\n',
      }),
    ).toBe(
      'app_UpdateEnable = "0"\napp_Key = "T-placeholder-key"\n',
    )
  })

  it("replaces every copy of a setting that appears twice", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText:
          'app_UpdateEnable = "1"\n  app_UpdateEnable="1"\n',
      }),
    ).toBe(
      'app_UpdateEnable = "0"\napp_UpdateEnable = "0"\n',
    )
  })

  it("does not treat a setting whose name only starts the same as a match", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText: 'app_UpdateEnableLater = "1"\n',
      }),
    ).toBe(
      'app_UpdateEnableLater = "1"\napp_UpdateEnable = "0"\n',
    )
  })

  it("keeps a comment that names a setting, and still sets it", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText: '# app_UpdateEnable = "1"\n',
      }),
    ).toBe(
      '# app_UpdateEnable = "1"\napp_UpdateEnable = "0"\n',
    )
  })

  it("leaves text that already has the settings unchanged", () => {
    const settingsText = `app_Key = "T-placeholder-key"\n${privacyLines}`

    expect(
      setMakemkvSettingsInText({
        settings: {
          app_AutoSubmitEnabled: "0",
          app_UpdateEnable: "0",
        },
        settingsText,
      }),
    ).toBe(settingsText)
  })

  it("adds a final newline to text that has none", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText: 'app_Key = "T-placeholder-key"',
      }),
    ).toBe(
      'app_Key = "T-placeholder-key"\napp_UpdateEnable = "0"\n',
    )
  })

  it("writes only the settings when there is no file text", () => {
    expect(
      setMakemkvSettingsInText({
        settings: { app_UpdateEnable: "0" },
        settingsText: "",
      }),
    ).toBe('app_UpdateEnable = "0"\n')
  })
})

describe("applyMakemkvPrivacySettings", () => {
  it("turns off the update check and dump submission and keeps the key", async () => {
    await writeSettings(settingsWrittenByMakemkv)

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(await readFile(settingsFilePath(), "utf8")).toBe(
      settingsWrittenByMakemkv.concat(privacyLines),
    )
  })

  it("does not rewrite a file that already has them off", async () => {
    await writeSettings(
      settingsWrittenByMakemkv.concat(privacyLines),
    )
    const modifiedTime = new Date("2026-01-01T00:00:00Z")
    await utimes(
      settingsFilePath(),
      modifiedTime,
      modifiedTime,
    )
    const before = await stat(settingsFilePath())

    await applyMakemkvPrivacySettings(testState.homePath)

    const after = await stat(settingsFilePath())
    expect(after.mtime).toEqual(modifiedTime)
    expect(after.ino).toBe(before.ino)
  })

  it("keeps group write access under a 0022 umask", async () => {
    await writeSettings(settingsWrittenByMakemkv, 0o660)
    process.umask(0o022)

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(
      (await stat(settingsFilePath())).mode & 0o7777,
    ).toBe(0o660)
  })

  it("keeps the original owner", async () => {
    await writeSettings(settingsWrittenByMakemkv)
    const before = await stat(settingsFilePath())

    await applyMakemkvPrivacySettings(testState.homePath)

    const after = await stat(settingsFilePath())
    expect([after.uid, after.gid]).toEqual([
      before.uid,
      before.gid,
    ])
  })

  it("creates a new settings file private to its owner", async () => {
    process.umask(0o000)

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(await readFile(settingsFilePath(), "utf8")).toBe(
      privacyLines,
    )
    expect(
      (await stat(settingsFilePath())).mode & 0o7777,
    ).toBe(0o600)
  })

  it("keeps the original, key included, and leaves no temporary file when the replacement fails", async () => {
    await writeSettings(settingsWrittenByMakemkv)
    renameFailure.error = Object.assign(
      new Error("ENOSPC: no space left on device"),
      { code: "ENOSPC" },
    )

    await expect(
      applyMakemkvPrivacySettings(testState.homePath),
    ).rejects.toThrow(
      /Could not turn off MakeMKV's update check.*ENOSPC/,
    )
    expect(await readFile(settingsFilePath(), "utf8")).toBe(
      settingsWrittenByMakemkv,
    )
    expect(
      await readdir(join(testState.homePath, ".MakeMKV")),
    ).toEqual(["settings.conf"])
  })

  it("never reuses a stale temporary file", async () => {
    await writeSettings(settingsWrittenByMakemkv, 0o600)
    const staleFileName = "settings.conf.rip-deck-stale.tmp"
    const staleFilePath = join(
      testState.homePath,
      ".MakeMKV",
      staleFileName,
    )
    await writeFile(staleFilePath, "stale")
    await chmod(staleFilePath, 0o644)
    process.umask(0o000)

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(
      (await stat(settingsFilePath())).mode & 0o7777,
    ).toBe(0o600)
    expect(
      (
        await readdir(join(testState.homePath, ".MakeMKV"))
      ).sort(),
    ).toEqual(["settings.conf", staleFileName])
  })

  it("writes through a `.MakeMKV` folder symlink, the deployed layout", async () => {
    // The deployed config folder carries `.MakeMKV -> /config`, so
    // the file MakeMKV reads is `/config/settings.conf`.
    await writeFile(
      join(testState.homePath, "settings.conf"),
      settingsWrittenByMakemkv,
    )
    await symlink(
      testState.homePath,
      join(testState.homePath, ".MakeMKV"),
    )

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(
      await readFile(
        join(testState.homePath, "settings.conf"),
        "utf8",
      ),
    ).toBe(settingsWrittenByMakemkv.concat(privacyLines))
    expect(
      (
        await lstat(join(testState.homePath, ".MakeMKV"))
      ).isSymbolicLink(),
    ).toBe(true)
  })

  it("keeps a symlinked settings.conf a symlink and edits the file it names", async () => {
    const realFilePath = join(
      testState.homePath,
      "real.conf",
    )
    await writeFile(realFilePath, settingsWrittenByMakemkv)
    await mkdir(join(testState.homePath, ".MakeMKV"))
    await symlink(realFilePath, settingsFilePath())

    await applyMakemkvPrivacySettings(testState.homePath)

    expect(
      (await lstat(settingsFilePath())).isSymbolicLink(),
    ).toBe(true)
    expect(await readlink(settingsFilePath())).toBe(
      realFilePath,
    )
    expect(await readFile(realFilePath, "utf8")).toBe(
      settingsWrittenByMakemkv.concat(privacyLines),
    )
  })

  it("fails closed when the settings folder cannot be made", async () => {
    // A HOME that is a file, not a folder: `.MakeMKV` cannot exist.
    const fileHomePath = join(
      testState.homePath,
      "not-a-folder",
    )
    await writeFile(fileHomePath, "")

    await expect(
      applyMakemkvPrivacySettings(fileHomePath),
    ).rejects.toThrow(/makemkvcon was not run/)
  })
})

/**
 * The settings are written BEFORE makemkvcon starts, and a failure
 * to write them means makemkvcon does not start at all.
 *
 * The test setup points HOME at an empty folder, and the stand-in
 * for makemkvcon reports what it found there when it started.
 */
describe("every makemkvcon spawn applies the settings first", () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    process.env.HOME = originalHome
  })

  it("identifyDisc runs makemkvcon only after both settings are off", async () => {
    process.env.HOME = testState.homePath

    const identified = await identifyDisc({
      devPath: "/dev/null",
      makemkv: {
        command: "sh",
        prefixArgs: [
          "-c",
          'grep -qx "app_UpdateEnable = \\"0\\"" "$HOME/.MakeMKV/settings.conf" && ' +
            'grep -qx "app_AutoSubmitEnabled = \\"0\\"" "$HOME/.MakeMKV/settings.conf" && ' +
            "printf 'CINFO:2,0,\"SETTINGS_OFF\"\\n'",
        ],
        wrapperArgs: null,
      },
      maxAttempts: 1,
    })

    expect(identified.spawnFailure).toBeNull()
    expect(identified.discName).toBe("SETTINGS_OFF")
  })

  it("enumerateDrives runs makemkvcon only after both settings are off", async () => {
    process.env.HOME = testState.homePath

    const enumeration = await enumerateDrives({
      makemkv: {
        command: "sh",
        prefixArgs: [
          "-c",
          'grep -qx "app_UpdateEnable = \\"0\\"" "$HOME/.MakeMKV/settings.conf" && ' +
            'grep -qx "app_AutoSubmitEnabled = \\"0\\"" "$HOME/.MakeMKV/settings.conf" && ' +
            'printf \'DRV:0,2,999,12,"BD-RE","LABEL","/dev/sr0"\\n\'',
        ],
        wrapperArgs: null,
      },
    })

    expect(enumeration.indexByDevPath.get("/dev/sr0")).toBe(
      0,
    )
  })

  it("identifyDisc reports a deployment fault and does not run makemkvcon when the settings cannot be written", async () => {
    const fileHomePath = join(
      testState.homePath,
      "not-a-folder",
    )
    await writeFile(fileHomePath, "")
    process.env.HOME = fileHomePath
    const markerPath = join(testState.homePath, "ran")

    const identified = await identifyDisc({
      devPath: "/dev/null",
      makemkv: {
        command: "sh",
        prefixArgs: ["-c", `touch "${markerPath}"`],
        wrapperArgs: null,
      },
      maxAttempts: 1,
    })

    expect(identified.spawnFailure).toMatch(
      /Could not turn off MakeMKV's update check/,
    )
    expect(identified.discName).toBeNull()
    await expect(stat(markerPath)).rejects.toThrow(/ENOENT/)
  })

  it("runRipJob stops before its preflight when the settings cannot be written", async () => {
    const fileHomePath = join(
      testState.homePath,
      "not-a-folder",
    )
    await writeFile(fileHomePath, "")
    process.env.HOME = fileHomePath
    const destinationRoot = join(testState.homePath, "rips")

    await expect(
      runRipJob({
        driveId: "1-1",
        devPath: "/dev/null",
        discIndex: 0,
        jobUuid: "00000000-0000-4000-8000-000000000000",
        discBytes: 1,
        destinationRoot,
        folderName: "[BACKUP] TEST",
        stateDir: join(testState.homePath, "state"),
        makemkv: {
          command: "true",
          prefixArgs: [],
          wrapperArgs: null,
        },
        isolation: null,
      }),
    ).rejects.toThrow(/makemkvcon was not run/)
    // Nothing was made: not the state folder, not a rip folder.
    expect(
      (await readdir(testState.homePath)).sort(),
    ).toEqual(["not-a-folder"])
  })
})
