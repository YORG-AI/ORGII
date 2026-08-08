# Frontend UI Audit — GlobalPreferencesPanel

**File:** `src/scaffold/GlobalPreferencesPanel/index.tsx` (94 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                             | Verdict | Reason                                                                   | Suggested change |
| ---- | --------------------------------------------------- | ------- | ------------------------------------------------------------------------ | ---------------- |
| —    | `Modal`, `Select`, `SectionContainer`, `SectionRow` | pass    | Interactive and settings surfaces use existing design-system components. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                              | Suggested change |
| ---- | ----- | ------- | --------------------------------------------------- | ---------------- |
| —    | —     | pass    | No arbitrary color or CSS-variable Tailwind values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value         | Verdict          | Reason                                                                                                                                     | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| —    | `width={480}` | keep with reason | Modal width is an explicit component API value used to define the panel's bounded desktop geometry; no color or spacing token is bypassed. | —                |

## D4 — Accessibility

| Line | Element                | Verdict | Reason                                                                                                                                                  | Suggested change |
| ---- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Preview-style selector | pass    | The selector receives the localized field label as its accessible name; the shared Modal owns Escape, focus trap, close control, and focus restoration. | —                |

## D5 — Visual Patterns Observed

- The component reuses the shared modal and settings-row pattern; no third independent implementation was introduced.

## Summary

- 0 fixes recommended
- 1 kept with documented reason
- 0 abstract candidates
