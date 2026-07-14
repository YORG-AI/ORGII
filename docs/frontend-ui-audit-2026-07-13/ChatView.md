# Frontend UI Audit — ChatView

**File:** `src/engines/ChatPanel/ChatView.tsx` (989 LOC)
**Date:** 2026-07-13
**Auditor:** Codex
**Scope:** Whole-file D1–D5 audit of the current source; the Canvas state-hook diff is noted separately below.

## D1 — Raw HTML vs Design System

No raw interactive or covered structural elements (`button`, `input`, `select`, `textarea`, `dialog`, `details`, `summary`, `table`, or `form`) appear in this file. The scroll-to-bottom control at lines 497–510 uses the design-system `Button`.

## D2 — Arbitrary Tailwind Value vs Token

No arbitrary CSS-variable or literal-color Tailwind values appear in this file.

## D3 — Hardcoded Sizes / Colors

| Line | Value         | Verdict | Reason                                                                                                                                                    | Suggested change                                                  |
| ---- | ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 891  | `top-[-28px]` | fix     | Tailwind's default spacing scale already provides 28px as `7`; the same floating-composer gradient offset also appears in `ChatFloatingComposer.tsx:221`. | In a separate UI cleanup, replace both occurrences with `-top-7`. |

## D4 — Accessibility

No raw interactive elements or non-semantic `onClick` handlers appear in this file. The design-system scroll-to-bottom `Button` has both `aria-label` and `title`; Canvas pill interaction is delegated to `CollapsedInlineRow`, which renders a named design-system `Button`.

## D5 — Visual Patterns Observed

- The floating-composer gradient offset pattern (`top-[-28px]`) appears here and in `ChatFloatingComposer.tsx`; count is 2, so it is a two-site cleanup rather than an abstraction candidate.
- Canvas pill rendering remains delegated through `ChatFloatingComposer` to the shared `CollapsedInlineRow`; `ChatView` only derives and passes the pill model.
- The current source diff replaces direct `canvasPreviewAtom` reads with `useCanvasForTurn` and adjusts Canvas shortcut eligibility. It does not add or restyle visible UI.

## Summary

- 1 fix recommended
- 0 kept with documented reason
- 0 abstract candidates
- Total source changes in this audit: 0. Landing belongs to a separate two-file D3 cleanup for `ChatView.tsx` and `ChatFloatingComposer.tsx`.
