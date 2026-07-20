# Test Cases: Edit activity diff statistics

## Preconditions

- An edit activity group contains at least one completed edit event.

## Happy Path

| #   | Scenario                          | Expected Result                                                          |
| --- | --------------------------------- | ------------------------------------------------------------------------ |
| 1   | Group has additions and deletions | Summary renders both values through `DiffStatsBadge` after the separator |
| 2   | Group has only one non-zero stat  | Only that value is rendered                                              |

## Edge Cases

- When both totals are zero, neither the separator nor diff badge is rendered.
- Multiple edit events are summed once before rendering.

## Error / Degraded States

- Missing per-event stats contribute zero and do not break the group summary.

## Accessibility

- The decorative separator remains `aria-hidden`.
- The summary remains readable in DOM order: activity count, additions,
  deletions.

## Acceptance Criteria

- No hand-written additions/deletions markup remains in the component.
- Shared semantic diff-stat tokens determine value colors.
- Existing aggregate tests and lint pass.
