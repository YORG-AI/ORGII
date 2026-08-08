# Test Cases: CodeEditor (WorkStation)

## Preconditions

- A workspace root is open with at least one file.
- `CodeEditor` module is mounted within a `WorkStation` layout with a Jotai provider.
- At least one git repository is initialized in the workspace root.
- A `CodeMirror` editor instance is rendered (extensions configured).

## Happy Path

| #   | Steps                                             | Expected Result                                                            |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Open a file via the file tree.                    | File content appears in the CodeMirror editor; tab created with file name. |
| 2   | Edit text in the editor.                          | Content changes in editor; tab marked as "unsaved" (dot indicator).        |
| 3   | Press Cmd+S / Ctrl+S.                             | File saved to disk; unsaved indicator removed.                             |
| 4   | Open a git-tracked file with uncommitted changes. | Git diff gutter shows changed lines (added/modified/deleted).              |
| 5   | Open the Find panel (Cmd+F).                      | Search bar appears; typing highlights matches in editor.                   |
| 6   | Use Find & Replace (Cmd+H).                       | Replace bar appears; replacing a term updates all occurrences.             |
| 7   | Switch between open tabs.                         | Editor renders content of selected tab; previous tab state preserved.      |
| 8   | Close a tab (Cmd+W or × button).                  | Tab closed; adjacent tab becomes active.                                   |
| 9   | Open bottom panel (Terminal tab).                 | Terminal renders; command can be typed and executed.                       |
| 10  | Open Problems tab.                                | Lint/TypeScript errors listed from active file's diagnostics.              |

## Edge Cases

| #   | Scenario                         | Steps                                              | Expected Result                                                                                       |
| --- | -------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Open a binary/unsupported file   | Click a `.png` in file tree.                       | Editor shows "binary file" or preview fallback; no garbled text.                                      |
| 2   | Open an empty file               | Click an empty `.ts` file.                         | Editor renders empty; no crash; save works.                                                           |
| 3   | File deleted externally mid-edit | Delete file outside app while it's open in editor. | Tab marked as "file not found"; editor shows warning.                                                 |
| 4   | Very large file (> 1 MB)         | Open a 2 MB log file.                              | CodeMirror loads without UI freeze; syntax highlight may be disabled.                                 |
| 5   | Git diff with binary changes     | Open file with only binary changes in diff.        | Diff gutter shows changed state; no garbled diff output.                                              |
| 6   | Multiple tabs open               | Open 15 files simultaneously.                      | All tabs shown (or overflow scrolled); each renders correctly.                                        |
| 7   | Search with no results           | Open search; type string not present in file.      | "No results" indicator shown; no crash.                                                               |
| 8   | Search with regex                | Open search; enable regex mode; type `\d+`.        | Numeric matches highlighted.                                                                          |
| 9   | Close unsaved tab                | Edit a file; close tab without saving.             | Confirmation dialog appears; cancel preserves tab; confirm discards changes.                          |
| 10  | Window resize                    | Resize workstation panel while file is open.       | Editor reflows; no layout artifacts.                                                                  |
| 11  | Stash count badge                | `useStashCount` returns > 0.                       | Git status area shows stash count badge.                                                              |
| 12  | Rapid open/close tabs            | Open and close 5 tabs rapidly.                     | No memory leak; no stale state in CodeMirror instances.                                               |
| 13  | Return to Review tab             | Open Review, switch to Files, then return.         | Existing Source Control tree stays visible while Git initialization is revalidated; no loading flash. |

## Error / Degraded States

| #   | Scenario            | Steps                                    | Expected Result                                            |
| --- | ------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 1   | File read IPC fails | Tauri `file.read` command returns error. | Error message shown in tab/editor area; no crash.          |
| 2   | Save IPC fails      | Tauri `file.save` command rejects.       | Error toast/message shown; unsaved indicator remains.      |
| 3   | Git diff IPC fails  | Git status fetch throws.                 | Diff gutter hidden or shows neutral state; no crash.       |
| 4   | Terminal crash      | Terminal process exits unexpectedly.     | Terminal tab shows exit message; restart button available. |

## Async Git View Continuity

| #   | Scenario                       | Steps                                                                          | Expected Result                                                                                |
| --- | ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | History mode re-entry          | Load Source Control History, switch to Changes, then return.                   | Cached commit rows render on the first frame; no full-sidebar loading placeholder.             |
| 2   | History refresh                | With commit rows visible, click Refresh.                                       | Existing rows remain visible until the replacement response succeeds; pagination stays usable. |
| 3   | Commit detail re-entry         | Open a commit, select a changed file, switch tabs, then return.                | Commit summary, selected file, and diff body render without a full-page loading placeholder.   |
| 4   | Stash detail re-entry          | Open a stash detail, switch tabs, then return.                                 | The same bounded commit/file cache restores the stash diff without retaining CodeMirror.       |
| 5   | Directory metadata pending     | Open a directory whose Git metadata queries are slow.                          | Directory entries appear after `readDir`; supplemental author/commit metadata fills in later.  |
| 6   | Directory re-entry             | Load a directory, switch tabs, then return within the cache window.            | Entries render immediately and duplicate directory/metadata requests are not issued.           |
| 7   | Repository switch              | Open equivalent History/Directory/Commit views in two repositories.            | Data remains isolated by repo ID/path; one repository never paints another repository's rows.  |
| 8   | Late response after tab switch | Start a slow commit request, switch to another commit, finish the old request. | The late response may populate its own cache key but cannot replace the active commit view.    |
| 9   | Oversized commit file          | Open a commit file body larger than the per-entry cache limit.                 | Content displays for the active view but is not retained after unmount.                        |

## Accessibility

- [ ] Keyboard-navigable (Tab moves between editor, tabs, and panels)
- [ ] Screen reader label on editor area (`aria-label` set to file name)
- [ ] Focus trap correct when modals (close confirmation) are open
- [ ] Tab bar announces active file

## Acceptance Criteria

- [ ] Opening a file displays its content in the CodeMirror editor
- [ ] Editing marks the tab as unsaved; saving clears the marker
- [ ] Git diff gutter shows changed lines for tracked files
- [ ] Find / Find & Replace work with plain text and regex
- [ ] Unsaved tab close triggers confirmation dialog
- [ ] Terminal in bottom panel executes commands
- [ ] Problems tab lists diagnostics from the active file
- [ ] Warm History, Commit/Stash, and Directory re-entry does not replace successful content with loading UI
- [ ] Git view caches remain entry/byte bounded and repository-scoped
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors (`pnpm typecheck`)
