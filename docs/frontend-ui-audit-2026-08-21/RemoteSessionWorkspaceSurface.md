# Frontend UI Audit — RemoteSessionWorkspaceSurface

**File:** `src/engines/Simulator/components/RemoteSessionWorkspaceSurface.tsx` (228 LOC)
**Date:** 2026-08-21
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line     | Element             | Verdict          | Reason                                                                                                     | Suggested change |
| -------- | ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| 122, 183 | Progress indicators | keep with reason | Both states use the shared `ProgressBar`; no raw interactive control duplicates a design-system component. | —                |
| 208      | Retry action        | keep with reason | The retry action uses the shared `Button` with the compact tertiary variant.                               | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                            | Verdict          | Reason                                                                                               | Suggested change |
| ---- | ------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary CSS-variable or raw-color utilities | keep with reason | New surfaces use the existing `bg-bg-2`, `text-text-*`, `border-border-2`, and `bg-danger-1` tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                         | Verdict          | Reason                                                                                                                                                                                            | Suggested change |
| ---- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 194  | `text-[11px]` progress detail | keep with reason | This matches the existing 11px WorkStation status-row typography, including the same-file refresh banner and `SectionStatusRow`; the current typography scale has no equivalent semantic utility. | —                |
| 203  | `text-[11px]` refresh banner  | keep with reason | Pre-existing compact WorkStation status typography; keeping both adjacent status rows aligned avoids a one-off size mismatch.                                                                     | —                |

## D4 — Accessibility

| Line     | Element         | Verdict          | Reason                                                                                                                                   | Suggested change |
| -------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 115      | Loading spinner | keep with reason | Decorative spinner is `aria-hidden`, respects reduced motion, and does not replace the semantic progress element.                        | —                |
| 122, 183 | `ProgressBar`   | keep with reason | Shared component exposes `role="progressbar"`, a localized accessible name, determinate value when known, and human-readable value text. | —                |
| 133, 195 | Progress text   | keep with reason | `aria-live="polite"` announces throttled progress without moving focus or interrupting the user.                                         | —                |
| 208      | Retry button    | keep with reason | Visible localized label supplies the accessible name and the design-system button supplies keyboard semantics.                           | —                |

## D5 — Visual Patterns Observed

- Centered and compact loading states deliberately share the same `ProgressBar` component and progress model.
- The compact banner follows the existing WorkStation status-row pattern. No third independent custom implementation was introduced, so there is no abstraction candidate.

## Summary

- 0 fixes recommended
- 9 kept with documented reason
- 0 abstract candidates
