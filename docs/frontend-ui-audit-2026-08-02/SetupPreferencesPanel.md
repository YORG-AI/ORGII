# Frontend UI Audit — SetupPreferencesPanel

**File:** `src/modules/SetupWalkthrough/components/SetupPreferencesPanel.tsx` (172 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                         | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------ | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 146    | Action wrapper `<div>`          | keep with reason | Layout-only wrapper around shared `Button` components.                                                                                 | —                |
| 156    | Arrow `<span>`                  | keep with reason | Decorative inline glyph is hidden from assistive technology.                                                                           | —                |
| 79–143 | Preview and preference controls | keep with reason | Uses shared `FormField`, `Select`, `LanguageSelector`, `SectionContainer`, and `SectionRow`; no raw interactive element is introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                 | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | All composition classes come from shared detail-panel or setup tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                                          | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | Sizing and color are expressed through design-system props and semantic tokens. | —                |

## D4 — Accessibility

| Line    | Element               | Verdict          | Reason                                                                                                                                              | Suggested change |
| ------- | --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 79–94   | Presentation selector | keep with reason | Shared `FormField` provides the visible label and `Select` receives the same localized accessible name; it is disabled during terminal persistence. | —                |
| 96–143  | Preference selectors  | keep with reason | Every shared selector receives its localized visible label as `ariaLabel`.                                                                          | —                |
| 147–166 | Terminal actions      | keep with reason | Shared native-button primitives expose text labels and disabled/loading state.                                                                      | —                |

## D5 — Visual Patterns Observed

- Both onboarding presentations reuse the same preference controls and callbacks; only the page composition changes.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
