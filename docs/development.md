# Local development

## Requirements

- Node.js 26.
- Corepack and Yarn 4.
- A writable Playwright browser directory for the web test suite.
- Linux optical-drive access only for hardware commands.

## Install

```sh
corepack yarn install --immutable
```

## Commands

```sh
corepack yarn dev
corepack yarn build:daemon
corepack yarn typecheck
corepack yarn lint
```

The CLI includes read-only inspection commands and commands that write media:

```sh
corepack yarn rip-deck probe
corepack yarn rip-deck probe --no-makemkv
corepack yarn rip-deck parse < capture.log

corepack yarn rip-deck rip --slot 9 --dry-run
corepack yarn rip-deck rip --slot 9
```

`probe` and `parse` are read-only. `rip` writes to the destination. The dry run resolves the requested work without spawning the ripper.

## Tests in an agent container

The web tests run Vitest in browser mode through Playwright. Install the browser revision pinned by this repository into a writable directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers corepack yarn playwright install chromium-headless-shell
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers corepack yarn test --run
```

Do not change the repository's Playwright version to match a browser in the agent image. `yarn install-playwright-browser` is the CI command and includes `--with-deps`, which can need root package installation.

## Compare rip-card layouts with fake data

Run `VITE_MOCK=1 corepack yarn workspace @rip-deck/web dev`. Open
`/?fake=showcase&layout=hierarchy` for A or `/?fake=showcase&layout=band` for B.
The mock-only toolbar switches layouts without replacing the fixture data. The
showcase includes poster/no-poster cards, a stall, a completed warning, a failure,
and an idle drive. Slot chips open drive details. Mock actions never call the real
daemon. Production builds ignore `VITE_MOCK` and do not show this toolbar.

Both layouts use Charcuterie's `ProgressCard`. Change the shared band, metric layout,
or responsive typography in that library first. `RipCard` supplies the rip state,
formatted values, media, and actions.

## Pull request gates

```sh
corepack yarn typecheck
corepack yarn lint
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers corepack yarn test --run
```

CI also checks the web package's Vite dependency-optimization list after the tests populate its cache.
