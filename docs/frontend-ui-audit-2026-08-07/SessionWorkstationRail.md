# Frontend UI Audit — Session Workstation Rail

**Files:** `src/engines/ChatPanel/components/SessionWorkstationRail.tsx`, `src/modules/shared/layouts/FocusedChatWorkstationRail.tsx`, `src/engines/ChatPanel/ChatPanelContent.tsx`
**Date:** 2026-08-07
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                 | Element                                          | Verdict          | Reason                                                                                                                                                                                                                | Suggested change |
| ------------------------------------ | ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FocusedChatWorkstationRail.tsx:191` | Static context row and conditional action button | keep with reason | The rail already uses semantic native row buttons for full-width navigation. A static `div` remains non-interactive; the work-item variant becomes a keyboard-accessible `button` matching the adjacent rail pattern. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value      | Verdict          | Reason                                                                                                              | Suggested change |
| ---- | ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | None added | keep with reason | The move reuses the rail's existing row sizing and typography classes; it introduces no new arbitrary layout value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                 | Value                       | Verdict          | Reason                                                                                                                             | Suggested change |
| ------------------------------------ | --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FocusedChatWorkstationRail.tsx:462` | `FolderKanban` context icon | keep with reason | The icon inherits the existing `WorkspaceContextRow` size, stroke, and text color instead of defining a parallel visual treatment. | —                |

## D4 — Accessibility

| Line                                 | Element                  | Verdict          | Reason                                                                                                                                                 | Suggested change |
| ------------------------------------ | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `FocusedChatWorkstationRail.tsx:219` | Work-item context action | keep with reason | Uses `type="button"`, retains a full label/title, closes the compact menu before navigation, and exposes `menuitem` semantics inside the compact menu. | —                |

## D5 — Visual Patterns Observed

- Pattern: repository, branch/worktree, and active work-item context now share the existing Workstation environment rail rather than creating a second transcript header row.
- Pattern: narrow layouts reuse the rail's existing compact Environment menu; wide focused layouts use the same context-row component.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
