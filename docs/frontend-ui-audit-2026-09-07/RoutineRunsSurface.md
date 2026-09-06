# RoutineRunsSurface UI audit

| Line                                  | Element                       | Verdict          | Reason                                                                                                                                   | Suggested change |
| ------------------------------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RoutineRunsSurface.tsx:131`          | Runs navigation list          | keep with reason | Reuses `CompactListPanel`, the same keyboard-accessible list primitive used by PR and Issue split panes.                                 | None.            |
| `RoutineRunsSurface.tsx:206`          | Run detail pane               | keep with reason | Reuses `DetailPaneLayout` and its standard header, placeholder, and close action contract.                                               | None.            |
| `RoutineRunsSurface.tsx:245`          | Work Item action row          | keep with reason | The raw button is a domain-specific full-width action inside the detail body; it is not a selectable navigation row or a toolbar action. | None.            |
| `RoutineRunsSurface.tsx:370`          | Split list header             | keep with reason | Reuses the two-row `SplitListHeader` composition already used by compact PR and Issue lists.                                             | None.            |
| `RoutineRunsSurface.tsx:382`          | Split-list search             | keep with reason | Reuses `WorkManagementSearchInput` with fill width in the compact left-pane row.                                                         | None.            |
| `RoutineRunsSurface.tsx:395`          | Fullscreen list header        | keep with reason | Reuses the standard full-width header with left context and a fixed-width right control group.                                           | None.            |
| `RoutineRunsSurface.tsx:461`          | Runs master-detail layout     | keep with reason | Reuses `InboxListDetailLayout` rather than introducing a Routine-specific splitter or width policy.                                      | None.            |
| `RoutineWebhooksPanel.tsx:203`        | Webhook detail pane           | keep with reason | Reuses `DetailPaneLayout`; existing install, rotate, copy, replay, and refresh controls remain design-system buttons.                    | None.            |
| `RoutineWebhooksPanel.tsx:470`        | Webhooks navigation list      | keep with reason | Reuses `CompactListPanel` and the same selected-row semantics as the Runs list.                                                          | None.            |
| `RoutineWebhooksPanel.tsx:481`        | Webhooks master-detail layout | keep with reason | Reuses `InboxListDetailLayout`, preserving the split/fullscreen behavior when switching Routine tabs.                                    | None.            |
| `WorkManagementDatasetSwitch.tsx:133` | Runs dataset option           | keep with reason | Extends the existing shared dataset selector and icon pattern; no parallel Routine-only selector is introduced.                          | None.            |

Verdict totals: **0 fix**, **11 keep with reason**, **0 abstract**.
