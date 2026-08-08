# Frontend UI Audit — SetupWalkthroughSidebar

**File:** `src/modules/SetupWalkthrough/components/SetupWalkthroughSidebar.tsx`
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                   | Verdict          | Reason                                                                                                                                           | Suggested change |
| ---- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 68   | `SetupApplicationPreview` | keep with reason | The compact preview delegates visible controls to shared `AppLogo`, `Button`, `IconButton`, `Tooltip`, `Avatar`, and `ComposerShell` components. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                    | Suggested change |
| ---- | ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | Preview composition classes use the spacing scale and existing background, fill, border, primary, and text tokens from `layoutTokens.ts`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                                                                                           | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No arbitrary pixel class, raw hex, RGB, or inline color is present; the miniature uses the shared spacing and typography scales. | —                |

## D4 — Accessibility

| Line  | Element                             | Verdict          | Reason                                                                                                                                                                          | Suggested change |
| ----- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 53–68 | Preview visual subtree              | keep with reason | The mascot remains decorative under `aria-hidden`; the compact preview stays exposed so its named icon tabs and localized tooltips are available to pointer and keyboard users. | —                |
| 24    | Preview section heading association | keep with reason | `aria-labelledby="setup-hero-title"` points to the visible localized heading.                                                                                                   | —                |

## D5 — Visual Patterns Observed

- Interactive component-based core-surface miniature: one implementation; no abstraction candidate.
- Brand hero + mascot: existing setup-specific presentation, not repeated across three independent components.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
