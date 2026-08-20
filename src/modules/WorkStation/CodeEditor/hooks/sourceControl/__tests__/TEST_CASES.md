# Test Cases: useGitFiles base-file stability (Issue #16, RC-3)

Covers the derivation + equality gate that lets `useGitFiles` hand back the
SAME `files` array reference when a new `gitStatus` object describes a
byte-identical working tree.

## Preconditions

- A repo is selected; `GitStatusContext` provides `currentGitStatus`.

## Happy Path

| #   | Steps                                                                                     | Expected Result                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Background status ping replaces `gitStatus` with a fresh object describing the SAME files | `deriveBaseFiles` produces a structurally identical list; `areBaseFileListsEqual` returns true; `baseFiles` returns the PRIOR reference (no cascade into `useSourceControlState`) |
| 2   | A file is modified / staged / added / removed                                             | Equality gate returns false; a NEW `baseFiles` ref is produced                                                                                                                    |

## Edge Cases

| #   | Scenario                               | Steps                            | Expected Result                                                    |
| --- | -------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| 1   | Empty working tree                     | No repo or no status             | `deriveBaseFiles([])` → `[]`; two empty lists compare equal        |
| 2   | Single file                            | One changed file                 | Mapped with `id = "<path>-0"`                                      |
| 3   | Reorder / rename                       | `original_path` or order changes | Gate returns false (cannot stick stale)                            |
| 4   | Only additions/deletions counts differ | Same identity fields             | Gate returns true (counts are not identity-bearing for base files) |

## Error / Degraded States

| #   | Scenario                                     | Steps                                   | Expected Result              |
| --- | -------------------------------------------- | --------------------------------------- | ---------------------------- |
| 1   | Malformed status missing `working_directory` | `gitStatus.working_directory` undefined | Falls back to `[]`, no throw |

## Accessibility

- [x] N/A (data-layer hook).

## Acceptance Criteria

- [x] `deriveBaseFiles` unit-tested (empty, mapping, ids).
- [x] `areBaseFileListsEqual` unit-tested for every identity field + ref-equality + length + non-identity fields ignored.
- [x] Gate compares `id`, `path`, `status`, `staged`, `original_path` so it can never return a stale array for a changed tree.
- [x] No new TypeScript / lint errors in touched files.
