# Frontend UI Audit — CloudOrgPanelView

**File:** `src/engines/ChatPanel/panels/CloudOrgPanelView/index.tsx` (269 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                          | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ---- | ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Navigation-request state change                  | keep with reason | The request state continues to use the established header, section, and scroll-container components.                                                          | —                |
| 167  | `<div data-guide-target>` around members content | keep with reason | The wrapper is layout-neutral instrumentation that covers both populated and empty member states; neither section variant exposes a shared guide-target slot. | —                |
| 219  | Simulation notice sections                       | keep with reason | Uses established `SectionContainer` and `SectionRow` primitives so the read-only warning follows the management panel's visual hierarchy.                     | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                                                             | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------ | ---------------- |
| —    | None in changed surface | keep with reason | The navigation and simulation presentation add no Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                                                              | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | The navigation and simulation presentation add no visual constants. | —                |

## D4 — Accessibility

| Line | Element                               | Verdict          | Reason                                                                                                                                                         | Suggested change |
| ---- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 112  | `CloudOrgPanelHeader` tab selection   | keep with reason | Programmatic guide navigation feeds the same controlled tab API used by user interaction, preserving the header's established semantics and keyboard behavior. | —                |
| 167  | Non-interactive members guide wrapper | keep with reason | The wrapper has no role or event handler; member controls retain their existing semantics while read-only users receive a visual explanation.                  | —                |
| 219  | Read-only simulation notice           | keep with reason | Localized section copy announces that displayed permissions are simulated and real organization actions are disabled.                                          | —                |

## D5 — Visual Patterns Observed

- Pattern: explicit open requests reuse the existing controlled organization-management tab surface; simulated roles reuse the same members and invite sections in a read-only mode.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
