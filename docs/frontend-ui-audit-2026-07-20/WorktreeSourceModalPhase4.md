# Frontend UI Audit — WorktreeSourceModal Phase 4

**Files:**

- `src/features/SessionCreator/components/WorktreeSmartTab.tsx` (129 LOC)
- `src/features/SessionCreator/components/WorktreeGitHubTab.tsx` (119 LOC)
- `src/features/SessionCreator/components/WorktreeSourceModal.tsx` (565 LOC after Phase 4)

**Date:** 2026-07-21
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line        | Element                     | Verdict          | Reason                                                                                        | Suggested change |
| ----------- | --------------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| Smart leaf  | labeled search input        | keep with reason | Uses shared `Input`; the native label provides the visible field name and stable association. | —                |
| GitHub leaf | search and refresh controls | keep with reason | Uses shared `Input` and the audited input-suffix refresh control from Phase 1.                | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line        | Value | Verdict          | Reason                                                                                                         | Suggested change |
| ----------- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| both leaves | none  | keep with reason | No arbitrary color, raw color, or CSS-variable utility was introduced; surfaces and text use semantic classes. | —                |

## D3 — Hardcoded Sizes / Colors

| Line        | Value                         | Verdict          | Reason                                                                                          | Suggested change                                                  |
| ----------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| both leaves | `min-h-[250px]`, `h-[180px]`  | keep with reason | Preserves the established modal tab/status-canvas geometry exactly across all four source tabs. | Consider only in a modal-wide sizing-token pass.                  |
| both leaves | `text-[12px]` / `text-[13px]` | keep with reason | Preserves the compact selector hierarchy moved unchanged from the modal.                        | Consider only in a repository-wide compact-menu typography sweep. |

## D4 — Accessibility

| Line        | Element            | Verdict          | Reason                                                                                    | Suggested change |
| ----------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| Smart leaf  | search label/input | keep with reason | Retains `htmlFor`/`id` association plus a contextual `aria-label`.                        | —                |
| GitHub leaf | search input       | keep with reason | Retains a contextual `aria-label`; refresh suffix has its own translated accessible name. | —                |
| GitHub leaf | error state        | keep with reason | Retains `role="alert"` and `aria-live="assertive"`.                                       | —                |
| both leaves | suggestion rows    | keep with reason | Reuses the native-button source row with visible title and keyboard semantics.            | —                |

## D5 — Visual Patterns Observed

- Smart, GitHub, Branch, and Name now share one audited list/row vocabulary while each tab owns its source-specific status and input composition.
- The fixed status canvas is repeated across three tab leaves; it is intentionally retained because the state semantics and custom-ref placement differ. No new abstraction is recommended.

## Summary

- 0 fixes recommended
- 9 kept with documented reason
- 0 abstract candidates
