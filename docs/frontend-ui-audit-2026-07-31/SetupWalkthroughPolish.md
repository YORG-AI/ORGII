# Frontend UI Audit — Setup Walkthrough Polish

**Files:** `src/components/AppLogo/index.tsx`,
`src/components/ActionCard/ActionCard.test.ts`,
`src/components/ActionCard/index.tsx`,
`src/components/ActionCard/types.ts`,
`src/modules/SetupWalkthrough/index.tsx`,
`src/modules/SetupWalkthrough/index.scss`,
`src/modules/SetupWalkthrough/components/SetupRoutePreview.tsx`,
`src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx`
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line / element                               | Element            | Verdict          | Reason                                                                                                                                                                                                | Suggested change                                                 |
| -------------------------------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` step navigation | Native `<button>`  | keep with reason | The row combines current/completed/locked states, a timeline connector, two-line copy, and `aria-current`; the shared Button variants do not cover this navigation shape.                             | Promote only if another wizard needs the same timeline contract. |
| `ActionCard/index.tsx` selectable container  | Native `<button>`  | keep with reason | `ActionCard` is itself the canonical design-system selectable control and owns native pressed/disabled/focus semantics. Wrapping it in Button would create the wrong visual and semantic abstraction. | —                                                                |
| `SetupRoutePreview.tsx` route structure      | `<aside>` + `<ol>` | keep with reason | The preview is derived, non-interactive content. Landmark and ordered-list semantics communicate the route without inventing an interactive design-system control.                                    | —                                                                |

## D2 — Arbitrary Tailwind Value vs Token

| Line / value  | Verdict | Reason                                                                                                                                                      | Suggested change |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Changed files | pass    | No arbitrary CSS-variable or raw-color Tailwind values remain in the audited TSX. The polish uses existing surface, border, text, fill, and primary tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / value                   | Verdict          | Reason                                                                                                                                            | Suggested change           |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Brand subtitle `max-w-[210px]` | fixed            | A spacing-scale equivalent is available.                                                                                                          | Replaced with `max-w-52`.  |
| Ready content `max-w-[760px]`  | fixed            | The intended content width maps closely to an existing width token.                                                                               | Replaced with `max-w-3xl`. |
| Setup progress `text-[11px]`   | keep with reason | This is compact secondary chrome between the 10 px brand tag and 12 px step copy; raising it to 12 px weakens the sidebar hierarchy.              | —                          |
| ActionCard badge `text-[10px]` | keep with reason | The badge is tertiary metadata inside a 13 px card title and is an established ActionCard micro-label size.                                       | —                          |
| Walkthrough sidebar `280px`    | keep with reason | This is a deliberate split-pane contract, not general spacing. It keeps eight localized step labels readable while preserving the content canvas. | —                          |
| Goal row `84px` minimum        | keep with reason | The minimum equalizes translated two-line descriptions without fixing the vertically stacked goal rows to a rigid height.                         | —                          |
| Route number `9px`             | keep with reason | Route ordinals are utility metadata inside a 12 px route label; their sequence is meaningful and the compact scale keeps labels dominant.         | —                          |

## D4 — Accessibility

| Element          | Verdict | Reason                                                                                                                                     | Suggested change |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Application logo | pass    | The canonical application asset is reused; decorative use is hidden from assistive technology and named use supports alternative text.     | —                |
| Step navigation  | pass    | Native buttons expose disabled state, current step uses `aria-current="step"`, and the group has a localized accessible label.             | —                |
| Goal choices     | pass    | ActionCard retains native button semantics and `aria-pressed`; the visual polish does not add or remove selection affordances dynamically. | —                |
| Route preview    | pass    | The derived path uses ordered-list semantics, a localized landmark label, and a polite live region when the selected goal changes.         | —                |

## D5 — Visual Patterns Observed

- The canonical desktop asset is exposed through a shared `AppLogo` component
  instead of introducing an onboarding-only brand mark.
- ActionCard's reusable inline/stacked layout keeps optional metadata and
  selection affordances in stable slots, preventing selection-driven reflow.
- The existing SelectionGrid and ActionCard primitives remain the canonical
  choice controls; walkthrough-specific polish stays at the layout layer.
- The ordered dual rail is deliberately local to setup: it encodes the real
  step sequence and echoes the canonical `II` mark without becoming a general
  progress component.
- No additional pattern appears independently in three or more files.

## Summary

- 2 fixes applied
- 8 kept with documented reason
- 0 remaining fix candidates
- 0 abstract candidates
