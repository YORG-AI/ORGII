# Task Kanban test cases

## Imported-history source filters

| Case                                | Expected result                                                       | Coverage                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A Warp imported session is present  | The agent filter includes `Warp` and selecting it keeps Warp sessions | `config.test.ts`; `KanbanHeaderFilters` derives the label from the imported-source registry |
| Another imported source is selected | Warp sessions do not match that source filter                         | Type-safe `EXTERNAL_HISTORY_FILTER_BY_SOURCE` lookup in `useTaskKanbanFilters`              |
| No Warp imported session is present | The Warp option is omitted from the compact filter list               | Existing present-source filtering in `KanbanHeaderFilters`                                  |

Manual acceptance: import at least one Warp conversation, open Agent Kanban, choose **Warp**, and confirm only `warpapp-*` cards remain visible.

## Session-name search

| Case                                       | Expected result                                                         | Coverage                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Enter a partial session name               | Only sessions whose titles contain the fragment remain                  | `sessionSearch.test.ts`; `chat-rendering-ui.spec.mjs`                   |
| Enter uppercase text with outer whitespace | Case and outer whitespace normalize before substring matching           | `sessionSearch.test.ts`; `chat-rendering-ui.spec.mjs`                   |
| Enter a touched-file path                  | File metadata does not match because the shared query is title-only     | `sessionSearch.test.ts`                                                 |
| Switch to List                             | The same header query filters rows; no second full-width search renders | `ListView/index.test.ts`; `chat-rendering-ui.spec.mjs`                  |
| Enter a query with no match                | A translated empty state replaces the board/list                        | `chat-rendering-ui.spec.mjs`                                            |
| Clear the query                            | The original unfiltered task set returns                                | `chat-rendering-ui.spec.mjs`                                            |
| Switch to Diary or use a headerless embed  | A hidden stale search does not filter that view                         | `TaskKanban` applies the query only where the search control is visible |

Manual acceptance: open **Work Management → Kanban**, search for part of a session name, verify only matching cards remain, switch to **List** and confirm the same query filters rows without a second full-width search, then clear the field and verify all sessions return.

## Runtime data-source navigation

| Case                                       | Expected result                                                                         | Coverage                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Hover the Data Sources header affordance   | A trailing arrow-up-right icon appears without changing the control width               | `FactoryViewPill/index.test.ts`; shared `TabPill.hoverBadge`    |
| Activate Data Sources from any Kanban view | Runtime opens or focuses as a singleton tab; the current Kanban view URL is not changed | `FactoryViewPill/index.test.ts`; `chatPanelTabsAtom.test.ts`    |
| Load a stale `?view=datasource` URL        | Kanban renders instead of mounting a second copy of the Runtime data-source panel       | `FactoryViewPill/index.test.ts`; closed `FactoryViewMode` union |

Manual acceptance: open **Work Management → Kanban**, hover **Data Sources** and confirm the arrow-up-right icon appears to its right without shifting the tabs. Click it and confirm **Runtime** opens or focuses; return to Kanban and confirm the previous board/List/Diary selection remains intact.

## List impact summary

| Case                                  | Expected result                                                               | Coverage                   |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| View a session with file/line changes | One `Files · Lines` column shows the file count before the colored line stats | `ListView/index.test.tsx`  |
| View sessions with related commits    | The List view does not render a separate `Commits` column                     | `ListView/index.test.tsx`  |
| View sessions in different states     | Status dots use the same working, asking, unread, and idle colors as Sidebar  | `sessionTableItem.test.ts` |
| View a session without impact data    | The consolidated impact cell shows the standard empty-value dash              | Shared `SessionTable`      |
| List contains more than 25 sessions   | Pagination defaults to 25 rows and offers only 25 or 50 rows per page         | `ListView` pagination      |

Manual acceptance: switch Work Management to **List** and confirm impact reads in the order `46 · +927 −606`, with no separate Files or Commits column. Confirm running and blocking status dots match the same session states in Sidebar. With more than 25 sessions, confirm the first page contains 25 rows and the page-size selector offers only **25** and **50**.

## Organization scope and creator attribution

