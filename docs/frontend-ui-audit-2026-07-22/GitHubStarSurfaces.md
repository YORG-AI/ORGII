# Frontend UI Audit — GitHub Star Surfaces

**Files:** `src/features/GitHubStar/GitHubStarSettingsRow.tsx`, `src/features/GitHubStar/GitHubStarReminder.tsx`, `src/modules/MainApp/Settings/sections/GeneralSection.tsx`, `src/modules/SetupWalkthrough/index.tsx`, `src/modules/shared/layouts/GlobalModals.tsx`
**Date:** 2026-07-22
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                               | Element                                           | Verdict          | Reason                                                                                                      | Suggested change |
| ---------------------------------- | ------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| `GitHubStarSettingsRow.tsx:65-107` | Design-system `Button` actions                    | keep with reason | Star, fallback, error, and busy states all use the shared Button component.                                 | —                |
| `GitHubStarReminder.tsx:55-112`    | Shared `Modal` and design-system `Button` actions | keep with reason | The reminder reuses the established modal and button contracts instead of introducing raw interactive HTML. | —                |
| `GitHubStarSettingsRow.tsx:98`     | Status `<span>`                                   | keep with reason | Non-interactive success text; semantic status is supplied by the adjacent live region.                      | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                      | Verdict          | Reason                                                                  | Suggested change |
| ---- | ---------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary color, CSS-variable, hex, RGB, or HSL classes | keep with reason | Surfaces use project tokens such as `text-success-6` and `text-text-3`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                                                       | Value                                                     | Verdict          | Reason                                                                                                                   | Suggested change |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `GitHubStarReminder.tsx:88,90` and `GitHubStarSettingsRow.tsx:68,79,90,99` | 14px Lucide icon sizes                                    | keep with reason | Matches the shared small-Button icon grid and is a deliberate optical micro-size.                                        | —                |
| `GitHubStarReminder.tsx:58`                                                | Modal width `420`                                         | keep with reason | Modal accepts a numeric content width; 420px provides space for three actions without introducing a reusable token need. | —                |
| —                                                                          | No raw color literals or arbitrary Tailwind pixel classes | keep with reason | Layout uses the project spacing scale and design tokens.                                                                 | —                |

## D4 — Accessibility

| Line                                | Element                   | Verdict          | Reason                                                                                              | Suggested change |
| ----------------------------------- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| `GitHubStarSettingsRow.tsx:117-124` | Polite status live region | keep with reason | Announces loading, fallback reason, and confirmed success; `aria-busy` mirrors actual pending work. | —                |
| `GitHubStarReminder.tsx:64-100`     | Reminder actions          | keep with reason | Every action is a semantic Button with visible translated text; icons are decorative.               | —                |
| `GitHubStarReminder.tsx:108-110`    | Reminder live region      | keep with reason | Announces controller status while preserving visible content stability.                             | —                |

## D5 — Visual Patterns Observed

- Settings presentation reuses `SectionRow` and `SectionContainer`; it does not create a parallel settings-row pattern.
- Reminder presentation reuses the canonical `Modal` and Button footer vocabulary.
- Controller logic is shared by Settings and reminder surfaces, preventing visual state semantics from drifting between entry points.

## Summary

- 0 fixes recommended
- 10 findings kept with documented reason
- 0 abstraction candidates
- Total source changes in this audit: 0; this report reviews the already-implemented feature without mixing audit-only fixes into the report pass.
