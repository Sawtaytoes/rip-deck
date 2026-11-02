# Headless ripping can use unknown job names

Status: Accepted
Date: 2026-11-02
Type: Rip pipeline
Supersedes: The mandatory-name requirement in the data-disc decision of 2026-09-15 when headless naming is enabled
Superseded by: —

## Context

Unlabeled data discs and audio CDs missing from MusicBrainz stop automatic
ingest even though their contents can be read and identified later.

## Decision

Add the opt-in `RIP_DECK_ALLOW_UNNAMED_DISCS=true` setting. Keep existing
names when available. Missing disc names become `Unknown <job UUID>`.
Audio CDs try normal metadata lookup first, then retry a missing-metadata
refusal with a manual unknown album name and MusicBrainz disabled.
An explicit audio name supplies manual metadata. Save audio process output.

## Consequences

Unattended ingest can preserve content before identification. UUIDs distinguish
unknown discs and connect output to history. Existing verification, offsets,
read-error detection, blank-media refusal, and uncertain-type holds remain.
The original mandatory-name behavior remains the default.

## Why

Requiring names before reading prevents headless ingest. Disabling all lookup
would discard metadata that is available, so only the specific missing-metadata
refusal triggers an automatic retry.

## Evidence

Subprocess integration tests cover unnamed data images and their mapfiles,
missing audio metadata, manual album names, preserved process logs, opt-out
behavior, and unchanged read failures. All 1,379 daemon tests passed.
An information-only probe of cyanrip 0.9.3 confirmed that `-N -a album=...`
continues with manual metadata while retaining AccurateRip and maximum paranoia.
