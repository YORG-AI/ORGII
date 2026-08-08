# Frontend UI Audit — SetupWalkthrough

**File:** `src/modules/SetupWalkthrough/index.tsx` (174 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                                  | Verdict          | Reason                                                                                                                                                           | Suggested change |
| ------ | ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 97–141 | Layout `<div>` / brand `<span>` wrappers | keep with reason | Non-interactive composition around `OnboardingLayout`, `AppLogo`, `SetupPreferencesPanel`, and the isolated mascot hero; no design-system control is duplicated. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                  | Suggested change |
| ---- | ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | Visible layout classes are owned by `SETUP_WALKTHROUGH_LAYOUT_TOKENS`; the component adds no arbitrary Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value                   | Verdict          | Reason                                                                                                                  | Suggested change |
| ------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 99, 133 | `AppLogo` sizes 36 / 28 | keep with reason | The shared logo API requires numeric pixel sizes; these distinguish desktop brand and constrained-width fallback roles. | —                |

## D4 — Accessibility

| Line            | Element                                      | Verdict          | Reason                                                                                                      | Suggested change |
| --------------- | -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| 98–105, 132–136 | Decorative logos beside visible `ORGII` text | keep with reason | Empty alt text prevents duplicate brand announcements.                                                      | —                |
| 114–124         | Translated hero title accent                 | keep with reason | The accent is text inside the sidebar’s labelled heading and does not create a separate interactive target. | —                |

## D5 — Visual Patterns Observed

- Compact and mascot presentations share one controlled `SetupPreferencesPanel`; no duplicate control implementation was introduced.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
