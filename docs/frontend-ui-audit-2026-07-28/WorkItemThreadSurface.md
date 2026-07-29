# Frontend UI Audit — Work Item Thread Surface

**Files:**

- `src/modules/ProjectManager/WorkItems/components/WorkItemThreadSurface/index.tsx` (58 LOC)
- `src/engines/ChatPanel/panels/WorkItemPanelView.tsx` (thread composition)
- `src/modules/MainApp/TeamInbox/components/AssignedWorkItemDetail.tsx` (thread composition)

**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line          | Element                        | Verdict          | Reason                                                                                                                                                                                                                   | Suggested change                     |
| ------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Surface 36–53 | Work Item metadata and content | abstract         | Team Inbox and the formal Work Item page previously selected presentation and properties independently. `WorkItemThreadSurface` now composes the existing design-system `WorkItemProperties` and `WorkItemContent` once. | Landed as the shared thread surface. |
| Panel 395–410 | delete toolbar action          | keep with reason | It uses the shared `Button` and `WorkstationToolbarTooltip`; the wrapper only owns toolbar grouping.                                                                                                                     | —                                    |
| Inbox 56–117  | degraded-state wrapper         | keep with reason | It owns Inbox-specific context/update warnings and navigation intent, which do not belong in the reusable Work Item surface.                                                                                             | —                                    |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                          | Suggested change |
| ---- | ----- | ------- | --------------------------------------------------------------- | ---------------- |
| —    | —     | —       | The new shared surface introduces no arbitrary Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason                                                                                     | Suggested change |
| ---- | ----- | ------- | ------------------------------------------------------------------------------------------ | ---------------- |
| —    | —     | —       | The shared surface delegates sizing and color to existing Work Item components and tokens. | —                |

## D4 — Accessibility

| Line          | Element           | Verdict          | Reason                                                                                                                                    | Suggested change |
| ------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Surface 36–53 | property controls | keep with reason | Existing Work Item property controls retain their names, keyboard behavior and popup semantics; the abstraction changes composition only. | —                |
| Panel 395–410 | delete action     | keep with reason | The icon-only action retains a localized accessible name and tooltip.                                                                     | —                |

## D5 — Visual Patterns Observed

- Both entry points now use the same ordered property pills, wrapping policy, primary task hierarchy and Discussion drill-in action.
- The formal page no longer adds a second Properties rail or the legacy Preview/Raw and Agent/Output/History presentation around the shared content.
- Navigation-specific chrome remains outside the shared surface: Inbox owns read/open actions; the formal page owns breadcrumb, delete and linked-session overlay.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 1 abstract candidate, completed
