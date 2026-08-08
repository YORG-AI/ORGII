# Frontend UI Audit — OnboardingTestModule

**File:** `src/scaffold/DeveloperTestPanel/modules/OnboardingTestModule.tsx` (87 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                | Verdict          | Reason                                                                                                        | Suggested change |
| ---- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| 47   | Group/layout wrappers  | keep with reason | Non-interactive wrappers provide grouping and spacing; every scenario action uses the design-system `Button`. | —                |
| 63   | Scenario `Button` list | keep with reason | Native button semantics expose selection and disabled states while sharing product sizing and variants.       | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                        | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | The module uses the established spacing and typography scale. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                                 | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | All visual states use semantic design-system variants or theme tokens. | —                |

## D4 — Accessibility

| Line | Element          | Verdict          | Reason                                                                                                      | Suggested change |
| ---- | ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| 47   | Scenario group   | keep with reason | The group has a localized accessible name and explanatory copy remains visible.                             | —                |
| 63   | Scenario choices | keep with reason | Native buttons expose `aria-pressed`; unavailable role cases use disabled semantics and a localized reason. | —                |

## D5 — Visual Patterns Observed

- Pattern: scenario modules follow a description → mutually exclusive full-width actions → dependency warning structure; future repetitions should use the panel registry before considering another abstraction.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
