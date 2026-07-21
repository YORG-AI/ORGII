# Frontend UI Audit — WorktreeSourceModal Phase 1

**Files:**

- `src/features/SessionCreator/components/WorktreeSourceModal.tsx` (884 LOC after Phase 1)
- `src/features/SessionCreator/components/WorktreeSourceModalRows.tsx` (99 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line | Element                   | Verdict          | Reason                                                                                                                                                                                  | Suggested change |
| ---- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| leaf | refresh suffix `<button>` | keep with reason | This is a borderless icon control embedded inside a shared `Input` suffix; it needs exact input-row geometry and stops propagation before invoking refresh.                             | —                |
| leaf | source row `<button>`     | keep with reason | The semantic action is a full-width multi-column selectable row with icon, title, optional detail/meta, and selected indicator; shared `Button` does not cover this command-row layout. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| leaf | none  | keep with reason | The extracted leaves use existing semantic surface/text classes and shared dropdown geometry tokens; no arbitrary color or CSS-variable class was introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                              | Verdict          | Reason                                                                                                  | Suggested change                                                        |
| ---- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| leaf | `text-[12px]` / `text-[13px]`      | keep with reason | Preserves the existing compact dropdown row hierarchy and was moved unchanged from the modal.           | Consider only in a repository-wide compact-menu typography token sweep. |
| leaf | icon sizes 14 / shared search size | keep with reason | Row icons preserve the established compact selector grid; refresh icon uses `DROPDOWN_SEARCH.iconSize`. | —                                                                       |

## D4 — Accessibility

| Line | Element        | Verdict          | Reason                                                                                                                            | Suggested change |
| ---- | -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| leaf | refresh suffix | keep with reason | Native button receives a caller-provided contextual `aria-label`, disabled state, and preserves event isolation.                  | —                |
| leaf | source row     | keep with reason | Native button has visible title/detail text and selected state remains visually represented without replacing keyboard semantics. | —                |

## D5 — Visual Patterns Observed

- All four tabs now consume one list wrapper and one source-row implementation from a dedicated leaf module.
- The refresh suffix is shared by GitHub and Branch search inputs; no third independent implementation was found in this modal scope.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 abstract candidates
