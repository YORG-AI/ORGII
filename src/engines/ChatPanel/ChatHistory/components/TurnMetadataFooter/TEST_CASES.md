# Turn metadata footer test cases

| Case                                              | Expected result                                                                                      | Coverage                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A completed round edits one or more files         | The footer shows the unique file count, paths, and additions/deletions                               | `turnFilesMapping.test.ts`; `chat-rendering-ui.spec.mjs`     |
| A round reads and searches files                  | Localized read/search counts and privacy-safe result/scope paths render without claiming edits       | Orgtrack projector tests; `chat-rendering-ui.spec.mjs`       |
| A read/search/write attempt fails                 | The failed observation remains visible, while failed writes do not enter the modified-file review    | Orgtrack projector tests                                     |
| A round commits and creates a GitHub PR           | Commit and PR summary chips and linkable rows render in the same round                               | Rust Git-artifact tests; `chat-rendering-ui.spec.mjs`        |
| A completed round makes no edits or Git artifacts | A translated explicit no-change state renders                                                        | `chat-rendering-ui.spec.mjs`                                 |
| A pending round has no materialized metadata yet  | No misleading zero/empty footer renders                                                              | `TurnMetadataFooter` settled-state guard                     |
| A historical session predates metadata index v10  | First turn-index access rebuilds from persisted events and then reads the materialized rows          | `TURN_INDEX_VERSION`; session-persistence turn tests         |
| Metadata arrives after chat content               | Only the matching footer atom updates; the virtualized chat tree is not subscribed to the result map | `TurnMetadataLoader` + `turnMetadataAtomFamily` architecture |
| Review/file row is clicked                        | Agent Station opens the cumulative session diff and focuses the selected path                        | Existing diff-scope integration                              |
| Commit/PR row is clicked                          | Commit opens Agent Station commit diff; PR opens its external URL                                    | Footer action handlers                                       |

Manual acceptance: open a completed ORGII-native or imported-provider session that read/searched/edited a file and ran `git commit`/`gh pr create`. Confirm the round footer shows observation, file, commit, and PR chips; expand the paths, open Review, then open the commit and PR rows. Open a no-activity round and confirm the explicit empty state.
