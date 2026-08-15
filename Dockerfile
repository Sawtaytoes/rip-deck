# syntax=docker/dockerfile:1

# Rip-Deck — node + makemkvcon in ONE filesystem view.
#
# Before this image, `rip-deck` could not invoke `makemkvcon` at
# all: makemkvcon lived only inside the previous ripper's
# container, the host has no `node`, and the app container had no
# `docker` CLI. Every workaround (exec into that container, ssh +
# docker exec) borrowed it — coupling the replacement to the thing
# it replaces, and needing RIP_DECK_DEST_INNER to translate between
# two views of the same dataset.
#
# Here there is one view, so RIP_DECK_DEST_INNER is unnecessary.
# "One view" means the long-running container and every per-rip
# container agree on the destination path — NOT that the path
# matches the host's. See the mount note below.
#
# ⚠️ This image now plays TWO roles, and both are it:
#
#  1. the long-running rip-deck container, which spawns…
#  2. …one short-lived container PER RIP, holding a single
#     `--device /dev/srN`, because `makemkvcon backup` re-scans
#     the whole USB bus before every rip and no flag stops it
#     ([decision](docs/decisions/2026-07-26-each-rip-runs-in-its-own-device-scoped-container.md)).
#
# Role 1 therefore needs a `docker` CLI and a mounted
# `/var/run/docker.sock`; role 2 needs neither, but it is the same
# image, so it carries them. Turning isolation on is deployment
# config, not a rebuild:
#
#   -v /var/run/docker.sock:/var/run/docker.sock
#   -e RIP_DECK_RIP_ISOLATION_IMAGE=rip-deck:0.1.0
#   -e RIP_DECK_RIP_ISOLATION_ARGS="\
#        -v /media/Disc-Rips:/media/Disc-Rips \
#        -v /srv/rip-deck/makemkv:/config"
#
# ⚠️ Only the SOURCE of a `-v` must be a host path. The earlier
# rule here — "the destination mount must be host-identical" —
# was too wide, and it is the reason Rip-Deck mounted its rips at
# `/media/Disc-Rips` while every one of mux-magic's
# thirteen datasets mounts under `/media/`. Precisely:
#
#  - LEFT of the colon is resolved by the DOCKER DAEMON, never by
#    whichever container asked, so it MUST be a path on the host.
#    That is why the host path appears here and nowhere else.
#  - RIGHT of the colon is free. It only has to be the same in
#    the long-running container and in each per-rip container,
#    because a rip is prepared by one and executed by the other
#    (`prepareDestination` → `makemkvcon backup`). Both see
#    `/media/Disc-Rips`, so they agree and RIP_DECK_DEST_INNER
#    stays unset.
#
# `-v …/rip-deck/makemkv:/config` was always non-identical, which
# on its own disproves the blanket rule.
#
# (handoff §10)

# --- MakeMKV --------------------------------------------------
# MakeMKV has no distro package and building it needs the
# oss+bin tarball pair and a compiler. jlesage's image already
# has a working build, and /opt/makemkv is SELF-CONTAINED: it
# ships its own glibc loader and libraries under /opt/makemkv/lib
# and resolves through them rather than the host's.
#
# That is why this transplants onto a different base at all.
# Verified 2026-07-25: running `ldd` on makemkvcon inside the
# Alpine original prints a screenful of "symbol not found"
# relocation errors, because Alpine's musl ldd resolves against
# musl. The binary runs correctly regardless. Don't be alarmed by
# ldd here, and don't "fix" it by installing glibc compat.
FROM ghcr.io/jlesage/makemkv:v26.07.2 AS makemkv

# ============================================================= #
# Build stage — installs the FULL workspace (devDependencies and
# all) to compile the dashboard and BUNDLE the daemon to plain
# JS. Nothing here — not yarn, not tsx, not the TypeScript source,
# not node_modules — crosses into the runtime image below. Only
# the two build outputs do.
# ============================================================= #
FROM node:26-trixie-slim AS build

