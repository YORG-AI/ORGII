# Frontend UI Audit — FindSkillsSection

**Files:**

- `src/modules/MainApp/Integrations/Skills/Table/FindSkillsSection.tsx` (69 LOC)
- `src/modules/MainApp/Integrations/Skills/Table/FindSkillsSection/FindSkillsResults.tsx` (159 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                                   | Element                | Verdict          | Reason                                                                                                                                | Suggested change |
| -------------------------------------- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FindSkillsSection.tsx:26–39`          | expand action          | keep with reason | Uses the canonical `Button` inside `SectionRow`; the coordinator adds no raw interactive element.                                     | —                |
| `FindSkillsResults.tsx:90–102,132–140` | preview/search actions | keep with reason | Both actions use the design-system `Button`; row click suppression now occurs on the semantic button rather than a clickable wrapper. | —                |
| `FindSkillsResults.tsx:109–157`        | search `<form>`        | keep with reason | Native form submission is required for Enter-key search and wraps the existing `SettingsTable` search surface.                        | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                        | Value                 | Verdict          | Reason                                                                                                                                              | Suggested change |
| --------------------------- | --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FindSkillsResults.tsx:154` | `w-[calc(100%+2rem)]` | keep with reason | This compensates for the established expanded SettingsTable container padding; it is a layout calculation rather than a missing color/design token. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                       | Value          | Verdict          | Reason                                                                                                                                                                                                          | Suggested change |
| -------------------------- | -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FindSkillsSection.tsx:45` | `text-[12px]`  | keep with reason | A repository sweep shows this is the established integrations/settings compact typography pattern. Changing one alert would reduce local consistency; typography consolidation remains a separate global sweep. | —                |
| `FindSkillsResults.tsx:93` | icon size `14` | keep with reason | Matches the existing small Button icon grid and preserves the pre-refactor visual size.                                                                                                                         | —                |

## D4 — Accessibility

| Line                            | Element                       | Verdict          | Reason                                                                                                     | Suggested change |
| ------------------------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `FindSkillsResults.tsx:109–157` | search form and submit button | keep with reason | Semantic form submission supports keyboard Enter; visible translated labels provide accessible names.      | —                |
| `FindSkillsResults.tsx:90–102`  | preview action                | keep with reason | The action is a semantic Button with visible text; stopping propagation does not remove keyboard behavior. | —                |

## D5 — Visual Patterns Observed

- The module continues to use `SettingsTable`, `SectionContainer`, `SectionRow`, and `Button` rather than introducing feature-specific table or action primitives.
- `text-[12px]` is part of an existing repository-wide typography sweep and is not changed site-by-site here.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
