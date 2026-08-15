# The deployed image runs compiled JS on node, never tsx

Status: Accepted
Date: 2026-07-28
Type: deployment / resource use
Supersedes:
Superseded by:

## Decision

The image runs the daemon as a **single esbuild bundle on plain `node`**
(`node /app/packages/daemon/dist/cli.js watch`), built in a throwaway stage.
**`tsx`, the TypeScript source, and `node_modules` never reach the runtime
image.** This closes the "Stage 6 should build" note in
`../HANDOFF.md` §7.

- **Build stage** (`node:24-trixie-slim AS build`): full `yarn install`, builds
  the dashboard (`@rip-deck/web`) and bundles the daemon (`yarn build:daemon` →
  `scripts/build-daemon.mjs`).
- **Runtime stage**: node + makemkvcon + the rip tools, plus only three build
  outputs — `packages/daemon/dist/`, `packages/web/dist/`, and `config/`. No
  yarn, no tsx, no source, no `node_modules`.

## Context

The image ran `tsx packages/daemon/src/cli.ts`. `tsx` transpiles with esbuild at
load and keeps it resident, and running from source meant installing the entire
devDependency tree (tsx, typescript, vite…) into the deployed image. The owner:

> *"Use compiled JS and node directly. That'll save like 300MB RAM. We should
> never deploy tsx in the actual image."*

## Why

**`tsc` cannot produce a runnable build here.** The source imports with explicit
`.ts` extensions (the tsx/ESM style, e.g. `from "./drives/sysfs.ts"`), which
`tsc` only accepts under `allowImportingTsExtensions` — and that forces
`noEmit`. esbuild rewrites the extensions and folds `@rip-deck/contracts`, `rxjs`
and `mqtt` into one file, so the runtime needs no `node_modules` at all.

**Two portability bugs surfaced and are fixed, not worked around:**

1. **`isWatchInvocation` keyed on the entry filename ending `.ts`**
   (`main.ts`). The compiled entry is `cli.js`, so the guard returned false and
   the watcher **exited 0 with the tower unwatched** — silent, and exactly the
   "rack goes dark" failure mode the `CMD` comment warns about. Now matches the
   basename with its extension stripped, so `…/main.ts`, `…/cli.ts watch` and
   `…/cli.js watch` all start it, while `probe` and a test runner still do not.
   Regression tests added in `main.test.ts`.

2. **The dashboard path is `import.meta.url`-relative** in `webAssets.ts`, and
   the bundle sits at a different depth than the source, so the default resolved
   to the wrong directory. The image pins `RIP_DECK_WEB_DIST=/app/packages/web/dist`,
   which `readWebDistRoot` already honours over the default.

**The bundle is verified end to end, not assumed.** `node dist/cli.js`: `probe`
runs the sysfs code and exits 0; `watch` prints its startup banner, loads the
dashboard, and polls (the dynamic `import("./main.ts")` esbuild folds in
resolves correctly). Full suite 1171 pass, typecheck and biome clean.

## Evidence

- `Dockerfile` — two stages; runtime `COPY --from=build` of `dist/` only; launcher
  is `exec node /app/packages/daemon/dist/cli.js "$@"`.
- `scripts/build-daemon.mjs` — esbuild bundle, `platform: node`, `format: esm`,
  with a `createRequire` banner for any bundled-CJS `require`.
- `isWatchInvocation` fix + tests: `main.ts`, `main.test.ts` (compiled-entry
  cases).
- Owner quote + chat: 2026-07-28, the Rip Deck power-incident session.
