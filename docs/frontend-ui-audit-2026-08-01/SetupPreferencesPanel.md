# Frontend UI Audit — SetupPreferencesPanel

**File:** `src/modules/SetupWalkthrough/components/SetupPreferencesPanel.tsx` (199 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                     | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| ------ | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 82–195 | Preference card composition | keep with reason | All interactive controls reuse `LanguageSelector`, `Select`, and `Button`; `SectionContainer`, `SectionRow`, and `WizardStepContent` own the repeated structural pattern. | —                |
| 41–50  | `PreferenceLabel` spans     | keep with reason | Non-interactive label composition has no covering DS primitive and is already localized by the parent row.                                                                | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                        | Verdict          | Reason                                                                                                      | Suggested change |
| ---- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary Tailwind values | keep with reason | Feature composition classes come from the centralized layout-token object; colors use project theme tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                             | Verdict          | Reason                                                                                                        | Suggested change |
| ---- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| 44   | Accent dot `h-4 w-4 bg-primary-6` | keep with reason | Uses the Tailwind spacing scale and the canonical primary-color token, so it responds to the selected preset. | —                |
| 46   | Repository icon size `18`         | keep with reason | Matches the shared 18px settings-row icon grid and is passed through the repository SVG adapter.              | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                         | Suggested change |
| ------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 103–167 | Four preference controls  | keep with reason | Every Select trigger receives a localized accessible name; the shared Select exposes combobox semantics and keyboard handling. | —                |
| 171–193 | Finish / skip actions     | keep with reason | DS Buttons have visible localized names and expose disabled/loading state during close.                                        | —                |
| 44, 181 | Decorative accent / arrow | keep with reason | Both are explicitly hidden from assistive technology.                                                                          | —                |

## D5 — Visual Patterns Observed

- The four settings rows are one `SectionRow` pattern, not four independent control implementations.
- The settings state boundary is the same `useAppearanceState` used by the main Settings surface.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 abstract candidates
