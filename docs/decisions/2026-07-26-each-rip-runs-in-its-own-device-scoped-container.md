# Each rip runs in its own container that can see one `/dev/srN`

Status: Accepted
Date: 2026-07-26
Type: architecture
Supersedes: —
Superseded by: —
Amends: [`makemkvcon backup` takes a disc index, and scans the whole bus to
resolve it](2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md), which
named this as the intended real fix and left it unbuilt

## Decision

A rip no longer runs beside its siblings. Each one gets a **short-lived
container holding a single `--device /dev/srN`**:

```
docker run --rm --init \
  --name rip-deck-rip-<jobUuid> \
  --device /dev/sr3 \
  <operator's mounts> \
  rip-deck:0.1.0 makemkvcon -r --noscan … backup --decrypt disc:0 <out>
```

Consequences, in the order they matter:

- **The forced bus scan finds exactly one drive.** A wedged sibling is not
  merely deprioritised, it does not exist inside that container.
- **The disc index collapses to a constant** — `ISOLATED_DISC_INDEX` = 0. The
  third numbering stops moving, because there is nothing left to renumber
  against.
- **`verifyDiscIndex` stays**, even though it becomes cheap and very nearly
  tautological. Reasons in *Why*.
- **Isolation is opt-in**, keyed on `RIP_DECK_RIP_ISOLATION_IMAGE` being set.
  Absence of config means "no isolation", never "misconfigured".
- The image gains a `docker` **client** and `procps`; the daemon container gains
  a `/var/run/docker.sock` mount. Sibling containers, not docker-in-docker.

Config surface, all read in `resolveRipIsolation`:

| Variable | Meaning |
| --- | --- |
| `RIP_DECK_RIP_ISOLATION_IMAGE` | Image with makemkvcon in it. **Setting it is what turns isolation on.** |
| `RIP_DECK_RIP_ISOLATION_DOCKER` | How to reach a runtime; default `docker`. Takes a vector, e.g. `ssh root@tower.example.com docker`. |
| `RIP_DECK_RIP_ISOLATION_ARGS` | The operator's `docker run` args: mounts, `--user`, extra `--device`. |

## Context

Measured on hardware 2026-07-25 and recorded in the decision this amends:
`backup` **ignores `--noscan`**, emits `PRGT:5018 "Scanning CD-ROM devices"` and
walks the entire USB bus before every rip. It is not a bug to route around — a
`disc:` source is *defined* in terms of that enumeration, so no flag can
suppress it.

That was survivable while `rip-deck rip` was one manual slot at a time. It is not
survivable at the shape the owner has now asked for: **drop nine discs in, get
nine rips.** Nine concurrent rips that each re-enumerate nine drives is 81 device
probes contending over one 10-port hub reached through one long extension cable —
the exact hardware that produced the original 17-minute "Scanning CD-ROM
devices" hang at 0% CPU. One drive in SCSI error recovery would delay the start
of all eight other rips.

Two things made the fix cheap now and not before:

- `rip-deck` owns its own image
  ([decision](2026-07-25-rip-deck-ships-its-own-makemkv.md)), so a per-rip
  container is a `docker run` of something that already exists.
- `resolveMakemkvCommand` already models the invocation as a **command vector**
  rather than a binary path, with `wrapperArgs` meaning "how to run an arbitrary
  command wherever makemkvcon actually runs". An isolated rip is a different
  *value* of that type, not a second code path.

## Why

- **Taking the siblings away is strictly stronger than asking MakeMKV not to
  look at them.** Every flag-based approach was tried and measured; this is the
  only mechanism left that the tool cannot ignore.
- **`--init` is load-bearing, and its absence would be silent.** Without it
  makemkvcon is PID 1, and the kernel drops signals with a default disposition
  sent to PID 1 — so a cancel would do nothing at all, which is E5 failing in
  precisely the way it was written to prevent. With it, tini is PID 1 and
  forwards.
