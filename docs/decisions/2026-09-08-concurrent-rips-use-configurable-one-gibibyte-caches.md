# Concurrent rips use configurable one-gibibyte caches

Status: Accepted
Date: 2026-09-08
Type: performance / configuration
Supersedes: —
Superseded by: —

## Decision

Each MakeMKV job uses its own 1 GiB cache by default. The deployment sets
`RIP_DECK_RIP_CACHE_MB=1024`, and the daemon accepts a positive integer override
for smaller installations. The caches remain per process; they are not shared
between concurrent rips.

## Context

The first full-bank run produced repeated `MSG:2008` write-pause warnings across
most jobs at similar times. That correlation identified a short shared write
path pause rather than one drive or one USB connection. The prior 128 MiB cache
provided little tolerance for such pauses.

## Why

A larger independent cache absorbs short pauses without changing the sustained
destination rate. One GiB per job is bounded at nine concurrent jobs, and the
configuration keeps the default portable.

## Evidence

The owner said in the 2026-09-08 session: *"This could be a way for us to
optimize. I think this is the first time we're actually ripping with all 9
slots."*
