# Frontend UI Audit — Setup Walkthrough Polish

**Files:** `src/components/AppLogo/index.tsx`,
`src/components/ActionCard/ActionCard.test.ts`,
`src/components/ActionCard/index.tsx`,
`src/components/ActionCard/types.ts`,
`src/components/InlineAlert/InlineAlert.test.ts`,
`src/components/InlineAlert/index.tsx`,
`src/components/ProgressBar/ProgressBar.test.ts`,
`src/components/ProgressBar/index.tsx`,
`src/config/windowChromeTokens.ts`,
`src/modules/shared/layouts/OnboardingLayout/index.tsx`,
`src/modules/SetupWalkthrough/__tests__/layoutTokens.test.ts`,
`src/modules/SetupWalkthrough/index.tsx`,
`src/modules/SetupWalkthrough/index.scss`,
`src/modules/SetupWalkthrough/layoutTokens.ts`,
`src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx`,
`src/scaffold/WizardSystem/primitives/WizardStepContent.test.ts`,
`src/scaffold/WizardSystem/primitives/WizardStepContent.tsx`
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line / element                               | Element           | Verdict          | Reason                                                                                                                                                                                                | Suggested change                                                 |
| -------------------------------------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` step navigation | Native `<button>` | keep with reason | The row combines current/completed/locked states, a timeline connector, two-line copy, and `aria-current`; the shared Button variants do not cover this navigation shape.                             | Promote only if another wizard needs the same timeline contract. |
| `ActionCard/index.tsx` selectable container  | Native `<button>` | keep with reason | `ActionCard` is itself the canonical design-system selectable control and owns native pressed/disabled/focus semantics. Wrapping it in Button would create the wrong visual and semantic abstraction. | —                                                                |
| `ReadinessSteps.tsx` feedback surfaces       | Local alert skin  | fixed            | The shared `InlineAlert` already covers info, success, danger, icons, actions, and tokenized spacing.                                                                                                 | Replaced the local `StatusBanner` implementation.                |
| `SetupWalkthrough/index.tsx` progress track  | Local progress UI | fixed            | The shared `ProgressBar` covers clamping, animation, track/fill tokens, and now accepts an accessible label.                                                                                          | Replaced setup-only progress markup with `ProgressBar`.          |
| `ReadinessSteps.tsx` step heading/frame      | Local page frame  | fixed            | The feature rebuilt semantic heading, icon, supporting copy, content width, and vertical rhythm instead of using WizardSystem.                                                                        | Added and reused shared `WizardStepContent`.                     |

## D2 — Arbitrary Tailwind Value vs Token

| Line / value  | Verdict | Reason                                                                                                                                  | Suggested change |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Changed files | pass    | No arbitrary color values remain in the audited TSX. The polish uses existing sidebar, surface, border, text, fill, and primary tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / value                   | Verdict          | Reason                                                                                                                                             | Suggested change                                            |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Brand subtitle `max-w-[210px]` | fixed            | A spacing-scale equivalent is available.                                                                                                           | Replaced with `max-w-52`.                                   |
| Ready/error content width      | fixed            | Local `max-w-*` wrappers drifted from the standard detail/wizard content measure.                                                                  | Reuses `DETAIL_PANEL_TOKENS.contentWidth`.                  |
| ActionCard badge `text-[10px]` | keep with reason | The badge is tertiary metadata inside a 13 px card title and is an established ActionCard micro-label size.                                        | —                                                           |
| Setup progress `text-[11px]`   | fixed            | The setup-only micro-size was unnecessary and did not use the configured type scale.                                                               | Replaced with the shared `text-xs` token.                   |
| Walkthrough sidebar `280px`    | fixed            | The setup shell guessed a width independently from the main application sidebar.                                                                   | Reuses `DEFAULT_SIDEBAR_WIDTH`.                             |
| macOS content top inset        | fixed            | Ordinary panel padding let native traffic lights touch the logo; the window-control safe area was not represented.                                 | Added shared `WINDOW_CHROME_TOKENS.titleBarHeight`.         |
| `OnboardingLayout` max sizes   | keep with reason | These values define the reusable onboarding card's viewport contract and predate this setup variant; changing them would alter login/repo layouts. | —                                                           |
| Fullscreen drag region `52px`  | keep with reason | This is a desktop hit-target region owned by the shared layout, not general content spacing.                                                       | —                                                           |
| Work-model numbered cards      | fixed            | Decorative ordinals, large corner radii, and hover scaling introduced a setup-only visual language.                                                | Replaced with shared SectionContainer / SectionRow density. |
| Ready destination glow         | fixed            | The blurred accent treatment was unique to setup and competed with the app's normal information hierarchy.                                         | Replaced with the shared InlineAlert info treatment.        |
| Setup title/body type scale    | fixed            | Local `text-lg` / `text-sm` combinations diverged from the app's compact main-surface hierarchy.                                                   | Reuses `TYPOGRAPHY.contentTitle` / `contentSubtitle`.       |

## D4 — Accessibility

| Element          | Verdict | Reason                                                                                                                                     | Suggested change |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Application logo | pass    | The canonical application asset is reused; decorative use is hidden from assistive technology and named use supports alternative text.     | —                |
| Step navigation  | pass    | Native buttons expose disabled state, current step uses `aria-current="step"`, and the group has a localized accessible label.             | —                |
| Goal choices     | pass    | ActionCard retains native button semantics and `aria-pressed`; the visual polish does not add or remove selection affordances dynamically. | —                |
| Dynamic feedback | pass    | Shared InlineAlert accepts an explicit role; asynchronous success uses `status` and operation failures use `alert`.                        | —                |
| Setup progress   | pass    | Shared ProgressBar exposes bounded `progressbar` semantics when setup supplies the localized step label.                                   | —                |
| Step headings    | pass    | Shared WizardStepContent owns the generated heading id and `aria-labelledby` relationship for every setup step.                            | —                |

## D5 — Visual Patterns Observed

- The canonical desktop asset is exposed through a shared `AppLogo` component
  instead of introducing an onboarding-only brand mark.
- ActionCard's reusable inline/stacked layout keeps optional metadata and
  selection affordances in stable slots, preventing selection-driven reflow.
- Goal selection delegates hover, selected, focus, spacing, and color to the
  existing SelectionGrid and ActionCard primitives; onboarding adds no custom
  card variant.
- Work-model explanations and the final readiness summary use the same
  SectionContainer / SectionRow hierarchy as Settings and other App surfaces.
- Guidance, success, and failure feedback use InlineAlert instead of a local
  onboarding banner variant.
- The setup shell derives its width and macOS titlebar inset from the same
  sidebar/window-chrome tokens as the main app, and delegates the linear meter
  to ProgressBar.
- WizardStepContent centralizes step title, description, icon, content width,
  spacing, and heading semantics for WizardSystem and onboarding. Internally it
  composes `TYPOGRAPHY`, `HEADER_ICON_SIZE`, `DETAIL_PANEL_TOKENS`, and
  `SECTION_GAP_CLASSES` rather than defining a parallel visual scale.
- Setup step status, path, summary, and descriptive copy reuse the shared
  SectionLayout typography/path tokens; raw feature-level text sizing remains
  only where a component owns the design-system primitive.
- No additional pattern appears independently in three or more files.

## Summary

- 11 fixes applied
- 5 kept with documented reason
- 0 remaining fix candidates
- 0 abstract candidates
