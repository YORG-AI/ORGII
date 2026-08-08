# Frontend UI Audit — SetupWalkthroughIcons

**Files:** `src/components/RepositoryAssetIcon/index.tsx` (74 LOC), `src/modules/SetupWalkthrough/components/SetupStepIcons.tsx` (39 LOC), `src/modules/SetupWalkthrough/config.tsx` (79 LOC), `src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx` (760 LOC), `src/modules/shared/layouts/SectionLayout/Heading.tsx` (122 LOC), `src/scaffold/WizardSystem/primitives/WizardStepContent.tsx` (47 LOC), `src/scaffold/WizardSystem/primitives/WizardStepNavigation.tsx` (156 LOC)
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                               | Element                                       | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ---------------------------------- | --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `RepositoryAssetIcon/index.tsx:31` | Decorative `<span>` test-runtime SVG fallback | keep with reason | This is a non-interactive rendering primitive for a CSS mask; Button/Input design-system components do not apply.                                                  | —                |
| `WizardStepNavigation.tsx:100`     | Full-width step-navigation `<button>`         | keep with reason | The control owns `aria-current`, disabled gating, connector geometry, and a multi-line navigation layout that the general-purpose Button component does not cover. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value   | Verdict          | Reason                                                                                | Suggested change |
| ---- | ------- | ---------------- | ------------------------------------------------------------------------------------- | ---------------- |
| —    | No hits | keep with reason | Changed UI uses existing `bg-*`, `text-*`, `border-*`, typography, and wizard tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                                        | Verdict          | Reason                                                                                                           | Suggested change |
| ---- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary pixel classes or literal colors | keep with reason | Rendered icon sizes come from `HEADER_ICON_SIZE` and `SECTION_INTRO_TOKENS`; icon color inherits `currentColor`. | —                |

## D4 — Accessibility

| Line                               | Element                    | Verdict          | Reason                                                                                                                                   | Suggested change |
| ---------------------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RepositoryAssetIcon/index.tsx:31` | Decorative repository icon | keep with reason | The adapter forwards `aria-hidden`; onboarding places the icon next to visible text and does not use it as the accessible name.          | —                |
| `WizardStepNavigation.tsx:100`     | Step navigation button     | keep with reason | Each button has visible title/description text, native keyboard behavior, disabled state, and `aria-current="step"` for the active item. | —                |

## D5 — Visual Patterns Observed

- Repository SVG normalization is centralized in `RepositoryAssetIcon`; no duplicate per-step color or sizing treatment remains.
- Step-to-asset semantics are centralized in `SetupStepIcons`; navigation and page headings consume the same components.
- No additional pattern appears independently in three or more changed files.

## Next-refactor candidates

- None identified in this icon-replacement scope.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
