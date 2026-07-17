# Frontend UI Audit — DownloadProgress

**File:** `src/scaffold/AppUpdater/DownloadProgress.tsx` (128 LOC)

**Companion styles:** `src/scaffold/AppUpdater/DownloadProgress.scss` (118 LOC)

**Date:** 2026-07-16

**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                        | Verdict          | Reason                                                                                                                                                                                                | Suggested change |
| ---- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 108  | `<button>` liquid download orb | keep with reason | The orb requires a clipped, percentage-driven liquid layer and fixed circular overlay geometry that the design-system `Button` content wrapper does not expose. Native button semantics are retained. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line       | Value                                        | Verdict          | Reason                                                                                                                          | Suggested change |
| ---------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 104        | `--download-progress` inline custom property | keep with reason | This is runtime progress state, not a project-owned static design value; CSS consumes it as the liquid height.                  | —                |
| SCSS 48–63 | primary-token gradient and wave mix          | keep with reason | Both colors come from project tokens; the mix supplies the translucent moving liquid edge and has no equivalent static utility. | —                |

## D3 — Hardcoded Sizes / Colors

| Line       | Value                  | Verdict          | Reason                                                                                                                                             | Suggested change |
| ---------- | ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| SCSS 11–12 | `2.75rem` orb diameter | keep with reason | The 44px floating target is deliberately larger than the 40px large-button token and meets touch-target guidance while remaining visually compact. | —                |

## D4 — Accessibility

| Line    | Element               | Verdict          | Reason                                                                                                                                      | Suggested change |
| ------- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 59–65   | progressbar semantics | keep with reason | Provides label, min/max, current value when determinate, and human-readable downloaded-size text.                                           | —                |
| 108–126 | liquid orb button     | keep with reason | Uses native keyboard semantics, a progress-aware accessible name, visible focus treatment, decorative child layers, and reduced-motion CSS. | —                |

## D5 — Visual Patterns Observed

- Liquid-fill collapsed progress orb: one implementation; no abstraction candidate.
- Linear progress uses the existing `ProgressBar` design-system component.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
