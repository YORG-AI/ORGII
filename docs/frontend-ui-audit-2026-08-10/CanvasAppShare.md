# Frontend UI Audit — CanvasApp Share

**File:** `src/engines/Simulator/apps/canvas/CanvasApp.tsx`
**Date:** 2026-08-10
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element           | Verdict          | Reason                                                                                                | Suggested change |
| ------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| 483     | Toolbar separator | keep with reason | Uses the shared workstation separator to preserve the existing header grouping pattern.               | —                |
| 493–504 | Share action      | keep with reason | Uses the shared tooltip and `Button` components with the established tertiary mini-toolbar treatment. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                    | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | The Share integration adds no arbitrary CSS-variable or raw-color values. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value          | Verdict          | Reason                                                                          | Suggested change |
| ---- | -------------- | ---------------- | ------------------------------------------------------------------------------- | ---------------- |
| 498  | Icon size `12` | keep with reason | Matches the adjacent Reload action and the established mini-toolbar icon scale. | —                |

## D4 — Accessibility

| Line    | Element      | Verdict          | Reason                                                                                                | Suggested change |
| ------- | ------------ | ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| 493–504 | Share action | keep with reason | The native shared button has visible localized text, a disabled state, and a reason-specific tooltip. | —                |

## D5 — Visual Patterns Observed

- Share follows the existing Canvas toolbar action pattern and introduces no new repeated visual primitive.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
