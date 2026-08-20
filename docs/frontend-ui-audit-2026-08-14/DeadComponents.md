# Frontend UI Audit — Dead Component Cleanup

**Files:** 16 unreachable shared/component ownership units
**Date:** 2026-08-14
**Auditor:** Codex focused review (the configured `frontend-ui-audit` skill file was unavailable)

## D1 — Raw HTML vs Design System

| Area                   | Element                         | Verdict          | Reason                                                                                                                                                                  | Suggested change                        |
| ---------------------- | ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Deleted components     | All rendered elements           | fix (resolved)   | The components have no production render path, so retaining or refactoring their internal controls would preserve dead UI rather than improve the active design system. | Delete the unreachable ownership units. |
| Live pill surfaces     | `CompoundPill/config.ts` tokens | keep with reason | These tokens are actively consumed by composer, selector, session-creator, and project surfaces.                                                                        | Retain the shared token module.         |
| Live property surfaces | `PropertyField` subcomponents   | keep with reason | Dropdown, editable-field, and direction-provider modules have active production callers.                                                                                | Delete only the unused root wrapper.    |

## D2 — Arbitrary Tailwind Value vs Token

| Area               | Value                              | Verdict        | Reason                                              | Suggested change                                          |
| ------------------ | ---------------------------------- | -------------- | --------------------------------------------------- | --------------------------------------------------------- |
| Deleted components | Component-local classes and styles | fix (resolved) | Unreachable styling is deleted with its sole owner. | No token migration is needed for code that cannot render. |

## D3 — Hardcoded Sizes / Colors

| Area               | Value                            | Verdict        | Reason                                                                               | Suggested change                                 |
| ------------------ | -------------------------------- | -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Deleted components | Component-local hardcoded values | fix (resolved) | These values disappear with unreachable components and do not affect a live pattern. | Do not promote dead values into reusable tokens. |

## D4 — Accessibility

| Area          | Element           | Verdict | Reason                                                                                               | Suggested change |
| ------------- | ----------------- | ------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| Production UI | All deleted units | keep    | No production accessibility behavior changes because none of the deleted units has a runtime caller. | None.            |

## D5 — Visual Patterns Observed

- No live visual pattern is removed or introduced.
- Active `ProgressBar`, Gantt timeline, domain-specific status badges, pill tokens, and property-field subcomponents remain in place.
- Historical audit documents remain as records; archived code is explicitly outside the production build.

## Summary

- 16 fixes recommended and resolved through deletion
- 2 live shared ownership areas kept with documented reason
- 0 abstraction candidates
- 0 rendered UI changes requiring screenshots
