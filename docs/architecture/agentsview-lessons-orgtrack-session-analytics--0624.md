---
status: active
---

# Agentsview lessons for ORGII session analytics

## Goal

Integrate the useful parts of `agentsview` into ORGII without creating a second
session analytics system. ORGII should keep `orgtrack` and the existing
`unified_stats` Tauri API as the shared pipeline for session discovery,
activity, token accounting, cost reporting, Dev Record, ops control, and chat
start-page analytics.

## What agentsview does well

`agentsview` is valuable mostly as a parser and analytics reference:

- It treats every supported agent history as a normalized session/message stream.
- It records usage as explicit events rather than as a single flat token count.
- It preserves prompt-cache dimensions separately:
  - input tokens
  - output tokens
  - cache creation/write tokens
  - cache read tokens
  - reasoning tokens when the source exposes them
  - cost in USD when the source exposes enough pricing context
- It renders time-based activity as a first-class heatmap rather than burying it
  in a session list.
- Its supported-source registry makes missing coverage easy to audit.

## ORGII integration points

ORGII already had the right foundations:

- `session_token_usage` stores per-round `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, and
  `context_tokens`.
- `unified_stats` already merges CLI sessions and Rust-native sessions into a
  single `SessionAggregateRecord` list.
- `orgtrack_adapter` already upserts aggregate sessions into the orgtrack
  lineage store.
- Dev Record already consumes `session_usage_list` and per-round token records.
- Chat Panel start page already had a tabbed start surface.
- Dev Record already had a reusable `HeatmapGrid` component.

The implementation therefore extends those surfaces instead of adding a new
agentsview-style database or a parallel frontend API.

## Implemented pipeline changes

### Prompt-cache-aware accounting

A shared Rust accounting module now computes session usage from
`session_token_usage`:

- sums input, output, cache read, cache write, total, and max context tokens
- applies cache-aware cost categories
- falls back to session aggregate total tokens when per-round rows are absent
- safely uses built-in pricing defaults when a pricing table is not available in
  the active sessions database

Consumers now call the same helper from:

- `session_usage_list` for Dev Record rows
- `session_get_aggregate_stats` for aggregate totals
- `session_usage_summary` for per-session summaries
- `session_heatmap` for activity/cost/token heatmap totals

### Heatmap data endpoint

`session_heatmap` returns a 7-by-24 grid from unified session rows:

- `day` uses Sunday-based weekday index
- `hour` uses UTC hour from session creation timestamps
- each cell contains session count, total tokens, and total computed cost
- response includes max and total values for rendering legends and summaries

The endpoint accepts the same shared filter dimensions as unified stats where
possible: date range, category, key source, and metric.

### Chat start-page Heat map tab

The chat panel start page now includes a third tab, `Heat map`, rendered with
Dev Record’s shared `HeatmapGrid`. The card displays:

- total sessions
- total tokens
- estimated cost
- weekday/hour activity intensity

This keeps the heatmap visible at the point where users decide what work to do
next.

### Dev Record / ops-control improvements

Dev Record session rows now use computed cache-aware cost instead of hardcoded
zero-cost placeholders. Expanded per-round rows show cache write/read token
counts when present, making prompt caching visible during operational review.

## Source coverage

The unified stats list now also loads imported orgtrack history sources through
existing orgtrack parsers, so these sources participate in the same heatmap and
Dev Record usage pipeline:

- Claude Code history
- Codex app history
- OpenCode history
- Windsurf history
- WorkBuddy history

Future source-coverage work should keep following this pattern:

1. add or extend an orgtrack source parser for the agent history format
2. normalize usage into the shared session/token accounting shape
3. upsert through the existing orgtrack/unified stats adapter
4. expose through `session_aggregate_list`, `session_usage_list`, and
   `session_heatmap`
5. do not add agent-specific UI tables unless the source has genuinely unique
   operational fields

## Non-goals

- No agentsview database is embedded in ORGII.
- No new frontend data store is introduced for heatmap or usage analytics.
- No separate cost-calculation service is introduced.
- No session source bypasses orgtrack/unified stats.

## Remaining risk

Model-specific pricing should eventually be resolved from a single orgtrack
pricing table attached to the active shared store. The current implementation is
prompt-cache-aware and table-safe, but uses built-in default per-million-token
rates when no pricing table is available on the active sessions connection.
