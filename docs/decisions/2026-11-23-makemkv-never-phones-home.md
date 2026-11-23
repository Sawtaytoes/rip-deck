# MakeMKV never phones home

- **Status:** Accepted
- **Date:** 2026-11-23
- **Type:** Privacy / deployment
- **Supersedes:** —
- **Superseded by:** —
- **Related:** Mux-Magic made the same change the same day in
  [Sawtaytoes/mux-magic#341](https://github.com/Sawtaytoes/mux-magic/pull/341)
  (its decision `2026-11-23-makemkv-is-pinned-to-1-18-4-and-never-phones-home.md`).
  This record follows that approach and adapts it to Rip Deck.

## Decision

- Before every `makemkvcon` spawn, `applyMakemkvPrivacySettings`
  (`packages/daemon/src/rip/makemkvPrivacySettings.ts`) sets two values to `"0"` in
  `$HOME/.MakeMKV/settings.conf`:
  - `app_UpdateEnable`, the update check (MSG:5074, "Automatic checking for updates is
    enabled").
  - `app_AutoSubmitEnabled`, the preference "Submit dumps automatically".
- The spawns that call it are the drive probe (`cli.ts`), `enumerateDrives`,
  `identifyDisc`, and `runRipJob`. The daemon also calls it once when `rip-deck watch`
  starts, so the file is right while nothing is ripping.
- It keeps every other line, including the registration key, and writes only when a
  value changes. It never truncates the file in place, so a failed write cannot erase
  the key. It writes a uniquely named temporary file beside the original (created
  exclusively), copies the original owner, sets the original mode with chmod (a create
  mode is filtered by the umask), and renames the temporary file over the original. A
  new file is created with mode 0600. A symlinked `settings.conf` stays a symlink, and
  the file it names is edited. A symlink whose target does not exist is refused and
  left as it is, because replacing it with a plain file would cut off a key put at the
  intended target later.
- Calls in one daemon run one at a time. Right before the rename, the edit reads the
  file again. If the file no longer holds the text the edit was made from (a new key,
  for example), nothing is replaced and the edit is redone from the new text, up to five
  times. Another process can still write in the instant between that read and the
  rename. Only a lock that MakeMKV also honored would close that window, and MakeMKV
  has none.
- It fails closed. When the file cannot be read or written, makemkvcon is not run.
  `identifyDisc` reports this as a spawn failure, which the bay card names as a
  deployment fault. `runRipJob` throws before its preflight, so no folder is made.
- The Dockerfile's build-time `makemkvcon info` check runs with a throwaway `HOME` that
  has the same two settings off. The build fails if makemkvcon still prints MSG:5074,
  writes `update.conf`, or exits with any status other than 0 or 253 (MakeMKV 1.18.4
  with no key).
- Tests run with `HOME` set to an empty temporary folder
  (`packages/daemon/src/isolateHomeForTests.ts`), so no test writes to a real
  MakeMKV settings file.

## Which file MakeMKV reads

makemkvcon reads `$HOME/.MakeMKV/settings.conf`. The image sets `HOME=/config`, and the
mounted config folder carries a `.MakeMKV -> /config` symlink, so the file is
`/config/settings.conf`. Every isolated rip container runs the same image with the same
folder mounted at `/config`, so it reads the same file. A `MakeMKV/settings.conf` in the
same folder (without the dot) is not read by makemkvcon and is left alone.

A `RIP_DECK_MAKEMKVCON` wrapper that runs makemkvcon on another machine reads that
machine's file, which the daemon cannot reach. Such a deployment must set the two values
there.

## Context

MakeMKV checks for updates by default. It records the check in `.MakeMKV/update.conf`
(`app_UpdateLastCheck`). The deployed settings file set neither value, so the default
applied: on 2026-11-23 a read-only `makemkvcon info disc:9999` in the running container
rewrote `update.conf`. "Submit dumps automatically" is also a default MakeMKV
preference. No telemetry or phone-home setting stays on in this deployment.

## Why

- An update check tells makemkv.com that this deployment exists, when it runs, and
  which version it runs. Nothing in Rip Deck needs that: the image pins MakeMKV, and a
  new version arrives only through a rebuild.
- A setting that is written once by hand does not stay written. The key is renewed by
  replacing `settings.conf`, and a replaced file brings the defaults back. Writing the
  values in code before each run is the only way they stay off.
- The file holds the registration key. A rip-deck that erased it would stop every rip,
  so the write must never truncate the file, change its owner, or widen its mode.

## What we rejected

- **Fixing the settings by hand in the mounted file only.** A replaced
  `settings.conf` (a new key, for example) would turn the update check back on, and
  nothing would notice. The code sets the values on every spawn.
- **Turning the values off only at daemon start.** The file can change while the daemon
  runs. The start-up call is in addition to the per-spawn call, not instead of it.
- **Logging and continuing when the write fails.** That would run makemkvcon with the
  update check on. A rip that cannot start says why; a silent phone-home says nothing.

## Evidence

- With both values at `"0"` and a throwaway `HOME`, the image's makemkvcon 1.18.4 ran
  `info disc:9999` with exit status 253, printed MSG:1005 and MSG:5021, did not print
  MSG:5074, and did not write `update.conf`. A packet capture in the container's network
  namespace for that run showed no traffic other than the daemon's existing MQTT
  connection.
- The live verification after deployment is recorded on the pull request.
- Tests: `makemkvPrivacySettings.test.ts` covers the text edits, the file writes (mode
  under a 0022 umask, owner, a new file at 0600, a stale temporary file never reused, a
  failed rename keeps the key and leaves no temporary file, the symlinked `.MakeMKV`
  folder, a symlinked `settings.conf`, and a dangling one left in place), a key replaced
  in the middle of an edit, a second call that waits for the first, an edit that gives
  up when the file changes every time, and the order at the call sites:
  `identifyDisc` and `enumerateDrives` start makemkvcon only after both values are off,
  and `identifyDisc` and `runRipJob` do not run makemkvcon when the file cannot be
  written.
