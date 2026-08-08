# Frontend UI Audit — Setup Readiness Flow

**Files:** `src/modules/SetupWalkthrough/index.tsx`,
`src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx`,
`src/modules/shared/layouts/OnboardingLayout/index.tsx`,
`src/components/ActionCard/index.tsx`,
`src/components/ActionCard/types.ts`,
`src/scaffold/WizardSystem/primitives/SelectionGrid.tsx`,
`src/scaffold/Tutorials/TutorialsModal.tsx`,
`src/scaffold/Tutorials/GeneralLayoutTour.tsx`,
`src/scaffold/Tutorials/CodeEditorTour.tsx`
**Date:** 2026-07-30
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line / element                               | Element                                                       | Verdict          | Reason                                                                                                                                                                                  | Suggested change                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` step navigation | Native `<button>`                                             | keep with reason | The control is a two-line timeline row with active, completed, locked, connector, and `aria-current` semantics. The shared Button variants do not cover this compound navigation shape. | Promote to a shared wizard step-navigation primitive only when a second flow needs the same timeline contract. |
| `ReadinessSteps.tsx` selectable choices      | `SelectionGrid` / `ActionCard`                                | keep with reason | Goal, organization, and tutorial choices continue to use the canonical keyboard-accessible selection components.                                                                        | —                                                                                                              |
| `ReadinessSteps.tsx` settings surfaces       | `SectionContainer`, `SectionRow`, `Select`, `Input`, `Button` | keep with reason | The polish pass changes composition and hierarchy without introducing parallel form controls.                                                                                           | —                                                                                                              |
| `SetupWalkthrough/index.tsx` footer actions  | `PanelFooter` / `Button`                                      | keep with reason | Back, skip, and continue retain the shared loading, disabled, focus, and button sizing behavior.                                                                                        | —                                                                                                              |
| `Tutorials/*Tour.tsx` tour controls          | `Button` plus native close button                             | keep with reason | Previous/next use the shared icon-button primitive; the native close control matches the established popup close pattern and preserves a direct accessible label.                       | —                                                                                                              |
| `ActionCard/index.tsx` selectable card       | Native `<button>` inside the design-system component          | keep with reason | `ActionCard` is itself the canonical selection primitive; native button and `aria-pressed` semantics are its accessibility contract.                                                    | —                                                                                                              |

## D2 — Arbitrary Tailwind Value vs Token

| Line / value                                               | Value                                       | Verdict          | Reason                                                                                                                                                  | Suggested change                                                        |
| ---------------------------------------------------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` setup badge and step metadata | `text-[10px]`                               | keep with reason | These are compact uppercase/status metadata subordinate to 12–14px labels; the normal typography token competes with the primary label at this density. | Keep until the design system gains a compact metadata typography token. |
| `SetupWalkthrough/index.scss` themed gradients             | `color-mix(... var(--color-primary-6) ...)` | keep with reason | The gradients derive entirely from runtime theme tokens and must adapt to every primary color and light/dark theme.                                     | —                                                                       |

## D3 — Hardcoded Sizes / Colors

| Line / value                                           | Value                              | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------------------------------------------------------ | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SetupWalkthrough/index.scss` sidebar geometry         | `300px`, `260px`                   | keep with reason | These define the split-pane information architecture and its responsive breakpoint behavior; they are not spacing-scale substitutions.                  | —                |
| `SetupWalkthrough/index.scss` brand/step icon geometry | `36px`, `44px`, `40px`             | keep with reason | The sizes establish deliberate optical hierarchy between the brand mark, desktop step emblem, and compact step emblem.                                  | —                |
| `SetupWalkthrough/index.scss` goal card geometry       | `16px` padding/radius              | keep with reason | The geometry matches the existing `p-4` / `rounded-2xl` visual language while CSS ownership is required for hover, selected, and reduced-motion states. | —                |
| `SetupWalkthrough/index.scss` shadows                  | theme color mixes with black/white | keep with reason | Black/white are used only as neutral shadow/highlight mix inputs; all visible surfaces and accents remain runtime design tokens.                        | —                |

## D4 — Accessibility

| Line / element                              | Element                                    | Verdict          | Reason                                                                                                                                                          | Suggested change |
| ------------------------------------------- | ------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SetupWalkthrough/index.tsx` progress meter | `role="progressbar"`                       | keep with reason | It exposes current, minimum, and maximum values while the visual width remains decorative.                                                                      | —                |
| `SetupWalkthrough/index.tsx` step timeline  | Step buttons                               | keep with reason | Every row has visible title text, native keyboard behavior, disabled state, and `aria-current="step"` on the active row.                                        | —                |
| `ReadinessSteps.tsx` step heading           | Semantic `<section>` + `<header>` + `<h1>` | keep with reason | Each rendered step has a stable accessible heading relationship through `aria-labelledby`.                                                                      | —                |
| `ReadinessSteps.tsx` status feedback        | `role="status"` / `role="alert"`           | keep with reason | Informational, success, and error feedback keep live-region semantics; added icons are explicitly decorative.                                                   | —                |
| `ActionCard/index.tsx` stacked selection    | Native button + `aria-pressed`             | keep with reason | The new arrangement changes only content hierarchy; keyboard activation, focus ring, disabled state, and selection announcement remain on the canonical button. | —                |

## D5 — Visual Patterns Observed

- `SetupWalkthrough/index.tsx` rendered the same step counter in the sidebar
  progress card and desktop footer. **Fix applied:** desktop footer now contains
  actions only; the compact counter remains on mobile, where the sidebar is
  hidden.
- The brand subtitle and persistent bottom reassurance card both communicated
  automatic progress saving. **Fix applied:** the bottom card was removed,
  preserving the brand-level promise while recovering vertical space for the
  eight-step team path.
- `walkthrough-goal-card` used a two-pixel hover translation despite selection
  already having border, color, and shadow feedback. **Fix applied:** hover
  changes shadow only, so pointer and selection transitions do not move layout.
- `OnboardingLayout` now exposes optional card/left/right class slots so product
  flows can specialize the shared shell without copying it.
- `ActionCard` and `SelectionGrid` expose a reusable stacked-card layout so
  badges and selection status do not compete with translated titles.
- `SelectionGrid` now exposes an optional wrapper class so a consuming flow can
  provide responsive column behavior while retaining canonical `ActionCard`
  semantics.
- `StepFrame`, `StatusBanner`, and the sidebar timeline remain local primitives
  because no second product flow currently shares their full visual contract.
- No new repeated visual pattern reaches the three-site abstraction threshold.

## Summary

- **3 fixes applied**
- **17 kept with documented reason**
- **0 abstract candidates**
