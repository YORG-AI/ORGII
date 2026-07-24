# Team Inbox React Lifecycle — Frontend UI Audit

## Scope

- `src/modules/MainApp/TeamInbox/components/TeamInboxList.tsx`
- `src/modules/MainApp/TeamInbox/TeamInboxView.tsx`
- `src/modules/MainApp/TeamInbox/useTeamInboxWorkItemBody.ts`

## Summary

| Verdict          | Count |
| ---------------- | ----: |
| fix              |     2 |
| keep with reason |     4 |
| abstract         |     0 |

No cross-file design-system sweep candidate was found.

## Findings

|                             Line | Element                        | Verdict          | Reason                                                                                                                                 | Suggested change                                                                                        |
| -------------------------------: | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
|           `TeamInboxList.tsx:87` | Recency grouping               | fix              | Calling `Date.now()` during render violates React render purity and makes the memo depend on an untracked value.                       | Pass the load-time reference timestamp from the owning view and include it in the memo dependencies.    |
| `useTeamInboxWorkItemBody.ts:38` | Selected Work Item body effect | fix              | Synchronously resetting state inside the effect causes an extra render and trips the React lifecycle rule.                             | Tag resolved state with the request key and derive the loading fallback during render when keys differ. |
|           `TeamInboxView.tsx:64` | Page load lifecycle            | keep with reason | The effect owns one abort controller per request, checks cancellation before state writes, and aborts on dependency change or unmount. | Keep.                                                                                                   |
|          `TeamInboxView.tsx:313` | Loading/error/empty states     | keep with reason | The shared `Placeholder` component expresses all three states consistently with the rest of the application.                           | Keep.                                                                                                   |
|          `TeamInboxView.tsx:328` | Split list/detail composition  | keep with reason | `SplitViewLayout` and `TeamInboxList` are existing shared layout and feature boundaries; another wrapper would add indirection.        | Keep.                                                                                                   |
|           `TeamInboxList.tsx:92` | Filter tabs and unread badges  | keep with reason | The implementation uses the shared `TabPill` control, translated labels, and explicit accessible badge labels.                         | Keep.                                                                                                   |
