# CloudOrgPanelView — Frontend UI Audit

The referenced `frontend-ui-audit` skill file was unavailable, so this report follows the columns and verdict conventions documented in `AGENTS.md`.

## Audit results

| Line                          | Element                              | Verdict          | Reason                                                                                                        | Suggested change |
| ----------------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:1`                 | Cloud organization panel coordinator | keep with reason | Selects panel mode and composes established management/session sections without owning their detailed markup. | None.            |
| `useCloudOrgPanelState.ts:1`  | Panel state hook                     | keep with reason | Co-locates target, refresh, access-floor, billing, and repo-scope state while keeping one source of truth.    | None.            |
| `CloudOrgPanelHeader.tsx:1`   | Panel header                         | keep with reason | Reuses existing controls and test IDs; extracted styles are unchanged.                                        | None.            |
| `CloudOrgGeneralTab.tsx:1`    | General tab                          | keep with reason | Groups established org settings/member/invite sections without duplicating design-system patterns.            | None.            |
| `CloudOrgRepoScopesTab.tsx:1` | Repository scopes tab                | keep with reason | Isolates one user task and preserves saving/cooldown/error presentation.                                      | None.            |

## Summary

- Fix: 0
- Keep with reason: 5
- Abstract: 0
