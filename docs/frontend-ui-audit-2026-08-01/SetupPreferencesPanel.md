# Frontend UI Audit — Setup preferences presentations

**Files:** `src/modules/SetupWalkthrough/components/SetupPreferencesPanel.tsx` (388 LOC), `SetupWalkthroughSidebar.tsx` (62 LOC)

**Related styles:** `src/modules/SetupWalkthrough/layoutTokens.ts`, `src/modules/SetupWalkthrough/setupWalkthrough.scss`

**Date:** 2026-08-01

**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                | Element                            | Verdict          | Reason                                                                                                                                                          | Suggested change |
| ----------------------------------- | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SetupPreferencesPanel.tsx:123–247` | Preference fields                  | keep with reason | All three presentations reuse `SectionContainer`, `SectionRow`, `LanguageSelector`, and the canonical `Select`; onboarding owns no form control implementation. | —                |
| `SetupPreferencesPanel.tsx:249–298` | Terminal actions                   | keep with reason | All presentations use shared `Button` components and the same loading, disabled, completion, and skip callbacks.                                                | —                |
| `SetupPreferencesPanel.tsx:300–324` | Step content                       | keep with reason | `WizardStepContent` owns heading semantics and body composition for all three presentations.                                                                    | —                |
| `SetupPreferencesPanel.tsx:326–384` | Presentation selector and wrappers | keep with reason | `FormField` and `Select` own the interactive selector. Remaining `div`/`span` elements are non-interactive layout, brand-copy, or test boundaries.              | —                |
| `SetupWalkthroughSidebar.tsx:18–59` | Cinematic hero                     | keep with reason | Reuses `AppLogo`; the ORG2-specific mascot is a decorative raster asset with empty alt text and no duplicated interaction.                                      | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                           | Value                     | Verdict          | Reason                                                                                                                                                                                                       | Suggested change |
| ------------------------------ | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `layoutTokens.ts:19–82`        | Setup composition classes | keep with reason | Feature composition is centralized in `SETUP_WALKTHROUGH_LAYOUT_TOKENS`; typography reuses `TYPOGRAPHY`, the native path reuses `DETAIL_PANEL_TOKENS`, and controls retain their component defaults.         | —                |
| `layoutTokens.ts:57–64`        | Classic panel hierarchy   | keep with reason | One outer surface frames the panel; the reused `SectionContainer` keeps row separators but suppresses its nested border/background, while canonical ghost `Select`s remove the repeated input-box treatment. | —                |
| `SetupPreferencesPanel.tsx:52` | Active-color swatch       | keep with reason | The swatch previews the active repository token via `bg-primary-6`; it does not declare a local color.                                                                                                       | —                |

## D3 — Hardcoded Sizes / Colors

| Line                           | Value                                      | Verdict          | Reason                                                                                                                                                                                                                     | Suggested change |
| ------------------------------ | ------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `setupWalkthrough.scss:1–132`  | Ambient, planet, card, row, and CTA colors | keep with reason | Every rendered color is derived from `--color-primary-*`, `--color-bg-*`, `--color-fill-*`, `--color-border-*`, or `--color-text-*`. No fixed brand hue remains; choosing another primary color updates the whole surface. | —                |
| `SetupPreferencesPanel.tsx:54` | Preference icon size                       | keep with reason | Uses the repository `HEADER_ICON_SIZE.md` token rather than a local numeric value.                                                                                                                                         | —                |
| App-native presentation        | Component dimensions and colors            | keep with reason | Adds no visual override: section, row, select, button, and detail-panel contracts own density, borders, radii, colors, and states.                                                                                         | —                |

## D4 — Accessibility

| Line                                | Element                  | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ----------------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `SetupPreferencesPanel.tsx:123–247` | Four preference controls | keep with reason | Each control has a visible localized label and matching accessible name in every presentation. Decorative icons and swatches are hidden from assistive technology. | —                |
| `SetupPreferencesPanel.tsx:249–298` | Finish and skip actions  | keep with reason | Shared buttons expose localized names and disabled/loading state while closing, preventing duplicate terminal actions.                                             | —                |
| `SetupPreferencesPanel.tsx:326–347` | Presentation selector    | keep with reason | Localized `FormField` label and `ariaLabel` describe this preview-only selector; it becomes disabled while onboarding closes.                                      | —                |
| `SetupWalkthroughSidebar.tsx:42–56` | Planet and mascot        | keep with reason | The visual group and decorative asset are explicitly excluded from the accessibility tree.                                                                         | —                |

## D5 — Visual Patterns Observed

- **App native** is the default and uses the same section container, rows, controls, typography, and buttons as Settings.
- **Immersive card** keeps the previously requested cinematic treatment, isolated behind `cinematic*` composition tokens and scoped CSS.
- **Classic panel** reuses `WizardStepContent`, a border-free `SectionContainer`, horizontal `SectionRow`, canonical ghost selectors, and canonical buttons. The duplicate logo/header was removed because the shell already owns ORGII branding.
- The ambient background, hero accent, planet, focus states, and CTA all derive from active theme tokens. Changing the primary-color preference immediately recolors the surface.
- All presentations render from one `useAppearanceState` instance and share one completion/skip path. Presentation selection is local preview state and resets to App native on remount.
- The hero now uses the ORG2 pearl-relay mascot (`org2-pearl-relay-mascot.png`) instead of the Codex-like blue cloud/terminal character while preserving the existing layout contract.

## Summary

- 0 fixes recommended
- 15 kept with documented reason
- 0 abstract candidates
