# Frontend UI Audit: Spotlight Selector Context Menus

## Scope

- `src/scaffold/GlobalSpotlight/components/SpotlightItemRow.tsx`
- `src/scaffold/GlobalSpotlight/shared/types.ts`
- Worktree, branch, repository, folder, and saved-workspace item builders under
  `src/scaffold/GlobalSpotlight/palettes/`

The configured `frontend-ui-audit` skill file was unavailable at both paths
documented in `AGENTS.md`. This pass applies the repository's audit dimensions
directly: shared-component usage, design-token consistency, arbitrary Tailwind
values, accessibility basics, and visual-pattern duplication.

## Findings

|                                   Line | Element                     | Verdict            | Reason                                                                                                                                                                                                     | Suggested change                                                                                                       |
| -------------------------------------: | --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
|              `SpotlightItemRow.tsx:59` | Native context-menu builder | abstract (applied) | All requested selector rows need consistent copy behavior, while filesystem-backed rows also need the platform-specific Reveal action. A single builder prevents visually or behaviorally divergent menus. | Centralized native menu creation, clipboard error handling, and file-manager reveal behavior in the shared row module. |
|             `SpotlightItemRow.tsx:319` | Right-click handler         | keep with reason   | The handler suppresses the WebView menu, highlights the target row, and never invokes the row's normal selection action. Headers, disabled rows, and rows without copy data remain inert.                  | None.                                                                                                                  |
|             `SpotlightItemRow.tsx:369` | Row context-menu binding    | keep with reason   | Reuses the existing shared Spotlight row rather than introducing wrapper elements or custom hit areas.                                                                                                     | None.                                                                                                                  |
|                   `shared/types.ts:63` | Declarative copy targets    | keep with reason   | Item builders provide only semantic name/path values; they do not import native menu UI or duplicate clipboard behavior.                                                                                   | None.                                                                                                                  |
|          `BranchPalette/index.tsx:138` | Worktree copy values        | keep with reason   | The copied name matches the displayed worktree label and the copied path matches the normalized filesystem path shown below it.                                                                            | None.                                                                                                                  |
|                 `useBranchItems.ts:81` | Branch copy value           | keep with reason   | Copy Name preserves the full branch name across checkout, ref-selection, and remove modes without adding a redundant path action.                                                                          | None.                                                                                                                  |
|                    `repoAdapter.ts:60` | Workspace/repo copy values  | keep with reason   | Repo and folder rows normalize `file://` and trailing separators before exposing Copy Path, while preserving the displayed name.                                                                           | None.                                                                                                                  |
| `useWorkspacePaletteWorkspace.tsx:386` | Saved workspace copy values | keep with reason   | A saved multi-repo workspace uses its primary folder as the singular path, falls back to the first folder, and omits Copy Path if it has no folders.                                                       | None.                                                                                                                  |

## Summary

- Fix: 0
- Keep with reason: 7
- Abstract: 1 applied
- Multi-file sweep candidates: 0

The menu is native OS chrome, so no custom colors, arbitrary Tailwind values,
or parallel context-menu styling were introduced. Reveal reuses the existing
platform label resolver, producing Finder, Explorer, or generic file-manager
labels as appropriate. Existing keyboard selection continues to work; the
requested right-click actions are supplemental.
