# `@rip-deck/web` — the dashboard

React 19 + Vite + Tailwind 4, ported from the ARM viewer's
`web/packages/dashboard` and moved onto rip-deck's data.

```
yarn workspace @rip-deck/web dev        # http://localhost:5173
yarn workspace @rip-deck/web build      # -> dist/, which the daemon serves
yarn test --run                        # all workspaces, this one included
```

## Who serves this

**The daemon does**, out of `dist/`, on the same port as `/json`
(`http://localhost:3007/`).

`packages/daemon/src/api/webAssets.ts` reads `dist/` into memory once at
startup and `api/router.ts` serves it below every API path. One origin
means the app needs no base URL, no CORS and no second container — and
it cannot drift to a different version than the data it is reading.

The Dockerfile runs the build, so a fresh image has the dashboard in it.
An older image answers `GET /` with a plain-text page saying so rather
than a 404.

## Where the data comes from

A bare `/` shows **the rack**. Poll `/json` on the same origin, render
what the tower is actually doing — including an idle one, which is a
normal state and not an error.

`VITE_MOCK=1` (set in `.env.example`, which you copy to `.env`) runs the
whole app on bundled fixtures with no backend instead. It is honoured in
**development only**: `src/env.ts` gates it on `import.meta.env.DEV`, so
no production bundle can ship on fixtures no matter what the environment
says. A dashboard confidently showing invented rips on the real tower is
this project's recurring failure mode, and the failure direction here is
always toward the real API.

Pick a scenario with `?fake=<name>` — the same eight names, spelled the
same way, that `packages/daemon/src/api/fixtures.ts` and the daemon's
router already use, so one URL means one thing against either source:

| `?fake=` | What it is for |
| --- | --- |
| `nine-rips` | Nine concurrent rips. The default, and the owner's headline request. |
| `empty` | **Zero drives — a NORMAL state.** The tower is switched off. Never red. |
| `verdicts` | One bay per verdict kind, every card the UI must render. |
| `hub-fault` | Four bays, ONE problem. Not four bad discs. |
| `confidence` | `suspected` vs `confirmed` — the two-drive rule, visible. |
| `rising-eta` | A rising ETA: a signal, and deliberately not an alarm. |
| `quarantined` | A bay out of service, with the control that returns it. |
| `held-at-startup` | Three discs HELD beside one that FAILED. The owner's tower, tonight. |
| `unmeasured` | Three FINISHED rips nothing judged. The live rack, and the render that got it wrong. |

Without `VITE_MOCK`, `httpDataSource` talks to the daemon on the same
origin. `?fake=` is forwarded verbatim and the daemon stamps
`is_fake: true` on the reply, so the page always says whether it is
looking at the rack.

**No `?fake=` means the rack, not a default scenario.** `readFixtureName`
answers `null` for a URL that names nothing, and an unknown name is
treated the same way — real data is never the wrong thing to fall back
to. `DEFAULT_FIXTURE` still exists, but it belongs to `mockDataSource`,
where there is genuinely no rack to draw.

## What it reads, and what it deliberately does not

`GET /json` is one document with two halves (`api/jsonDocument.ts`).
`hosts` is the ARM-viewer-shaped compatibility projection, which is why
the port was cheap; `rip-deck` is the native view. Where the two
disagree, the native field wins, and the call site says why:

- **ETA** — `eta_seconds` / `eta_trend`, measured per stage. The
  viewer's linear extrapolation crossed a PRGV reset at every MakeMKV
  stage boundary and reported a rising ETA on a healthy rip
  (HANDOFF §2.4). No fallback: a blank beats a plausible wrong number.
- **Activity** — `bay.state.state`, not `rip.status`. `toArmStatus`
  folds `ripping`, `throttled` and `stalled` into one word, and a bay
  that has stopped answering reading "ripping" is a lie on the card.
- **Bay identity** — `drive_id`. `/dev/srN` reshuffles on every USB
  re-enumeration, so cards keyed on it merge two bays after a
  power-cycle. Chips are labelled with the SLOT, the one number that is
  a place.
- **Controls** — `bay.actions`, published per bay. The UI never decides
  that a quarantined bay gets a clear button. The one exception is the
  tray pair, and `trayActionsFor` argues its case in full.

Two of the viewer's features are gone on purpose:

- **No hide / clear-recent.** That store lived in `server.py`; `/json`
  has neither the endpoint nor the field.
