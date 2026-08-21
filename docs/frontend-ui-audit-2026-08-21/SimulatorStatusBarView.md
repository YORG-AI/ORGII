# Frontend UI Audit — SimulatorStatusBarView

**File:** `src/engines/Simulator/components/SimulatorStatusBar/SimulatorStatusBarView.tsx` (183 LOC)
**Date:** 2026-08-21
**Auditor:** Codex PR #850 CI repair

## D1 — Raw HTML vs Design System

| Line | Element                             | Verdict          | Reason                                                                                                                                                                     | Suggested change |
| ---- | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 96   | free-browse `<button>`              | keep with reason | This is a 20 px transport control inside a custom replay pill; the general Button component does not own this geometry, while Tooltip provides the standard help surface.  | —                |
| 109  | previous/play/next `<button>` group | keep with reason | These controls use the shared `STATUS_BAR_ICON_BTN_20*` tokens and must preserve the compact circular primary/neutral replay states extracted from the desktop status bar. | —                |
| 167  | follow `<button>`                   | keep with reason | The text transport uses the shared `STATUS_BAR_TEXT_20` token and lives inside the same custom replay control, not a general form/action surface.                          | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value         | Verdict          | Reason                                                                                                                   | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 79   | `text-[11px]` | keep with reason | The 11 px compact status label is an established cross-repo microcopy size and is coupled to the 20 px transport height. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                | Verdict          | Reason                                                                                                                         | Suggested change |
| ---- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 103  | 12 px transport icon | keep with reason | The icon size is intentionally nested in the named 20 px status-bar control geometry and matches the sibling play/pause icons. | —                |

## D4 — Accessibility

| Line | Element                   | Verdict          | Reason                                                                                                                               | Suggested change |
| ---- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 96   | replay transport controls | keep with reason | Every icon-only control has a localized accessible name; previous/play/next also expose disabled state, and Follow has visible text. | —                |

## D5 — Visual Patterns Observed

- The controlled replay pill is the shared abstraction used by desktop and Web adapters; no third unabstracted transport pattern was found in this extraction.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
