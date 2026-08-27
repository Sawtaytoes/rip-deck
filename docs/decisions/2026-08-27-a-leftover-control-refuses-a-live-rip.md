# A leftover control refuses a live rip, and the live set has one answer

Status: Accepted
Date: 2026-08-27
Type: correctness / data loss
Refines: [A leftover rename refuses rather than clobbers](2026-08-27-a-leftover-rename-refuses-rather-than-clobbers.md)
— that decision shared four source rules between Delete and Rename. This one
adds the fifth, which neither verb had, and which is the only rule that asks
the watcher instead of the filesystem.

## Decision

Neither Delete nor Rename may touch a leftover that a live rip claims, and the
panel says so before the operator presses anything.

1. **One answer to "is this rip live", in `packages/daemon/src/rip/liveRips.ts`.**
   It unions two pieces of evidence: the watcher's bay table (a bay in
   `starting` or `ripping` is claimed) and the uuids in running processes'
   argv, read with `reaper.ts`'s own `readRunningArgvUuidsFromProc`. Both
   readers of the question take this: the reaper's caller as `liveJobUuids`,
   the leftovers endpoint as a whole `LiveRips`.
2. **Unknown is a state, not an empty set.** `LiveRips` is
   `{ isKnown: true, jobUuids }` or `{ isKnown: false, reason }`. Every caller
   fails closed on the second. A router built without a reader gets the
   unknown default, never "nothing is running".
3. **The rule lives in `refusalToTouchLeftover`, which both verbs share.** A
   third verb inherits it and cannot miss it. `liveRips` is a required
   argument on `refusalToDeleteLeftover` and `refusalToRenameLeftover`, with
   no default, so a forgotten argument is a type error rather than a deleted
   rip.
4. **A duplicate landing is exempt.** `(rip-deck-duplicate-…)` is applied by
   the rename that ENDS a rip, so a folder wearing it is never being written
   to. Locking one would take away the only control that resolves a collision.
5. **An in-flight rip is LISTED and LOCKED, not hidden.** `scanLeftovers`
   takes the same `LiveRips` and sets `isLocked` / `lockReason` from the same
   function the two verbs refuse on. The panel renders a **Ripping now** chip,
   disables Rename and Delete, and prints the reason under the row.
6. **`readLiveRips` is threaded the way `destinationRoot` is** — from
   `main.ts` into `createApiServer` into `createApiRouter` — and read once per
   request, so the row's locked state and the endpoint's answer come from one
   read and cannot disagree.

## Context

The owner, 2026-08-27:

> *"Fix everything now before I start ripping again. I don't wanna wind up in a
> bad situation."*

`reaper.ts` has guarded this case since it was written. Its header names it in
the first paragraph: the tower runs nine drives, so at any instant there can be
nine `.rip-deck-incomplete-<uuid>` directories being written to right now, and
"a reaper that matched on the name alone would delete, with equal enthusiasm,
an in-flight 90 GB UHD rip and the evidence the owner deliberately kept". It
has five guards, and guards 2, 3 and 4 are all about liveness.

`leftovers.ts` — which puts a **Delete** button in front of the operator over
the same directories — had four rules, and not one of them asked whether a job
claimed the uuid. Its four were: the target resolves inside the destination
root, it is a direct child of that root, it is not the root itself, and its
name is one `classifyLeftover` recognises. A rip in progress satisfies all
four. It was listed in the panel as a deletable leftover with its bytes still
arriving.

