# Frontend UI Audit — WorkstationSidebarConnector

**File:** `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/index.tsx` (716 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                        | Verdict          | Reason                                                                          | Suggested change |
| ---- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------- | ---------------- |
| 640  | Sidebar header wrapper `<div>` | keep with reason | Layout-only wrapper around the existing organization selector and layer header. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                            | Suggested change |
| ---- | ----- | ---------------- | ----------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | The connector delegates rendering to sidebar blocks and variants. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                     | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------ | ---------------- |
| —    | None  | keep with reason | No local visual constants were introduced. | —                |

## D4 — Accessibility

| Line    | Element                        | Verdict          | Reason                                                                                                   | Suggested change |
| ------- | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| 648–692 | Navigation/sidebar composition | keep with reason | Accessible names and interaction semantics remain owned by shared sidebar, search, and guide components. | —                |

## D5 — Visual Patterns Observed

- No visual pattern is implemented locally; this file remains a state/navigation coordinator.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
