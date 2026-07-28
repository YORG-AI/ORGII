# Frontend UI Audit — HistoryTab composition

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemContent/HistoryTab.tsx`
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line   | Element                                    | Verdict          | Reason                                                                                                                                              | Suggested change |
| ------ | ------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| thread | Subscription and submit actions            | keep with reason | Both actions use the shared `Button`; editing continues through `RichMarkdownEditor` and `ComposerShell`.                                           | —                |
| thread | Activity-history `<details>` / `<summary>` | keep with reason | Native disclosure supplies default-collapsed state, keyboard activation and screen-reader expanded state without introducing duplicate React state. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line   | Value                      | Verdict          | Reason                                                                                                                                        | Suggested change                                   |
| ------ | -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| —      | No arbitrary color utility | keep with reason | Layout uses the spacing scale and detail-panel tokens; runtime avatar colors are passed through the `Avatar` API with design-token fallbacks. | —                                                  |
| thread | Activity-history surface   | fix              | A primary-brand container token gave secondary audit history the visual weight of a primary action.                                           | Replaced with the neutral `bg-bg-2` surface token. |

## D3 — Hardcoded Sizes / Colors

| Line   | Value                                                                        | Verdict          | Reason                                                                                                                          | Suggested change |
| ------ | ---------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| thread | 16px icon, 28px avatar/editor minimum, 120px editor maximum, 13px empty copy | keep with reason | Values are component API dimensions or the established compact-thread type scale; the maximum bounds the auto-growing composer. | —                |

## D4 — Accessibility

| Line   | Element                                 | Verdict          | Reason                                                                                                                                                                           | Suggested change |
| ------ | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| thread | Subscription and comment submit buttons | keep with reason | The icon-only submit action has localized `title` and `aria-label`, plus native disabled/loading states.                                                                         | —                |
| thread | Discussion region                       | keep with reason | The localized `aria-label` names the region; read-only mode removes the non-functional composer while preserving comments, audit history and subscription controls.              | —                |
| thread | Sticky composer                         | keep with reason | It remains last in DOM order; the wrapper is transparent while `ComposerShell` owns its semantic input surface, and the composer stays reachable in the owning thread container. | —                |

## D5 — Visual Patterns Observed

- Thread presentation derives a comments-first Discussion and a default-collapsed Activity history from one canonical timeline; it does not duplicate or rewrite persisted events.
- Timeline rendering remains owned by `WorkItemActivityTimeline`; `HistoryTab` composes the two projections, subscription and editor.
- The comment editor continues to reuse `ComposerShell variant="comment"` in thread mode.
- Discussion visibility is owned once by the parent drill-in action; only the audit-history disclosure owns local open/closed state.

## Summary

- 1 fix applied
- 7 kept with documented reason
- 0 abstract candidates
