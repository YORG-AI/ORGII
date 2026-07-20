# Frontend UI Audit — Repository Health

**Scope:** Repo-wide D1–D5 sweeps with manual adjudication of high-leverage and representative hits  
**Date:** 2026-07-15  
**Auditor:** Codex  
**Mode:** Audit only; no source files changed

This is a broad health audit, not a claim that every one of the 683 raw-element hits was manually reviewed. Every reported fix/keep verdict below was inspected at its source; raw counts are used only to size future sweeps.

## D1 — Raw HTML vs Design System

The application layers contain 453 raw `<button>` uses across 272 files, plus 80 raw form/data elements. Most are not automatically violations: many are full-row, sticky, nested-interaction, or primitive implementations. The highest-leverage confirmed findings are below.

| Line                                                                     | Element                       | Verdict          | Reason                                                                                                                                       | Suggested change                                                                         |
| ------------------------------------------------------------------------ | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `components/Upload/UploadFileList.tsx:48,84`                             | icon-only remove `<button>`   | fix              | The Upload design-system component reimplements an icon button twice and supplies no accessible name                                         | Use `IconButton` (or a shared Upload remove action) with localized `aria-label`          |
| `components/SearchInput/index.tsx:208`                                   | clickable expand `<div>`      | fix              | SearchInput already belongs to the design system; its chevron is an interactive control                                                      | Render `IconButton`/semantic button with expanded state and label                        |
| `components/DateRangeSelector/index.tsx:96`                              | clickable field `<div>`       | fix              | This is a form trigger with an existing Button/Select-style interaction contract                                                             | Use a semantic button/DS trigger and expose expanded state                               |
| `MainApp/WorkManagement/GitHubWorkItemsSurface.tsx:899,1011`             | multi-line row `<button>`     | keep with reason | The DS `Button` does not cover a full-width issue/PR row containing title, labels and metadata; both controls have explicit accessible names | Keep raw semantic button; factor the duplicated issue/PR row body when the file is split |
| `WorkStation/CodeEditor/SessionReplay/CodePanel/CombinedDiffView.tsx:69` | sticky diff header `<button>` | keep with reason | Sticky full-width, multi-column diff headers are outside the DS Button shape and match the workstation's established header pattern          | —                                                                                        |

## D2 — Arbitrary Tailwind Value vs Token

The current sweep found 30 project-var arbitrary-value hits.

