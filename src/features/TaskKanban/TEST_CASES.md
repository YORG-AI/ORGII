# Task Kanban test cases

## Imported-history source filters

| Case                                | Expected result                                                       | Coverage                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A Warp imported session is present  | The agent filter includes `Warp` and selecting it keeps Warp sessions | `config.test.ts`; `KanbanHeaderFilters` derives the label from the imported-source registry |
| Another imported source is selected | Warp sessions do not match that source filter                         | Type-safe `EXTERNAL_HISTORY_FILTER_BY_SOURCE` lookup in `useTaskKanbanFilters`              |
| No Warp imported session is present | The Warp option is omitted from the compact filter list               | Existing present-source filtering in `KanbanHeaderFilters`                                  |

Manual acceptance: import at least one Warp conversation, open Agent Kanban, choose **Warp**, and confirm only `warpapp-*` cards remain visible.

## Touched-file search

| Case                                                              | Expected result                                                             | Coverage                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Enter a basename fragment                                         | Only sessions whose materialized `touchedFiles` contain the fragment remain | `fileSearch.test.ts`; `chat-rendering-ui.spec.mjs`                      |
| Enter a partial path with Windows separators or uppercase letters | Separators and case normalize before substring matching                     | `fileSearch.test.ts`; `chat-rendering-ui.spec.mjs`                      |
| Enter a query with no match                                       | A translated empty state replaces the board/list                            | `chat-rendering-ui.spec.mjs`                                            |
| Clear the query                                                   | The original unfiltered task set returns                                    | `chat-rendering-ui.spec.mjs`                                            |
| Switch to Diary/Data Source or use a headerless embed             | A hidden stale search does not filter that view                             | `TaskKanban` applies the query only where the search control is visible |

Manual acceptance: open **Work Management → Kanban**, search for part of a file path shown under a session's Touched Files detail, verify only matching sessions remain, then clear the field and verify all cards return.

## List impact summary

| Case                                  | Expected result                                                               | Coverage                  |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| View a session with file/line changes | One `Files · Lines` column shows the file count before the colored line stats | `ListView/index.test.tsx` |
| View a session without impact data    | The consolidated impact cell shows the standard empty-value dash              | Shared `SessionTable`     |
| List contains more than 25 sessions   | Pagination defaults to 25 rows and offers only 25 or 50 rows per page         | `ListView` pagination     |

Manual acceptance: switch Work Management to **List** and confirm impact reads in the order `46 · +927 −606`, with no separate Files column. With more than 25 sessions, confirm the first page contains 25 rows and the page-size selector offers only **25** and **50**.

## Organization scope and creator attribution

| Case                                        | Expected result                                                                                          | Coverage                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Select Personal in the sidebar              | Kanban, List, and Diary contain Personal sessions; sessions explicitly removed from Personal stay hidden | `useKanbanOrgScope.test.ts`                               |
| Select a local organization                 | Every task view contains only sessions owned by that local org                                           | Shared `sessionMatchesOrgFilter` projection               |
| Select a cloud organization                 | Bare cloud ownership, explicit cloud tags, and scope-matched imported history are included               | `useKanbanOrgScope.test.ts`; shared sidebar scope helpers |
| Cloud roster contains a teammate session    | The teammate row appears in Kanban/List with avatar/name even before it is imported locally              | `cloudRemoteToKanbanTask.test.ts`                         |
| Cloud roster also contains my local session | The matching cloud row is suppressed only when both viewer identity and source session id match          | `cloudRemoteToKanbanTask.test.ts`                         |
| A teammate source id collides locally       | The teammate row stays visible because ownership differs                                                 | `cloudRemoteToKanbanTask.test.ts`                         |
| A teammate replay was imported locally      | The local imported task wins and the cloud metadata row is not duplicated                                | `cloudRemoteToKanbanTask.test.ts`                         |
| Teammate session has no published events    | Its creator/session metadata stays visible but the card/row cannot open or drag                          | `cloudRemoteToKanbanTask.test.ts`                         |
| View an owned organization session          | The card and List owner column show the current profile avatar and name                                  | `sessionTableItem.test.ts`                                |
| View an imported teammate session           | Persisted owner profile data is shown; missing images fall back to name initials                         | `useKanbanOrgScope.test.ts`; `TaskCreator.test.ts`        |
| Change organization with a task detail open | The old task detail closes instead of remaining as a stale loading overlay                               | `TaskKanban` scope-change effect                          |
| Change organization from the Kanban header  | The ghost selector and sidebar stay in sync; Kanban, List, and Diary immediately use the new scope       | Shared `sidebarSelectedOrgIdAtom`                         |
| Open Sessions from managed-org General      | The organization scope is selected and the existing Work Management Kanban tab opens in one click        | `cloud-org-ui.spec.mjs`                                   |
| View a replayable teammate in Kanban List   | The row exposes Take over; activating it forks through the canonical cloud-session action                | `ListView/index.test.tsx`; `cloud-org-ui.spec.mjs`        |
| View a metadata-only teammate in List       | No Take over action renders because the source has no replayable events                                  | `TaskKanban` action capability guard                      |

Manual acceptance: switch between Personal and an organization from both the sidebar and the ghost selector beside the Kanban header divider, confirming both selectors stay synchronized and the card set changes immediately. Then switch to **List** and confirm the same set plus its Creator column. Verify both a profile image and a letter fallback when those records are available.

## Bounded column rendering and default range

| Case                                       | Expected result                                                                  | Coverage                   |
| ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------- |
| Open a column containing more than 25 rows | Only its first 25 tasks are initially available to the card renderer             | `taskRenderWindow.test.ts` |
| Scroll that column to the bottom           | Exactly the next 25 tasks become available; the revealed range stays virtualized | `taskRenderWindow.test.ts` |
| Reach the final partial batch              | The reveal count clamps to the real column length                                | `taskRenderWindow.test.ts` |
| Open Kanban without a saved range          | The initial activity window is 3 days                                            | `config.test.ts`           |

Manual acceptance: use a column with at least 60 tasks, confirm the initial scrollbar represents 25 cards, scroll to the bottom twice, and confirm tasks 26–50 and then 51–60 appear without mounting the full history at once. Clear `orgii:kanbanTimeFilter` and reload to confirm the range starts at **3d**.
