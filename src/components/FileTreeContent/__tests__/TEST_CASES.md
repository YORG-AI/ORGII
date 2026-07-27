# Test Cases: FileTreeContent

## Preconditions

- A workspace is open with at least one file in the tree
- The `FileTreeContent` component is rendered inside a `GitStatusContext.Provider` (provided internally)
- A valid `dispatch` function is available (from `ActionSystem` or passed as a prop)

---

## Happy Path

| #   | Steps                                          | Expected Result                                                                      |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Render with a flat list of files               | All files appear in the tree at depth 0                                              |
| 2   | Render with a nested directory (expanded)      | Directory and its children appear; children are indented                             |
| 3   | Click a file                                   | `onSelectNode` is called with the file's path                                        |
| 4   | Click a directory                              | `onSelectNode` AND `onToggleDirectory` are called; directory toggles expand/collapse |
| 5   | Type in the filter input                       | `onFilterChange` is called with the typed query                                      |
| 6   | Right-click a file                             | Native OS context menu appears with file-specific actions                            |
| 7   | Right-click background (no node)               | Context menu shows New File, New Folder, Refresh                                     |
| 8   | Context menu → Rename                          | Inline rename input appears in-place                                                 |
| 9   | Rename input → Enter                           | `file.rename` dispatch is called; rename input closes                                |
| 10  | Rename input → Escape                          | Rename input closes without dispatching                                              |
| 11  | Context menu → New File                        | Inline `NewItemInput` appears; typing a name + Enter creates the file                |
| 12  | Context menu → New Folder                      | Inline `NewItemInput` appears; typing a name + Enter creates the folder              |
| 13  | F2 on selected file                            | Inline rename input appears for the selected file                                    |
| 14  | F2 inside rename input                         | Selection cycles: basename → full → extension → basename                             |
| 15  | Cmd/Ctrl+Delete on selected file               | Confirmation dialog appears; if confirmed, `file.delete` is dispatched               |
| 16  | Drag a file out of the tree                    | Native OS drag is initiated via `useNativeDrag`                                      |
| 17  | `revealPath` prop changes with new `revealKey` | Tree scrolls to the revealed file                                                    |
| 18  | Git-modified file                              | Git status badge is rendered on the file row                                         |
| 19  | Git-modified folder                            | Folder row shows aggregate git status dot in sticky header                           |
| 20  | Multi-root workspace (isMultiRoot=true)        | Top-level directories render as folder header rows                                   |

---

## Edge Cases

| #   | Scenario                                  | Steps                                               | Expected Result                                                           |
| --- | ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Empty tree                                | Render with `treeData=[]`                           | Empty message placeholder is shown                                        |
| 2   | Empty tree + active filter                | Render with `treeData=[]`, `filterQuery="abc"`      | "No results" placeholder is shown                                         |
| 3   | Single file                               | Render with one file                                | File appears, no crash                                                    |
| 4   | Very deep nesting                         | 10+ levels of expanded directories                  | Tree renders without layout overflow; depth indentation is correct        |
| 5   | Rename with empty input                   | Rename input → Enter with blank value               | Rename cancels; no dispatch called                                        |
| 6   | Rename with unchanged value               | Type same name → Enter                              | Rename cancels; no dispatch called                                        |
| 7   | New item cancel via Escape                | NewItemInput → Escape                               | Input closes without dispatching                                          |
| 8   | New item cancel via blur with empty value | NewItemInput → click outside with empty input       | Input closes without dispatching                                          |
| 9   | New item confirm via blur with value      | NewItemInput → type name → click outside            | File/folder created                                                       |
| 10  | revealPath already visible                | File is already in viewport                         | Scroll position is preserved (no scroll)                                  |
| 11  | revealPath in collapsed directory         | `revealPath` points to a file under a collapsed dir | Poll retries until directory is expanded; then scrolls                    |
| 12  | Workbench route branch unmounted          | Navigate to a standalone route                      | File tree and reveal hook unmount; no hidden scroll side effect           |
| 13  | Rapid F2 presses in rename                | Press F2 multiple times                             | Selection cycles through basename → full → extension → basename correctly |
| 14  | File without extension in rename          | Open rename for file like `.gitignore`              | Selects full name (no extension cycle)                                    |
| 15  | Simultaneous right-clicks                 | Right-click rapidly on multiple nodes               | Only one context menu shown at a time; previous closes                    |
| 16  | repoPath is null                          | Render with `repoPath={null}`                       | No context menu; no git status lookup; tree renders normally              |
| 17  | isMultiRoot with nested dirs              | Multi-root tree with 2 roots, each with children    | Both root headers render; children nest correctly below each root         |

---

## Error / Degraded States

| #   | Scenario                     | Steps                            | Expected Result                                         |
| --- | ---------------------------- | -------------------------------- | ------------------------------------------------------- |
| 1   | `loading=true`               | Render with loading prop         | VirtualizedStickyTree shows loading indicator           |
| 2   | `error="some error"`         | Render with error prop           | VirtualizedStickyTree shows error state                 |
| 3   | `dispatch` throws            | Confirm rename; dispatch rejects | Error is caught; rename mode exits                      |
| 4   | Tauri menu unavailable       | Context menu show fails          | `onClose` is called; menu state is cleaned up; no crash |
| 5   | Delete confirmation rejected | Cmd+Delete → cancel dialog       | No `file.delete` dispatch; tree is unchanged            |

---

## Accessibility

- [ ] Container div has `tabIndex={0}` for keyboard focus
- [ ] Keyboard shortcuts (F2, Enter, Delete/Backspace) work when tree has focus
- [ ] Rename input auto-focuses on activation
- [ ] NewItemInput auto-focuses on activation
- [ ] Escape closes both rename and new-item inputs
- [ ] Git status badges have `title` attributes for screen readers
- [ ] Sticky header click scrolls to item (keyboard-equivalent via `onStickyHeaderClick`)

---

## Acceptance Criteria

- [ ] All happy-path test cases pass
- [ ] All edge cases documented above are verified
- [ ] No regressions in WorkStation or HumanTools file tree panels
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors (`pnpm typecheck`)
- [ ] No new lint warnings
- [ ] WorkStation's `EditorPrimarySidebar` passes `stickyBgClass` via `usePrimarySidebarSurface()`
- [ ] Both WorkStation and HumanTools import from `@src/components/FileTreeContent`
- [ ] `getLookupPath`, `flattenTree`, `findFileInNodes` are covered by unit tests
- [ ] Loading, empty, error states are all visually handled
- [ ] Rename and new-item inputs handle blur, Enter, Escape correctly
- [ ] `useRevealPath` skips scroll when WorkStation is not the active view
