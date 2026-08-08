# Frontend UI Audit — SetupWalkthroughPreferences

**Files:** `src/modules/SetupWalkthrough/index.tsx`, `src/modules/SetupWalkthrough/components/SetupPreferencesPanel.tsx`, `src/modules/SetupWalkthrough/components/SetupWalkthroughSidebar.tsx`
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                         | Verdict          | Reason                                                                                                                                                                                       | Suggested change |
| ---- | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Preference controls and actions | keep with reason | The surface composes `LanguageSelector`, `Select`, `PanelFooter`, `SectionContainer`, `SectionRow`, `WizardStepContent`, and `OnboardingLayout`; no raw interactive controls are introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                             | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------ | ---------------- |
| —    | —     | keep with reason | No arbitrary color or CSS-variable Tailwind values are introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value         | Verdict          | Reason                                                                                                                                          | Suggested change |
| ---- | ------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Control width | keep with reason | Controls use the canonical `SECTION_CONTROL_STYLE`; shell sizing comes from `SETUP_WALKTHROUGH_LAYOUT_TOKENS` and shared window/sidebar tokens. | —                |

## D4 — Accessibility

| Line | Element                              | Verdict          | Reason                                                                                                                                                                  | Suggested change |
| ---- | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Preference fields and footer actions | keep with reason | Accessible interaction semantics are owned by the reused `Select`, `LanguageSelector`, and `PanelFooter` components; no clickable non-semantic elements are introduced. | —                |

## D5 — Visual Patterns Observed

- The preference rows reuse the same appearance settings state and Section Layout composition as the main Settings surface.
- The compact sidebar reuses the existing application logo and setup shell, while making progress/navigation optional instead of creating a second sidebar component.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
