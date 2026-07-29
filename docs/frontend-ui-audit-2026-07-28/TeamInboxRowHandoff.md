# Frontend UI Audit — TeamInboxRow Handoff Projection

**File:** `src/modules/MainApp/TeamInbox/components/TeamInboxRow.tsx` (150 LOC)
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                    | Verdict          | Reason                                                                                                                                                                                   | Suggested change |
| ------ | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 90–145 | Raw `<button>` list option | keep with reason | The row implements `role="option"`, roving `tabIndex`, full-width multi-line layout, and shared `ListPanel` state classes; the generic DS Button does not model listbox-option behavior. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value               | Verdict          | Reason                                                                                                                                           | Suggested change |
| ------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 105–140 | Row utility classes | keep with reason | All colors and dimensions use the design token and spacing scales; no arbitrary CSS variables, raw colors, or bracketed pixel sizes are present. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value            | Verdict          | Reason                                                            | Suggested change |
| ---- | ---------------- | ---------------- | ----------------------------------------------------------------- | ---------------- |
| 113  | Lucide size `14` | keep with reason | The icon API size matches the established compact Inbox row grid. | —                |

## D4 — Accessibility

| Line   | Element      | Verdict          | Reason                                                                                                                                             | Suggested change |
| ------ | ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 90–106 | Inbox option | keep with reason | It is keyboard-focusable through listbox roving focus, exposes selected/read state in its localized label, and preserves native button activation. | —                |

## D5 — Visual Patterns Observed

- Pattern: compact Inbox list option — already centralized through `getListItemClasses`; handoff changes only its data projection.
- Pattern: Markdown-to-plain compact preview — one Team Inbox helper, below the abstraction threshold.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
