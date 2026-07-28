# Turn metadata footer test cases

| Case                                              | Expected result                                                                                       | Coverage                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A completed round edits one or more files         | The footer shows the unique file count, paths, and additions/deletions                                | `turnFilesMapping.test.ts`; `chat-rendering-ui.spec.mjs`     |
| A completed round only edits files                | Only the Edits pill renders; the empty Reads pill is omitted                                          | `TurnMetadataFooter.test.ts`                                 |
| A completed round only reads files                | Only the Reads pill renders; the empty Edits pill is omitted                                          | `TurnMetadataFooter.test.ts`                                 |
| A round edits and reads files                     | Edits is the default pill; read rows stay unmounted until the Reads pill is selected                  | `chat-rendering-ui.spec.mjs`                                 |
| A read/search/write attempt fails                 | The failed observation remains visible, while failed writes do not enter the modified-file review     | Orgtrack projector tests                                     |
| A round commits and creates a GitHub PR           | Commit and PR rows render under Edits alongside changed files                                         | Rust Git-artifact tests; `chat-rendering-ui.spec.mjs`        |
| More than four resources are expanded             | Rows scroll with no visible scrollbar; the larger collapse control stays pinned below the scroll area | `TurnMetadataFooter.test.ts`                                 |
| A completed round makes no edits or Git artifacts | A translated explicit no-change state renders                                                         | `chat-rendering-ui.spec.mjs`                                 |
| A pending or working round has projected metadata | No footer renders until status becomes completed, interrupted, or failed                              | `turnFinality.test.ts`; Codex lifecycle projector tests      |
| A historical session predates metadata index v10  | First turn-index access rebuilds from persisted events and then reads the materialized rows           | `TURN_INDEX_VERSION`; session-persistence turn tests         |
| Metadata arrives after chat content               | Only the matching footer atom updates; the virtualized chat tree is not subscribed to the result map  | `TurnMetadataLoader` + `turnMetadataAtomFamily` architecture |
| Review/file row is clicked                        | Agent Station opens the cumulative session diff and focuses the selected path                         | Existing diff-scope integration                              |
| Commit/PR row is clicked                          | Commit opens Agent Station commit diff; PR opens its external URL                                     | Footer action handlers                                       |

Manual acceptance: open a completed ORGII-native or imported-provider session that read/edited a file and ran `git commit`/`gh pr create`. Confirm Edits is selected by default and contains the file, commit, and PR rows; confirm no read row is mounted until selecting Reads. Open Review, then open the commit and PR rows. While a Codex turn is running, confirm the footer is absent and appears only after the terminal lifecycle event is imported.
