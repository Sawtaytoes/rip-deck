import { Button, Dialog } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { useDataSource } from "../hooks/useDataSource"

export type LogTarget = {
  jobUuid: string
  label: string
}

/**
 * How much of the capture a freshly-opened modal asks for.
 *
 * A robot log is 1–3 MB and the interesting part of one is the
 * END — the failure, the exit code, the last title written — so
 * the default is a tail and the rest is opt-in. Matching
 * `RipDeckDataSource.fetchLog`'s own default.
 */
const DEFAULT_TAIL_LINES = 600

/** Each "load more" asks for four times what it last got. */
const MORE_FACTOR = 4

const countLines = (text: string): number =>
  text === "" ? 0 : text.split("\n").length

/**
 * In-page capture tail.
 *
 * Ported from the viewer's `LogModal` and dormant until now: the
 * daemon answered `/logs` with a 501, `armView` therefore sent
 * `logfile: null`, and the card hid its button — a button that
 * 501s being worse than no button. `/logs` serves the capture
 * now, so `logfile: null` has gone back to meaning what it says
 * (this job never wrote one) and this is live.
 *
 * ⚠️ **A robot log is a parsed format, not prose. It is
 * rendered, never summarised.** Nothing here matches on the
 * text: no "looks like it failed" banner, no error highlighting,
 * no counting `MSG:` codes. Reading structure out of MakeMKV's
 * output by string-matching is precisely the `MSG:5072` bug
 * (`docs/HANDOFF-eject-and-open-questions.md` §4.4), and a
 * diagnosis screen that quietly paraphrases the evidence is the
 * worst possible place to repeat it.
 *
 * ⚠️ **"Load more" is not "load everything", and says so.** The
 * `lines` / `all=1` query parameters are the WEB side's
 * proposal; a daemon that does not implement them answers with
 * its own default tail and no error. So the control promises
 * nothing — it asks for more, and the caption reports how many
 * lines actually ARRIVED rather than how many were requested. If
 * the count stops growing, the button retires itself: either
 * that is the whole file, or the daemon is ignoring the
 * parameter, and from this side those two are the same
 * observation.
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
  const [requestedLines, setRequestedLines] = useState(
    DEFAULT_TAIL_LINES,
  )
  const [hasMore, setHasMore] = useState(true)
  /**
   * How many lines the last answer carried.
   *
   * A ref rather than state, and not folded into a `setText`
   * updater either: an updater that also calls `setHasMore` is a
   * side effect inside a function React is free to run twice.
   */
  const loadedLineCount = useRef(0)

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
    setRequestedLines(DEFAULT_TAIL_LINES)
    setHasMore(true)
    setText("")
    loadedLineCount.current = 0
  }

  const jobUuid = target?.jobUuid ?? null

  // Fetch the capture whenever a new target opens, or the
  // operator asks for more of the same one.
  useEffect(() => {
    if (jobUuid === null) return

    let isCancelled = false

    setIsLoading(true)

    dataSource
      .fetchLog(jobUuid, requestedLines)
      .then((body) => {
        if (isCancelled) return

        const nextCount = countLines(body)

        // No more lines than last time means we are looking at
        // everything the daemon will give us — whether that is
        // the whole file or a tail it capped on its own side.
        // From here those two are the same observation.
        if (nextCount <= loadedLineCount.current) {
          setHasMore(false)
        }

        loadedLineCount.current = nextCount

        setText(body)
      })
      .catch((error: unknown) => {
        if (isCancelled) return

        setText(String(error))
        setHasMore(false)
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [jobUuid, requestedLines, dataSource])

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

            {hasMore && (
              <Button
                appearance="outline"
                isDisabled={isLoading}
                onClick={() => {
                  setRequestedLines(
                    (current) => current * MORE_FACTOR,
                  )
                }}
                size="sm"
              >
                Load more
              </Button>
            )}
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
