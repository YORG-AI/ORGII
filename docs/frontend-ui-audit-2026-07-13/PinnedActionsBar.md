# Frontend UI Audit — PinnedActionsBar

**File:** `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/index.tsx` (373 LOC)
**Date:** 2026-07-13
**Auditor:** Codex

## D1 — Raw HTML vs Design System

No hits.

## D2 — Arbitrary Tailwind Value vs Token

No hits.

## D3 — Hardcoded Sizes / Colors

| Line | Value           | Verdict | Reason                                                     | Suggested change           |
| ---- | --------------- | ------- | ---------------------------------------------------------- | -------------------------- |
| 69   | `max-w-[180px]` | fix     | The project Tailwind spacing scale defines `180: "180px"`. | Replaced with `max-w-180`. |

## D4 — Accessibility

No hits in the audited interactive-element patterns; action pills use design-system buttons with visible or explicit names.

## D5 — Visual Patterns Observed

- Canvas uses the existing `UserActionButton` pill pattern; no new visual implementation was introduced.

## Summary

- 1 fix applied
- 0 kept with documented reason
- 0 abstract candidates
