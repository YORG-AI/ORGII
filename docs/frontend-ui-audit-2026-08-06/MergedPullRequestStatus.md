# Frontend UI Audit — Merged Pull Request Status

**Files:** `src/components/Button/index.tsx`, `src/shared/pr/prStatus.ts`, `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel.tsx`, `src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/gitIndicator.tsx`
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line | Element       | Verdict          | Reason                                                                                                              | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Merged action | keep with reason | Callers continue to use the shared `Button` and PR-status primitives; no new raw interactive element is introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line               | Value                               | Verdict          | Reason                                                                                                                               | Suggested change |
| ------------------ | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `Button/index.tsx` | `bg-merged`, `text-merged-contrast` | keep with reason | The semantic button colors are mapped through Tailwind to theme-owned CSS variables, including hover, active, and foreground tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                 | Value                                 | Verdict          | Reason                                                                                                                | Suggested change |
| -------------------- | ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `public/orgii_*.css` | Purple scale and merged-button colors | keep with reason | Hex values live only in the canonical theme definitions; component code consumes semantic tokens instead of literals. | —                |

## D4 — Accessibility

| Line               | Element                      | Verdict | Reason                                                                                                                                                                                                            | Suggested change                                                           |
| ------------------ | ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Button/index.tsx` | Solid merged button contrast | fix     | White text on the original dark/high-contrast `purple-6` backgrounds measured 3.35:1 and 1.77:1. Theme-specific merged foreground/background tokens now keep every normal, hover, and active pairing above 4.5:1. | Retain the semantic foreground token whenever merged button colors change. |

## D5 — Visual Patterns Observed

- Badge, dot, text, sidebar indicator, and action-button colors remain owned by the shared PR-status/Button boundaries; no third independent status map is introduced.

## Summary

- 1 fix recommended and applied
- 3 kept with documented reason
- 0 abstract candidates
