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
`src/modules/shared/layouts/SectionLayout/Description.tsx`,
`src/modules/shared/layouts/SectionLayout/__tests__/Heading.test.ts`,
`src/modules/shared/layouts/SectionLayout/__tests__/SectionDescription.test.ts`,
`src/modules/shared/layouts/SectionLayout/Heading.tsx`,
`src/modules/shared/layouts/SectionLayout/index.ts`,
`src/modules/shared/layouts/SectionLayout/tokens.ts`,
`src/modules/SetupWalkthrough/__tests__/layoutTokens.test.ts`,
`src/modules/SetupWalkthrough/components/SetupWalkthroughSidebar.tsx`,
`src/modules/SetupWalkthrough/components/__tests__/SetupWalkthroughSidebar.test.ts`,
`src/modules/SetupWalkthrough/index.tsx`,
`src/modules/SetupWalkthrough/layoutTokens.ts`,
`src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx`,
`src/scaffold/WizardSystem/primitives/FormField.tsx`,
`src/scaffold/WizardSystem/primitives/SelectionGrid.tsx`,
`src/scaffold/WizardSystem/primitives/WizardProgressCard.tsx`,
`src/scaffold/WizardSystem/primitives/WizardStepLayout.tsx`,
`src/scaffold/WizardSystem/primitives/WizardStepNavigation.tsx`,
`src/scaffold/WizardSystem/primitives/__tests__/WizardStepContent.test.ts`,
`src/scaffold/WizardSystem/primitives/__tests__/WizardStepNavigation.test.ts`,
`src/scaffold/WizardSystem/primitives/WizardStepContent.tsx`
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line / element                                | Element           | Verdict          | Reason                                                                                                                                                                                                       | Suggested change                                                                                                                                         |
| --------------------------------------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` step navigation  | Native `<button>` | fixed            | The feature owned a reusable wizard navigation pattern and rebuilt current/completed/locked state, connector geometry, typography, and semantics locally.                                                    | Added shared `WizardStepNavigation`; setup now supplies only flow state and localized content.                                                           |
| `WizardStepNavigation.tsx` interactive root   | Native `<button>` | keep with reason | The shared primitive is the design-system boundary for this compound navigation control and owns native disabled/current semantics. Wrapping it in the generic Button would apply the wrong visual contract. | —                                                                                                                                                        |
| `ActionCard/index.tsx` selectable container   | Native `<button>` | keep with reason | `ActionCard` is itself the canonical design-system selectable control and owns native pressed/disabled/focus semantics. Wrapping it in Button would create the wrong visual and semantic abstraction.        | —                                                                                                                                                        |
| `ReadinessSteps.tsx` feedback surfaces        | Local alert skin  | fixed            | The shared `InlineAlert` already covers info, success, danger, icons, actions, and tokenized spacing.                                                                                                        | Replaced the local `StatusBanner` implementation.                                                                                                        |
| `SetupWalkthrough/index.tsx` progress track   | Local progress UI | fixed            | The shared `ProgressBar` covers clamping, animation, track/fill tokens, and now accepts an accessible label.                                                                                                 | Replaced setup-only progress markup with `ProgressBar`.                                                                                                  |
| `ReadinessSteps.tsx` step heading/frame       | Local page frame  | fixed            | The feature rebuilt semantic heading, icon, supporting copy, content width, and vertical rhythm instead of using WizardSystem.                                                                               | Added and reused shared `WizardStepContent`.                                                                                                             |
| `WizardStepContent.tsx` intro hierarchy       | Raw structural UI | fixed            | The wizard primitive still assembled `<section>`, `<header>`, heading, and supporting copy instead of delegating the established SectionLayout system.                                                       | Added the generic `SectionHeading appearance="intro"` contract.                                                                                          |
| `ReadinessSteps.tsx` invite link              | Local card markup | fixed            | A one-off rounded border/fill surface duplicated the established settings information-row composition.                                                                                                       | Replaced with `SectionContainer`, `SectionRow`, the shared path token, and Button.                                                                       |
| `ReadinessSteps.tsx` supporting paragraphs    | Native `<p>`      | fixed            | Multiple setup steps repeated the same paragraph reset, line height, and shared description token.                                                                                                           | Added and reused `SectionDescription`.                                                                                                                   |
| `SectionDescription.tsx` semantic root        | Native `<p>`      | keep with reason | This shared SectionLayout primitive is the semantic design-system boundary for supporting copy and must preserve ordinary paragraph attributes.                                                              | —                                                                                                                                                        |
| `SetupWalkthrough/index.tsx` sidebar assembly | Local UI assembly | fixed            | The route mixed flow ownership with brand, progress, and navigation presentation even though every constituent already had a shared primitive.                                                               | Extracted atomic `SetupWalkthroughSidebar`; it composes `AppLogo`, `SectionDescription`, `ProgressBar`, and `WizardStepNavigation` without owning state. |

## D2 — Arbitrary Tailwind Value vs Token

| Line / value  | Verdict | Reason                                                                                                                                  | Suggested change |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Changed files | pass    | No arbitrary color values remain in the audited TSX. The polish uses existing sidebar, surface, border, text, fill, and primary tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / value                   | Verdict          | Reason                                                                                                                                                       | Suggested change                                                                                          |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Brand subtitle `max-w-[210px]` | fixed            | A spacing-scale equivalent is available.                                                                                                                     | Replaced with `max-w-52`.                                                                                 |
| Ready/error content width      | fixed            | Local `max-w-*` wrappers drifted from the standard detail/wizard content measure.                                                                            | Reuses `DETAIL_PANEL_TOKENS.contentWidth`.                                                                |
| ActionCard badge `text-[10px]` | keep with reason | The badge is tertiary metadata inside a 13 px card title and is an established ActionCard micro-label size.                                                  | —                                                                                                         |
| Setup progress `text-[11px]`   | fixed            | The setup-only micro-size was unnecessary and did not use the configured type scale.                                                                         | Replaced with the shared `text-xs` token.                                                                 |
| Walkthrough sidebar `280px`    | fixed            | The setup shell guessed a width independently from the main application sidebar.                                                                             | Reuses `DEFAULT_SIDEBAR_WIDTH`.                                                                           |
| macOS content top inset        | fixed            | Ordinary panel padding let native traffic lights touch the logo; the window-control safe area was not represented.                                           | Added shared `WINDOW_CHROME_TOKENS.titleBarHeight`.                                                       |
| `OnboardingLayout` max sizes   | keep with reason | These values define the reusable onboarding card's viewport contract and predate this setup variant; changing them would alter login/repo layouts.           | —                                                                                                         |
| Fullscreen drag region `52px`  | keep with reason | This is a desktop hit-target region owned by the shared layout, not general content spacing.                                                                 | —                                                                                                         |
| Work-model numbered cards      | fixed            | Decorative ordinals, large corner radii, and hover scaling introduced a setup-only visual language.                                                          | Replaced with shared SectionContainer / SectionRow density.                                               |
| Ready destination glow         | fixed            | The blurred accent treatment was unique to setup and competed with the app's normal information hierarchy.                                                   | Replaced with the shared InlineAlert info treatment.                                                      |
| Setup title/body type scale    | fixed            | Local `text-lg` / `text-sm` combinations diverged from the app's compact main-surface hierarchy.                                                             | Reuses `TYPOGRAPHY.contentTitle` / `contentSubtitle`.                                                     |
| Wizard primitive typography    | fixed            | `FormField`, compact `SelectionGrid`, progress copy, and step footer retained local pixel or generic text sizes instead of the configured application scale. | Reuses `TYPOGRAPHY.valueMedium`, `secondary`, `value`, `contentSubtitle`, and `sectionTitle`.             |
| Wizard content padding         | fixed            | WizardSystem duplicated the same padding strings already owned by the shared detail-panel layout token.                                                      | `WIZARD_CONTENT_TOKENS` now references `DETAIL_PANEL_TOKENS` directly.                                    |
| Setup responsive layout        | fixed            | A feature SCSS file owned bespoke `800px`/`640px` breakpoints and repeated pixel padding for content, footer, and mobile progress.                           | Deleted the SCSS and composed standard `sm`/`md` responsive spacing in `SETUP_WALKTHROUGH_LAYOUT_TOKENS`. |
| Setup entrance motion          | fixed            | A one-off keyframe and `220ms` duration duplicated the application animation scale.                                                                          | Reuses `animate-fade-in` and `motion-reduce:animate-none`.                                                |

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
- SetupWalkthrough projects authoritative flow state into
  WizardStepNavigation; the shared primitive owns connector geometry,
  active/completed/locked styling, native semantics, and stable icon slots.
- Work-model explanations and the final readiness summary use the same
  SectionContainer / SectionRow hierarchy as Settings and other App surfaces.
- Invite-link presentation uses the same SectionContainer / SectionRow / Button
  composition and path token as other structured app surfaces.
- Guidance, success, and failure feedback use InlineAlert instead of a local
  onboarding banner variant.
- The setup shell derives its width and macOS titlebar inset from the same
  sidebar/window-chrome tokens as the main app, and delegates the linear meter
  to ProgressBar.
- SetupWalkthroughSidebar is an atomic composition boundary around AppLogo,
  SectionDescription, ProgressBar, and WizardStepNavigation. It receives a
  state projection and callbacks; controller and persistence ownership remain
  in the route.
- Responsive content/footer spacing, mobile progress, and entrance motion are
  centralized in SETUP_WALKTHROUGH_LAYOUT_TOKENS using the standard Tailwind
  scale. The onboarding-only SCSS file is no longer needed.
- WizardStepContent centralizes step title, description, icon, content width,
  spacing, and heading semantics for WizardSystem and onboarding. It now
  delegates the entire semantic intro hierarchy to the shared
  `SectionHeading` component; SectionLayout composes `TYPOGRAPHY`,
  `HEADER_ICON_SIZE`, and `SECTION_GAP_CLASSES`, while WizardSystem supplies
  only `DETAIL_PANEL_TOKENS.contentWidth`.
- Setup step status, path, summary, and descriptive copy reuse the shared
  SectionLayout typography/path tokens. SectionDescription owns the semantic
  paragraph boundary, while WizardSystem primitives compose the application
  typography and detail-panel spacing tokens.
- No additional pattern appears independently in three or more files.

## Summary

- 20 fixes applied
- 6 kept with documented reason
- 0 remaining fix candidates
- 0 abstract candidates
