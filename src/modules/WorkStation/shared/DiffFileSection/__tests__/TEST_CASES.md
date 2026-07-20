# Test Cases: DiffFileSection line statistics

## Preconditions

- A diff section receives exact line stats, a unified diff, or content for a
  file whose status is known to be added/deleted.

## Happy Path

| #   | Scenario                                              | Expected Result                                                     |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Both exact stats supplied                             | Header badge displays the supplied additions and deletions          |
| 2   | Unified diff replaces one line with one line          | Header displays `+1 -1`, not `0 0`                                  |
| 3   | Only additions supplied and unified diff is available | Supplied additions stay authoritative; deletions come from the diff |

## Edge Cases

| #   | Scenario                                   | Expected Result                                                   |
| --- | ------------------------------------------ | ----------------------------------------------------------------- |
| 1   | Supplied stat is explicitly zero           | Zero is preserved and does not trigger a fallback                 |
| 2   | Added file has content but no stats/diff   | Additions equal the full content line count                       |
| 3   | Deleted file has content but no stats/diff | Deletions equal the full content line count                       |
| 4   | Modified file lacks exact data             | Missing stats remain zero; content-length deltas are not invented |

## Error / Degraded States

- Malformed or empty unified diff resolves missing values to zero without
  crashing the section.

## Accessibility

- The existing collapsible file-header control and its accessible name remain
  unchanged.
- Line stats continue to use the shared `DiffStatsBadge` semantic colors.

## Acceptance Criteria

- Equal-length replacements report both additions and deletions.
- Each supplied stat is resolved independently.
- Added/deleted full-content fallback is status-aware.
- Pure resolver tests pass.
