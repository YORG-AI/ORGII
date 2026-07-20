# Task Kanban test cases

## Imported-history source filters

| Case                                | Expected result                                                       | Coverage                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A Warp imported session is present  | The agent filter includes `Warp` and selecting it keeps Warp sessions | `config.test.ts`; `KanbanHeaderFilters` derives the label from the imported-source registry |
| Another imported source is selected | Warp sessions do not match that source filter                         | Type-safe `EXTERNAL_HISTORY_FILTER_BY_SOURCE` lookup in `useTaskKanbanFilters`              |
| No Warp imported session is present | The Warp option is omitted from the compact filter list               | Existing present-source filtering in `KanbanHeaderFilters`                                  |

Manual acceptance: import at least one Warp conversation, open Agent Kanban, choose **Warp**, and confirm only `warpapp-*` cards remain visible.

## Qoder imported-history source

| Case                                                       | Expected result                                                                                        | Coverage                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Qoder transcripts exist in either supported project layout | Data Sources shows Qoder as importable and its session count is available                              | Rust discovery fixtures; imported-source registry tests               |
| Qoder is enabled                                           | Sidebar pagination loads `qoderapp-*` sessions independently and Kanban offers a `Qoder` source filter | `paginationAtoms.test.ts`; `sidebarLoaders.test.ts`; `config.test.ts` |
| Qoder is disabled                                          | No Qoder sidebar request is sent and other imported sources still load                                 | `sidebarLoaders.test.ts`                                              |
| Update is selected                                         | Only changed Qoder JSONL files are reparsed                                                            | Parser/file-signature cache test                                      |
| Clear + rescan is selected                                 | Qoder cache rows rebuild while another provider's rows remain intact                                   | `qoder_clear_and_rescan_pruning_does_not_touch_other_sources`         |
| A Qoder session is opened                                  | User, assistant, thinking, shell/read/edit tools and paired outputs replay read-only                   | Qoder transcript fixture test; session dispatch tests                 |

Manual acceptance: create a local Qoder session, open **Data Sources**, update Qoder, select **Qoder** in Agent Kanban, and open the card to confirm the replay and edit diff. Disable Qoder and confirm its cards disappear without affecting other imported sources.
