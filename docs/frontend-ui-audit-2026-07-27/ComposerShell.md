# Frontend UI Audit — ComposerShell

**File:** `src/components/ComposerShell/index.tsx` (117 LOC)
**Date:** 2026-07-27
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element       | Verdict          | Reason                                                                                                                                           | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 98   | Shell `<div>` | keep with reason | This is the non-interactive structural primitive that defines the design-system composer surface; focus remains on its child editor and buttons. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line  | Value                             | Verdict          | Reason                                                                                                                                | Suggested change |
| ----- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 47–78 | Imported composer surface classes | keep with reason | Radius, background, border, and focus-ring values come from the project-owned `INPUT_AREA` token set rather than being restated here. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 50   | `px-1.5 py-1.5 gap-1.5` | keep with reason | The compact comment variant uses the existing Tailwind spacing scale and the shared composer radius token; no raw pixel or color literal is introduced. | —                |

## D4 — Accessibility

| Line   | Element        | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------ | -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 98–110 | Composer shell | keep with reason | The wrapper adds no competing role or tab stop; focus-visible behavior is derived from its interactive descendants via `focus-within`. | —                |

## D5 — Visual Patterns Observed

- Pattern: bordered composer surface with tokenized background and focus treatment is already abstracted here and used by chat, session creation, message editing, and now work-item comments.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
