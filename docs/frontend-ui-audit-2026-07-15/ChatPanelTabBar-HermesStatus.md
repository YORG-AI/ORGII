# Frontend UI Audit — ChatPanelTabBar Hermes Status

**File:** `src/engines/ChatPanel/ChatPanelTabBar.tsx` (status change at lines 121–129, 225–230, 252–258)  
**Date:** 2026-07-15  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element         | Verdict          | Reason                                                                                                                                                           | Suggested change |
| ------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 225–230 | status `<span>` | keep with reason | The span is a non-interactive indicator inside the existing `WorkStationTabPillSurface`; using a Button/Badge control would add incorrect interaction semantics. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value              | Verdict          | Reason                                                                                                                                               | Suggested change |
| ---- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 229  | status color class | keep with reason | Status classes resolve through the typed presentation map to semantic `warning`, `success`, `danger`, and fill tokens; no arbitrary color was added. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                    | Verdict          | Reason                                                                                                     | Suggested change |
| ---- | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| 229  | `h-1.5 w-1.5` status dot | keep with reason | This preserves the existing compact tab-status indicator scale; only the blocked semantic color was added. | —                |

## D4 — Accessibility

| Line    | Element            | Verdict          | Reason                                                                                                                                                       | Suggested change |
| ------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 225–230 | colored status dot | keep with reason | `role="status"` and a localized accessible label expose the state without relying on color; the tab remains a keyboard-selectable design-system tab control. | —                |

## D5 — Visual Patterns Observed

- Pattern: compact tab status plus hover details — terminal tabs now follow the session-tab hover-card pattern already present in the same tab bar.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates

## Next-refactor candidates

- None for this two-file status treatment. Keep future CLI-agent state colors in `TERMINAL_AGENT_STATUS_PRESENTATION` rather than branching inside the tab bar.
