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
