# Frontend UI Audit — Session Handoff Entry Points

**Files:** `src/engines/ChatPanel/ChatPanelTabContextMenu.tsx`, `src/modules/WorkStation/shared/TabBar/TabContextMenu.tsx`, `src/modules/MainApp/TeamInbox/components/TeamInboxSessionDropSurface.tsx`
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                             | Element                        | Verdict          | Reason                                                                                                                                                           | Suggested change |
| -------------------------------- | ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Context-menu action construction | Native Session action          | keep with reason | Both tab surfaces already use the Tauri native menu API; the new action extends that shared platform pattern and forwards into the existing Team Inbox composer. | —                |
| Drop surface result controls     | Review / retry / open controls | keep with reason | Actions continue to use the existing `Button` and `SessionHandoffComposer` primitives; the request atom adds no parallel visual implementation.                  | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                           | Value           | Verdict          | Reason                                                                                                                          | Suggested change |
| ------------------------------ | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Team Inbox overlay and notices | Utility classes | keep with reason | Existing semantic color, spacing, border, and typography tokens remain unchanged; the alternative entry adds no styling values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                  | Value | Verdict          | Reason                                                                                                     | Suggested change |
| --------------------- | ----- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| Entry-point additions | None  | keep with reason | The context-menu route adds behavior only and introduces no sizes, raw colors, or one-off visual geometry. | —                |

## D4 — Accessibility

| Line                         | Element                  | Verdict          | Reason                                                                                                                                                                                              | Suggested change |
| ---------------------------- | ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Session native context menus | `Create team Work Item…` | keep with reason | The native menu is reachable through pointer context-menu and the platform keyboard context-menu gesture, while the resulting composer keeps its labeled controls, focus trap, and alert semantics. | —                |

## D5 — Visual Patterns Observed

- Pattern: two Session tab hosts expose one identically named native action.
- Pattern: drag and menu activation converge on one persisted request boundary and one review composer.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (the native menu hosts intentionally remain platform-owned)