Rename shipped on 2026-08-27 (PR #23) and inherited the same four rules, so it
inherited the same hole. Renaming a directory out from under a running
`makemkvcon` strands the rip exactly as deleting it does.

## Why

**The name cannot answer the question, and neither can the bytes.** A folder
being written to right now and one abandoned last week are byte-for-byte the
same shape. A 40 GB half-written UHD rip looks identical whether the process
writing it died an hour ago or is writing it this second. Only the live job set
tells them apart, so the endpoint has to be handed a fact the filesystem does
not hold.

**Two answers to "is this rip live" is how this bug happened.** The reaper had
one and the panel had none. Writing a second implementation for the panel would
have replaced "none" with "a different one", and the one that disagrees quietly
is the one that deletes a rip. So `liveRips.ts` is the single module, and the
reaper's own `/proc` reader is imported rather than re-written.

**Both pieces of evidence are needed, for the reasons the reaper already gives.**
The bay table is definitive while this daemon owns the rip. The `/proc` argv
scan is the evidence that survives a daemon RESTART, and that case is real
today: nothing re-adopts a running ripper child, so a restart mid-rip leaves
the bay table empty while `makemkvcon` keeps writing. A match on either proves
live; no match proves nothing, which is why neither is used alone and why a
failed read is `isKnown: false`.

**The phase filter is the whole bay-table function.** `BayState.jobUuid`
survives the outcome latch on purpose, so a finished disc's card can still
offer its `<uuid>.robot.log`. Reading it unfiltered would lock the panel
against the one folder the operator most wants to clear — the leftover of the
rip that just failed in that very bay.

**`starting` counts as live even though its child has not spawned.**
`prepareDestination` creates the incomplete directory BEFORE the spawn, so the
window between them is a real folder for a real rip with no process behind it.
`watcher.ts` and `trayCommand.ts` already treat the same pair of phases as a
claimed drive.

**A disabled button beats a refusal.** The API refusing a delete is correct and
insufficient. By the time the operator has pressed Delete he has already decided
to delete it, and an error toast after the fact teaches him that the panel's
buttons are unreliable rather than that this one folder is busy. The lock is
computed by the same function the refusal uses, so the disabled state is not a
guess about what the endpoint would say.

**In-flight rows are shown, not hidden.** Hiding was the alternative and it is
worse in three ways. The panel would disagree with the bay grid about what is
on disk, which is two views of one tower contradicting each other. An operator
who cannot see the folder cannot tell "there is no leftover" from "the panel is
not listing one", and that is the trust the panel needs the next time a rip
really does strand output. And a row that appears the moment a rip fails, with
no warning that it was ever there, reads as a new problem rather than as the
end of one he was watching. A greyed row that says *"Ripping now"* costs one
line and answers all three.

**`isLocked` is separate from `isSafeToDelete`.** They are different kinds of
statement. `isSafeToDelete` is advice the operator may overrule — a duplicate
landing is "not safe" and he deletes one on purpose, because the collision is
exactly the moment a human has to choose. `isLocked` is the daemon refusing:
both verbs answer 400, so the button is disabled rather than armed with a trap
behind it. Folding them into one field would have meant either arming a control
the API refuses or disabling one the operator is supposed to use.

## Evidence

⚠️ **A rip was lost on the live tower and this hole is consistent with it, but
it is not proven to be the cause.** Slot 8, job
`4d37d72e-7f72-4cee-a82b-7af82c10bfd3`, reached 99.1 %, ended with `MSG:5070`
and `MSG:5081 "Backup done"`, and recorded **zero** read errors. Rip Deck
reported `empty_output` and no partial output was anywhere on disk. Roughly
8 GB is gone. A folder deleted through this endpoint while the rip was still
writing would produce exactly that reading, and so would several other things.
Nothing in the logs names the delete, so the fix is justified by the hole
itself and not by that rip.

**What IS proven** is the hole, and the tests pin each half:

- `refusalToDeleteLeftover` and `refusalToRenameLeftover` both refuse a uuid in
  the live set, and both allow the same path once the job is gone.
- On a real filesystem, a refused delete and a refused rename leave the folder
  and its bytes exactly where they were.
- The other eight bays' folders stay clearable while one bay is ripping — a
  guard that locked the whole panel whenever anything was running would be
  ignored within a week.
- An unreadable live set refuses; an idle rack is known-and-empty and allows.
- A duplicate landing is never locked, even when its marker's uuid is live.
- The four original rules are unchanged: a finished rip is still refused before
  anything asks the watcher about it.

**A drive-by fix in the same file.** The duplicate chip was written as
`bg-intent-warning-subtle text-intent-warning`, and Charcuterie publishes
neither name — its token set is `border` / `content` / `on-solid` / `solid` /
`surface`. Tailwind v4 emits nothing for a class it cannot resolve and reports
nothing either, so that chip has been painting no background and inheriting its
colour since it shipped. It is `bg-intent-warning-surface
text-intent-warning-content` now. Fixed rather than left, because copying it
into the new tone would have turned a typo into a convention.
