# Frontend UI Audit — SetupPreferencesPanel

**File:** `src/modules/SetupWalkthrough/components/SetupPreferencesPanel.tsx` (361 LOC)
**Related styles:** `src/modules/SetupWalkthrough/layoutTokens.ts`, `src/modules/SetupWalkthrough/setupWalkthrough.scss`
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                                   | Verdict          | Reason                                                                                                                                                    | Suggested change |
| ------- | ----------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 104–251 | Preference fields                         | keep with reason | Both presentations reuse `SectionContainer`, `SectionRow`, `LanguageSelector`, and the canonical `Select`; there is no onboarding-owned form control.     | —                |
| 254–303 | Terminal actions                          | keep with reason | Both variants use the shared `Button` component and the same callbacks/loading contract. The native variant also uses `DETAIL_PANEL_TOKENS.contentStack`. | —                |
| 305–319 | Step header and body                      | keep with reason | `WizardStepContent` owns heading semantics and body composition for both presentations.                                                                   | —                |
| 321–357 | Presentation selector and layout wrappers | keep with reason | `FormField` and `Select` own the interactive selector. Remaining `div` elements are non-interactive layout or test boundaries only.                       | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                           | Value                         | Verdict          | Reason                                                                                                                                                                        | Suggested change |
| ------------------------------ | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `layoutTokens.ts:54–70`        | Presentation layout classes   | keep with reason | All feature layout classes are centralized in `SETUP_WALKTHROUGH_LAYOUT_TOKENS`; the App-native path consumes shared `DETAIL_PANEL_TOKENS` and unmodified component defaults. | —                |
| `SetupPreferencesPanel.tsx:52` | Accent swatch utility classes | keep with reason | The swatch is a semantic preview of the active app token (`bg-primary-6`), uses the shared spacing scale, and is only rendered in the requested cinematic comparison.         | —                |

## D3 — Hardcoded Sizes / Colors

| Line                           | Value                                  | Verdict          | Reason                                                                                                                                                                                                                                       | Suggested change |
| ------------------------------ | -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `setupWalkthrough.scss:84–126` | Cinematic card, row, and CTA treatment | keep with reason | These styles intentionally preserve the historical immersive option requested for side-by-side comparison. Colors are derived from repository theme variables; the CSS is scoped to cinematic-only class names and never affects App native. | —                |
| `SetupPreferencesPanel.tsx:54` | Preference icon size                   | keep with reason | Uses the repository `HEADER_ICON_SIZE.md` token rather than a local numeric value.                                                                                                                                                           | —                |
| App-native presentation        | Component dimensions and colors        | keep with reason | The native path adds no visual overrides; `SectionContainer`, `SectionRow`, `Select`, `Button`, and shared detail-panel tokens own density, borders, radii, color, and state styling.                                                        | —                |

## D4 — Accessibility

| Line    | Element                  | Verdict          | Reason                                                                                                                                                                       | Suggested change |
| ------- | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 104–251 | Four preference controls | keep with reason | Every control has a visible localized label and matching accessible name in both presentations. Decorative icons and the accent swatch are hidden from assistive technology. | —                |
| 254–303 | Finish and skip actions  | keep with reason | Shared buttons retain visible localized names and expose disabled/loading state during close, preventing duplicate terminal actions.                                         | —                |
| 321–340 | Presentation selector    | keep with reason | The localized `FormField` label and `ariaLabel` describe the preview-only selector; it is disabled while onboarding closes.                                                  | —                |

## D5 — Visual Patterns Observed

- **App native** is the default and uses the same section container, rows, controls, typography, and buttons as Settings.
- **Cinematic card** is an explicitly selected historical presentation. Its visual overrides are isolated behind `cinematic*` layout tokens and scoped CSS classes.
- Both versions render from one canonical `useAppearanceState` instance and share the same completion/skip callbacks; presentation switching duplicates no product state or write path.
- The presentation choice is local preview state and resets to App native on the next onboarding mount.

## Summary

- 0 fixes recommended
- 12 kept with documented reason
- 0 abstract candidates
