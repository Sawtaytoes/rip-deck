# Local development

## Requirements

- Node.js 26.
- pnpm 12.9.1.
- A writable Playwright browser directory for the web test suite.
- Linux optical-drive access only for hardware commands.

## Install

```sh
npm install --global --force --allow-scripts=pnpm pnpm@12.9.1
npm install --global --force --allow-scripts=pnpm pnpm@12.9.1
pnpm install --frozen-lockfile
```

## Commands

```sh
pnpm dev
pnpm build:daemon
pnpm typecheck
pnpm lint
```

The CLI includes read-only inspection commands and commands that write media:

```sh
pnpm rip-deck probe
pnpm rip-deck probe --no-makemkv
pnpm rip-deck parse < capture.log

pnpm rip-deck rip --slot 9 --dry-run
pnpm rip-deck rip --slot 9
```

`probe` and `parse` are read-only. `rip` writes to the destination. The dry run resolves the requested work without spawning the ripper.

## Tests in an agent container

The web tests run Vitest in browser mode through Playwright. Install the browser revision pinned by this repository into a writable directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm playwright install chromium-headless-shell
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm test --run
```

Every web test runs in four windows — `web-narrow` 384x824, `web-tall` 1080x1920, `web-wide` 1920x1080, and `web-ultrawide` 3440x1440 — and a test that fails in one is triaged, never pinned back to one window ([decision](https://github.com/Sawtaytoes/charcuterie/blob/master/docs/decisions/2026-10-04-every-browser-test-runs-in-four-named-windows.md)). `vitest run --project web-narrow` runs one window alone. The visual-regression capture (`pnpm vrt:capture`) keeps its own single window.

Do not change the repository's Playwright version to match a browser in the agent image. `pnpm install-playwright-browser` is the CI command and includes `--with-deps`, which can need root package installation.

## Pull request gates

```sh
pnpm typecheck
pnpm lint
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm test --run
```

CI also checks the web package's Vite dependency-optimization list after the tests populate its cache.
