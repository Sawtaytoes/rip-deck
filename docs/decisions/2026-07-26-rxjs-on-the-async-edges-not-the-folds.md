# `rip-deck` adopts RxJS — on the async edges, not on the pure folds

Status: Accepted
Date: 2026-07-26
Type: architecture / conventions
Amends: the ⚠️ RxJS block in `AGENTS.md`, which described the alignment as an
open decision, and the matching trap bullet in `docs/HANDOFF.md` §6

## Decision

**`rip-deck` is on RxJS.** `rxjs ^7.8.2` is a dependency of `@rip-deck/daemon`,
matching the version and the per-package placement `mux-magic`,
`gallery-downloader` and `castkit` all use. The alignment `AGENTS.md` called an
open decision is closed: it is adopted, not deferred.

**It is adopted on the async edges only.** The line runs between *plumbing* and
*decisions*, and it is not negotiable by taste:

| Converted — orchestration | Kept pure — decisions |
| --- | --- |
| `settle.ts`'s poll-until-stable (`defer` + `repeat({ delay })` + `first`) | `foldSettleRound`, and the stability window inside it |
| `sampler.ts`'s interval, in-flight guard and read watchdog (`exhaustMap`, `raceWith`) | `health/**`'s folds, which the sampler only feeds |
| `watcher.ts`'s poll loop and per-bay dispatch (`exhaustMap`, `Subject` + bounded `mergeMap`) | `decideBayAction` / `applyBayDecision` / `applyBayOutcome` |
| — | `progress.ts`'s `createProgressTracker` / `observeEvent` |
| — | `liveness.ts`'s `assessLiveness` |

`progress.ts` and `liveness.ts` were **not converted at all**, because after the
line is drawn there is nothing in either file on the async side of it. Both are
pure folds end to end. The streams they belong to — the child's stdout lines and
the liveness re-assessment timer — live in `rip/ripJob.ts`, which is where an
RxJS conversion of them belongs and where it has not happened yet.

Three constraints survive the adoption and constrain any future use of it:

- **Timers come from `rip/unrefTimers.ts`, never from `interval`/`timer`/
  `timeout`.** RxJS schedules all three through `asyncScheduler`, whose handles
  are ref'd.
- **`mergeMap` is always bounded**, and in `watcher.ts` it is bounded at the
  governor's own cap.
- **Unsubscription is not cancellation.** A rip is cancelled by its
  `AbortSignal`; `stop()` completes the dispatch subject rather than
  unsubscribing it, so the two compose instead of racing.

## Context

`AGENTS.md` has listed "RxJS for streaming" as a house convention since Stage 0.
That was correct about the *house* — all three sibling monorepos depend on
`rxjs ^7.8.2` and use it heavily — and wrong about `rip-deck`, which had it in
neither `package.json`, `yarn.lock` nor a single import. The code grew a
different idiom instead: pure folds taking the clock as an argument, injected
deps with a `defaultDeps` binding, `*_TUNING` const objects, and
`setInterval` + `unref()`.

The owner raised the mismatch on 2026-07-26 and decided it the same day, before
the hardware-validation session rather than after it.

## Why

The owner's reasoning, verbatim:

> "It does so much of the right things we need and ensures the async logic is
> super easy to follow and less custom AI-generated code needs to be written. It
> does a lot of that for us and tests it."

Note what that asks for: **the async logic**. Three of the mechanisms this repo
had hand-rolled are single operators with a library's worth of testing behind
them — the sampler's in-flight guard is `exhaustMap`, both watchdogs are
`raceWith`, and the settle loop's exit is `first`. Two copies of the same
`raceWithTimeout` helper (`sampler.ts` and `watcher.ts`) went away with them.

It does **not** ask for the reducers, and converting them would have cost the
property this project is actually built on: a wedged drive, a nine-bay
flap-storm and a 25-minute rip are all testable in milliseconds with no
hardware, because every decision is a pure function of state and a clock passed
in as an argument. That is worth more than idiom consistency, and idiom
consistency was never in conflict with it — RxJS's own guidance is that
operators orchestrate and the functions inside them stay pure.

## Evidence

- Owner, 2026-07-26, on adopting it now rather than leaving it open: *"It does
  so much of the right things we need and ensures the async logic is super easy
  to follow and less custom AI-generated code needs to be written. It does a lot
  of that for us and tests it."*
- Sibling repos, checked 2026-07-26: `mux-magic` (api, cli, tools, core),
  `gallery-downloader` (sync-manga, download-web-images, sync-scheduler,
  web-server, shared-tools) and `castkit` (server) all pin `rxjs ^7.8.2` in the
  package that uses it, never at the monorepo root.
- The unref trap is measured, not assumed: a sampler and a watcher both left
  running with wedged reads exit the process in 0.6 s
  (`unrefTimers.test.ts` asserts `hasRef() === false`), and
  `rip-deck watch` still has to be killed by `timeout`.
- The refactor preserved all 527 pre-existing tests. **That proves the refactor
  did not change what the tests assert; it proves nothing about hardware.** No
  byte has moved through any of this code.
