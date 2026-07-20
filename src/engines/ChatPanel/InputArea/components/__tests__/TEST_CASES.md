# Test Cases: CompactFileChanges "N Files Changed" pill (staleness fix)

## Preconditions

- An agent session is active with the floating composer mounted (`ChatFloatingComposer`).
- `getOrgtrackSessionEditArtifacts` returns the canonical runtime edit artifacts
  for new Rust sessions; `getOrgtrackSessionFinalDiffs` remains available as a
  fallback for historical/final-diff-only sessions.
- The composer files pill reads its count/additions/deletions from
  `CompactFileChanges` → `useCompactFileData` (orgtrack path, `initialData` unset),
  NOT from the separate git-artifacts (commit/PR) pill.

## Bug Background

The pill's visible number is `fileChangeStats.count` in `useComposerSections`,
fed by `CompactFileChanges.onVisibleStatsChange`, which reduces `allFiles` from
`useCompactFileData`. Before the fix the fetch effect deps were
`[initialData, sessionId]`, so the orgtrack snapshot only refetched on session
switch / remount. As the agent edited more files in later rounds the pill stayed
stale (round 1 edits 1 file → pill shows 1; round 2 edits a 2nd file → pill still
shows 1 until the session changed).

## Fix Summary

`useCompactFileData` first loads `getOrgtrackSessionEditArtifacts` and maps the
runtime artifacts by normalized file path. This lets Rust sessions show Files
Changed stats before orgtrack final-diff materialization. If no edit artifacts
exist, the hook falls back to `getOrgtrackSessionFinalDiffs` for historical
sessions.

A `reloadKey` shaped like the per-round footer's `turnFilesReloadKey`
(`${sessionId}:${roundCount}:${working|idle}`) is threaded into
`useCompactFileData`'s effect deps. It bumps when the session changes, a new
round appears (user-message boundary), or the agent transitions to idle — never
on every streamed tick.

## Happy Path

| #   | Steps                                      | Expected Result                                                                   |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | Round 1: agent edits 1 file, goes idle     | Pill shows `1` with that file's +/- stats                                         |
| 2   | Round 2: agent edits a 2nd file, goes idle | `reloadKey` bumps (round count +1 and working→idle); pill refetches and shows `2` |
| 3   | Switch to another session, then back       | Pill reflects each session's own edit-artifact count, or final-diff fallback      |

## Edge Cases

| #   | Scenario                              | Steps                                  | Expected Result                                                                 |
| --- | ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Empty session                         | No edits yet                           | `countChatRounds` = 0; pill hidden (count 0)                                    |
| 2   | Single round, single file             | One user message, one edit, idle       | Pill shows `1`                                                                  |
| 3   | Mid-stream deltas                     | Assistant tokens stream within a round | `reloadKey` unchanged (round count stable, still working) → no refetch storm    |
| 4   | User message without text (synthetic) | Empty/null `displayText`               | Not counted as a round boundary                                                 |
| 5   | Deleted file                          | Final diff `isDeleted: true`           | Mapped to status `D`; still contributes to count                                |
| 6   | Windows-style path                    | `a\b\c.ts`                             | `fileName` = `c.ts`                                                             |
| 7   | Rapid round completions               | Several rounds finish quickly          | Each working→idle / round increment triggers exactly one refetch via key change |

## Error / Degraded States

| #   | Scenario                               | Steps            | Expected Result                                                        |
| --- | -------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| 1   | `getOrgtrackSessionFinalDiffs` rejects | Backend error    | Warning logged; previous `orgtrackFiles` retained; no crash            |
| 2   | No session id                          | `sessionId` null | Effect early-returns; `reloadKey` session segment is empty; pill empty |

## Accessibility

- [ ] N/A — `CompactFileChanges` renders `null` (headless tracker). The visible
      pill lives in `CollapsedInlineRow` and is unchanged by this fix.

## Acceptance Criteria

- [ ] Pill count updates after a new round completes without a session switch.
- [ ] No additional `getOrgtrackSessionFinalDiffs` calls fire on each streaming tick.
- [ ] `reloadKey` derivation and final-diff mapping covered by Vitest.
- [ ] No new TypeScript errors in touched files; relevant Vitest file passes.

## Diff-stat unification addendum

- Impact summaries keep aggregate additions/deletions as aggregate data; they
  are not assigned to a synthetic first file.
- Static `initialData` uses `totalAdditions` / `totalDeletions` as the source of
  truth, while orgtrack file data continues to sum real per-file values.
- The visible composer pill uses `DiffStatsBadge`; when both values are zero,
  it omits both the dot separator and the badge.
- Pure helper tests cover per-file summation and aggregate-total resolution.
