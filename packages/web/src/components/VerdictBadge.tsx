import { Alert } from "@charcuterie/ui"
import type {
  VerdictConfidence,
  VerdictKind,
} from "@rip-deck/contracts"

import { verdictIntent, verdictTone } from "../format"

/**
 * A verdict, said in words.
 *
 * There is no component in the ARM viewer to port here: ARM
 * computed its health verdict at rip END, so "bay 7 is
 * struggling, go clean the disc" could only ever arrive after
 * the rip had already failed. This is the thing rip-deck exists
 * to show, so it is new code, and every choice in it is aimed at
 * one failure mode — being confidently wrong.
 *
 * Three of those choices are load-bearing:
 *
 *  1. **The message is the payload, not the kind.** The verdict
 *     templates are written to name a physical object and a
 *     physical action, because "read errors detected" is useless
 *     at 2am and "clean the disc" is not. `disc_dirty` and
 *     `disc_scratched` therefore share a colour and differ only
 *     in their sentence — "clean it and try again" versus
 *     "cleaning will not help, source another copy". Encoding
 *     that difference as a colour would invite reading the
 *     colour.
 *  2. **`suspected` says so.** A disc verdict from one drive is
 *     shown but never announced; two drives agreeing is what
 *     upgrades it. Labelling the confidence is what makes
 *     "always re-test in another drive" visible rather than a
 *     rule somebody has to remember.
 *  3. **Evidence is shown, not hidden behind a disclosure.** The
 *     owner is being asked to go and do something physical. The
 *     reason why fits on one line and buying trust is worth one
 *     line.
 *
 * ## Why the shared `Alert` takes no `label` here
 *
 * A `label` would make it a landmark, and there are nine bays.
 * Nine regions all named "Part of the tower-wide problem above."
 * is axe's `landmark-unique`, so this renders as a plain block —
 * which is what an unnamed `<section>` already is, per HTML. The
 * bay's own card is the region that scopes a query to this
 * verdict.
 */
export function VerdictBadge({
  verdict,
  message,
  confidence,
  evidence = [],
  isShared = false,
}: {
  verdict: VerdictKind
  message: string
  confidence: VerdictConfidence | null
  evidence?: string[]
  /**
   * This bay's trouble is one the tower alert above already
   * states in full, across several bays.
   */
  isShared?: boolean
}) {
  // `ok` is the default verdict and carries no news. Rendering a
  // calm grey chip on all nine bays would be nine chips saying
  // nothing, which is how a real one stops being noticed.
  if (verdict === "ok") return null

  const intent = verdictIntent(verdict)

  // A hub fault printed in full on four consecutive cards is
  // four paragraphs of identical text, and the reader has to
  // work out that it is one problem — which is the very thing
  // the grouped alert was added to say. So the card defers: it
  // marks itself affected and points at the sentence, rather
  // than repeating it.
  if (isShared) {
    return (
      <Alert
        className="mt-1.5"
        heading={
          // Regular weight, like the version this replaced. It is
          // a POINTER at the sentence above, not a finding of its
          // own, and four bold copies of "part of the problem
          // above" shout louder than the one statement they defer
          // to.
          <span className="font-normal">
            Part of the tower-wide problem above.
          </span>
        }
        intent={intent}
        size="sm"
      />
    )
  }

  // `unmeasured` is a footnote about rip-deck's own
  // instrumentation, not a finding about the disc, so it does not
  // get the emphasis a finding gets. See `verdictTone`.
  const isUnmeasured = verdictTone(verdict) === "unmeasured"

  // An `unknown` verdict has no message worth printing. It says
  // "not enough information to judge this rip yet", which is a
  // statement about rip-deck's own build state, and it was
  // printed on every finished card on the rack — nine copies of
  // a sentence the owner cannot act on. `ok` is dropped one
  // branch up for the same reason: a chip that always shows is a
  // chip nobody reads.
  //
  // The EVIDENCE is a different thing and survives. It carries
  // the rip's own outcome sentence — "empty_output …", the path
  // a partial rip was kept at — which is the one line on the
  // card that names what actually happened. So an unmeasured
  // verdict with evidence renders as its evidence alone, and one
  // without renders as nothing at all.
  if (isUnmeasured && evidence.length === 0) return null

  // Something has to occupy the heading, or `Alert` renders a
  // block of detail lines under a blank first row. For a real
  // verdict that is the message; for an unmeasured one it is the
  // first evidence line, promoted, with the rest left as detail.
  const [lead, ...rest] = evidence

  return (
    <Alert
      className="mt-1.5"
      details={isUnmeasured ? rest : evidence}
      heading={
        <span className={isUnmeasured ? "font-normal" : ""}>
          {isUnmeasured ? lead : message}
          {/* `suspected` earns that sentence only when there is a
              verdict to confirm. On `unknown` there is not: it is
              the absence of a measurement, so a second drive has
              nothing to agree with — and printing "retry in
              another drive to confirm" under three finished
              backups is an invitation to re-rip 225 GB. */}
          {confidence === "suspected" && !isUnmeasured && (
            <span className="ml-1.5 font-normal opacity-80">
              (suspected — retry in another drive to
              confirm)
            </span>
          )}
        </span>
      }
      intent={intent}
      size="sm"
    />
  )
}
