# Rip Deck builds on push and deploys like the fleet, not by hand

- **Status:** Accepted
- **Date:** 2026-08-02
- **Type:** deployment / infra
- **Supersedes:** the hand-build steps in
  2026-07-30 deployed-and-two-ux-fixes handoff §"redeploy"
- **Superseded by:** —

## Decision

Rip Deck is a real product now, so it deploys the **same way as every other
fleet app**. Hand-built `docker build`/`docker push` on Tower is retired.

- CI (`.forgejo/workflows/ci.yml`) gains a `docker-deploy` job — a direct mirror
  of gallery-downloader's `.gitea/workflows/ci.yml` — that `needs: [check]`,
  is skipped on `pull_request`, and on a push to `main` builds the image once
  and pushes it to `ghcr.io/sawtaytoes/rip-deck`.
- The app **consumes the moving `:latest` tag with `pull_policy: always`**, the
  way the running `gallery-downloader` app does
  (`repository: …/gallery-downloader`, `tag: latest`, `pull_policy: always`).
  TrueNAS is pull-based
  ([2026-05-07](2026-05-07-docker-registry-truenas-consumer-side.md)), so a
  redeploy force-pulls the newest build. `RIP_DECK_RIP_ISOLATION_IMAGE` moves to
  `:latest` too, so the per-rip container matches the long-running one.

## Context / the tag question

Rip Deck previously carried a **hand-bumped semver** image tag (`1.2.5`) pinned
in `deploy/docker-compose.yaml`, built and pushed by hand. That is the thing
"deploy exactly like the fleet, hand-built images are out" retires. The fleet
convention (gallery-downloader) is moving-`:latest` + force-pull, with immutable
`:<sha>` / `:<branch>` tags for audit.

Two owner instructions had to be reconciled: "deploy exactly like the fleet"
(→ `:latest`) and "bump the image ref forward, never back to 1.2.1, pick the
next version after 1.2.5" (→ a semver). Resolution: **the app consumes
`:latest`**, and CI **also** stamps the immutable fleet tags **plus rip-deck's
own semver** read from `package.json` (`version` is now the single source of
truth, bumped `0.1.0` → **1.2.6**). So `docker-deploy` pushes four tags —
`:latest`, `:<sha>`, `:<ref_name>`, `:1.2.6` — and 1.2.1 can never be what runs.
Rip-deck keeps its semver line for rollback; consumption matches the fleet.

## Why

- One deploy path for the whole fleet; no bespoke hand-build to forget or get
  wrong.
- `:latest` + force-pull means `deploy/docker-compose.yaml` never has to be
  edited to ship — push to `main` and redeploy.
- The immutable `:<sha>` and `:1.2.6` tags preserve reproducibility and rollback
  that a bare `:latest` would lose.

## Evidence

- gallery-downloader running app: `image.repository
  example.com/gallery-downloader`, `image.tag latest`,
  `image.pull_policy always` (TrueNAS `app.query`, 2026-08-02).
- gallery-downloader `docker-deploy` job template:
  `/srv/Repos/gallery-downloader/.gitea/workflows/ci.yml`.
- Owner (coordinator, 2026-08-02): *"rip-deck is now treated as a real product…
  it must deploy the EXACT same way as the other fleet apps. Hand-built images
  are out. Mirror gallery-downloader's deploy exactly."*
