# Frontend UI Audit — GuideHighlightOverlay

**File:** `src/scaffold/Tutorials/GuideHighlightOverlay.tsx` (270 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                       | Verdict          | Reason                                                                                                                                                                                                 | Suggested change |
| ---- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 218  | Portal overlay `<div>` layers | keep with reason | These elements form a geometry-driven, pointer-transparent spotlight mask and portal boundary; the design system has no equivalent structural primitive. The dismiss action continues to use `Button`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                  | Verdict          | Reason                                                                                                                                                                                                              | Suggested change |
| ---- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 218  | `z-[10060]`            | keep with reason | The overlay must sit above the existing tutorial portal range (`10000`–`10002`) while remaining below no known product modal; this is existing overlay-layer behavior, not introduced by the delayed-target change. | —                |
| 221  | Spotlight `shadow-[…]` | keep with reason | The large spread shadow creates the cutout mask and glow in one geometry-bound declaration; ordinary elevation tokens cannot express this spotlight effect.                                                         | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                         | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ---- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 125  | Light/dark glass border alpha | keep with reason | The values complement runtime material backgrounds from `getMaterialConfig`; replacing them with a static color token would break the material pairing. | —                |
| 221  | Spotlight mask/glow colors    | keep with reason | These colors are effect parameters for the dedicated tutorial spotlight, not reusable surface or text colors.                                           | —                |

## D4 — Accessibility

| Line | Element               | Verdict          | Reason                                                                                                                                           | Suggested change |
| ---- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 219  | Visual highlight ring | keep with reason | The ring is correctly hidden from assistive technology; the adjacent localized message and named dismiss button carry the user-facing semantics. | —                |

## D5 — Visual Patterns Observed

- Pattern: high-z tutorial overlays also appear in `GeneralLayoutTour.tsx` and `CodeEditorTour.tsx`; this overlay intentionally remains a smaller runtime guide primitive rather than duplicating their step engine.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
