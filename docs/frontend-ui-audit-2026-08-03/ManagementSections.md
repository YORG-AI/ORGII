# Frontend UI Audit — ManagementSections

**File:** `src/engines/ChatPanel/panels/CloudOrgPanelView/ManagementSections.tsx` (671 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                        | Verdict          | Reason                                                                                                                                                                                         | Suggested change |
| ---- | ---------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 316  | `<div data-guide-target>` around invite action | keep with reason | The wrapper is layout-neutral instrumentation around the existing design-system `SectionRow` and `Button`; neither component exposes a guide-target slot that covers the whole actionable row. | —                |
| 250  | Disabled invite/member controls                | keep with reason | Existing `Button` and `Select` primitives expose the read-only state consistently; handler guards provide defense in depth without adding parallel UI.                                         | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                                                     | Suggested change |
| ---- | ----------------------- | ---------------- | ---------------------------------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | The guide target and read-only mode add no Tailwind value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                                                             | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------ | ---------------- |
| —    | None in changed surface | keep with reason | The guide target and read-only mode add no size or color constant. | —                |

## D4 — Accessibility

| Line | Element                       | Verdict          | Reason                                                                                                                   | Suggested change |
| ---- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 316  | Non-interactive guide wrapper | keep with reason | The wrapper has no role or event handler; focus and accessible naming remain owned by the nested design-system button.   | —                |
| 250  | Read-only mutation controls   | keep with reason | Native disabled state removes mutation controls from interaction while retaining visible labels for scenario inspection. | —                |

## D5 — Visual Patterns Observed

- Pattern: tutorial instrumentation wraps existing semantic controls, and the developer simulation composes their established disabled contract.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
