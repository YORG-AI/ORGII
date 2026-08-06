# Frontend UI Audit — Dropdown Default Alignment

**File:** `src/components/Dropdown/index.tsx` (482 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                           | Verdict          | Reason                                                                                                                                                                                   | Suggested change |
| ------- | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 452–478 | Dropdown trigger and menu surface | keep with reason | This is the design-system primitive itself; it delegates semantics and layout to `DropdownTriggerWrapper` and `DropdownMenuSurface` rather than duplicating a consumer-side raw control. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                | Verdict          | Reason                                                                                                            | Suggested change |
| ---- | -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| 147  | `bottom-end` default | keep with reason | Placement is a typed semantic option resolved by the dropdown positioning layer, not an arbitrary Tailwind value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                  | Verdict          | Reason                                                                                               | Suggested change |
| ---- | ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| 147  | Default placement only | keep with reason | The change introduces no pixel literals or colors; panel dimensions remain owned by dropdown tokens. | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                              | Suggested change |
| ------- | ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 452–478 | Trigger/menu relationship | keep with reason | Changing horizontal placement does not alter keyboard handling, visibility state, focus behavior, or the trigger's accessible name. | —                |

## D5 — Visual Patterns Observed

- Pattern: the shared default now matches right-edge toolbar actions, while callers with layout-specific requirements retain explicit typed placement.
- Compatibility sweep: all 27 production `<Dropdown>` instances on `develop` explicitly pass `position`; the new default therefore does not silently move an existing menu.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
