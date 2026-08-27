# A redeploy cancels every running rip

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** Operations
- **Supersedes:** —
- **Superseded by:** —

## Decision

Never redeploy, restart or stop the `rip-deck` app while a rip is running. A
redeploy sends `SIGTERM` to the daemon, and the daemon answers that signal by
cancelling **every** rip in flight. Read `/json` first. If any bay reports
`ripping`, wait.

The check must FAIL CLOSED, because the two dangerous answers look the same.
This is the command:

```sh
curl -sf --max-time 20 https://rip-deck.octen.dev/json | python3 -c '
import json, sys
doc = json.load(sys.stdin)
rips = [r for h in doc["hosts"] for r in h["rips"] if r.get("status") == "ripping"]
print(len(rips))
sys.exit(1 if rips else 0)
'
```

Exit 0 means it is safe. Any other exit means WAIT.

⚠️ **Do not count the matches with `grep -c`.** `curl | grep -c` prints `0`
when nothing is ripping AND when the request fails — an unreachable daemon,
a timeout, a DNS failure. Those are opposite facts and the naive command
gives them one answer, which is the same mistake as reading the container
layout: a signal that cannot say "I do not know" will say "safe" instead. The
command above pipes into a parser, so a failed fetch raises rather than
printing zero. This was measured on 2026-08-27: a `grep -c` watch loop
reported "0 bays ripping" while both bays were at 91%.

## Context

Each rip runs in its own container. `docker ps` shows them beside the daemon:

```
rip-deck-rip-<job_uuid>   ghcr.io/sawtaytoes/rip-deck:latest
ix-rip-deck-rip-deck-1    ghcr.io/sawtaytoes/rip-deck:latest
```

That separate container is what made a redeploy look safe. It is not safe. The
daemon owns the `docker run` child, and `main.ts` binds the signal:

```ts
process.once("SIGTERM", () => shutdown("SIGTERM"))
```

`shutdown` prints `cancelling every running rip` and calls `watcher.stop()`,
which kills each ripper child. The container being separate changes who holds
the file descriptor. It does not change who gets the signal.

The daemon says this on every start, in its own banner:

```
Ctrl-C cancels every running rip.
```

On 2026-08-27 an agent redeployed the app to test a fix. Two DVD rips were at
80% and 87%. Both died. The partial output was kept, but a partial ISO is not a
backup, and both discs had to start again from zero.

## Why

- A rip is long. A DVD takes 10 to 20 minutes and a Blu-ray takes longer, so the
  window where a redeploy is destructive is most of the time the tower is in
  use.
- The cost of the check is one HTTP request. The cost of skipping it is a disc
  read from the start.
- "The rips are in separate containers" is a true statement that gives the wrong
  answer. Write down the signal path, not the container layout.

## Evidence

Owner, 2026-08-27, after the two rips were destroyed:

> "Also 5 and 6 failing because you canceled the rip, and they're not
> re-ripping anything now."

Daemon log from the restart that followed:

```
[slot 5 · 05 - Pioneer BDR-212U] held on startup — cancelled_by_operator (exit 143).
  Partial output KEPT at /media/Disc-Rips/.rip-deck-incomplete-36e0255d-…
[slot 6 · 06 - Pioneer BDR-211M] held on startup — cancelled_by_operator (exit 143).
  Partial output KEPT at /media/Disc-Rips/.rip-deck-incomplete-3b5d3968-…
```

Exit 143 is `SIGTERM`. The daemon recorded the cause correctly:
`cancelled_by_operator`.
