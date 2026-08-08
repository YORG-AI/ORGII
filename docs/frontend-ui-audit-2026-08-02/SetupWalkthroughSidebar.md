# Frontend UI Audit — SetupWalkthroughSidebar

**File:** `src/modules/SetupWalkthrough/components/SetupWalkthroughSidebar.tsx` (59 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line  | Element                                                    | Verdict          | Reason                                                                                            | Suggested change |
| ----- | ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| 16–53 | `<section>`, heading, copy, and decorative layout wrappers | keep with reason | Semantic content and non-interactive composition; shared interactive controls are not applicable. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                       | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------ | ---------------- |
| —    | None  | keep with reason | All visual classes come from the feature layout-token owner. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value               | Verdict          | Reason                                                                           | Suggested change |
| ---- | ------------------- | ---------------- | -------------------------------------------------------------------------------- | ---------------- |
| 24   | `AppLogo size={36}` | keep with reason | Shared logo API requires a numeric size and this is the desktop hero brand role. | —                |

## D4 — Accessibility

| Line         | Element                  | Verdict          | Reason                                                                                                      | Suggested change |
| ------------ | ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| 16–18, 33–38 | Hero section and heading | keep with reason | `aria-labelledby` points to the visible translated heading.                                                 | —                |
| 44–50        | Planet and mascot        | keep with reason | The visual container is `aria-hidden` and the image has empty alt text, so decorative art is not announced. | —                |

## D5 — Visual Patterns Observed

- The mascot hero is isolated in one presentation-only component and reuses `AppLogo`; no repeated hero implementation was introduced.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
