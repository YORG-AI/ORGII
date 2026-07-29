# Frontend UI Audit — TeamInboxView

**File:** `src/modules/MainApp/TeamInbox/TeamInboxView.tsx` (436 LOC)

**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                             | Verdict          | Reason                                                                                                                                                         | Suggested change                                               |
| ---- | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 368  | retained-data `<div role="status">` | keep with reason | This is a non-interactive, flow-layout status banner; the shared `Placeholder` replaces content and does not model a non-blocking retained-data warning/error. | Keep until a shared full-width status-banner primitive exists. |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                                  | Suggested change |
| ---- | ----- | ------- | ----------------------------------------------------------------------- | ---------------- |
| —    | —     | —       | No arbitrary color or CSS-variable Tailwind value appears in this file. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value                          | Verdict          | Reason                                                                                                                                | Suggested change |
| ------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 381–383 | `280 / 220 / 360` split widths | keep with reason | The range preserves readable three-tab labels and compact row metadata while remaining resizable/collapsible for constrained windows. | —                |

## D4 — Accessibility

| Line    | Element              | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------- | -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 366–378 | retained-data status | keep with reason | It exposes a live semantic status, distinguishes partial warning from total error, and uses tokenized colors without covering content. | —                |

## D5 — Visual Patterns Observed

- The layout, loading/empty/error surfaces and detail shell use shared components.
- The retained-data banner and Work Item inline update error have different layout duties; no third duplicate full-width pattern exists.

## Summary

- 0 fixes recommended
- 3 kept with documented reason
- 0 abstract candidates
