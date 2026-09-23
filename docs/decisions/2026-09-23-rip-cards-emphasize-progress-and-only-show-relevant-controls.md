# Rip cards emphasize progress and only show relevant controls

Status: Accepted
Date: 2026-09-23
Type: Web / presentation
Supersedes: [Permanent job-control explanations](2026-09-08-job-controls-explain-their-effects-before-a-press.md) for active rip cards; [disc mark beside percentage](2026-08-25-the-disc-mark-is-right-aligned-against-the-percentage.md) for the redesigned rip cards
Superseded by: [B is the default](2026-09-23-the-dashboard-uses-the-progress-band-layout.md) for the provisional layout selection only; the cleanup requirements remain accepted.

## Decision

The non-kiosk dashboard gives the percentage the largest type. Speed, remaining duration, and estimated finish have separate labels and contrasting values. A known issue colors the whole card, with the issue stated in words as well. Keep the disc-type logo once; remove its duplicate text and the low-level stage message such as “Copying file.”

Normal active rips offer Cancel. Remove Give up from the displayed controls. Keep trying appears only for a known problem for which the verdict says continuing is sensible, and disappears after activation. Explanations belong in hover/focus tooltips rather than permanent paragraphs on every card. Existing cancel behavior still stops only the selected rip, retains partial output, and opens its tray after the process exits.

The slot chips open a shared Dialog containing the selected drive's identity and job details. Remove the Drive Info accordion from each rip card and remove the redundant host name and bay/rip count line above the chips.

An absent post-job diagnosis is not evidence of a live problem. The dashboard uses the job's known activity and progress independently of that diagnostic verdict. An unknown verdict alone neither colors the card nor offers Keep trying. Read errors, actionable diagnoses, and reported stalled/throttled states remain visible. This change does not turn the post-job diagnostic engine into a live engine or label an unmeasured diagnosis as confirmed health.

The owner selected A (large percentage above a thin progress bar), then requested B (percentage on a filled progress band) in the fake environment for comparison. A remains the default; the development-only mock environment exposes the A/B switch and fixture links. Both use the same app controls and data. Review of B does not authorize a production deployment.

## Context

The previous cards repeated several lines of control instructions and offered Keep trying during normal progress. The daemon used `verdict !== "ok"` even though the real feed commonly carries `unknown` until a job's diagnostic file is written after completion. The separate job state already said the rip was running. The mock also invented a retry action absent from the daemon; its action list now follows the daemon's policy.

## Why

The page should make progress and actual problems easy to recognize. Internal diagnostic availability must not make an ordinary rip look troubled. Advanced drive information is useful on demand, but should not consume space on every card.

## Evidence

Owner, thread `93858a0e-26d6-44f2-9424-9fdd94dbc85e`, 2026-09-23:

> When it's ripping no problem, "Keep Trying" makes _no_ sense to keep visible.

> Between Give Up and Cancel, just keep Cancel.

> In this view, put the rip percentage big!

> The "Drive Info" accordion could be a modal instead.

> And it says "9 bays * 4 ripping". yes, I can clearly see that. That info is useless as well!

> We should know the state though. We can tell if there are health issues because it tells us we need to do something. Also, it's ripping just fine!

After selecting A:

> Can you also do B? I wanna see the difference in a fake env.
