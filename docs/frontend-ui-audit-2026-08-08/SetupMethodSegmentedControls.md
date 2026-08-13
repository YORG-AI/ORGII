# Frontend UI Audit — Setup Method Segmented Controls

**Files:** `src/components/ActionCard/index.tsx`, `src/scaffold/WizardSystem/primitives/SelectionGrid.tsx`, and Setup Method selector call sites in `src/scaffold/WizardSystem/`
**Date:** 2026-08-08

## D1 — Raw HTML vs Design System

| Line                                                       | Element                       | Verdict | Reason                                                                                                                                                                                                                 | Suggested change                                            |
| ---------------------------------------------------------- | ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ActionCard/index.tsx:120–183`                             | Shared compact selection card | fixed   | The existing `ActionCard` primitive owns all segmented control states and native-button semantics. Defining the 36px height here prevents the visual requirement from being duplicated in every provider setup screen. | Reuse `compactCards` for future inline segmented selectors. |
| `CodexSetup.tsx:104–110` and equivalent Setup Method grids | Setup method selectors        | fixed   | Every provider and integration setup-method selector now uses the same compact primitive, so selected, unselected, icon, and trailing-check states share one height.                                                   | —                                                           |

## D2 — Arbitrary Tailwind Value vs Token

| Line                       | Value | Verdict          | Reason                                                                                                                                                   | Suggested change |
| -------------------------- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ActionCard/index.tsx:127` | `h-9` | keep with reason | `h-9` is the design-system utility for the requested 36px control height; it replaces implicit padding-derived sizing with an explicit shared dimension. | —                |

## D4 — Accessibility

| Line                           | Element                     | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------------------------ | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ActionCard/index.tsx:274–286` | Compact setup-method option | keep with reason | The compact treatment retains the native button, keyboard behavior, focus ring, and pressed-state semantics supplied by `ActionCard`. | —                |

## Summary

- 2 fixes applied
- 2 kept with documented reason
- 0 abstraction candidates
