# Frontend UI Audit — Team Member Usage Range

**File:** `src/modules/shared/dataSource/TeamMemberDetail.tsx` (396 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                   | Verdict          | Reason                                                                                                                | Suggested change |
| ------- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 291–340 | Source and range controls | keep with reason | The flow reuses the project `TabPill` and `Select`; the separator is decorative and hidden from assistive technology. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value          | Verdict          | Reason                                                                                                              | Suggested change |
| ------- | -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 291–340 | Usage controls | keep with reason | Control spacing, border, and text styling use standard utilities and semantic tokens; no arbitrary color was added. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value                | Verdict          | Reason                                                                                                          | Suggested change |
| ------- | -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| 315–321 | `h-4 w-px` separator | keep with reason | The geometry uses project scale utilities and only separates the existing source pills from the range selector. | —                |

## D4 — Accessibility

| Line    | Element                | Verdict          | Reason                                                                                                                                                                                                    | Suggested change |
| ------- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 291–340 | Range/source selection | keep with reason | Both controls retain their design-system keyboard behavior and visible selected labels; the unsupported source selector is removed entirely in hourly mode instead of being shown disabled or misleading. | —                |

## D5 — Visual Patterns Observed

- Pattern: the drilldown extends the existing range selector with a typed `24h` option and keeps daily-source filtering on the established `TabPill` surface.
- Pattern: empty, loading, and chart states remain the existing shared placeholders and chart component for both hourly and daily ranges.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
