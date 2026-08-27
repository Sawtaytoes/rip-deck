import { Alert, Button } from "@charcuterie/ui"

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
 * ## Why a duplicate's Delete is not styled as safe
 *
 * `is_safe_to_delete` is FALSE for every duplicate, because a
 * duplicate is a finished rip. The daemon will delete one if
 * asked — it is a real choice, and the collision is exactly the
 * moment a human has to make it — but nothing here should imply
 * it is housekeeping.
 */
export function LeftoverRips() {
  const {
    leftovers,
    isLoading,
    loadError,
    clear,
    pendingPath,
    lastMessage,
    isLastRefused,
  } = useLeftovers()

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
          heading={
            isLastRefused ? "Not cleared" : "Cleared"
          }
          intent={isLastRefused ? "warning" : "success"}
          label="Leftover rips"
        />
      )}

      {/* One column at every width — see the note above. */}
      <ul className="flex list-none flex-col gap-3 p-0">
        {leftovers.map((leftover) => (
          <LeftoverRow
            isPending={pendingPath === leftover.path}
            key={leftover.path}
            leftover={leftover}
            onClear={() => clear(leftover.path)}
          />
        ))}
      </ul>
    </section>
  )
}

function LeftoverRow({
  leftover,
  isPending,
  onClear,
}: {
  leftover: Leftover
  isPending: boolean
  onClear: () => void
}) {
  return (
    <li className="border-border bg-surface flex flex-col gap-2 rounded-lg border p-3 @md/leftovers:flex-row @md/leftovers:items-start @md/leftovers:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              leftover.kind === "duplicate"
                ? "bg-intent-warning-subtle text-intent-warning rounded px-2 py-0.5 text-xs font-semibold uppercase"
                : "bg-surface-raised text-content-muted rounded px-2 py-0.5 text-xs font-semibold uppercase"
            }
          >
            {leftover.kind === "duplicate"
              ? "Finished — duplicate"
              : "Unfinished"}
          </span>
          <span className="text-content-muted text-xs">
            {formatSize(leftover.size_bytes)}
          </span>
        </div>

        {/* `break-all`: these names are 60 characters of uuid and
            must not push the Delete button off a narrow view. */}
        <p className="text-content font-mono text-sm break-all">
          {leftover.name}
        </p>

        <p className="text-content-muted text-sm">
          {leftover.detail}
        </p>
      </div>

      <Button
        appearance="outline"
        intent={
          leftover.is_safe_to_delete ? "neutral" : "danger"
        }
        isDisabled={isPending}
        onClick={onClear}
        size="sm"
      >
        {isPending ? "Clearing…" : "Delete"}
      </Button>
    </li>
  )
}

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
