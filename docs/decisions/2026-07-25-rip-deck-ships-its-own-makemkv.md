# `rip-deck` ships its own image with `makemkvcon` in it

Status: Accepted
Date: 2026-07-25
Type: architecture / deployment
Supersedes: HANDOFF §3.0's four costed options; closes open question 6

## Decision

**`rip-deck` builds and runs its own container image containing both `node` and
`makemkvcon`.** It does not reach into any other container to rip.

- `/opt/makemkv` is copied from `ghcr.io/jlesage/makemkv` into a `node` base in
  a multi-stage build. See `Dockerfile`.
- The MakeMKV key lives in a **rip-deck-owned copy** of the config directory at
  `/srv/rip-deck/makemkv`, mounted at `/config` with
  `HOME=/config`. It is copied from the standalone `makemkv` app rather than
  from ARM, and never written to the live app's own config.
- Drives reach the container via `--device-cgroup-rule` plus a `/dev` bind,
  **never a fixed `devices:` list** — the owner powers the tower independently,
  and Docker refuses to start a container naming a missing device node (F3).
- The rip dataset is mounted **at the identical host path**, so `rip-deck` and
  `makemkvcon` share one filesystem view.

Consequently **`RIP_DECK_DEST_INNER` is no longer needed** on this path. It stays
in the code because the wrapper seam is still the right shape for a future
remote invocation, but nothing configured here sets it.

## Context

Stage 3's code was finished on 2026-07-24 and could not be run at all. The
blocker, recorded as HANDOFF §3.0: `makemkvcon` existed only inside ARM's
container, Tower has no `node`, and the agent container has no `docker` CLI.
Four options were costed, three of which borrowed ARM's container.

By 2026-07-25 the owner had powered the tower on, **disabled the
automatic-ripping-machine app entirely** and asked to see `rip-deck` do the job —
noting "we don't even need the container running at all". That removed the
borrow options by fact rather than by argument: the `arm` container no longer
exists, only its viewer.

Two other things were true and made this cheap:

- A standalone `makemkv` TrueNAS app (jlesage v26.07.2) was already installed,
  with **its own permanent key**, so nothing had to be taken from ARM.
- `/opt/makemkv` is **self-contained**. It ships its own glibc loader and
  libraries under `/opt/makemkv/lib` and resolves through them, so it
  transplants onto a different base cleanly.

## Why

- **It decouples the replacement from the thing it replaces.** Every `docker
  exec arm` variant made `rip-deck` depend on ARM staying installed, which is
  incoherent for a project whose endpoint is ARM's retirement.
- **One filesystem view removes a whole class of bug.** Two views meant every
  path had to be translated at exactly the right moment; the first dry run got
  that wrong and wrote a path that did not exist on the other side.
- **`docker exec` does not proxy signals**, so the borrow options all needed the
  UUID-scoped inner-kill workaround to avoid orphaning a `makemkvcon` holding a
  drive (E5). Running `makemkvcon` as a direct child makes the ordinary signal
  path work.
- It is **not throwaway work**. This is the Stage 6 deployment artifact, minus
  the daemon entrypoint.

## Evidence

Owner, 2026-07-25, choosing between a sidecar, reconfiguring the `makemkv` app,
and building the image: **"Build the real rip-deck image now."** Framing in the
same session: *"I turned on the optical ripper tower and disabled
automatic-ripping-machine to stop it from auto-ripping. We don't even need the
container running at all. I'd like to see how ours does."*

Verified the same night: nine drives visible inside the container,
`rip-deck probe` resolving 9/9 by firmware serial, and a real Blu-ray backup
running from it.

## Still open

- The image runs `tsx` against TypeScript sources rather than a compiled build,
  and installs devDependencies to do it. Fine for a proving run; Stage 6 should
  build.
- `CMD` is `sleep infinity` because Stage 3 is a manual `docker exec rip-deck
  rip-deck rip --slot N`. The daemon entrypoint replaces it.
- The image is local to Tower. J1 wants it in `example.com`
  under a TrueNAS custom-compose app.
- Key refresh (open question 1) is unchanged by this: the key is still a copied
  file, not something `rip-deck` can renew on its own.