WORKDIR /app

# Manifests before source, so editing a .ts does not re-run a
# full yarn install on every rebuild.
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases ./.yarn/releases
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/daemon/package.json ./packages/daemon/
#
# ⚠️ EVERY workspace's manifest must be listed here, including ones
# this image never runs. `package.json` declares `workspaces:
# ["packages/*"]`, so yarn resolves against the whole set; omit one
# and `--immutable` fails with YN0028 "the lockfile would have been
# modified" — which reads like a corrupt lockfile and is not.
#
# Leaving `packages/web` out broke the build the moment it was
# added (2026-07-26). No gate catches this: `yarn test`,
# `typecheck`, `biome` and `eslint` never build the image. If you
# add a workspace, add it here in the same commit.
COPY packages/web/package.json ./packages/web/
RUN npm install -g corepack@latest && corepack enable && yarn install --immutable

COPY . .

# --- The dashboard --------------------------------------------
# `packages/daemon/src/api/webAssets.ts` reads the built dist into
# memory once at startup and the router serves it at `/`, on the
# same origin and the same port as `/json` — which is why the app
# needs no base URL, no CORS and no second container. The output
# is ~260 KB across three files and ships to the runtime image as
# static files. Vite and the rest of the web toolchain stay in
# THIS stage.
RUN yarn workspace @rip-deck/web build \
  && test -s packages/web/dist/index.html

# --- The daemon, compiled -------------------------------------
# One esbuild bundle → `packages/daemon/dist/cli.js`, which the
# runtime runs on plain `node`. This REPLACES `tsx …/cli.ts`:
# tsx kept esbuild resident to transpile on every start (~300 MB
# of RAM on a long-lived watcher) and dragged the whole
# devDependency tree into the deployed image. We never ship tsx.
#
# `tsc` cannot produce this — the source imports with explicit
# `.ts` extensions (`allowImportingTsExtensions` forces
# `noEmit`) — so esbuild rewrites them and folds `@rip-deck/contracts`,
# `rxjs` and `mqtt` in. The runtime image then needs no
# node_modules at all.
# ([decision](docs/decisions/2026-07-28-compiled-js-on-node-not-tsx.md))
RUN yarn build:daemon \
  && test -s packages/daemon/dist/cli.js

# ============================================================= #
# Runtime stage — node + makemkvcon, the compiled bundle, and the
# static dashboard. No yarn, no tsx, no node_modules, no source.
# ============================================================= #
#
# Debian rather than Alpine: MakeMKV's bundled libraries are
# glibc-linked, so a glibc base is the low-surprise choice even
# though the bundle carries its own loader.
#
# ⚠️ TRIXIE, not bookworm, and the reason is `cyanrip` below —
# Debian 13 is the oldest release that packages it. Bumping the
# base was the cheaper of the two ways to get `cyanrip`, and the
# risky one, because it moves the ground out from under the
# MakeMKV transplant. That
# risk is now measured rather than argued: on this base
# `makemkvcon -r info disc:9999` prints its v1.18.4 banner and a
# full 16-row DRV table, so the self-contained loader does what
# the transplant decision said it would. If a future base bump
# breaks it, the symptom is a loader error on the interpreter or
# a glibc version complaint, NOT a MakeMKV message.
FROM node:26-trixie-slim

COPY --from=makemkv /opt/makemkv /opt/makemkv
ENV PATH="/opt/makemkv/bin:${PATH}"

# The transplant, asserted rather than assumed.
#
# `--cache=1` and a nonexistent `disc:9999` keep this cheap and
# device-free; the point is only that the bundled loader resolves
# on THIS base. Matching MSG:1005 rather than the exit code is
# deliberate — makemkvcon exits 0 on "Failed to open disc", so an
# exit code proves nothing, while the startup banner can only
# come from a binary that actually started.
#
# Costs one empty layer and turns a future base bump from a
# runtime surprise into a build failure. That is the whole reason
# it is here: the bookworm→trixie move was defended for three
# stages with "it should work" and nobody had checked.
RUN makemkvcon -r --cache=1 info disc:9999 \
  | grep -q 'MSG:1005.*started'

