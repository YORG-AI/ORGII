# Frontend UI Audit — SetupWalkthrough

**File:** `src/modules/SetupWalkthrough/index.tsx` (135 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                             | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ------ | ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 97–113 | Layout-only `div` / `span` wrappers | keep with reason | These wrappers provide responsive composition around `OnboardingLayout`, `AppLogo`, and `SetupPreferencesPanel`; no interactive DS primitive is duplicated. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                              | Verdict          | Reason                                                       | Suggested change |
| ---- | -------------------------------------------------- | ---------------- | ------------------------------------------------------------ | ---------------- |
| —    | No arbitrary Tailwind color or CSS-variable values | keep with reason | Styling is routed through `SETUP_WALKTHROUGH_LAYOUT_TOKENS`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value               | Verdict          | Reason                                                                                                                 | Suggested change |
| ---- | ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 99   | `AppLogo size={28}` | keep with reason | Uses the canonical logo component API; 28px is the compact-header asset size rather than a duplicated layout constant. | —                |

## D4 — Accessibility

| Line    | Element              | Verdict          | Reason                                                                                                        | Suggested change |
| ------- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| 78–93   | Localized hero title | keep with reason | The title is rendered as the sidebar's labelled `h1`; the brand accent is presentation-only.                  | —                |
| 106–110 | Terminal actions     | keep with reason | Actions are delegated to DS `Button` controls and remain visible/disabled while a terminal save is in flight. | —                |

## D5 — Visual Patterns Observed

- Full-screen split layout is delegated to the existing `OnboardingLayout`; no new shell primitive is duplicated.
- Mobile brand treatment reuses `AppLogo` rather than introducing a second logo renderer.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
