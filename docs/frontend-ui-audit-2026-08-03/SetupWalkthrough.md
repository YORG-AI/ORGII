# Frontend UI Audit — SetupWalkthrough

**File:** `src/modules/SetupWalkthrough/index.tsx` (148 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element | Verdict          | Reason                                                                                                                    | Suggested change |
| ---- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —       | keep with reason | The route composes `OnboardingLayout`, `AppLogo`, and `SetupPreferencesPanel`; it introduces no raw interactive controls. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                               | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | The component references centralized setup layout tokens and adds no arbitrary Tailwind color value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                                                                     | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | Layout geometry is owned by `layoutTokens.ts`; the component contains no pixel-literal class or raw color. | —                |

## D4 — Accessibility

| Line | Element                                      | Verdict          | Reason                                                                                                                                                                               | Suggested change |
| ---- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 95   | Left preview / right preferences composition | keep with reason | The preview is supplied as complementary branded content, while all editable controls remain in the right preferences component with their existing localized names and focus order. | —                |

## D5 — Visual Patterns Observed

- Fixed onboarding preview/settings split: one implementation in `SetupWalkthrough`; no abstraction candidate.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