| Line / group                                                                                                    | Value                                              | Verdict          | Reason                                                                                                 | Suggested change                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Message/index.tsx:89-103`, `SqlEditor/QueryResults.tsx:55-200`, `DataGrid/ActionBar.tsx:104-117`               | `text-[var(--color-*-6)]`, `bg-[var(--color-*-6)]` | fix              | These are project-owned semantic colors already represented by `text-success-6`, `text-danger-6`, etc. | Replace direct variable access with semantic Tailwind classes                                     |
| `ChatStatusBanners.tsx:16`                                                                                      | `bg-[var(--color-chat-container)]`                 | fix              | Project-owned surface token is consumed directly in a product component                                | Map/use a named surface class                                                                     |
| `SettingsTableAddFooter.tsx:32`                                                                                 | `bg-[var(--settings-table-surface)]`               | fix              | A DS component exposes a local CSS variable rather than a stable class-level token                     | Add a SettingsTable surface token/class or fold into the existing surface scale                   |
| 7 non-bridge files (`DiffFileSection`, `CombinedDiffView`, `PanelHeader`, simulator, status/work-item surfaces) | `bg-[var(--cm-editor-background…)]`                | abstract         | The same project-owned editor surface has escaped the bridge layer repeatedly                          | Add one `cm-editor` Tailwind color/surface mapping, then migrate all non-bridge hits in one sweep |
| `Button/index.tsx:239`, `Message/index.tsx:89-103`, `InsertRowModal.tsx:259`                                    | `color-mix(...)` focus/status backgrounds          | keep with reason | Computed alpha mixes are not equivalent to a single solid Tailwind color and live in DS/specialized UI | Optionally promote repeated mixes to named shadow/background utilities                            |
| `config/workstation/tokens.ts:13`                                                                               | CodeMirror bridge `--cm-editor-background`         | keep with reason | This is the intentional project/CodeMirror theme bridge                                                | —                                                                                                 |

## D3 — Hardcoded Sizes / Colors

The broad pixel-literal regex finds 2,153 values, dominated by typography/icon alignment and dynamic layout constants. Treating all of them as violations would be counterproductive. The confirmed raw-color groups are more actionable.

| Line / group                                                                              | Value                         | Verdict          | Reason                                                                                                             | Suggested change                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `LaunchButton.tsx:88-96`, `WorkspaceExplorePanelView.tsx:325`, `InputActions.tsx:193-199` | `text-[#fff]`                 | fix              | Literal white is already expressible as `text-white`; button foreground may deserve an `on-primary` semantic token | Replace with `text-white` or the shared on-accent token           |
| `AgentOrgs/components/org/config.ts:20-21`                                                | `#d97706`, `#10b981`          | fix              | Domain status/accent colors should not bypass the theme scale                                                      | Point the built-in agent mappings at named warning/success tokens |
| `UserChatItem.tsx:131`                                                                    | tooltip `bg-[#232325]`        | fix              | A normal product tooltip should follow theme surfaces                                                              | Use the existing tooltip/overlay surface token                    |
| `TrafficLights` and `ModeSelectionWindow`                                                 | macOS traffic-light palette   | keep with reason | These colors reproduce fixed platform chrome, not application theme semantics                                      | Centralize as named platform constants if desired                 |
| `DevPassport/*`                                                                           | paper/leather/dossier palette | keep with reason | This is an intentionally skeuomorphic isolated feature whose palette is outside normal app surfaces                | Optionally move literals to a local `devPassportTheme` object     |

## D4 — Accessibility Basics

The targeted sweep found 17 `<div>/<span onClick>` sites. Stop-propagation wrappers were separated from controls; the following are the confirmed behavior groups.

| Line / group                                                      | Element                                              | Verdict          | Reason                                                                                                          | Suggested change                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `UploadFileList.tsx:48,84`                                        | icon-only remove buttons                             | fix              | No visible text and no accessible name                                                                          | Add localized label; prefer `IconButton`                                                                       |
| `CollapseRow.tsx:31`, `GitHubDiff/DiffRow.tsx:236`                | clickable collapsed-diff rows                        | fix              | Mouse-only expand/collapse controls                                                                             | Render semantic buttons or add role, tabindex, Enter/Space handling, and expanded state                        |
| `ListPanelSidebar/index.tsx:269`, `VirtualizedSessionList.tsx:45` | clickable list rows                                  | fix              | Selection is unavailable from the keyboard                                                                      | Use listbox/option or semantic row buttons with selected state                                                 |
| `DebugJsonViewer/index.tsx:107`                                   | expandable JSON row                                  | fix              | Mouse-only tree expansion                                                                                       | Use treeitem semantics with keyboard expansion                                                                 |
| `SearchInput/index.tsx:208`, `DateRangeSelector/index.tsx:96`     | clickable form triggers                              | fix              | Neither is keyboard-reachable                                                                                   | Promote to semantic buttons and add `aria-expanded`                                                            |
| `Image/index.tsx:207-214`                                         | preview overlay plus clickable `X` SVG               | fix              | Modal close is mouse-only and the close icon is not a named control                                             | Reuse `ImagePreviewOverlay`/modal scaffold with focus management, Escape, and IconButton                       |
| `BrowseCard.tsx:91`                                               | clickable `role="group"` when a nested action exists | fix              | The whole-card action becomes mouse-only to avoid a nested button                                               | Provide keyboard handling and an explicit role/link target, or split the primary action from the nested action |
| Skills/MCP/GitHub stop-propagation wrappers                       | `<div>/<span onClick={stopPropagation}>`             | keep with reason | These wrappers do not invoke a user action; they prevent a parent row action around nested controls             | —                                                                                                              |
| `ComponentIssueModal/index.tsx:210`                               | click-away overlay                                   | keep with reason | The modal also has a close button and a document-level Escape handler                                           | Focus trapping remains a separate modal-quality improvement                                                    |
| `BaseFileSearchPanel.tsx:180`                                     | click-away backdrop                                  | keep with reason | A visible close button is rendered and the search panel owns focus                                              | Confirm Escape behavior in the shared panel contract                                                           |
| `SpotlightShellChrome.tsx:109`                                    | footer click refocuses input                         | keep with reason | This is a mouse convenience inside a keyboard-driven spotlight; it is not the only way to focus/use the control | —                                                                                                              |

## D5 — Visual Patterns Observed

| Pattern                                                        | Where                                                                                                                   |                             Count | Verdict  | Suggested change                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------: | -------- | -------------------------------------------------------------------------------------------------------------------- |
| Oversized product surfaces combining transport/state/rendering | `GitHubWorkItemsSurface` (2,356 LOC), `ChatHistory` (1,373), `RoutineWizard` (1,150), Session Creator ChatPanel (1,115) | 78 non-test TS/TSX files ≥600 LOC | abstract | Split each by state hook, transport adapter, and presentational sections; start with `GitHubWorkItemsSurface`        |
| Session replay shell/chrome                                    | Browser, CodeEditor, Diff, ProjectManager replay modules                                                                |                                4+ | abstract | Promote shared sidebar/tabs/placeholder/status chrome to `ReplayShell`; keep domain body slots                       |
| Click-away modal/backdrop + container + close action           | ComponentIssueModal, Image preview, file search, database dialogs, settings overlays                                    |                                3+ | abstract | Establish/reuse one accessible Dialog/Overlay scaffold with Escape, focus trap, labelled title and click-away policy |

## Summary

- **16 fix candidates** across adjudicated D1–D4 groups
- **10 keep-with-reason groups**
- **4 abstract candidates** (including the D2 editor-surface token sweep)

### Recommended UI cleanup order

1. Fix the DS-level accessibility defects in `UploadFileList`, `SearchInput`, and `Image`; they affect every consumer.
2. Repair the six mouse-only row/trigger groups and add keyboard-focused tests.
3. Add the `cm-editor` surface mapping and migrate all non-bridge hits together.
4. Replace normal-product raw colors (`#fff`, agent accents, tooltip surface); retain documented platform/skeuomorphic palettes.
5. Split `GitHubWorkItemsSurface` before adding more issue/PR behavior, then extract the shared replay and modal shells.