# --- Tools the rip loop needs ---------------------------------
# `eject` is the operator tray command (`rip/tray.ts`), and it
# is the ONLY reason a rebuild is needed for the eject button to
# work: node:26-bookworm-slim carries no `eject`, and until this
# image is rebuilt and redeployed every tray command reports
# "this rip-deck image has no `eject` binary" rather than moving a
# drive.
#
# A binary rather than an in-process `CDROMEJECT` ioctl on
# purpose. Node has no ioctl at all, so "directly" would mean a
# native addon — and an ioctl in the daemon's own process is the
# synchronous device call this project forbids: a drive wedged in
# SCSI error recovery blocks it for up to 600 s and freezes all
# nine bays plus the API. A child process is already off the
# event loop and is killable.
#
# `procps` is for `pkill`. The kill path reaches into whichever
# container makemkvcon ended up in and kills it by JOB UUID
# (`buildInnerKillArgs`), which is E5: SIGTERM to a docker client
# kills the client and leaves makemkvcon holding the drive.
# That path has only ever run against ARM's container, which has
# procps; bookworm-slim does NOT, so an isolated rip would have
# had no reachable kill at all.
#
# The `docker` CLI is the client for role 1 above — a client
# only, talking to the host daemon over the mounted socket. This
# is sibling containers, not docker-in-docker: no daemon runs
# here.
#
# `cyanrip` is the audio-CD half of the fork in `discType.ts`
# (plan A3: FLAC, AccurateRip v1+v2). It is the ONLY reason this
# image is on trixie. Without it an inserted audio CD is detected
# and classified correctly and then fails for want of a binary —
# loud and correct, but still a failure, and it stayed that way
# for three stages.
#
# Deliberately UNPINNED, unlike the docker CLI: it comes from
# Debian main, so the base tag pins it. `node:26-trixie-slim`
# gives cyanrip 0.9.3.1-1+b1 today.
#
# Provenance re-confirmed at install time rather than taken on
# trust (workspace J6 forbids unclear origin). The installed
# package's own `copyright` names upstream **Lynne
# <dev@lynne.ee>** and `github.com/cyanreg/cyanrip` under
# LGPL-2.1+, which is the project audited in
# `rip/cyanripCommand.ts` — not a same-named impostor. Its whole
# dependency chain (FFmpeg, libcdio-paranoia, libmusicbrainz5,
# libcurl) is long-established Western FOSS.
#
# Note the deps come from the DISTRO here. cyanrip links Debian's
# FFmpeg 7.1 and libcdio, none of which MakeMKV's bundle
# supplies — the two rippers share this filesystem and nothing
# else.
#
# Pinned, per the workspace's version-soak rule. Check
# https://download.docker.com/linux/static/stable/ before moving
# it.
ARG DOCKER_CLI_VERSION=27.5.1

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates curl cyanrip eject procps; \
  rm -rf /var/lib/apt/lists/*; \
  cyanrip -V; \
  case "$(dpkg --print-architecture)" in \
    amd64) dockerArch=x86_64 ;; \
    arm64) dockerArch=aarch64 ;; \
    *) echo "no static docker CLI for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/docker.tgz \
    "https://download.docker.com/linux/static/stable/${dockerArch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
  tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
  rm /tmp/docker.tgz; \
  docker --version

WORKDIR /app

# Only the build's outputs cross the stage boundary: the bundled
# daemon, the static dashboard, and the drive config the watcher
# reads relative to /app. There is no node_modules and no tsx in
# this image BY CONSTRUCTION — they never leave the build stage.
COPY --from=build /app/packages/daemon/dist ./packages/daemon/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY config ./config

# `node` on the compiled bundle, not `tsx` on source: one less
# process, no esbuild resident, and no yarn preamble polluting
# stdout — which matters because robot-mode output is parsed, not
# read.
#
# The `cd` is load-bearing. RIP_DECK_DRIVES_CONFIG defaults to the
# relative path `config/drives.json`, so a caller running from
# elsewhere would silently get an empty drive registry and every
# drive would resolve to "UNKNOWN DRIVE".
RUN printf '%s\n' \
  '#!/bin/sh' \
  'cd /app' \
  'exec node /app/packages/daemon/dist/cli.js "$@"' \
  > /usr/local/bin/rip-deck \
  && chmod +x /usr/local/bin/rip-deck

# HOME drives where makemkvcon looks for its key: it reads
# $HOME/.MakeMKV/settings.conf. The mounted config directory
# carries a `.MakeMKV -> /config` symlink (jlesage's layout), so
# pointing HOME at /config resolves the key, and app_DataDir's
# "/config/data" lands inside the mount too.
ENV HOME=/config

# The CONTAINER's view of the rips dataset, matching how
# mux-magic mounts all thirteen of its datasets. The host side
# stays `/media/Disc-Rips` and is named only in the
# `-v` sources, per the mount note at the top of this file.
ENV RIP_DECK_DEST=/media/Disc-Rips
ENV RIP_DECK_STATE_DIR=/var/lib/rip-deck

# The bundle sits at a different directory depth than the source,
# so webAssets.ts's `import.meta.url`-relative default no longer
# resolves to the dashboard. `readWebDistRoot` honours this env
# over that default, so pin it to where the dist was copied above.
ENV RIP_DECK_WEB_DIST=/app/packages/web/dist

# `rip-deck watch` binds this for BOTH the dashboard (`/`) and the
# JSON it reads (`/json`) — one origin, one port, one `-p`.
# Documentation only, as EXPOSE always is: publish it with
# `-p 3007:3007`, or the owner gets a UI he cannot reach.
EXPOSE 3007

# Stage 6, and this is the line that was waiting for it.
#
# It used to be `sleep infinity`, with `rip-deck watch` started by
# hand through `docker exec`. That works right up until anything
# restarts the container — and then the container comes back
# (`--restart unless-stopped`) while the daemon does NOT, so the
# tower is silently unwatched, `/json` and the dashboard answer
# nothing, and no inserted disc is ever ripped. Found the hard way
# on 2026-07-26: a `docker restart` to pick up a config change
# left the rack dark, and nothing said so.
#
# Auto-starting the watcher is only safe because bay memory now
# survives a restart (`rip/bayLedger.ts`). Before that, this line
# would have made every reboot re-rip whatever was loaded — which
# is exactly the 225 GB the ledger exists to prevent. The two
# changes belong together; do not restore this CMD to `watch`
# behaviour in an image whose ledger does not work.
#
# This Dockerfile sets no ENTRYPOINT, which is why the CMD is safe
# to change: a per-rip container runs `docker run … rip-deck:1.0.0
# makemkvcon -r … backup …`, replacing this CMD wholesale, and the
# per-rip path never inherits it.
#
# ⚠️ But there IS an inherited one. `node:26-trixie-slim` sets
# `ENTRYPOINT ["docker-entrypoint.sh"]`, so every per-rip argv is
# really `docker-entrypoint.sh makemkvcon …`. Verified against the
# script in the built image: it re-execs `"$@"` untouched UNLESS
# the first argument starts with `-`, is not on `PATH`, or is a
# non-executable file — in which case it silently prepends
# `node`. `makemkvcon` is on `PATH` via `/opt/makemkv/bin`, so
# today it passes through. Anything that makes the first argument
# a flag or a bare path turns an isolated rip into
# `node <path>`, which fails for a reason nobody would guess.
CMD ["rip-deck", "watch"]
