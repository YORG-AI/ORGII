# Frontend UI Audit — RemoteSessionChatPanelSurface

**File:** `src/engines/ChatPanel/components/RemoteSessionChatPanelSurface.tsx` (194 LOC)
**Date:** 2026-08-21
**Auditor:** Codex PR #850 CI repair

## D1 — Raw HTML vs Design System

No findings. Interactive presentation uses the existing `SelectorPill` and `SessionReadOnlyBar` components.

## D2 — Arbitrary Tailwind Value vs Token

No findings.

## D3 — Hardcoded Sizes / Colors

| Line | Value                 | Verdict          | Reason                                                                                                                   | Suggested change |
| ---- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 80   | agent icon `size: 14` | keep with reason | The compact icon is shared by the published header and selector pill and matches the established selector icon geometry. | —                |

## D4 — Accessibility

| Line | Element                 | Verdict          | Reason                                                                                                     | Suggested change |
| ---- | ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| 154  | disabled `SelectorPill` | keep with reason | The component supplies an explicit localized `ariaLabel`; the icon is decorative and marked `aria-hidden`. | —                |

## D5 — Visual Patterns Observed

- Read-only transcript chrome composes existing shared primitives; no repeated pattern requiring a new abstraction was found.

## Summary

- 0 fixes recommended
- 2 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
