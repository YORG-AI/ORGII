# Frontend UI Audit — WorkItemHandoffNotice

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemContent/WorkItemHandoffNotice.tsx` (157 LOC)
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                              | Verdict          | Reason                                                                                                                                    | Suggested change |
| ------ | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 59–156 | Handoff status and response controls | keep with reason | Accept/Return use the design-system `Button`; the reason uses `Modal` and `Textarea`; raw elements are semantic section/text/layout only. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line   | Value                            | Verdict          | Reason                                                                                                            | Suggested change |
| ------ | -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| 61–151 | Notice and modal utility classes | keep with reason | Surfaces, borders, state colors, text colors, spacing, and radii use project tokens and standard Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line       | Value                | Verdict          | Reason                                                                                        | Suggested change |
| ---------- | -------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| 33–38, 100 | Lucide sizes `14–16` | keep with reason | Icon API micro-sizing follows the existing compact action convention.                         | —                |
| 116        | Modal width `460`    | keep with reason | Width is expressed through the shared modal API and keeps a short return-reason task focused. | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                                         | Suggested change |
| ------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 59–111  | Status notice and actions | keep with reason | The section has a localized accessible label, visible action names, decorative icons, an alert error, and mutually disabled in-flight actions. | —                |
| 113–152 | Return dialog             | keep with reason | Empty reasons cannot submit; escape/mask close are disabled during mutation; textarea length and visible hint bound the response.              | —                |

## D5 — Visual Patterns Observed

- Pattern: canonical handoff status/decision surface — extracted once and reused by Team Inbox detail and formal Work Item detail through `WorkItemContent`.
- Pattern: destructive/negative decision with required rationale — one domain instance, below the shared-component threshold.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
