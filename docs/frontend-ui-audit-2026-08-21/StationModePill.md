# Frontend UI Audit — StationModePill

**File:** `src/modules/WorkStation/shared/StationModePill/index.tsx` (128 LOC)
**Date:** 2026-08-21
**Auditor:** Codex PR #850 CI repair

## D1 — Raw HTML vs Design System

No findings. Both interactions use the design-system `SegmentedIconButton`.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value             | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 88   | `rounded-[100px]` | keep with reason | This is the established full-pill geometry used by `SegmentedIconButton`, `TabPill`, and sidebar pill controls; replacing it at one site would break shape parity. | —                |

## D3 — Hardcoded Sizes / Colors

No findings. Button sizes and selected colors are named shared classes passed to `SegmentedIconButton`.

## D4 — Accessibility

| Line | Element                 | Verdict          | Reason                                                                                                                                     | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 51   | segmented icon controls | keep with reason | Each segment supplies a localized `ariaLabel` and `ariaPressed`, preserving keyboard-button semantics through the design-system primitive. | —                |

## D5 — Visual Patterns Observed

- The new controlled `StationModePillView` centralizes the desktop and remote-host presentation; no further abstraction candidate was found.

## Summary

- 0 fixes recommended
- 2 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
