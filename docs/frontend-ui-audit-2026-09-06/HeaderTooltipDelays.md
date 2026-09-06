# Chat and My Station header tooltip delays UI audit

| Line                                                                     | Element                         | Verdict          | Reason                                                                                                       | Suggested change |
| ------------------------------------------------------------------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/config/tooltip.ts:2`                                                | Chrome tooltip delay            | keep with reason | The shared token centralizes the requested dwell time without changing generic Tooltip defaults.             | None.            |
| `src/engines/ChatPanel/ChatPanelHeader.tsx:188`                          | TUI and focus controls          | keep with reason | The header keeps its existing Tooltip and tab-bar primitives while explicitly opting into the chrome timing. | None.            |
| `src/engines/ChatPanel/SessionContinueCliHeaderExtras.tsx:198`           | Continue-in-CLI control         | keep with reason | This conditional header action retains its specialized explanatory Tooltip and shares the standard delay.    | None.            |
| `src/engines/ChatPanel/ChatPanelTabBar/ChatPanelPlusMenu.tsx:252`        | Chat Panel plus menu            | keep with reason | Its existing tab-bar trigger owns open-state suppression and now receives the shared delay.                  | None.            |
| `src/modules/WorkStation/AppShell/AgentStationTopHeader.tsx:182`         | My Station header controls      | keep with reason | Caption and panel controls reuse the tab-bar button primitive with an explicit chrome delay.                 | None.            |
| `src/modules/WorkStation/AppShell/useWorkstationTrailingSlot.tsx:138`    | Workstation trailing controls   | keep with reason | The conditional header controls opt in without altering tab-bar tooltips used outside this chrome.           | None.            |
| `src/modules/WorkStation/AppShell/PinnedWorkbenchChrome.tsx:77`          | Pinned macOS workbench controls | keep with reason | The fixed right-edge duplicates preserve the same timing as their in-header counterparts.                    | None.            |
| `src/modules/WorkStation/AppShell/TabBarPlusMenu/TabBarPlusMenu.tsx:115` | My Station plus menu            | keep with reason | The standard workstation plus trigger uses the shared chrome timing and preserves menu-open suppression.     | None.            |

Verdict totals: **0 fix**, **8 keep with reason**, **0 abstract**.
