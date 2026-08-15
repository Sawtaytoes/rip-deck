import { Button } from "@charcuterie/ui"

import { useTrayCommand } from "../hooks/useTrayCommand"

/**
 * "I took them out" — clear the loaded-discs reminder by hand.
 *
 * The owner, 2026-07-30, on the reminder this button dismisses:
 *
 * > *"Kinda like taking out the trash … It's something I need to
 * > do eventually."*
 *
 * A chore is done when a human has done it, and the daemon usually
 * cannot watch it happen: the discs come out of a powered-OFF
 * tower, off the bus, where no probe can see them go. So the
 * reminder needs a way to be told, and this is it — a plain
 * `clear_loaded` press the daemon owns, which drops its on-disk
 * memory of the discs and lets the reminder fall silent
 * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
 *
 * ## Why it is its own component, not part of the banner
 *
 * `LoadedDiscsBanner` is presentational — it forwards the daemon's
 * words to `Alert` and nothing else — and stays that way so its
 * test can render it without a query client or a data source. The
 * command, its pending state and its failure live here, and this
 * is handed to the banner's `actions` slot from `HostSection`,
 * which already sits inside the providers `useTrayCommand` needs.
 *
 * ## Why there is no success line
 *
 * A clear that lands changes what `/json` says — the discs are
 * forgotten — and `useTrayCommand` refetches it, so the count
 * drops to zero and the whole banner (this button with it)
 * unmounts. **The reminder vanishing IS the confirmation.** The
 * only state worth rendering is the one where that did NOT happen:
 * the endpoint was unreachable, the banner is still here, and the
 * press needs to say why rather than look ignored.
 *
 * ## Why it rides `useTrayCommand`
 *
 * `clear_loaded` is a bulk command on the same `POST /api/tray`
 * surface as Open trays and Tower off — it takes no bay — so it
 * reuses the one hook, which means one press cannot mean two
 * different things and the daemon's answer is rendered rather than
 * swallowed. `isBulkPending` guards the double-press.
 */
export function ClearLoadedButton() {
  const { run, isBulkPending, lastError } = useTrayCommand()

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        appearance="outline"
        intent="neutral"
        isDisabled={isBulkPending}
        onClick={() => {
          run({ command: "clear_loaded" })
        }}
        size="sm"
      >
        🗑{" "}
        {isBulkPending ? "Clearing…" : "Mark as taken out"}
      </Button>

      {lastError !== null && (
        <div className="rounded-md border border-intent-danger-border bg-intent-danger-surface px-2 py-1 text-sm text-intent-danger-content">
          could not clear the reminder: {lastError}
        </div>
      )}
    </div>
  )
}
