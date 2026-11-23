import { randomUUID } from "node:crypto"
import {
  chmod,
  chown,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Settings that stop MakeMKV from contacting makemkv.com on its own.
 *
 * - `app_UpdateEnable` is the update check behind MSG:5074
 *   ("Automatic checking for updates is enabled"). With it at "0",
 *   makemkvcon 1.18.4 stops printing MSG:5074 and stops writing
 *   `.MakeMKV/update.conf`.
 * - `app_AutoSubmitEnabled` is the preference "Submit dumps
 *   automatically", which uploads diagnostic dumps.
 *
 * Both stay off because no telemetry or phone-home stays on
 * ([decision](../../../../docs/decisions/2026-11-23-makemkv-never-phones-home.md)).
 */
export const makemkvPrivacySettings: Readonly<
  Record<string, string>
> = {
  app_AutoSubmitEnabled: "0",
  app_UpdateEnable: "0",
}

const settingNamePattern = /^\s*([A-Za-z0-9_]+)\s*=/

const getSettingName = (line: string): string | null =>
  line.match(settingNamePattern)?.[1] ?? null

const formatSettingLine = (input: {
  name: string
  value: string
}): string => `${input.name} = "${input.value}"`

/**
 * Set each named setting in the text of a MakeMKV `settings.conf`.
 *
 * MakeMKV writes `name = "value"` lines under a comment header.
 * Every other line, the registration key included, is kept as it
 * is. Each named setting is replaced where it appears and appended
 * where it does not. A comment that mentions a setting is not a
 * setting, so it is kept as it is.
 */
export const setMakemkvSettingsInText = (input: {
  settings: Readonly<Record<string, string>>
  settingsText: string
}): string => {
  const lines =
    input.settingsText === ""
      ? []
      : input.settingsText.replace(/\n$/, "").split("\n")

  const presentNames = new Set(
    lines
      .map(getSettingName)
      .filter((name) => name !== null),
  )

  return lines
    .map((line) => {
      const name = getSettingName(line)

      return name !== null &&
        Object.hasOwn(input.settings, name)
        ? formatSettingLine({
            name,
            value: input.settings[name],
          })
        : line
    })
    .concat(
      Object.keys(input.settings)
        .filter((name) => !presentNames.has(name))
        .map((name) =>
          formatSettingLine({
            name,
            value: input.settings[name],
          }),
        ),
    )
    .join("\n")
    .concat("\n")
}

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  error.code === "ENOENT"

const readTextOrNull = async (
  filePath: string,
): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

/**
 * Follow a symlinked `settings.conf` to the file it names, so the
 * rename below replaces that file and not the link. A missing file
 * is written where MakeMKV looks for it.
 */
const resolveSettingsFilePath = async (
  filePath: string,
): Promise<string> => {
  try {
    return await realpath(filePath)
  } catch (error) {
    if (isMissingFileError(error)) return filePath
    throw error
  }
}

/**
 * Replace a file without truncating it in place.
 *
 * The file holds the registration key, so a failed write (a full
 * disk, say) must never leave it empty. The new text goes to a
 * temporary file beside it, which is then renamed over the
 * original.
 *
 * The temporary file has a unique name and is created exclusively
 * (`wx`), so a stale file left by a crash is never reused with its
 * own permissions. Its owner is copied from the original, and its
 * mode is set with chmod after the chown, because the mode given
 * to a create is filtered by the process umask. A new file is
 * 0600, since it may soon hold a key. On any failure the temporary
 * file is removed and the original is untouched.
 */
const replaceFileAtomically = async (input: {
  filePath: string
  text: string
}): Promise<void> => {
  const temporaryFilePath = `${input.filePath}.rip-deck-${randomUUID()}.tmp`
  const originalStats = await stat(input.filePath).catch(
    (error: unknown) => {
      if (isMissingFileError(error)) return null
      throw error
    },
  )

  try {
    await writeFile(temporaryFilePath, input.text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })

    if (originalStats !== null) {
      await chown(
        temporaryFilePath,
        originalStats.uid,
        originalStats.gid,
      )
    }

    await chmod(
      temporaryFilePath,
      originalStats === null
        ? 0o600
        : originalStats.mode & 0o7777,
    )
    await rename(temporaryFilePath, input.filePath)
  } catch (error) {
    await rm(temporaryFilePath, { force: true })
    throw error
  }
}

/** Where makemkvcon reads its settings: `$HOME/.MakeMKV/settings.conf`. */
export const makemkvSettingsFilePath = (
  makemkvHomePath: string,
): string =>
  join(makemkvHomePath, ".MakeMKV", "settings.conf")

/**
 * Turn off MakeMKV's update check and dump submission.
 *
 * Runs before every `makemkvcon` spawn, so a settings file that
 * was replaced by hand (a new key, say) is corrected before
 * MakeMKV reads it. The file is written only when a setting
 * changes.
 *
 * `makemkvHomePath` defaults to this process's home. That is the
 * file every makemkvcon of this deployment reads: the daemon's own
 * children share its `HOME`, and each isolated rip container runs
 * the same image (`HOME=/config`) with the same host folder
 * mounted at `/config`. A wrapper that runs makemkvcon on another
 * machine reads another file, which this cannot reach.
 *
 * It fails closed. When the file cannot be read or written, it
 * throws, and the caller does not run makemkvcon.
 */
export const applyMakemkvPrivacySettings = async (
  makemkvHomePath: string = homedir(),
): Promise<void> => {
  const settingsFilePath =
    makemkvSettingsFilePath(makemkvHomePath)

  try {
    const targetFilePath = await resolveSettingsFilePath(
      settingsFilePath,
    )
    const originalText =
      (await readTextOrNull(targetFilePath)) ?? ""
    const updatedText = setMakemkvSettingsInText({
      settings: makemkvPrivacySettings,
      settingsText: originalText,
    })

    if (updatedText === originalText) return

    await mkdir(dirname(targetFilePath), {
      recursive: true,
    })
    await replaceFileAtomically({
      filePath: targetFilePath,
      text: updatedText,
    })
  } catch (error) {
    throw new Error(
      "Could not turn off MakeMKV's update check and dump " +
        `submission in ${settingsFilePath}, so makemkvcon was ` +
        `not run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
