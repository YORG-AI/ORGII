# Frontend UI Audit — PlanTodoPill

**File:** `src/engines/ChatPanel/InputArea/components/PlanTodoPill.tsx` (210 LOC)
**Date:** 2026-07-21
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line | Element                | Verdict          | Reason                                                                                                    | Suggested change        |
| ---- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- | ----------------------- |
| 118  | Todo pill trigger      | keep with reason | Already uses the design-system `Button`; its compact outlined pill shape is covered by existing variants. | —                       |
| 138  | Todo popover container | fix              | The hand-built panel duplicated the shared dropdown surface and theme-aware shadow behavior.              | Reuse `DropdownPanel`.  |
| 147  | Todo popover header    | fix              | The hand-built header duplicated the shared dropdown header spacing, separator, and layout.               | Reuse `DropdownHeader`. |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                      | Suggested change |
| ---- | ----- | ---------------- | --------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No arbitrary color or CSS-variable Tailwind values remain in the component. | —                |

## D3 — Hardcoded Sizes / Colors

| Line               | Value                             | Verdict          | Reason                                                                                                                                    | Suggested change |
| ------------------ | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 143                | Responsive `min()` panel width    | keep with reason | This is viewport clamping, not a fixed design-token size; the shared panel accepts caller-owned width constraints.                        | —                |
| 144                | Responsive `min()` maximum height | keep with reason | The Todo list needs a viewport-aware scroll ceiling rather than the standard menu maximum. It is now passed through the shared panel API. | —                |
| 153, 156, 185, 190 | 10–12px text sizes                | keep with reason | These are existing compact metadata/list typography values; changing visual density was outside this behavior-preserving refactor.        | —                |

## D4 — Accessibility

| Line    | Element      | Verdict          | Reason                                                                                                                 | Suggested change |
| ------- | ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 118–130 | Todo trigger | keep with reason | Uses a semantic DS button with an accessible label plus `aria-expanded` and `aria-controls`.                           | —                |
| 138–145 | Todo panel   | keep with reason | Retains `role="region"`, the batch-title accessible name, stable control ID, and dropdown-engine focus/close behavior. | —                |

## D5 — Visual Patterns Observed

- Dropdown surface and header duplication matched existing shared primitives and has been replaced with `DropdownPanel` and `DropdownHeader`.
- Todo rows remain domain-specific, non-interactive checklist content; forcing them through `DropdownItem` would give them incorrect option semantics.

## Related Dropdown Surface Sweep

A repository-wide follow-up checked direct uses of `DROPDOWN_CLASSES.panel`, `panelAnimated`, and `menuPanelBase`, plus `useDropdownEngine` / `createPortal` combinations.

### Migrated to `DropdownPanel`

- `src/modules/MainApp/AgentOrgs/config/shared/SubAgentsEditor.tsx`
- `src/scaffold/NavigationSidebar/connectors/SessionFilterButton.tsx`
- `src/modules/WorkStation/shared/TerminalNewSessionSplitButton.tsx`
- `src/features/TaskKanban/components/DiaryPanel/DiaryCommitDropdowns.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/SourceControlMoreMenu.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/WorktreeActionsMenu.tsx` (trigger menu and context menu)
- `src/engines/ChatPanel/ChatHistory/components/TurnPaginationControls.tsx`
- `src/features/SessionCreator/variants/ChatPanel/WorkItemAttachmentControl.tsx`

The migrations explicitly preserve the former animation and maximum-height behavior rather than accepting new `DropdownPanel` defaults accidentally.

### Remaining Classified Exceptions

- Dropdown infrastructure and wrappers (`Select`, `PropertyField`, `InlineDropdown`, `ContextDropdown`, `TabPill`) retain token-level surfaces because they implement or host the dropdown primitive itself.
- Complex managed overlays (Global Spotlight palettes, ContextMenu, Slash Command menu/flyout) retain their own measurement, keyboard, submenu, or layered-portal contracts.
- Tooltip/detail surfaces (`TaskTooltip`, `ConversationMinimap`, editor/status detail panels) use the surface appearance without dropdown menu semantics.
- Existing domain-level menu composites (`menuPanelBase` / `menuPanelWithHeaderBase`) remain token consumers pending a separate menu-composite API migration; they are consistent surfaces rather than hand-written color/border/shadow duplication.

## Summary

- 10 source surfaces migrated in this batch (Todo plus 9 related surfaces)
- Remaining direct token uses classified as infrastructure, complex-overlay, tooltip/detail, or domain-menu exceptions
- 0 unclassified hits in the audited issue class
