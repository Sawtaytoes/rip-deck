# Build `rip-deck` rather than adopt an off-the-shelf ripper

Status: Accepted
Date: 2026-07-24
Type: architecture

## Decision

Build an in-house disc ripper, `rip-deck`, in staged increments beside the
running ARM instance. **There is no adoption target** — every credible
off-the-shelf candidate was audited against a written requirements catalogue
first, and none of them fit.

Grow it in stages, most-wanted feature first:

| Stage | What ships | ARM |
| --- | --- | --- |
| 0 | Tower back online; aux-power standing check | Ripping |
| 1 | Health sidecar → MQTT → HA | Ripping |
| 2 | `rip-deck probe` + `rip-deck parse` | Ripping |
| 3 | Single-drive rip loop | Ripping 8 drives |
| 4–5 | MQTT parity, SSE, verdict UI | Ripping 8 drives |
| 6 | All 9 drives + fault injection | **Retired** |
| 7+ | Audio CD, then data/game discs | — |

**ARM is retired only after a 9-drive run survives deliberate fault injection.**

## Context

The stated preference was off-the-shelf, so this started by testing that
preference rather than assuming it away: fix the requirements in writing, then
score every candidate against them.

ARM works, but keeping it doing what we want costs **seven bind-mounted
`my_init.d` patch scripts plus a fail-closed gate**, all re-anchored to upstream
source lines that drift on every `:latest` bump.

Several premises turned out to be wrong and are corrected here:

| Belief | Reality |
| --- | --- |
| "ARM v2 is effectively dead" | Alive but thin. 2.24.1 shipped 2026-07-22, ~121 commits/yr, much of it dependabot. |
| "ARM v3 is a rewrite worth studying" | Stalled. `3.0_devel` last commit 2026-04-18, ahead 101 / behind 148 of `main`. Still Flask/MySQL/HandBrake and the same log-scraping progress code. No REST API, no MQTT. Fixes none of our pain points. |
| "PR #1791 is open" | Merged 2026-07-22, in 2.24.1. |
| "#1771 = MakeMKV global-index bug" | Misattribution. #1771 is the v3 announcement issue. |
| "v3 lives in a separate repo" | Half right: `uprightbass360` split ARM into decoupled repos, then abandoned them. |
| "the SCSI wedge is a topology problem" | Superseded — see [the cable correction](2026-07-24-active-usb-extension-aux-power-explains-the-wedge.md). |

## Why

### The pain points are architectural and old

