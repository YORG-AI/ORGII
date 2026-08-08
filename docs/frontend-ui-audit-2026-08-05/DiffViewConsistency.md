# Frontend UI Audit: Diff View Consistency

**Files:**

- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/components/SourceControlHeaderContent.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/index.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SourceControlMainPane.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SourceControlMainContent/index.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SourceControlMainContent/FocusView.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SourceControlMainContent/AllChangesView.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitDiffContent/index.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent/index.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrChangesTab.tsx`
- `src/modules/WorkStation/Diff/SessionReplay/index.tsx`
- `src/modules/WorkStation/Diff/SessionReplay/diffSessionReplay.useDetailContent.tsx`
- `src/modules/WorkStation/shared/DiffFileSection/index.tsx`
- `src/modules/WorkStation/shared/DiffSectionList/index.tsx`
- `src/modules/shared/components/FileHeader/index.tsx`
- `src/features/CodeMirror/Diff/index.tsx`
- `src/features/CodeViewer/GitDiffViewer.tsx`

**Date:** 2026-08-05

**Auditor:** Codex

## D1 — Design-system component usage

| Line                                   | Element                         | Verdict          | Reason                                                                                                                 | Suggested change                                                                                                     |
| -------------------------------------- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SourceControlHeaderContent.tsx:217`   | Unified / split selector        | keep with reason | Uses the existing `TabPill` design-system control, matching the file diff header interaction.                          | None.                                                                                                                |
| `SessionReplay/index.tsx:269`          | Unified / split selector        | keep with reason | Uses the same `TabPill` control and shared preference as the other diff surfaces.                                      | None.                                                                                                                |
| `GitCommitDetailContent/index.tsx:377` | Collapsed file-list rail button | keep with reason | The control occupies a full-height 24 px rail; the current design-system `Button` variants do not model that geometry. | Keep the raw semantic button until the rail pattern is abstracted.                                                   |
| `PrChangesTab.tsx:214`                 | Collapsed file-list rail button | keep with reason | Same full-height rail geometry as commit details.                                                                      | Keep the raw semantic button until the rail pattern is abstracted.                                                   |
| `DiffFileSection/index.tsx:418`        | Sticky expandable file header   | keep with reason | It is a full-width, multiline disclosure row rather than a standard action button.                                     | Continue using a semantic button; consider a dedicated diff-section header only if the pattern gains more consumers. |
| `FocusView.tsx:51`                     | No-file Focus empty state       | keep with reason | Reuses the workstation `NoTabsPlaceholder` with a focused instruction instead of assembling a bespoke empty state.     | None.                                                                                                                |

## D2 — Color and token usage

| Line | Element                 | Verdict          | Reason                                                                                                                           | Suggested change |
| ---- | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Audited visible changes | keep with reason | New controls use existing semantic border, fill, and text tokens; no raw colors or duplicated token expressions were introduced. | None.            |

## D3 — Spacing and typography

| Line                                     | Element                                       | Verdict          | Reason                                                                                                                                     | Suggested change                                                                             |
| ---------------------------------------- | --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `DiffSectionList/index.tsx:51`           | Virtual-list footer buffer `h-[100px]`        | keep with reason | This is an exact scroll affordance rather than visual component sizing, and the spacing scale has no exact 100 px token.                   | None.                                                                                        |
| `DiffFileSection/index.tsx:321`          | Loading placeholder `h-[480px] min-h-[320px]` | fix              | Both values have exact Tailwind scale equivalents and are unrelated to the current diff-mode behavior.                                     | In a separate visual-cleanup sweep, use `h-120 min-h-80` and visually verify loading layout. |
| `DiffFileSection/index.tsx:424`          | Chevron reservation `w-[14px]`                | keep with reason | The width deliberately matches the 14 px icon and has no exact standard spacing class.                                                     | None.                                                                                        |
| `DiffFileSection/index.tsx:436-463`      | Dense diff metadata typography                | keep with reason | The 13 px filename and 11 px metadata match the established dense diff header hierarchy; the standard text scale has no exact equivalents. | Keep until diff typography is tokenized system-wide.                                         |
| `SourceControlHeaderContent.tsx:119-123` | Dense source-control header typography        | keep with reason | The 11 px prefix and 13 px title preserve the existing editor-header hierarchy and were not introduced by this change.                     | Keep until editor header typography is tokenized system-wide.                                |

## D4 — Accessibility basics

| Line                                   | Element                            | Verdict          | Reason                                                                                                      | Suggested change                                                                                |
| -------------------------------------- | ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SourceControlHeaderContent.tsx:217`   | Unified / split selector           | keep with reason | Both options have visible translated labels and expose button semantics through `TabPill`.                  | None.                                                                                           |
| `SessionReplay/index.tsx:269`          | Unified / split selector           | keep with reason | Both options have visible translated labels and expose button semantics through `TabPill`.                  | None.                                                                                           |
| `GitCommitDetailContent/index.tsx:377` | Icon-only collapsed file-list rail | fix              | It has a tooltip title but no explicit accessible label.                                                    | Add the translated “show file list” string as `aria-label` in a coordinated rail-control sweep. |
| `PrChangesTab.tsx:214`                 | Icon-only collapsed file-list rail | fix              | It has a tooltip title but no explicit accessible label.                                                    | Add the translated “show file list” string as `aria-label` in the same sweep.                   |
| `DiffFileSection/index.tsx:418`        | Expandable file header             | keep with reason | The visible filename supplies an accessible name and `aria-expanded` communicates disclosure state.         | None.                                                                                           |
| `FocusView.tsx:51`                     | No-file Focus empty state          | keep with reason | The translated caption explicitly tells the user to select a changed file and exposes no unrelated actions. | None.                                                                                           |

## D5 — Duplication and abstraction candidates

- **Abstract candidate:** the collapsed 24 px file-list rail appears in commit details, pull-request changes, and `GitFileDiffSplit`. A small shared rail-control component could centralize geometry, tooltip, and accessible naming. This is a multi-file sweep candidate and is intentionally not mixed into the diff-view consistency fix.
- The new unified / split selectors intentionally reuse `TabPill` and one shared persisted atom; no new visual-pattern duplication was introduced.

## Summary

- **Fix candidates:** 3 (two rail-control accessible labels; one standardizable loading height)
- **Keep with reason:** 12
- **Abstract candidates:** 1
- **Current change verdict:** the new controls follow the design system and introduce no new arbitrary colors, spacing, or inaccessible icon-only actions.
