# Frontend UI Audit: WorktreePalette

## Scope

- `src/scaffold/GlobalSpotlight/palettes/BranchPalette/index.tsx`
- `src/scaffold/GlobalSpotlight/index.tsx`

The configured `frontend-ui-audit` skill file was unavailable at both paths
documented in `AGENTS.md`. This pass applies the repository's audit dimensions
directly: shared-component usage, design-token consistency, arbitrary Tailwind
values, accessibility basics, and visual-pattern duplication.

## Findings

| Line | Element                   | Verdict          | Reason                                                                                                                                                                          | Suggested change                                                                                       |
| ---: | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
|  136 | Active worktree indicator | fix (applied)    | The shared `SpotlightItemRow` already replaces the row icon with a primary check when `isCurrentSelection` is true, so the additional `Current` pill duplicated the same state. | Removed the pill and retained `isCurrentSelection` as the single visual and semantic selection signal. |
|  230 | Worktree pinned actions   | keep with reason | New, Remove, Refresh, and Done reuse `SpotlightPinnedActionSection`, the same shared action rows and two-column layout used by the branch palette.                              | None.                                                                                                  |
|  251 | Remove-mode disclosure    | keep with reason | The disclosure chevron communicates that Remove opens a nested mode; the icon and label reuse the existing Lucide and translated worktree action patterns.                      | None.                                                                                                  |
|  291 | Selectable-item guard     | keep with reason | Headers and in-flight removal rows are excluded from keyboard activation through the palette kernel rather than through custom row behavior.                                    | None.                                                                                                  |
|  302 | Pinned action navigation  | keep with reason | Pinned actions share the palette's item index space, so mouse and keyboard selection remain consistent with the existing Spotlight implementation.                              | None.                                                                                                  |
|  329 | Worktree mode path        | keep with reason | Switch and Remove modes use the existing Spotlight path component and existing translated labels; no custom breadcrumb or arbitrary style values were introduced.               | None.                                                                                                  |

## Summary

- Fix: 1 applied
- Keep with reason: 5
- Abstract: 0
- Multi-file sweep candidates: 0

No arbitrary colors, sizes, raw interactive controls, or duplicated Spotlight row
implementations were introduced.
