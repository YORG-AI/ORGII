# Frontend UI Audit — DeveloperTestPanel

**File:** `src/scaffold/DeveloperTestPanel/index.tsx` (166 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                          | Verdict          | Reason                                                                                                                      | Suggested change |
| ---- | -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 43   | Module disclosure `DropdownItem` | keep with reason | Reuses the shared dropdown row and its built-in keyboard activation instead of introducing a raw disclosure button.         | —                |
| 95   | Flask trigger `IconButton`       | keep with reason | The icon-only entry uses the established sidebar header control and tooltip pattern.                                        | —                |
| 119  | `DropdownPanel` test surface     | keep with reason | The shared panel owns material, border, shadow, animation, and constrained positioning while the inner module list scrolls. | —                |
| 141  | Close `IconButton`               | keep with reason | Uses the design-system icon action with a localized accessible name.                                                        | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                                                                                                   | Suggested change |
| ---- | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| 136  | `text-[10px]` DEV badge | keep with reason | Matches the existing compact guide badge and keeps the environment marker from increasing header height. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                                                                           | Suggested change |
| ---- | ----------------------- | ---------------- | -------------------------------------------------------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | Icons use `HEADER_ICON_SIZE`/dropdown tokens; colors use semantic theme classes. | —                |

## D4 — Accessibility

| Line | Element           | Verdict          | Reason                                                                                                                            | Suggested change |
| ---- | ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 43   | Module disclosure | keep with reason | Focusable `role="button"` rows expose `aria-expanded` and inherit Enter/Space activation from `DropdownItem`.                     | —                |
| 95   | Flask trigger     | keep with reason | Exposes a localized name, `aria-haspopup="dialog"`, and current expanded state.                                                   | —                |
| 119  | Test panel        | keep with reason | The panel has dialog semantics and a localized label; Escape/outside-click lifecycle remains owned by the shared dropdown engine. | —                |

## D5 — Visual Patterns Observed

- Pattern: developer modules register once in `moduleRegistry.ts` and receive a consistent collapsible section, preventing future modules from creating separate ad-hoc test popovers.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