- **`LogModal` is dormant.** `/logs` answers 501 today, so `armView`
  sends `logfile: null` and the card hides its button. Ported anyway —
  the captures exist and it needs nothing when `/logs` lands.

A third was dropped and has been put back. This README used to say
*"No eject/close — rip-deck never ejects"*, and that was wrong. The rule
is **never eject-LOOP**: no auto-eject as part of the rip cycle, because
that flap-storm is what killed valid rips on other bays. rip-deck does
**not** auto-eject and must not — but it exposes *operator-triggered*
tray commands over MQTT (`open_completed`, `close_open`, `open_bay`,
`close_bay`). See
`docs/HANDOFF-eject-and-open-questions.md`
§1 for the correction, and
`docs/eject-and-durable-bay-state.md`
for the payloads and the nine result kinds.

So the per-bay tray control is back, with one rule attached: **a bay in
`starting` or `ripping` is never offered one.** Opening a tray mid-rip
destroys 90 GB and an hour; the daemon refuses it as the first branch of
`decideTrayBayAction`, and `format.trayActionsFor` refuses to draw a
button that only exists to be refused. That function is also the one
place the UI derives a control instead of rendering `bay.actions` — it
explains why, and it yields the day the daemon starts publishing tray
commands per bay.

**An unmeasured rip is not a failed one either — and this one
shipped wrong.** `towerFeed` stamps `verdict: "unknown"` on every
bay it did not measure, deliberately, because `ok` there would be a
lie. `unknown` means *"nothing judged this rip"*, **not** *"this rip
is suspect"*. The dashboard read the absence of a measurement as
evidence of a problem, and on 2026-07-26 the live rack presented
three successful, verified, 225 GB backups as a fault: a full-width
red banner, a yellow `needs attention` heading, and a **Retry in
another drive** button on each — an invitation to re-rip the exact
discs the bay ledger exists to protect
(`__screenshots__/2026-07-26-live-dashboard-0.5.0.png`).

`isVerdictActionable` is the fix, and it reads the answer off
`VERDICT_TEMPLATES` rather than listing kinds: a verdict whose
`action` is `"none"` asks nothing of a human, which is true of `ok`,
`disc_marginal_slow` and `unknown`. It gates the bucket, the banner
and the rail chip. `verdictTone` gives `unknown` its own quiet
`unmeasured` tone so the caveat still appears — as a footnote on the
card that earned it, never as the loudest thing on the page.

`bayActionsFor` is the other half, and it is the one place the UI
**subtracts** from `bay.actions`. `retry_in_another_drive` is hidden
when the rip is `completed` or the verdict is `unknown`: the control
exists to confirm a suspected disc verdict in a second drive, and
neither of those bays has a verdict to confirm. Hidden rather than
disabled — a disabled button still says "this is a thing you might do
to a finished rip". ⚠️ The real fix is `towerView.buildBayActions`
not publishing it; delete the guard when it stops.

**A held bay is not a failed one.** When rip-deck cannot tell whether a
loaded disc was already ripped, it **holds and flags, never rips**
(`rip/bayLedger.ts`). `HeldBayCard` is that state: amber rather than
red, no progress numbers at all, the daemon's own sentence quoted
verbatim, and the tray control that releases the disc. It sits above the
active rips, next to quarantine, because those two are the only things
on the page waiting on a person.

**Most job actions still have no transport.** `cancel`, `keep_trying`,
`give_up` and `clear_quarantine` still refuse locally. The
`retry_in_another_drive` control is different: it is a physical hand-off,
so it sends `open_bay` through the existing guarded tray endpoint, then
tells the operator to move the disc. Normal insertion starts the
comparison rip in the new bay. The mock performs every action so the
controls can be exercised.

## Tests

`yarn test --run`. jsdom, not vitest browser mode — CI installs nothing
but `yarn install`, and the logic under test is data-shaping rather
than layout. `.spec.ts` stays reserved for Playwright and is not
matched by the vitest `include`. See the comments in
`vitest.config.ts`, including why `optimizeDeps.include` is there
before it is needed.

There is no MSW. The seam worth faking is `RipDeckDataSource`, which
the app already selects at build time and tests inject through context;
the one place that touches the network is covered by a stubbed `fetch`
in `src/api/httpDataSource.test.ts`, which also records the reasoning
in full.
