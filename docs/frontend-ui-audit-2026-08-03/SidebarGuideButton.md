# Frontend UI Audit — SidebarGuideButton

**File:** `src/scaffold/NavigationSidebar/connectors/SidebarGuideButton.tsx` (313 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element               | Verdict          | Reason                                                                                           | Suggested change |
| ---- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------ | ---------------- |
| 222  | Guide `DropdownPanel` | keep with reason | The guide remains on the shared floating-panel primitive and now contains only product guidance. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value             | Verdict          | Reason                                                       | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------ | ---------------- |
| —    | None in migration | keep with reason | Removing the embedded test controls adds no Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value             | Verdict          | Reason                                                        | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------- | ---------------- |
| —    | None in migration | keep with reason | Removing the embedded test controls adds no visual constants. | —                |

## D4 — Accessibility

| Line | Element       | Verdict          | Reason                                                                                                              | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 222  | Guide surface | keep with reason | Existing menu naming, focus capture, and close behavior remain unchanged after the development section was removed. | —                |

## D5 — Visual Patterns Observed

- Pattern: product guidance and developer tooling now use separate triggers and surfaces instead of competing within one dropdown hierarchy.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
