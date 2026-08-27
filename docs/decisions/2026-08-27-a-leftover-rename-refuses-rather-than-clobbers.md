# A leftover rename refuses rather than clobbers, and keeps the `.iso`

Status: Accepted
Date: 2026-08-27
Type: product / correctness
Refines: [A DVD backup is one ISO file, not a directory](2026-08-26-a-dvd-backup-is-one-iso-file-not-a-directory.md)
— that decision put the collision marker BEFORE the extension. This one is
what happens when a person then has to resolve that collision by hand, and it
fixes the `classifyLeftover` test that decision's shape had already broken.

## Decision

The leftover panel can RENAME a folder, not only delete it. Four rules:

1. **`POST /api/leftovers` carries a `command`** — `"delete"` or `"rename"` —
   dispatched by `handleLeftoversWrite`. One route, not a second pathname.
2. **A rename REFUSES a destination that already exists.** Never clobber.
3. **A file-shaped rip keeps `.iso`.** If the leftover is a regular file and
   the typed name omits the suffix, it is appended. A directory gets none.
4. **The new name is one path segment** — not empty, no `/`, no `\`, not `.`,
   not `..`, no control characters, and the resolved result is still a direct
   child of the destination root. The source keeps the four rules the delete
   already enforced, now shared rather than copied.

The new name does **not** have to be one `classifyLeftover` claims. Removing
the `(rip-deck-duplicate-…)` marker is the main reason to rename, and a rename
whose result had to still look like a leftover could never do it.

## Context

The owner, 2026-08-27, on a Teenage Mutant Ninja Turtles box set:

> *"We need to be able to delete (which you added) AND also rename the rip, so
> it doesn't conflict."*

The tower names a rip from the disc's own UDF volume label
([decision](2026-08-26-a-discs-name-comes-from-udev-before-makemkvcon.md)). On
that box set the labels are wrong and inconsistent. Some carry a volume
number and some do not. One disc whose on-screen menu reads *SEASON 4 / Disc
Two* is labelled `Teenage_Mutant_Ninja_Turtles_V7_Disc_2`. Two more share the
label `TEENAGE_MUTANT_NINJA_TURTLES` outright, so the second landed marked as
a duplicate.

None of those is litter. Each is a good rip with a wrong name, and the panel
that could see them had one button, which threw them away.

## Why

**Refusing to clobber is the whole feature, not a safety margin.** The reason
to rename is a name collision. Resolving a collision by silently overwriting
an 8 GB ISO with another 8 GB ISO would be the worst failure this code could
have, and it is unrecoverable. `finaliseDestination` already makes that
promise from the rip side; the manual control must make the same one, or the
two halves of the same rule disagree.

**The exists-check is not atomic, and that is stated rather than hidden.** The
check and the `rename` are two syscalls, and Node exposes no
`RENAME_NOREPLACE`. A rip finalising into that exact name in between would
still be clobbered. The window is microseconds against a control a person
presses, and `finaliseDestination` refuses the same collision from its side.

**A retyped name has no reason to remember the extension.** A DVD backup is
one ISO image and `makemkvcon` writes it with no extension at all. An
extension-less 8 GB file is what the 2026-08-26 decision exists to stop —
Windows offers to open it in a text editor and no scanner recognises it. So
the suffix is appended for the operator, decided from the shape on disk rather
than from the disc type.

**One route rather than two.** Both verbs take the same target, answer with
the same remaining list, and share every source rule. `POST /api/tray` already
reads its verb out of a `command` field, so a reader of this server has met
the shape. Two pathnames would have meant two copies of the four source rules,
and the copy that drifts is the one nobody tested.

## Evidence

⚠️ **`classifyLeftover` could not see a DVD duplicate at all.** It tested
`name.endsWith(")")`, which is true of every Blu-ray duplicate and false of
every DVD one, because the marker goes before the extension:

```
[BACKUP] Ivanhoe (1952) - Blu-ray (rip-deck-duplicate-01234567)       ← seen
[BACKUP] Teenage … Turtles - DVD (rip-deck-duplicate-68fa9004).iso    ← invisible
```

So the panel that exists to resolve collisions could not show the DVD
collisions — which is the exact folder this feature was asked for. It is now a
pattern built from `DUPLICATE_MARKER` with an optional `.iso`, and
`occupied_name` keeps the extension, because the file it collided with has one.

The panel prefills the form with `occupied_name` — the name without the
marker. Pressing Save on that unchanged is answered honestly: it is taken, by
definition, and the daemon says so. That refusal is information rather than a
dead end. It tells the operator the other disc has not been renamed yet, which
is the order the job has to be done in.
