# Runtime usage charts UI audit

## Scope

- `src/modules/shared/dataSource/TeamRuntimeToday.tsx`
- `src/modules/shared/dataSource/TeamMemberDetail.tsx`

The configured `frontend-ui-audit` skill file was unavailable, so this report
uses the repository's documented audit columns and manually checks design-system
reuse, arbitrary Tailwind values, accessibility, and duplicated visual patterns.

## Findings

| Line                       | Element                              | Verdict          | Reason                                                                                                                                                                                                               | Suggested change |
| -------------------------- | ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TeamRuntimeToday.tsx:258` | Rolling usage chart section          | keep with reason | Reuses the existing lazy-loaded `UsageTrendChart`, shared section heading classes, semantic color tokens, and existing localized range/title strings. The standard `h-72` fallback adds no arbitrary Tailwind value. | None.            |
| `TeamRuntimeToday.tsx:284` | Per-member usage breakdown           | keep with reason | Reuses `SectionContainer`, `Avatar`, existing typography/border/fill tokens, and native buttons. `aria-pressed` exposes the selected member filter to assistive technology.                                          | None.            |
| `TeamMemberDetail.tsx:315` | Source filter visibility in 24h mode | keep with reason | Reuses the existing `TabPill`; hiding it for the all-source hourly snapshot prevents a control from implying unsupported per-source hourly data.                                                                     | None.            |
| `TeamMemberDetail.tsx:336` | Usage range selector                 | keep with reason | Reuses the shared `Select` and existing localized `24h` label, keeps the default daily controls intact, and adds a stable test id without introducing a parallel range component.                                    | None.            |

## Summary

- fix: 0
- keep with reason: 4
- abstract: 0
- systematic sweep candidates: 0
