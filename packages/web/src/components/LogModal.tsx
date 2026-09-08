import { Dialog } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { useDataSource } from "../hooks/useDataSource"
import { buildOperatorLog } from "../operatorLog"

export type LogTarget = {
  jobUuid: string
  label: string
}

const countLines = (text: string): number =>
  text === "" ? 0 : text.split("\n").length

/**
 * In-page operator log.
 *
 * Ported from the viewer's `LogModal` and dormant until now: the
 * daemon answered `/logs` with a 501, `armView` therefore sent
 * `logfile: null`, and the card hid its button — a button that
 * 501s being worse than no button. `/logs` serves the capture
 * now, so `logfile: null` has gone back to meaning what it says
 * (this job never wrote one) and this is live.
 *
 * The complete raw capture remains the diagnostic record on
 * disk. The browser removes typed telemetry records and keeps
 * MakeMKV messages, major stages and Rip Deck's final result.
 * It does not infer success or failure from message prose.
 *
 * ## What M5 changed — and M8 after it
 *
 * This renders `@charcuterie/ui`'s chrome dialog, `Dialog`: a focus
 * trap, Escape, a scrim, and `inert` on everything behind it. M5
 * built that on a native `<dialog>`/`showModal()` and the platform
 * **top layer**; M8 (`ui@2.0.0`) moved it off the top layer and onto
 * a portal to `document.body`, so it is no longer a native
 * `<dialog>` — but what a consumer here sees is unchanged. (The old
 * chrome component was called `Modal`; `ui@2.0.0` renamed it to
 * `Dialog` and gave the base overlay the `Modal` name.)
 *
 * What went is the *ownership* problem this file had and did not
 * name: the effect here that called `showModal()`/`close()` in step
 * with `target` was rip-deck's own hand-rolled answer to the same
 * conflict the whole state layer exists to resolve. `Dialog` takes
 * `isVisible` as the truth and makes the overlay agree; nothing in
 * this file reads `dialog.open` any more, because nothing in this
 * file has a dialog.
 *
 * The two hand-rolled buttons went too — including the one whose
 * accessible name was the string "Close ✕".
 */
export function LogModal({
  target,
  onClose,
}: {
  target: LogTarget | null
  onClose: () => void
}) {
  const dataSource = useDataSource()
  const bodyRef = useRef<HTMLPreElement>(null)
  const [text, setText] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  /**
   * Reset the request when a different job opens.
   *
   * Adjusted during render rather than in an effect, which is
   * React's own answer for state derived from a prop: an effect
   * would let one render fire a fetch for the PREVIOUS job's
   * line count before the reset landed, so every re-open of a
   * second job would fetch twice.
   */
  const [openedJobUuid, setOpenedJobUuid] = useState<
    string | null
  >(null)

  if ((target?.jobUuid ?? null) !== openedJobUuid) {
    setOpenedJobUuid(target?.jobUuid ?? null)
    setText("")
  }

  const jobUuid = target?.jobUuid ?? null

  // Fetch the bounded complete capture once. The browser then
  // removes progress telemetry and renders only operator events.
  useEffect(() => {
    if (jobUuid === null) return

    let isCancelled = false

    setIsLoading(true)

    dataSource
      .fetchLog(jobUuid, "all")
      .then((body) => {
        if (isCancelled) return
        setText(
          buildOperatorLog(body) ||
            "No important messages were recorded.",
        )
      })
      .catch((error: unknown) => {
        if (isCancelled) return

        setText(String(error))
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [jobUuid, dataSource])

  // Open at the END. A rip fails at the bottom of its capture,
  // and a modal that opens on "MakeMKV v1.18.1 starting" makes
  // the operator scroll a megabyte to reach the news.
  useEffect(() => {
    const body = bodyRef.current

    if (body && text !== "") {
      body.scrollTop = body.scrollHeight
    }
  }, [text])

  const lineCount = countLines(text)

  return (
    <Dialog
      heading={target?.label ?? "Capture"}
      isVisible={target !== null}
      onClose={onClose}
      size="xl"
      footer={
        target && (
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-content-muted text-sm tabular-nums">
              {isLoading
                ? "loading…"
                : `${lineCount} lines`}
            </span>
          </div>
        )
      }
    >
      {target && (
        <pre
          ref={bodyRef}
          className="m-0 h-full overflow-auto whitespace-pre-wrap break-words font-mono text-content-secondary text-sm leading-relaxed"
        >
          {isLoading && text === "" ? "loading…" : text}
        </pre>
      )}
    </Dialog>
  )
}
