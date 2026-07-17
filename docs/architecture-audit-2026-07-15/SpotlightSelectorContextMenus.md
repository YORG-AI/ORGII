# Architecture Audit: Spotlight Selector Context Menus

## Acceptance criteria

- [x] One shared context-menu renderer owns native menu creation and clipboard
      failure handling.
- [x] Selector builders declare copy values without importing UI transport.
- [x] Branches expose name only; worktrees and workspace-path rows expose name
      and path.
- [x] Filesystem-backed rows expose Reveal through the existing cross-platform
      opener API and label resolver; branch rows do not invent a path action.
- [x] Repository paths are normalized at their domain adapter boundary.
- [x] Every new production type/property is consumed by a live call path.

## Ten-layer review

| Layer                                   | Coverage                                                                                                                                                        | Verdict                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Compilation correctness              | Changed files pass ESLint and focused Vitest coverage. The full repository typecheck reports only the unrelated pre-existing `ContextInfoButton.tsx:468` error. | No changed-file error found.                    |
| 2. Dead code and structural duplication | Traced item builders → `SpotlightItemData.contextMenuCopy` → `SpotlightItemRow` → native Tauri menu → shared `copyText` / `revealItemInDir`.                    | One live path; no per-palette menu duplication. |
| 3. Naming consistency                   | `contextMenuCopy.name/path`, `Copy Name`, and `Copy Path` describe the copied values consistently.                                                              | Keep.                                           |
| 4. Semantic overloading                 | Branch name, worktree label, workspace name, and filesystem path remain distinct fields.                                                                        | Keep.                                           |
| 5. Default-branch analysis              | Menu entries are included explicitly only when their corresponding value exists; no catch-all invents a path.                                                   | Keep.                                           |
| 6. Cross-domain leakage                 | Palette builders own domain-to-copy-value mapping; the shared row knows only optional name/path strings.                                                        | Keep.                                           |
| 7. New-developer clarity                | The item data shows exactly which values a row exposes. Native-menu and clipboard concerns remain centralized.                                                  | Keep.                                           |
| 8. Wire protocol                        | No application wire contract changed. Tauri's existing native-menu, opener, and clipboard APIs are reused.                                                      | No custom serialization to audit.               |
| 9. Init parity                          | No initialization path changed; every Spotlight row renderer receives the same optional data contract.                                                          | Not applicable beyond call-path trace.          |
| 10. Resolver symmetry                   | No resolver or fallback chain changed. The saved-workspace primary/first-folder choice is one documented single-field rule.                                     | Not applicable.                                 |

## Call path

`selector item builder` → `contextMenuCopy` → row `contextmenu` event → native
Tauri menu → shared `copyText` browser/Tauri/textarea fallback chain or
cross-platform `revealItemInDir`.

No architecture fix candidates remain in the audited scope.
