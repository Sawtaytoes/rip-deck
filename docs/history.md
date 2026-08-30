# Rip history

The dashboard history is at `/history`. It records every terminal rip instead of only the latest record for each bay.

## Storage

`$RIP_DECK_STATE_DIR/history.jsonl` is an append-only JSON Lines file. One row is written when a rip reaches a terminal outcome. The row preserves the disc name, disc type, destination, and outcome available at that moment.

`bays.json` serves a different purpose. It stores one current record per bay so the watcher can avoid re-ripping a completed disc that remains in a tray.

Per-job byte counts, durations, read errors, and health verdicts remain in `<uuid>.features.json` and `<uuid>.verdict.json`. The history API joins those files only for the requested page.

## API

```sh
curl -s 'http://host:3007/api/history?limit=25'
curl -s 'http://host:3007/api/history?from=2026-08-25&to=2026-08-26&outcome=failed'
curl -s 'http://host:3007/api/history?q=disc-title'
```

`from` and `to` accept `YYYY-MM-DD` or epoch milliseconds. A date string uses the daemon time zone. The dashboard sends milliseconds, so a selected day follows the browser time zone.

The `limit` value is capped at 200 because each enriched row can require two file reads.

## Retention and backfill

Rip Deck does not prune history. At start-up, it can rebuild older entries from existing feature files. A rebuilt row can lack a disc name because earlier job evidence did not store it.

The [append-only history decision](decisions/2026-08-27-rip-history-is-an-append-only-log-beside-the-job-files.md) records the data boundary and the measured backfill limits.
