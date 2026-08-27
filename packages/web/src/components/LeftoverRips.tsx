import { Alert, Button, Field } from "@charcuterie/ui"
import { useState } from "react"

import { useLeftovers } from "../hooks/useLeftovers"
import type { Leftover } from "../types"

/**
 * The folders a rip left behind, and the button that clears one.
 *
 * The owner, 2026-08-26, after four DVDs failed and left four
 * empty directories he had to be told to delete by hand:
 *
 * > *"Clear the messed up folders, in fact, add a control inside
 * > Rip Deck to clear it if we're in a state where it needs to
 * > know if it should overwrite a rip folder or not. That'd be
 * > super helpful! It'd be even better if we had some way to know
 * > if the previous rip was complete or incomplete. We're logging
 * > everything, so we should know."*
 *
 * We do know, and the folder's own NAME is the proof. A rip that
 * succeeds is RENAMED into the library as its last step, and the
 * rename is atomic — so a `.rip-deck-incomplete-` folder still
 * sitting there is, by construction, a rip that did not finish.
 * A `(rip-deck-duplicate-…)` folder is the opposite: a rip that
 * DID finish, into a name something already occupied.
 *
 * ## Why the panel is hidden when there is nothing in it
 *
 * This is a chore that is usually already done. An empty panel
 * every day teaches the eye to skip the place the real one will
 * appear — the same argument `LoadedDiscsBanner` makes for being
 * loudest on an otherwise empty page.
 *
 * ## Why it is one column and not a grid
 *
 * The fleet rule is that a list of cards is a GRID, narrowed on
 * 2026-08-25: a repeating item that is a title, a sentence and
 * some numbers is a READING surface and gets one column at every
 * width. Every row here is a long folder name over a full
 * sentence of explanation, with nothing for the eye to anchor on
 * — no poster, no tile, no progress bar. Two columns of that is
 * two columns of prose.
 *
 * ## Why the daemon's sentence is rendered rather than composed
 *
 * `detail` already says what the folder is and what deleting it
 * costs, and it is computed from the two facts that decide it —
 * whether a `VIDEO_TS`/`BDMV` directory is there at all, and how
 * many bytes landed. Recomposing that here would be a second
 * opinion that drifts. Same rule `LoadedDiscsBanner` keeps.
 *
 * ## Why Rename is beside Delete, and not instead of it
 *
 * The owner, 2026-08-27, looking at a Teenage Mutant Ninja
 * Turtles box set:
 *
 * > *"We need to be able to delete (which you added) AND also
 * > rename the rip, so it doesn't conflict."*
 *
 * The tower names a rip from the disc's own UDF volume label, and
 * on that box set the labels are wrong and inconsistent — one
 * disc whose menu reads SEASON 4 / Disc Two is labelled
 * `…_V7_Disc_2`, and two discs share one label outright, so the
 * second landed marked as a duplicate. None of that is litter.
 * Deleting is the wrong answer to a rip that is fine apart from
 * its name, and it is the ONLY answer this panel had.
 *
 * ## Why the form is a real `<form>`
 *
 * Enter submits and Escape is the only key that needs handling.
 * A `<div>` with an `onKeyDown` would have to re-implement the
 * first one, and would get it wrong for anybody driving this
 * from a keyboard — which, on a nine-bay tower being cleaned up
 * one folder at a time, is how it is actually driven.
 *
 * ## Why the suggested name drops the duplicate marker
 *
 * `occupied_name` is the name this rip WANTED, which is the name
 * with `(rip-deck-duplicate-…)` taken off. Starting there is the
 * one edit that is always correct to have begun, and pressing
 * Save on it unchanged is answered honestly — the daemon refuses
 * a name that is already taken, and says so. That refusal is
 * information, not a dead end: it tells him the other disc has
 * not been renamed yet.
 *
 * ## Why a duplicate's Delete is not styled as safe
 *
 * `is_safe_to_delete` is FALSE for every duplicate, because a
 * duplicate is a finished rip. The daemon will delete one if
 * asked — it is a real choice, and the collision is exactly the
 * moment a human has to make it — but nothing here should imply
 * it is housekeeping.
 *
 * ## ⚠️ Why a rip that is RUNNING shows up here, greyed out
 *
 * A rip in progress writes into a `.rip-deck-incomplete-<uuid>`
 * folder, which is the same shape as one a dead rip left behind.
 * The daemon now refuses both verbs on one — but a refusal the
 * operator only meets by pressing Delete is worse than a disabled
 * button, because by then he has already decided to delete it. So
 * `is_locked` disables Rename and Delete, and `lock_reason` says
 * which job owns the folder.
 *
 * It is not HIDDEN, and that was the choice. A hidden row makes
 * this panel disagree with the bay grid about what is on disk,
 * and an operator who cannot see the folder cannot tell "there is
 * no leftover" from "the panel is not showing one" — which is the
 * trust the panel needs the next time a rip really does strand
 * output
 * ([decision](../../../../docs/decisions/2026-08-27-a-leftover-control-refuses-a-live-rip.md)).
 */
