# Frontend UI Audit — WorkItemThreadViewAction

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemThread/WorkItemThreadViewAction.tsx`
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line  | Element                  | Verdict          | Reason                                                                                                         | Suggested change |
| ----- | ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| 25–48 | Discussion / Back action | keep with reason | The action reuses the shared tertiary ghost `Button`; no local tab or raw interactive primitive is introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value               | Verdict          | Reason                                                                               | Suggested change |
| ---- | ------------------- | ---------------- | ------------------------------------------------------------------------------------ | ---------------- |
| —    | No arbitrary values | keep with reason | Visual treatment is entirely owned by the shared Button variant and semantic tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line   | Value      | Verdict          | Reason                                                                                 | Suggested change |
| ------ | ---------- | ---------------- | -------------------------------------------------------------------------------------- | ---------------- |
| 34, 36 | 13px icons | keep with reason | The icons match the design-system mini-button icon scale and compact metadata density. | —                |

## D4 — Accessibility

| Line  | Element                  | Verdict          | Reason                                                                                                                           | Suggested change |
| ----- | ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 25–48 | Discussion / Back action | keep with reason | The native shared Button has a visible translated label, keyboard activation, and focus-visible treatment; icons are decorative. | —                |

## D5 — Visual Patterns Observed

- The Work Item remains the implicit primary view; its independent footer action drills into Discussion.
- Discussion owns a separate toolbar where the same component renders Back beside the subscription action.
- No count badge is shown because the available count is total history, not unread comments.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
