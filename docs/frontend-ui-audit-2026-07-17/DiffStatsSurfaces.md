# Frontend UI Audit — Diff stats surfaces

**Files:** diff-stat consumers under `src/` (multi-file sweep)
**Date:** 2026-07-17
**Auditor:** Codex
**Audited ref:** `origin/develop` at `5be17525bc38c56c27157de5f7e2f471bff45d42`

## Scope and screenshot identification

The screenshot's `+7996 -1689` display is the working-tree line total rendered
inside `EditorStatusBar`. It is not a separate diff-bar implementation:

- `EditorStatusBar.tsx:297-307` renders the shared `DiffStatsBadge`.
- The totals come from the shared `useWorkingTreeDiffTotals` hook through
  `useEditorStatusBarGit`.
- The same badge component is used by 21 UI consumer files on the audited ref.
- The same totals hook is used by four surfaces: Start Page, tab-bar plus menu,
  editor status bar, and focused-chat workstation rail.

The refresh + chevron immediately after the badge is `GitSyncStatusMenu`. Its
ahead/behind commit counts are not line diff stats and should not be forced into
`DiffStatsBadge`.

## D1 — Raw HTML vs Design System

| Line                                     | Element                                       | Verdict | Reason                                                                                               | Suggested change                                                                                  |
| ---------------------------------------- | --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `EditorStatusBar.tsx:297-307`            | working-tree `+N/-N`                          | keep    | Already uses shared `DiffStatsBadge`; the surrounding `StatusBarButton` is also shared status-bar UI | —                                                                                                 |
| `FocusedChatWorkstationRail.tsx:409-417` | Review-row `+N/-N`                            | keep    | Already uses shared `DiffStatsBadge`                                                                 | —                                                                                                 |
| `EditActivityGroup/index.tsx:224-234`    | hand-written diff-stat spans                  | fix     | Reimplements an existing design-system component                                                     | Replace the value spans with `DiffStatsBadge` and preserve the leading separator                  |
| `useComposerSections.ts:82-101`          | `React.createElement("span")` diff-stat nodes | fix     | Reimplements `DiffStatsBadge` through raw spans                                                      | Render `DiffStatsBadge` via `React.createElement`, or allow JSX in a small presentation component |

## D2 — Arbitrary Tailwind Value vs Token

| Line                        | Value            | Verdict | Reason                                                                              | Suggested change                     |
| --------------------------- | ---------------- | ------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| `useComposerSections.ts:88` | `text-green-500` | fix     | Raw palette color bypasses the project diff token already owned by `DiffStatsBadge` | Migrate the pair to `DiffStatsBadge` |
| `useComposerSections.ts:97` | `text-red-500`   | fix     | Same issue for deletions                                                            | Migrate the pair to `DiffStatsBadge` |

No screenshot-site D2 issue was found.

## D3 — Hardcoded Sizes / Colors

| Line                           | Value                         | Verdict          | Reason                                                                               | Suggested change            |
| ------------------------------ | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| `useComposerSections.ts:88,97` | raw green/red palette classes | fix              | Diff colors already have semantic `DIFF_STATS` tokens inside the shared badge        | Covered by the D1 migration |
| `EditorStatusBar.tsx:297-307`  | `size="xs"`                   | keep with reason | Named size is part of the shared badge API and matches compact status-bar typography | —                           |

## D4 — Accessibility

| Line                   | Element                               | Verdict | Reason                                                                                                            | Suggested change |
| ---------------------- | ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| screenshot site        | `DiffStatsBadge` inside branch button | keep    | The numbers are visible text within an already named native button; no extra interactive semantics are introduced | —                |
| remaining manual sites | non-interactive spans                 | keep    | No keyboard behavior is expected; migration is for consistency/token ownership rather than an a11y defect         | —                |

## D5 — Visual Patterns Observed

| Pattern                              | Where                                      |      Count | Verdict                                                    |
| ------------------------------------ | ------------------------------------------ | ---------: | ---------------------------------------------------------- |
| Shared additions/deletions badge     | `DiffStatsBadge` consumers                 |   21 files | already abstracted                                         |
| Shared working-tree aggregate loader | `useWorkingTreeDiffTotals` consumers       | 4 surfaces | already abstracted                                         |
| Hand-written colored `+N/-N` pair    | `EditActivityGroup`, `useComposerSections` |          2 | fix existing call sites; do not create another abstraction |

Text-only strings produced by `formatDiffStatsLabel`, PR prompt metadata, and
diff parsers are intentionally excluded: they are serialization/label content,
not visual badge implementations.

## Summary

- **2 fixes recommended:** migrate the two remaining hand-written visual pairs.
- **3 kept with documented reason:** screenshot badge, named compact size, and
  non-interactive semantics.
- **0 new abstract candidates:** the correct visual and data abstractions
  already exist.

The screenshot therefore demonstrates reuse rather than duplication. The
remaining debt is narrow and should be handled as a two-call-site cleanup, not a
new diff-bar component project.
