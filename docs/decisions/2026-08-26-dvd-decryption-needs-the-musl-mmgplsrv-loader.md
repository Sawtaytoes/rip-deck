# DVD decryption needs `mmgplsrv`, which is a musl binary on a glibc base

Status: Accepted
Date: 2026-08-26
Type: build / correctness

## Decision

The runtime image carries a **musl runtime for exactly one binary**:
`/opt/makemkv/bin/mmgplsrv`, MakeMKV's GPL-licensed DVD decryption helper.

Three files come across from the Alpine stage:

| File | Where it goes | Why there |
| --- | --- | --- |
| `ld-musl-x86_64.so.1` | `/lib/ld-musl-x86_64.so.1` | It is the `PT_INTERP` compiled into the binary. Nothing on a Debian base looks at that path, so it collides with nothing. |
| `libstdc++.so.6.0.32` | `/opt/makemkv-musl/lib/` | Its own prefix, found through `/etc/ld-musl-x86_64.path`. |
| `libgcc_s.so.1` | `/opt/makemkv-musl/lib/` | Same. |

⚠️ **Do NOT put Alpine's `libstdc++.so.6` in `/usr/lib` instead.** It would
shadow Debian's for every glibc binary in the image, starting with `node`.
`/etc/ld-musl-x86_64.path` replaces musl's built-in search path and is read by
the musl loader alone, so no glibc binary is affected.

A build-time assertion sits beside the copy, because the existing `makemkvcon`
smoke test cannot catch this and still cannot:

```dockerfile
RUN ! /opt/makemkv/bin/mmgplsrv --help 2>&1 | grep -q 'not found'
```

This does not make the image "musl-compatible" and must not be grown into that.
One binary, three files, one search path.

## Context

The owner loaded 8 Teenage Mutant Ninja Turtles DVDs on 2026-08-26 — the first
DVDs the tower had ever been given. Every drive failed. His question, which
turned out to be the whole answer: *"Is it something to do with DVDs vs BDs and
UHD BDs that I typically rip?"*

After two other defects were fixed (the `starting`-bay wedge, and MakeMKV
refusing a pre-created destination), a rip finally started — and still failed:

```
004041:0000 Failed to execute external program 'mmgplsrv' from location '/opt/makemkv/bin/mmgplsrv'
005069:0080 Backup failed
```

## Why

`/opt/makemkv` is **not** as self-contained as the transplant comment claims.
`makemkvcon` is — it ships its own glibc loader under `/opt/makemkv/lib` and
resolves through it, which is what the smoke test proves. But **DVD decryption
does not happen inside `makemkvcon`.** It is delegated to `mmgplsrv`, a separate
GPL binary, and jlesage's image is Alpine, so `mmgplsrv` is built against musl:

```
$ ldd /opt/makemkv/bin/mmgplsrv          # on the Debian runtime base
        libc.musl-x86_64.so.1 => not found
        /lib/ld-musl-x86_64.so.1 => /lib64/ld-linux-x86-64.so.2

$ /opt/makemkv/bin/mmgplsrv
sh: /opt/makemkv/bin/mmgplsrv: not found     # the LOADER is missing, not the file
```

`/opt/makemkv/lib` bundles a glibc loader for `makemkvcon` and **nothing** for
`mmgplsrv`, so the interpreter named in its ELF header does not exist on this
base and it can never start.

**The cost was silent and total: no DVD had ever ripped in this image.** Blu-ray
and UHD never touch `mmgplsrv` — AACS and BD+ are handled inside `makemkvcon` —
so every rip the tower had ever completed worked, and the defect was invisible
until the first DVD arrived. That is exactly why the owner's BD/UHD library grew
for weeks without a hint of it.

The smoke test could not have caught it. `info disc:9999` never spawns the
helper.

## Evidence

Same disc, same drive (slot 9, Pioneer BDR-211M), same argv, one isolated
container each. The only difference is the three files:

| Image | Result |
| --- | --- |
| `ghcr.io/sawtaytoes/rip-deck:latest` | `MSG:4041` → `MSG:5069 Backup failed`, **0 bytes written** |
| same + musl runtime | `MSG:1011 "Using LibreDrive mode (v02.1 id=…)"`, `MSG:5072`, **607 MB written in ~110 s**, `PRGV` climbing |

`MSG:1011` is the tell. LibreDrive never announced itself before, because the
drive was never successfully opened for a DVD.

## Consequences to watch

- **The `Scsi error … READ OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION` messages
  in `dmesg` were a SYMPTOM, not a cause.** With `mmgplsrv` unable to start,
  MakeMKV fell back to reading scrambled sectors directly and the drive
  correctly refused. They disappear with this fix. An earlier reading of this
  incident blamed the drives for those errors; that was wrong.
- **This does not fix the three cross-flashed LG drives.** Their `scsi_eh`
  threads sit in uninterruptible sleep and udev cannot even detect media in
  them — a separate, real fault on the same night. See the tower's own notes.
- **A jlesage base bump can change the two library filenames.**
  `libstdc++.so.6.0.32` is copied by its versioned name on purpose, so a bump
  that moves it fails the build loudly rather than silently reverting DVD
  support.
- **If jlesage ever ships a glibc `mmgplsrv`, delete all of this.** The check
  is one `ldd` away.
