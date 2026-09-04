# Sidebar tab navigation UI audit

| Line                                     | Element                          | Verdict          | Reason                                                                                                                                                                                    | Suggested change |
| ---------------------------------------- | -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `sidebarTabContextMenu.ts:62`            | Sidebar destination context menu | keep with reason | Reuses the shared native-menu utility already used by session rows, so non-session destinations get the same platform-consistent menu behavior without a parallel dropdown implementation | None.            |
| `useWorkstationSidebarContextMenu.ts:97` | Draft-row context menu actions   | keep with reason | Extends the existing native draft menu with the standard localized `Open in New Tab` action while preserving its destructive action and established interaction surface                   | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
