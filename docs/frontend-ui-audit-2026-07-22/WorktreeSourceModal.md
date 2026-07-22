# Frontend UI Audit — WorktreeSourceModal

**File:** `src/features/SessionCreator/components/WorktreeSourceModal.tsx` (978 LOC)
**Date:** 2026-07-22
**Auditor:** Codex worktree data-flow fix

## D1 — Raw HTML vs Design System

| Line | Element                   | Verdict          | Reason                                                                                                                                                                         | Suggested change |
| ---- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 200  | Refresh suffix `<button>` | keep with reason | It is an icon-only suffix embedded inside the DS `Input`; the zero-padding transparent hit area and propagation stop are specific to that composition. It has an `aria-label`. | —                |
| 227  | Source result `<button>`  | keep with reason | This is a full-width, multi-column selectable row with icon, two text levels, metadata, and selection state; the DS `Button` does not cover this list-option layout.           | —                |
| 938  | Tab `<button>`            | keep with reason | The control implements the WAI-ARIA tab roles and a border-strip shape not covered by the general DS button variants.                                                          | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                 | Verdict          | Reason                                            | Suggested change |
| ---- | ----------------------------------------------------- | ---------------- | ------------------------------------------------- | ---------------- |
| —    | No project CSS-variable or raw-color arbitrary values | keep with reason | The audited component uses existing color tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line             | Value                         | Verdict          | Reason                                                                                                                                                                     | Suggested change                                                                  |
| ---------------- | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 240–250, 543–950 | `text-[12px]` / `text-[13px]` | abstract         | Repository sweep found these typography literals in 242 and 205 files respectively, so this is a design-token gap rather than a worktree-local fix.                        | Define semantic compact/body typography utilities in a separate systematic sweep. |
| 540–966          | `min-h-[250px]` / `h-[180px]` | keep with reason | These values establish stable modal and empty-state geometry; there is no matching spacing token, and changing them would be a visual redesign outside this data-flow fix. | —                                                                                 |

## D4 — Accessibility

| Line | Element        | Verdict          | Reason                                                                                | Suggested change |
| ---- | -------------- | ---------------- | ------------------------------------------------------------------------------------- | ---------------- |
| 200  | Refresh suffix | keep with reason | Icon-only control has an explicit localized accessible name.                          | —                |
| 227  | Source row     | keep with reason | Visible title/detail provide an accessible name and native button keyboard semantics. | —                |
| 938  | Tab strip      | keep with reason | Uses `tablist`, `tab`, `aria-selected`, `aria-controls`, and labelled tab panels.     | —                |

## D5 — Visual Patterns Observed

- Pattern: fixed-height loading/error/empty panel is repeated across the four source tabs. This is an abstract candidate for a shared source-state panel, but it predates and is unrelated to the launch data-flow change.
- Pattern: compact 12px/13px typography is repository-wide and should be handled as a token-level sweep, not site by site.

## Summary

- 0 fixes recommended in this change
- 7 kept with documented reason
- 2 abstract candidates (>= 3 occurrences)