- **No `-t`.** A TTY merges stderr into stdout and appends CRs to lines that get
  parsed field by field. Robot-mode output is parsed, not read, and §2.5 already
  cost a rip to one malformed line.
- **`verifyDiscIndex` is kept deliberately.** Under isolation it can only fail in
  two ways, and both are worth catching: `--device` is built from a `/dev/srN`
  resolved from sysfs, and `srN` reshuffles on every USB re-enumeration, so a
  stale path maps a **sibling** into the container with total confidence; and the
  claim that a lone drive is numbered 0 is assumed, not measured. The error it
  guards against — this bay's folder name over another bay's disc — is
  unrecoverable by inspection, and on a stream we already parse the check costs a
  `find` over sixteen rows. Cheap insurance against an expensive, undetectable
  mistake is worth keeping even when it looks tautological.
- **Opt-in, not default.** The Stage 3 loop ripped a real Blu-ray twice,
  byte-identical, without a docker socket in sight. A deployment that cannot
  reach a container runtime must keep doing that rather than fail every rip.
- **The mounts are the operator's, not ours.** rip-deck supplies what only rip-deck
  knows — which device, which container name, which image, which argv — and
  refuses to guess a deployment's mount layout. A wrong guess is a rip that dies
  on a missing MakeMKV key twenty minutes in.
- **Per-job container names, never per-drive.** Nine at once, and a drive can be
  re-ripped while its previous container is still tearing down. `docker run
  --name` fails outright on a duplicate, which would turn a name collision into a
  refused rip.

## Evidence

The measurement this is built on, from the rip of 2026-07-25 (full context in
the decision this amends):

```
$ makemkvcon -r --noscan … backup --decrypt disc:5 <out>
PRGT:5018,0,"Scanning CD-ROM devices"
PRGV:0,0,65536 … PRGV:65536,65536,65536
DRV:5,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00009","","/dev/sr0"
```

Covered by `ripCommand.test.ts` (the invocation, the nine-concurrent case, the
kill path through a remote runtime) and `discIndex.test.ts` (the one-row DRV
table an isolated container is expected to produce).

### ⚠️ What is NOT verified

**The tower has been off throughout, by standing rule, so none of this has met a
disc.** The tests prove the argv we build and the decisions we make from it;
they cannot prove the behaviour of MakeMKV inside a container it has never run
in. A hardware test must check, in this order:

1. **Does `makemkvcon` enumerate at all with only `/dev/srN` present?** If it
   also needs the matching SCSI-generic node, add `--device /dev/sgN` to
   `RIP_DECK_RIP_ISOLATION_ARGS`. The ARM deployment carried a `c 21:* rmw`
   cgroup rule, so this is a live possibility rather than paranoia.
2. **Is the lone drive `disc:0`?** If not, the rip aborts `wrong_drive` before
   writing — a safe failure, and the reason `verifyDiscIndex` was kept.
3. **Does the scan actually shorten?** Time `PRGT:5018` inside the container
   against the ~25 s whole-preamble figure measured unisolated.
4. **Does a cancel still land?** Ctrl-C mid-rip, then
   `docker ps -a --filter name=rip-deck-rip-` must come back empty and
   `pgrep -f makemkvcon` must find nothing. This is unit F's job and it is the
   `--init` claim's only real test.
5. **The image has never been built with these changes** — no `docker` CLI
   exists in the agent sandbox. The `DOCKER_CLI_VERSION` pin and the static
   download are unproven.
6. **The wedged-sibling win is partly unrealised until the CLI stops
   pre-scanning.** `rip-deck rip` still calls `enumerateDrives` (a full
   `info disc:9999` bus scan) before every rip to resolve an index that
   isolation makes irrelevant. Inside the rip, isolation holds; the *start* of a
   rip can still be delayed by a wedged sibling until that call is skipped when
   `resolveRipIsolation` returns non-null. `cli.ts` was owned by another unit
   this pass.
