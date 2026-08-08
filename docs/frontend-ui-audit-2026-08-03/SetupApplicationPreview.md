# Frontend UI Audit — SetupApplicationPreview

**File:** `src/modules/SetupWalkthrough/components/SetupApplicationPreview.tsx`
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                     | Element                  | Verdict          | Reason                                                                                                                                                                                                                             | Suggested change |
| ------------------------ | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 40–75, 165–220, 227–362  | Preview controls         | keep with reason | Tabs, tooltips, logo, avatars, composer, the file-content disclosure, and icon actions reuse shared `Button`, `Tooltip`, `AppLogo`, `Avatar`, `ComposerShell`, and `IconButton` components.                                        | —                |
| 88–117, 145–227, 364–410 | Structural preview shell | keep with reason | Semantic header, tablist navigation, tabpanel, aside, main, summary rows, the fixed split container, and the decorative Python excerpt describe this setup-only miniature; no design-system layout primitive owns the composition. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                                     | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | Feature composition classes are centralized in `SETUP_APPLICATION_PREVIEW_TOKENS` and use the established spacing, surface, border, and typography scales. | —                |

## D3 — Hardcoded Sizes / Colors

| Line             | Value                    | Verdict          | Reason                                                                                                                                            | Suggested change |
| ---------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 181–214, 266–350 | Logo, avatar, icon sizes | keep with reason | Icons use shared `HEADER_ICON_SIZE`; compact avatars use the shared component's size API; all colors come from theme tokens without raw literals. | —                |

## D4 — Accessibility

| Line             | Element                      | Verdict          | Reason                                                                                                                                                                                                                                                       | Suggested change |
| ---------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 47–75, 108–117   | Core-surface tab system      | keep with reason | Every icon tab has a localized accessible name, `aria-selected`, and panel association; the active surface uses a named `tabpanel`, while the shared tooltip supplies the hover label.                                                                       | —                |
| 165–183, 364–410 | Side file-content disclosure | keep with reason | The title-bar Workstation `PanelRight` icon button exposes localized open/close names, `aria-expanded`, and `aria-controls`; a two-track `minmax(0, 1fr)` grid locks both panes to equal widths and clips child overflow so content cannot move the divider. | —                |
| 246–281          | Composer illustration        | keep with reason | Composer actions remain non-focusable because they are illustrative; only the three surface tabs and file-content disclosure accept interaction, so the miniature cannot submit or mutate real data.                                                         | —                |

## D5 — Visual Patterns Observed

- Interactive icon-rail/core-surface miniature with a side-by-side direct-code disclosure: one setup-specific composition; no abstraction candidate.
- Shared application primitives remain the source of truth for control styling.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 abstract candidates
