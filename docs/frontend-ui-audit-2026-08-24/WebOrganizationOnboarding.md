# Frontend UI Audit — WebOrganizationOnboarding

**File:** `src/web/features/sessions/WebOrganizationOnboarding.tsx` (225 LOC)
**Date:** 2026-08-24
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                          | Verdict          | Reason                                                                                                                                                                                | Suggested change |
| ---- | ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 180  | `<form>` organization membership submit boundary | keep with reason | The repository has no covering design-system Form component; the native form preserves Enter-to-submit and semantic grouping while all interactive controls use `Button` and `Input`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                           | Verdict          | Reason                                                                             | Suggested change |
| ---- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary color/token values | keep with reason | The component uses existing surface, border, text, danger, and workstation tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                                         | Verdict          | Reason                                                           | Suggested change |
| ---- | --------------------------------------------- | ---------------- | ---------------------------------------------------------------- | ---------------- |
| —    | No pixel-literal Tailwind sizes or raw colors | keep with reason | Layout uses the project spacing scale and semantic color tokens. | —                |

## D4 — Accessibility

| Line | Element                        | Verdict          | Reason                                                                                                       | Suggested change |
| ---- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| 125  | Organization setup `<section>` | keep with reason | `aria-labelledby` connects the region to its visible heading.                                                | —                |
| 143  | Create/join mode group         | keep with reason | The group has an accessible label and each design-system button exposes `aria-pressed`.                      | —                |
| 165  | Roster refresh error           | keep with reason | `role="alert"` announces stale-data status while the adjacent design-system Retry button preserves recovery. | —                |
| 187  | Organization input             | keep with reason | The native label is associated through `htmlFor`/`id`; form submission also works from the keyboard.         | —                |
| 203  | Membership error               | keep with reason | `role="alert"` announces command failures without removing the form or disabling retry.                      | —                |

## D5 — Visual Patterns Observed

- No new pattern appears in three or more independent files. The onboarding card is Web-specific and reuses existing design-system controls and semantic tokens.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
