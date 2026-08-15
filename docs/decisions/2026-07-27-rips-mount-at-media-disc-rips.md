# Rips mount at `/media/Disc-Rips`, and only a `-v` *source* must be a host path

Status: Accepted
Date: 2026-07-27
Type: deployment / conventions
Amends: the "the destination mount must be host-identical" note in the
`Dockerfile` and `docs/deployment-requirements.md` §3, which stated a rule about
the **source** as though it governed both sides of the colon

## Decision

**Rip Deck sees its rips at `/media/Disc-Rips`.** `RIP_DECK_DEST` defaults to that
path in the `Dockerfile`, and both the long-running container and every per-rip
container mount the dataset there:

```
-v /media/Disc-Rips:/media/Disc-Rips     # long-running container
RIP_DECK_DEST=/media/Disc-Rips
RIP_DECK_RIP_ISOLATION_ARGS="-v /media/Disc-Rips:/media/Disc-Rips …"
```

The host path `/media/Disc-Rips` appears **exactly twice, both times
as a `-v` source**, and nowhere else. `RIP_DECK_DEST_INNER` stays **unset**.

The rule it replaces, stated precisely:

- **Left of the colon must be a host path.** A `-v` handed to the Docker socket
  is resolved by the **Docker daemon**, not by whichever container asked. This is
  the true constraint and it applies to the source only.
- **Right of the colon is free**, subject to one requirement: it must be the
  same in the long-running container and in each per-rip container, because a rip
  is *prepared* by one (`prepareDestination` creates
  `.rip-deck-incomplete-<uuid>`) and *executed* by the other (`makemkvcon backup`
  writes into it). Both see `/media/Disc-Rips`, so they agree.

## Context

The owner noticed the mismatch while reading the live dashboard:

> *"I noticed you mounted `Disc-Rips` to `/media/Disc-Rips/`, but
> that doesn't match how we set them up in Mux-Magic. […] I don't like to expose
> physical locations when mounting volumes […] it's simpler to type
> `/media/Disc-Rips`. If they both match, my future plans to kick off mux-magic
> to post-process a rip will be a lot easier."*

Verified: **mux-magic mounts all thirteen of its datasets under `/media/`** —
`/media/Disc-Rips → /media/Disc-Rips`, `→ /media/Movies`,
`→ /media/Shows`, and so on. Rip Deck was the outlier, so Rip Deck changed.

The blanket rule looked like it forbade this. It did not, and the deployment
already disproved it: `-v /srv/rip-deck/makemkv:/config`
has never been host-identical.

## Why

- **It is the house convention, and the owner named the reason.** A future
  mux-magic post-process handoff needs no path translation if both sides speak
  the same path.
- **It does not expose a physical location.** The dataset layout is a fact about
  the pool, not something a container's own view should recite.
- **The hazard is real but contained.** An earlier design carried
  `RIP_DECK_DEST_INNER` to translate between two views of the same dataset, and it
  was retired when the image gained "one view"
  ([decision](2026-07-25-rip-deck-ships-its-own-makemkv.md)). This reintroduces
  two views — host and container — so the audit that had to pass was: *does any
  code assume its own path is the host's?*

  **It does not.** Audited 2026-07-27:
  - `RIP_DECK_RIP_ISOLATION_ARGS` is **deliberately opaque** —
    `resolveRipIsolation` splits it on whitespace into `extraArgs` and
    `buildIsolatedMakemkvCommand` splices it verbatim. Nothing derives a `-v`
    from `RIP_DECK_DEST`, so nothing can get the source wrong.
  - `destination.ts` (`prepareDestination`, `checkFreeSpace`, the `chown`) works
    entirely in the daemon's own view, which is the correct view for every one
    of those operations.
  - The only host-path arguments Rip Deck itself generates are `--device
    /dev/srN` and `--device /dev/sgN`, which are host device nodes and are read
    from sysfs.
  - `RIP_DECK_DEST_INNER` was never deleted from the code — `cli.ts`,
    `watcher.ts`, `ripJob.ts` and `destination.ts` still thread it end to end. It
    is simply not needed here, because the two views agree.

## Evidence

Owner, 2026-07-26, quoted above and recorded in
`HANDOFF-stage7-ui-and-naming.md` §10.

Live container before the change (`docker inspect rip-deck`, 2026-07-27):
`RIP_DECK_DEST=/media/Disc-Rips`, isolation args
`-v /media/Disc-Rips:/media/Disc-Rips …`, and a
`/config` bind that was already non-identical.

## Consequences to watch

- **The deployment must change in lockstep with the image.** An image defaulting
  to `/media/Disc-Rips` run with the old `-v` writes to a path that does not
  exist in the container. The run command and `RIP_DECK_RIP_ISOLATION_ARGS` are
  both listed in `../deployment-requirements.md`
  §3–§4.
- **The live `bays.json` holds `detail` strings under the old path.** They are
  display strings for finished rips, not paths anything reopens, but they will
  read `/media/Disc-Rips/…` until rewritten. Migration is deliberate
  and manual; the ledger version bump lands in the same wave and discards the
  file anyway, holding loaded discs rather than re-ripping them
  ([decision](2026-07-26-bay-memory-survives-a-restart.md)).
- **Anything already on disk is untouched.** This is a mount-point rename inside
  a container, not a move: the dataset, its 700-odd existing folders and their
  `568:568` ownership are the same bytes at the same place on the host.
