# Frontend UI Audit — Setup Walkthrough Polish

**Files:** `src/components/PearlMark/index.tsx`,
`src/components/ActionCard/ActionCard.test.ts`,
`src/components/ActionCard/index.tsx`,
`src/components/ActionCard/types.ts`,
`src/modules/SetupWalkthrough/index.tsx`,
`src/modules/SetupWalkthrough/index.scss`,
`src/modules/SetupWalkthrough/steps/ReadinessSteps.tsx`
**Date:** 2026-07-31
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line / element                               | Element           | Verdict          | Reason                                                                                                                                                                                                | Suggested change                                                 |
| -------------------------------------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SetupWalkthrough/index.tsx` step navigation | Native `<button>` | keep with reason | The row combines current/completed/locked states, a timeline connector, two-line copy, and `aria-current`; the shared Button variants do not cover this navigation shape.                             | Promote only if another wizard needs the same timeline contract. |
| `ActionCard/index.tsx` selectable container  | Native `<button>` | keep with reason | `ActionCard` is itself the canonical design-system selectable control and owns native pressed/disabled/focus semantics. Wrapping it in Button would create the wrong visual and semantic abstraction. | —                                                                |

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
| Goal row `112px` minimum       | keep with reason | The minimum equalizes translated two-line descriptions without fixing the card to a rigid height.                                                 | —                          |

## D4 — Accessibility

| Element         | Verdict | Reason                                                                                                                                     | Suggested change |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Pearl mark      | pass    | Decorative use is hidden from assistive technology; named use supports `role="img"` and a direct accessible label.                         | —                |
| Step navigation | pass    | Native buttons expose disabled state, current step uses `aria-current="step"`, and the group has a localized accessible label.             | —                |
| Goal choices    | pass    | ActionCard retains native button semantics and `aria-pressed`; the visual polish does not add or remove selection affordances dynamically. | —                |

## D5 — Visual Patterns Observed

- The pearl is now a shared, theme-aware `PearlMark` component instead of an
  onboarding-only icon treatment.
- ActionCard's reusable inline/stacked layout keeps optional metadata and
  selection affordances in stable slots, preventing selection-driven reflow.
- The existing SelectionGrid and ActionCard primitives remain the canonical
  choice controls; walkthrough-specific polish stays at the layout layer.
- No additional pattern appears independently in three or more files.

## Summary

- 2 fixes applied
- 6 kept with documented reason
- 0 remaining fix candidates
- 0 abstract candidates
