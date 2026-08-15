import type { ColumnChoice } from "../hooks/useLayoutColumns"
import { ColumnPicker } from "./ColumnPicker"
import { SchemeSwitcher } from "./SchemeSwitcher"
import { TrayControls } from "./TrayControls"

/**
 * The page's own header: what this is, when it last spoke, and
 * the two controls that address the whole rack rather than one
 * bay.
 *
 * **The product is Rip-Deck.** Two words, title-cased, the way
 * the Homepage tile spells it — showing the owner a bare
 * lowercase `rip-deck` here reads like a Docker image name.
 * Hyphenated `rip-deck` is still correct for every genuine
 * identifier (the repo, `rip-deck watch`, the image, `@rip-deck/*`,
 * the MQTT topic base, HA entity ids); it is wrong for prose, and
 * this line is prose.
 *
 * Both controls live up here for the same reason: they are the
 * only two things on the page that are about the TOWER instead
 * of about a disc.
 */
export function DashboardHeader({
  updatedAt,
  choice,
  autoColumns,
  onChooseColumns,
  hasBays,
}: {
  /** `dataUpdatedAt`; zero before the first answer. */
  updatedAt: number
  choice: ColumnChoice
  autoColumns: number
  onChooseColumns: (choice: ColumnChoice) => void
  /**
   * Whether there is a rack to act on. A tray button above a
   * switched-off tower is a control with nothing behind it, and
   * pressing it teaches the owner that the button does nothing.
   */
  hasBays: boolean
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="mb-1 text-lg font-semibold">
          🗜️ Rip-Deck{" "}
          {updatedAt > 0 && (
            <small className="font-normal text-content-muted">
              · {new Date(updatedAt).toLocaleTimeString()}
            </small>
          )}
        </h1>
        <p className="text-base text-content-muted">
          Every bay of the tower · progress, verdict and
          destination per disc
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {hasBays && <TrayControls />}
        <ColumnPicker
          choice={choice}
          autoColumns={autoColumns}
          onChoose={onChooseColumns}
        />
        <SchemeSwitcher />
      </div>
    </header>
  )
}