- silent success on read errors — [#1298](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1298), open 18 months
- abort doesn't cancel — [#1014](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1014), open since 2023
- DB-locked with multiple drives — [#500](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/500), open **four years**, filed by another 9-drive user
- MQTT requested — [#1613](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1613), no action

`SKIP_TRANSCODE` doesn't even apply to `RIPMETHOD: backup` (#1230) — which is
*why* patch `01` exists.

### Every candidate failed the catalogue

| Candidate | Verdict |
| --- | --- |
| **ARM v2** | Keep running it; don't expect it to improve. |
| **ARM v3** | Does not exist as a shippable thing. No v3 tag; `arm-ripper` is commented out of its own compose; `utils_old.py` (35 KB) is still the largest file; announcement issue has zero comments six weeks on. |
| **`uprightbass360` decoupled ARM** | Best-engineered thing in the landscape, and abandoned by its author the same day he created `arm-v3`. 0 watchers, no human-filed issue in five months. Also doesn't fix our two worst problems: cancel only works on already-paused jobs, and drive identity is still `/dev/srN`-derived with `serial` explicitly "for reporting only". |
| **DiscEcho** | Good Go code, architecturally wrong here. `Scan()` runs `makemkvcon info` without `--noscan` (at 9 drives one wedged unit hangs every other identify); `dev_path UNIQUE` with no serial column; no MQTT; **no stall watchdog anywhere**; and **no `makemkvcon backup` at all** — it cannot produce disc images, which is the whole workflow. |
| **arm-sharp** | 8 weeks old; `Conductor.RunAsync(devicePath)` takes one device. No multi-drive. |
| **docker-ripper / autoripper / Autorippr** | Single-drive by design, an empty skeleton, and dead since 2018. |

### The build is far smaller than it looks

Most of the product already exists in-house: the React dashboard (already TS),
RxJS job-orchestration patterns from `mux-magic`/`gallery-downloader`, the MQTT
+ HA-discovery layer from `castkit`, and a TMDB client with the timeout
handling already learned the hard way. The rejected projects are MIT-licensed,
so their hardest-won knowledge is portable **without taking the dependency**.

### The headline feature is separable from the ripper

The disc-health engine's inputs are kernel-side — `ioerr_cnt`,
`/sys/block/srN/stat`, `/dev/kmsg`, throughput against a per-drive baseline.
So v0.1 is a **health sidecar that watches ARM**: it ships the most-wanted
feature without touching the ripper, and keeps working unchanged under whatever
ripper eventually wins. It is also the instrument that tells us whether the
harder failure-isolation work in Stage 6 is needed at all.

**Nice synergy: the first thing we build is the thing that answers whether we
need the rest.**

## Why TypeScript, not Python

The earlier brief defaulted to Python because three reusable pieces are Python.
They are portable, and TS wins where it matters: it is the owner's language, the
house already has two RxJS job-orchestrators of almost exactly this shape, and
the dashboard and its `types.ts` contract are already TS — so the daemon shares
types with the UI instead of re-declaring them across a language boundary.

**The decisive technical reason is the wedge, not familiarity.** A synchronous
`ioctl` on a drive stuck in uninterruptible D-state blocks its caller. On Node's
single event loop that would freeze all nine drives' monitoring and the whole
API at once. The architecture is therefore **one child process per drive**: a
wedged `ioctl` or a hung `makemkvcon` hangs only its own child, and the parent
reaps it. That deletes the Python design's "sacrificial thread leakage" standing
risk outright rather than capping it.

**The one real cost, stated honestly:** the tray-control ioctls that
`drive_control.py` got free from stdlib need a small N-API/`ioctl` binding in
Node. ~50 lines, and it lives in the child where a blocking call can't hurt
anyone else.

## Risks accepted

1. **Every health threshold is invented.** Bad thresholds produce false "clean
   this disc" alerts and the feature becomes worse than absent. Mitigations:
   `ok` is the default; only two-drive `confirmed` verdicts announce; the full
   feature vector is persisted so tuning is a query, not a re-rip; don't tune
   before ~30 real jobs.
2. **Scope creep — the health engine is the fun part and can be built forever.**
   Stop rule: step 3 is the whole value proposition. If it slips past two
   weekends, stop and reconsider.
3. **`privileged: true` is probably required** for USB de-auth/re-auth recovery.
   Not new exposure given ARM's existing device access, but a conscious choice.
4. **The udev rule may not survive a TrueNAS upgrade, silently.** Install via
   `initshutdownscript.create`; the daemon verifies the rule's hash at startup
   and screams over MQTT if it's missing.
5. **ddrescue against AACS media is unverified.** Test on one real disc before
   building the escalation ladder.

## Evidence

- Owner: strong preference for off-the-shelf; the audit above was run to test
  that preference, not to justify a build. (chat 2026-07-24)
- Owner correction on hub topology: "It's a long 10m-15m USB cable into a single
  10-port USB hub into those SATA to USB adapters." (chat 2026-07-24)
- Owner correction on identity: "the USB adapters are probably the same. Even
  with the new firmware, the old serial numbers should've been retained."
  (chat 2026-07-24) — verified: the ASMedia bridges expose no SCSI VPD page
  0x80, and the firmware serial is only readable via `makemkvcon`.
- Supersedes
  [`media-library-todo/arm-lean-rewrite-plan.md`](/srv/Repos/agentic/media-library-todo/arm-lean-rewrite-plan.md).
