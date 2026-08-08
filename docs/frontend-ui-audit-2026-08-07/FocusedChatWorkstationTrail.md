# Frontend UI Audit — Focused Chat Workstation Trail

**File:** `src/modules/shared/layouts/FocusedChatWorkstationRail.tsx`
**Date:** 2026-08-07
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                     | Element                            | Verdict          | Reason                                                                                                                                                                                | Suggested change                                                                                 |
| ---------------------------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `FocusedChatWorkstationRail.tsx:432–484` | Section row stack                  | fix              | Repository, branch, work-item, and action rows were split across two layout-only group wrappers. The section can own their common vertical spacing and render every row as a sibling. | Remove the context-group and item-group wrappers; keep one section wrapper per semantic section. |
| `FocusedChatWorkstationRail.tsx:810–819` | Width track and elevated container | keep with reason | The outer track owns responsive width and the minimap sibling, while the inner `aside` owns the visible elevated landmark. They have separate layout and semantic responsibilities.   | —                                                                                                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                 | Value                                          | Verdict          | Reason                                                                                                                                                      | Suggested change                                                 |
| ------------------------------------ | ---------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `FocusedChatWorkstationRail.tsx:429` | Expanded-only section padding                  | fix              | Expanded mode added `px-1 pb-1` inside the panel while icon-only mode relied directly on the panel padding, producing different container insets.           | Let the elevated panel's `p-1` own docked padding in both modes. |
| `FocusedChatWorkstationRail.tsx:818` | Existing rail sizes and `@[1100px]` breakpoint | keep with reason | The cleanup preserves the established fixed track sizes, responsive breakpoint, row sizing, and collapsed controls; it does not introduce a parallel value. | —                                                                |

## D3 — Hardcoded Sizes / Colors

| Line                                 | Value                                     | Verdict          | Reason                                                                                                                                                                                    | Suggested change |
| ------------------------------------ | ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FocusedChatWorkstationRail.tsx:818` | Docked panel surface and shadow           | keep with reason | The docked trail remains a single elevated container and consumes the shared `shadow-dropdown` token instead of defining another shadow value.                                            | —                |
| `FocusedChatWorkstationRail.tsx:765` | Compact dropdown panel surface and shadow | keep with reason | The narrow-layout trail floats above content, so its shared dropdown background, border, radius, and shadow still communicate elevation and preserve separation from the chat beneath it. | —                |

## D4 — Accessibility

| Line                                 | Element                                   | Verdict          | Reason                                                                                                                                         | Suggested change |
| ------------------------------------ | ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FocusedChatWorkstationRail.tsx:816` | Environment landmark and collapse control | keep with reason | The elevated `aside` retains the localized accessible name; collapse and row buttons keep their labels, expanded state, and keyboard behavior. | —                |

## D5 — Visual Patterns Observed

- Pattern: docked and compact trails both keep an elevated panel surface and the shared dropdown shadow.
- Pattern: the rail keeps one structural width/minimap track around one semantic visual container.
- Pattern: context and action rows share one section-level spacing stack without internal grouping wrappers.
- Pattern: expanded and icon-only docked modes share the elevated panel's single padding boundary.

## Summary

- 2 fixes applied
- 5 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
