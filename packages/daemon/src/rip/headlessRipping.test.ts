import { randomUUID } from "node:crypto"
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildCyanripArgs,
  escapeCyanripMetadataValue,
} from "./cyanripCommand.ts"
import {
  type BayRipInput,
  createWatcherConfig,
  ripAudioCd,
  ripDataDisc,
} from "./watcher.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
const setup = async (
  script: string,
  isEnabled = true,
): Promise<BayRipInput> => {
  const root = await mkdtemp(
    join(tmpdir(), "headless-rip-"),
  )
  dirs.push(root)
  const tool = join(root, "ripper.cjs")
  await writeFile(tool, script)
  const config = createWatcherConfig({
    RIP_DECK_DEST: root,
    RIP_DECK_STATE_DIR: join(root, "state"),
    RIP_DECK_ALLOW_UNNAMED_DISCS: String(isEnabled),
  })
  config.cyanrip = {
    command: process.execPath,
    prefixArgs: [tool],
    wrapperArgs: null,
  }
  config.ddrescue = config.cyanrip
  return {
    config,
    driveId: "test-drive",
    bay: 1,
    name: "Test drive",
    kernelName: "sr0",
    devPath: "/dev/sr0",
    jobUuid: randomUUID(),
    readOffsetSamples: 6,
    signal: new AbortController().signal,
    note: vi.fn(),
    onRipStarted: vi.fn(),
    onIdentified: vi.fn(),
    onDestination: vi.fn(),
  }
}
const audioScript = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('../attempts.jsonl', JSON.stringify(args) + '\n');
if (!args.includes('-N')) {
 console.error("Unable to find release info for this CD, and metadata hasn't been manually added!");
 process.exit(1);
}
const album = args[args.indexOf('-a') + 1].slice(6);
fs.mkdirSync(album);
fs.writeFileSync(album + '/01.flac', 'fixture');
console.log('offline rip finished');
`

describe("headless disc ripping", () => {
  it.each([
    "MusicBrainz lookup failed, but DiscID has a matching stub",
    "Could not connect to MusicBrainz.",
    "MusicBrainz query failed: timeout",
    "Please specify which release to use by adding the -R argument with an index or ID.",
  ])("retries metadata refusal: %s", async (message) => {
    const script = audioScript.replace(
      "Unable to find release info for this CD, and metadata hasn't been manually added!",
      message,
    )
    const input = await setup(script)
    expect(
      (await ripAudioCd({ input, capacityBytes: 65536 }))
        .kind,
    ).toBe("completed")
    expect(
      (
        await readFile(
          join(
            input.config.destinationRoot,
            "attempts.jsonl",
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toHaveLength(2)
  })
  it("escapes apostrophes and dictionary separators in manual metadata", () => {
    expect(
      escapeCyanripMetadataValue("Bob's Album=Live:1"),
    ).toBe(String.raw`Bob\'s Album\=Live\:1`)
    expect(
      buildCyanripArgs({
        devPath: "/dev/sr0",
        albumName: "Bob's Album",
        isMetadataLookupEnabled: false,
      }),
    ).toContain(String.raw`album=Bob\'s Album`)
  })

  it("is opt-in", () => {
    expect(
      createWatcherConfig({}).isUnnamedDiscRippingEnabled,
    ).toBe(false)
    expect(
      createWatcherConfig({
        RIP_DECK_ALLOW_UNNAMED_DISCS: "false",
      }).isUnnamedDiscRippingEnabled,
    ).toBe(false)
  })
  it("retries missing audio metadata with a unique album, keeping offsets, verification, and logs", async () => {
    const input = await setup(audioScript)
    const result = await ripAudioCd({
      input,
      capacityBytes: 65536,
    })
    expect(result.kind).toBe("completed")
    const title = `Unknown ${input.jobUuid}`
    expect(
      await readFile(
        join(
          input.config.destinationRoot,
          title,
          "01.flac",
        ),
        "utf8",
      ),
    ).toBe("fixture")
    const attempts = (
      await readFile(
        join(
          input.config.destinationRoot,
          "attempts.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).not.toContain("-N")
    expect(attempts[1]).toContain("-N")
    expect(attempts[1]).toContain(`album=${title}`)
    for (const args of attempts) {
      expect(args).toContain("-s")
      expect(args).toContain("6")
      expect(args).not.toContain("-A")
      expect(args).not.toContain("-P")
      expect(args).not.toContain("-Q")
    }
    expect(
      await readFile(
        join(
          input.config.stateDir,
          `${input.jobUuid}.robot.log`,
        ),
        "utf8",
      ),
    ).toContain("offline rip finished")
  })
  it("uses an operator-supplied audio name", async () => {
    const input = await setup(audioScript)
    input.explicitName = "Sampler album"
    expect(
      (await ripAudioCd({ input, capacityBytes: 65536 }))
        .kind,
    ).toBe("completed")
    expect(
      await readdir(
        join(input.config.destinationRoot, "Sampler album"),
      ),
    ).toContain("01.flac")
  })
  it.each([false, true])(
    "does not retry read failures (enabled=%s)",
    async (isEnabled) => {
      const input = await setup(
        `console.error('unrecoverable read error'); process.exit(1)`,
        isEnabled,
      )
      const result = await ripAudioCd({
        input,
        capacityBytes: 65536,
      })
      expect(result.kind).toBe("failed")
      expect(result.detail).toContain(
        "unrecoverable read error",
      )
      expect(input.note).toHaveBeenCalledTimes(1)
    },
  )
  it("still holds missing audio metadata when disabled", async () => {
    const input = await setup(audioScript, false)
    expect(
      (await ripAudioCd({ input, capacityBytes: 65536 }))
        .kind,
    ).toBe("failed")
    expect(
      await readdir(input.config.destinationRoot),
    ).not.toContain(`Unknown ${input.jobUuid}`)
  })
  it("publishes an unnamed data image and its verified mapfile", async () => {
    const input = await setup(String.raw`
const fs = require('node:fs');
const [image, map] = process.argv.slice(-2);
fs.writeFileSync(image, Buffer.alloc(65536));
fs.writeFileSync(map, '0x0 + 1\n0x0 0x10000 +\n');
`)
    const result = await ripDataDisc({
      input,
      capacityBytes: 65536,
      volumeLabel: null,
    })
    expect([
      "completed",
      "completed_with_warnings",
    ]).toContain(result.kind)
    expect(
      await readdir(
        join(
          input.config.destinationRoot,
          `[DATA] Unknown ${input.jobUuid}`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        `Unknown ${input.jobUuid}.iso`,
        `Unknown ${input.jobUuid}.iso.map`,
      ]),
    )
  })
  it("holds unnamed data discs when disabled", async () => {
    const input = await setup("process.exit(99)", false)
    expect(
      (
        await ripDataDisc({
          input,
          capacityBytes: 65536,
          volumeLabel: null,
        })
      ).kind,
    ).toBe("needs_attention")
    expect(input.onRipStarted).not.toHaveBeenCalled()
  })
})