export function LeftoverRips() {
  const {
    leftovers,
    isLoading,
    loadError,
    clear,
    rename,
    pendingPath,
    lastMessage,
    isLastRefused,
    lastCommand,
  } = useLeftovers()

  // Which row has its form open. A path rather than a boolean per
  // row, because only one may be open: two half-typed names for
  // two folders is a way to press Save on the wrong one.
  const [renamingPath, setRenamingPath] = useState<
    string | null
  >(null)

  // Silent while loading, too. A panel that flashes "no leftover
  // rips" on every page load is noise about a state that is
  // normal.
  if (isLoading) return null

  if (loadError !== null) {
    return (
      <Alert
        description={loadError}
        heading="Could not list leftover rips"
        intent="warning"
        label="Leftover rips"
      />
    )
  }

  if (leftovers.length === 0) return null

  return (
    <section
      aria-label="Leftover rips"
      className="flex flex-col gap-3"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-content text-lg font-semibold">
          Leftover rip folders ({leftovers.length})
        </h2>
        <p className="text-content-muted text-sm">
          A rip that finishes is renamed into the library.
          These were not, so each one is either an
          unfinished rip or a finished rip that landed
          beside a name already taken.
        </p>
      </header>

      {lastMessage === null ? null : (
        <Alert
          description={lastMessage}
          heading={headingFor({
            command: lastCommand,
            isRefused: isLastRefused,
          })}
          intent={isLastRefused ? "warning" : "success"}
          label="Leftover rips"
        />
      )}

      {/* One column at every width — see the note above. */}
      <ul className="flex list-none flex-col gap-3 p-0">
        {leftovers.map((leftover) => (
          <LeftoverRow
            isPending={pendingPath === leftover.path}
            isRenaming={renamingPath === leftover.path}
            key={leftover.path}
            leftover={leftover}
            onCancelRename={() => setRenamingPath(null)}
            onClear={() => clear(leftover.path)}
            onRename={(newName) =>
              rename({ newName, path: leftover.path })
            }
            onStartRename={() =>
              setRenamingPath(leftover.path)
            }
          />
        ))}
      </ul>
    </section>
  )
}

