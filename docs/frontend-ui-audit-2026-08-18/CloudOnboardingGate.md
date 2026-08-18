# Frontend UI Audit — CloudOnboardingGate

**File:** `src/features/Org2Cloud/CloudOnboardingGate.tsx` (232 LOC)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                             | Verdict          | Reason                                                                                                           | Suggested change |
| ------ | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| 91–228 | Onboarding and auth-block structure | keep with reason | Native elements are non-interactive layout and semantic text; all actions use the shared design-system `Button`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                        | Verdict          | Reason                                                                                                      | Suggested change |
| ---- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary Tailwind values | keep with reason | Spacing, radii, typography, surfaces, and semantic colors all use the existing Tailwind/design-token scale. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                    | Value                            | Verdict          | Reason                                                                                                  | Suggested change |
| ----------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| 96–97, 167–168, 183–184 | Icon containers and Lucide sizes | keep with reason | The 14/18/20px glyphs sit inside standard 28/36/40px scale containers and introduce no hardcoded color. | —                |

## D4 — Accessibility

| Line             | Element                      | Verdict          | Reason                                                                                                                                    | Suggested change |
| ---------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 97, 168, 184     | Decorative icons             | keep with reason | Icons are hidden from assistive technology; adjacent visible copy names each value and action.                                            | —                |
| 105–121, 198–205 | Pending and failure feedback | keep with reason | Pending copy uses polite status semantics and failures use `role="alert"`; buttons expose visible names and real disabled/loading states. | —                |

## D5 — Visual Patterns Observed

- Pattern: a local-first Cloud introduction that collapses into a contextual auth boundary. It is intentionally abstracted here and reused by Settings, Cloud Org creation, invite acceptance, share import, and Team Runtime.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 1 abstract candidate, implemented as the shared component