| Case                                        | Expected result                                                                                          | Coverage                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Select Personal in the sidebar              | Kanban, List, and Diary contain Personal sessions; sessions explicitly removed from Personal stay hidden | `useKanbanOrgScope.test.ts`                               |
| Select a local organization                 | Every task view contains only sessions owned by that local org                                           | Shared `sessionMatchesOrgFilter` projection               |
| Select a cloud organization                 | Bare cloud ownership, explicit cloud tags, and scope-matched imported history are included               | `useKanbanOrgScope.test.ts`; shared sidebar scope helpers |
| Cloud roster contains a teammate session    | The teammate row appears in Kanban/List with avatar/name even before it is imported locally              | `cloudRemoteToKanbanTask.test.ts`                         |
| Cloud roster also contains my local session | The matching cloud row is suppressed only when both viewer identity and source session id match          | `cloudRemoteToKanbanTask.test.ts`                         |
| A teammate source id collides locally       | The teammate row stays visible because ownership differs                                                 | `cloudRemoteToKanbanTask.test.ts`                         |
| A teammate session was imported locally     | The local imported task wins and the cloud metadata row is not duplicated                                | `cloudRemoteToKanbanTask.test.ts`                         |
| Teammate session has no published events    | Its creator/session metadata stays visible but the card/row cannot open or drag                          | `cloudRemoteToKanbanTask.test.ts`                         |
| View an owned organization session          | The card and List owner column show the current profile avatar and name                                  | `sessionTableItem.test.ts`                                |
| View an imported teammate session           | Persisted owner profile data is shown; missing images fall back to name initials                         | `useKanbanOrgScope.test.ts`; `TaskCreator.test.ts`        |
| Change organization with a task detail open | The old task detail closes instead of remaining as a stale loading overlay                               | `TaskKanban` scope-change effect                          |
| Change organization from the Kanban header  | The ghost selector and sidebar stay in sync; Kanban, List, and Diary immediately use the new scope       | Shared `sidebarSelectedOrgIdAtom`                         |
| Open Sessions from managed-org General      | The organization scope is selected and the existing Work Management Kanban tab opens in one click        | `cloud-org-ui.spec.mjs`                                   |
| View a published teammate in Kanban List    | The row exposes Take over; activating it forks through the canonical cloud-session action                | `ListView/index.test.tsx`; `cloud-org-ui.spec.mjs`        |
| View a metadata-only teammate in List       | No Take over action renders because the source has no published events                                   | `TaskKanban` action capability guard                      |

Manual acceptance: switch between Personal and an organization from both the sidebar and the ghost selector beside the Kanban header divider, confirming both selectors stay synchronized and the card set changes immediately. Then switch to **List** and confirm the same set plus its Creator column. Verify both a profile image and a letter fallback when those records are available.

## Bounded column rendering and default range

| Case                                       | Expected result                                                                  | Coverage                   |
| ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------- |
| Open a column containing more than 25 rows | Only its first 25 tasks are initially available to the card renderer             | `taskRenderWindow.test.ts` |
| Scroll that column to the bottom           | Exactly the next 25 tasks become available; the revealed range stays virtualized | `taskRenderWindow.test.ts` |
| Reach the final partial batch              | The reveal count clamps to the real column length                                | `taskRenderWindow.test.ts` |
| Open Kanban without a saved range          | The initial activity window is 3 days                                            | `config.test.ts`           |

Manual acceptance: use a column with at least 60 tasks, confirm the initial scrollbar represents 25 cards, scroll to the bottom twice, and confirm tasks 26–50 and then 51–60 appear without mounting the full history at once. Clear `orgii:kanbanTimeFilter` and reload to confirm the range starts at **3d**.

## Team session preview

| Case                                        | Expected result                                                                   | Coverage                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Click a published teammate card or List row | The board's draggable preview window opens in place; no Chat Pane tab is created  | `TaskKanban` `openSurface` preview target                       |
| The remote import is still running          | The preview renders the teammate card with the pending imported session id        | `cloudSessionPreview.test.ts`                                   |
| The imported copy lands on the board        | The preview switches to the local imported task, whose cloud duplicate is dropped | `cloudSessionPreview.test.ts`                                   |
| Navigate to another card during the import  | The other card previews normally; the stale preview target is ignored             | `cloudSessionPreview.test.ts`                                   |
| Click a metadata-only teammate card         | Nothing opens because no published transcript is available                        | `TaskKanban` `canOpen` guard; `cloudRemoteToKanbanTask.test.ts` |

Manual acceptance: open **Work Management → Kanban** with an organization selected, click a teammate's session card, and confirm the floating preview window opens over the board (Work Management stays mounted, so the import is not aborted) and fills with the imported transcript. Close it and confirm the board selection resets.

## Card secondary-click menu

| Case                                        | Expected result                                                                           | Coverage                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Right-click a local session card            | A native menu offers **Open as Floating Pane** and **Open in New Tab**                    | `cardContextMenu.test.ts`                                           |
| Choose **Open as Floating Pane**            | Same result as a primary click — the board's floating preview opens over the board        | `TaskKanban` reuses `handleTaskClick` for the action                |
| Choose **Open in New Tab**                  | The session opens (or focuses) its own Chat Pane tab; the Kanban tab stays open           | `openOrFocusSessionInChatPanelTabAtom`; `chatPanelTabsAtom.test.ts` |
| Right-click a published teammate cloud card | Only the floating action is offered — a Chat Pane tab would abort the board-hosted import | `cardContextMenu.test.ts`                                           |
| Right-click a card with no local session    | Only the floating action is offered                                                       | `cardContextMenu.test.ts`                                           |
| Right-click a card that cannot be opened    | No ORGII menu is shown                                                                    | `cardContextMenu.test.ts`; `KanbanColumn` `canOpen` guard           |

Manual acceptance: open **Work Management → Kanban**, right-click a session card and confirm the ORGII menu replaces the WebView's Reload / Inspect Element menu. Pick **Open in New Tab** and confirm a new Chat Pane pill appears with that session while the Kanban pill stays open; right-click another card, pick **Open as Floating Pane**, and confirm the draggable preview opens over the board.