function LeftoverRow({
  leftover,
  isPending,
  isRenaming,
  onCancelRename,
  onClear,
  onRename,
  onStartRename,
}: {
  leftover: Leftover
  isPending: boolean
  isRenaming: boolean
  onCancelRename: () => void
  onClear: () => void
  onRename: (newName: string) => void
  onStartRename: () => void
}) {
  return (
    <li className="border-border bg-surface flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-col gap-2 @md/leftovers:flex-row @md/leftovers:items-start @md/leftovers:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={CHIP_CLASS[chipToneOf(leftover)]}
            >
              {chipWordOf(leftover)}
            </span>
            <span className="text-content-muted text-xs">
              {formatSize(leftover.size_bytes)}
            </span>
          </div>

          {/* `break-all`: these names are 60 characters of uuid
              and must not push the buttons off a narrow view. */}
          <p className="text-content font-mono text-sm break-all">
            {leftover.name}
          </p>

          <p className="text-content-muted text-sm">
            {leftover.detail}
          </p>

          {/* The daemon's own refusal, said where the buttons
              are — a disabled control with no reason beside it
              reads as a broken page. `detail` already carries
              the same sentence, so this is the SHORT half: what
              the operator does next. */}
          {leftover.is_locked ? (
            <p className="text-intent-accent-content text-sm font-semibold">
              Rip Deck will not delete or rename this folder
              while the rip is running.
            </p>
          ) : null}
        </div>

        {/* `shrink-0`: the two buttons keep their width while the
            60-character name beside them wraps. */}
        <div className="flex shrink-0 gap-2">
          <Button
            appearance="outline"
            intent="neutral"
            // ⚠️ `is_locked` disables BOTH verbs, not just
            // Delete. Renaming a folder a `makemkvcon` is
            // writing into strands every byte of the rip, so it
            // is the same loss under a friendlier name.
            isDisabled={
              isPending || isRenaming || leftover.is_locked
            }
            onClick={onStartRename}
            size="sm"
          >
            Rename
          </Button>

          <Button
            appearance="outline"
            intent={
              leftover.is_safe_to_delete
                ? "neutral"
                : "danger"
            }
            // Disabled while the form is open: deleting the
            // folder you are in the middle of renaming is not a
            // press anybody means to make. And disabled while a
            // rip is writing into it, which is not a press
            // anybody means to make either.
            isDisabled={
              isPending || isRenaming || leftover.is_locked
            }
            onClick={onClear}
            size="sm"
          >
            {isPending && !isRenaming
              ? "Clearing…"
              : "Delete"}
          </Button>
        </div>
      </div>

      {isRenaming ? (
        <RenameForm
          isPending={isPending}
          // Remounted per row, so the draft always starts from
          // THIS folder's suggested name.
          key={leftover.path}
          onCancel={onCancelRename}
          onSubmit={onRename}
          suggestedName={
            leftover.occupied_name ?? leftover.name
          }
        />
      ) : null}
    </li>
  )
}

/**
 * Type the name this rip should have had.
 *
 * ## Why the control is a plain `<input>` inside a `Field`
 *
 * Charcuterie has no text-input component. `Field` is the
 * label-and-wiring half and it CLONES the control it is given —
 * its own stories pass a bare `<input>` with a local class
 * constant, and points-market spells the same constant three
 * times. That is a shared shape and it belongs in the library,
 * so the class below is a copy with a known home to move to, not
 * a house style invented here. Nothing about it is a native
 * `<select>`, which is the element Charcuterie deprecates.
 *
 * ## Why Save can be pressed on an unchanged name
 *
 * The suggested name is a duplicate's `occupied_name`, which is
 * by definition taken — that is what made it a duplicate. The
 * daemon answers "already taken" and the panel shows it. Greying
 * the button out instead would hide the one fact the operator
 * needs, which is that the OTHER disc still has that name.
 */
function RenameForm({
  isPending,
  onCancel,
  onSubmit,
  suggestedName,
}: {
  isPending: boolean
  onCancel: () => void
  onSubmit: (newName: string) => void
  suggestedName: string
}) {
  const [draft, setDraft] = useState(suggestedName)

  return (
    <form
      // Stacked, not a row: the hint under the input is two lines
      // wide, and a `items-end` row puts Save level with the HINT
      // rather than with the control it submits.
      className="border-border flex flex-col gap-3 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(draft)
      }}
    >
      <Field
        className="min-w-0"
        description={
          "One folder name, no slashes. A DVD rip is a single " +
          "ISO file and keeps its .iso — you do not have to " +
          "type it."
        }
        label="New name"
      >
        <input
          className={TEXT_INPUT_CLASS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel()
          }}
          value={draft}
        />
      </Field>

      <div className="flex justify-end gap-2">
        <Button
          appearance="ghost"
          intent="neutral"
          isDisabled={isPending}
          onClick={onCancel}
          size="sm"
          type="button"
        >
          Cancel
        </Button>

        <Button
          appearance="solid"
          intent="accent"
          isDisabled={isPending || draft.trim() === ""}
          size="sm"
          type="submit"
        >
          {isPending ? "Renaming…" : "Save name"}
        </Button>
      </div>
    </form>
  )
}

/**
 * The text control's look, until Charcuterie owns one.
 *
 * Copied from `Field`'s own stories rather than invented, and
 * every value is a token — `border-border`, `bg-surface-raised`,
 * `text-content`, and the focus ring's three `--focus-ring-*`
 * variables — so it follows the colour scheme and the density
 * axis the same way a `Button` does.
 */
const TEXT_INPUT_CLASS =
  "border-border bg-surface-raised text-content w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-(--focus-ring-offset) focus-visible:outline-focus-ring"

/**
 * The heading over the daemon's sentence.
 *
 * Named for the VERB, because "Not cleared" over a refused
 * rename contradicts the sentence beneath it — and that sentence
 * ("that name is already taken") is the most useful thing this
 * endpoint produces.
 */
const headingFor = (input: {
  command: "delete" | "rename" | null
  isRefused: boolean
}): string => {
  if (input.command === "rename") {
    return input.isRefused ? "Not renamed" : "Renamed"
  }

  return input.isRefused ? "Not cleared" : "Cleared"
}

/**
 * Which of the three words the chip carries.
 *
 * "Ripping now" wins over the kind, because the kind is a fact
 * about the FOLDER and this is a fact about what is happening to
 * it — and only one of those decides whether the operator may
 * touch it. Every locked row is an incomplete one (a duplicate
 * landing is written by the rename that ENDS a rip, so no live
 * job can claim one), which is why this is a two-branch answer
 * and not a matrix.
 */
const chipToneOf = (
  leftover: Leftover,
): keyof typeof CHIP_CLASS => {
  if (leftover.is_locked) return "live"

  return leftover.kind === "duplicate"
    ? "duplicate"
    : "unfinished"
}

const chipWordOf = (leftover: Leftover): string => {
  if (leftover.is_locked) return "Ripping now"

  return leftover.kind === "duplicate"
    ? "Finished — duplicate"
    : "Unfinished"
}

/**
 * The chip's look, one entry per tone.
 *
 * `accent` for the live one rather than `warning`: a rip that is
 * running is the tower working correctly, and the warning colour
 * on this panel already means "a finished rip is sitting here,
 * decide about it". Two meanings for one colour on one list is
 * how a colour stops meaning anything.
 *
 * ⚠️ **`…-surface` / `…-content`, not `…-subtle`.** The duplicate
 * chip was written as `bg-intent-warning-subtle
 * text-intent-warning`, and Charcuterie publishes neither name —
 * the token set is `border` / `content` / `on-solid` / `solid` /
 * `surface`. Tailwind v4 emits nothing for a class it cannot
 * resolve and reports nothing either, so the chip has been
 * painting no background and inheriting its colour since it
 * shipped. Fixed here rather than left, because copying it into
 * a second tone would have made a typo into a convention.
 */
const CHIP_CLASS = {
  duplicate:
    "bg-intent-warning-surface text-intent-warning-content rounded px-2 py-0.5 text-xs font-semibold uppercase",
  live: "bg-intent-accent-surface text-intent-accent-content rounded px-2 py-0.5 text-xs font-semibold uppercase",
  unfinished:
    "bg-surface-raised text-content-muted rounded px-2 py-0.5 text-xs font-semibold uppercase",
} as const

/**
 * Bytes for a person.
 *
 * Its own tiny helper rather than `format.ts`'s: this is the only
 * place a leftover's size is shown, and 0 bytes has to read as
 * "empty" rather than as "0.0 GB" — that exact number is the
 * MSG:5068 signature and is the one an operator acts on.
 */
const formatSize = (bytes: number): string => {
  if (bytes === 0) return "empty"

  const gb = bytes / 1_000_000_000

  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`
}
