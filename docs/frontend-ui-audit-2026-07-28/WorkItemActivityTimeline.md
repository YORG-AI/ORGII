# Frontend UI Audit — WorkItemActivityTimeline

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemContent/WorkItemActivityTimeline.tsx` (329 LOC)
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                                             | Verdict          | Reason                                                                                                                                                                                                                              | Suggested change |
| ------- | --------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 206–281 | `<details>` / `<summary>` grouped-change disclosure | keep with reason | Native disclosure provides the exact local open/closed semantics, keyboard activation and screen-reader state needed inside a compact `TimelineEventCard`; `CollapsibleSection` would add section-level spacing and heading chrome. | —                |
| 316–327 | `<details>` / `<summary>` multi-field disclosure    | keep with reason | This is the existing semantic text disclosure for one event and needs no independent React state or custom interactive element.                                                                                                     | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                      | Verdict          | Reason                                                                                            | Suggested change |
| ---- | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary color or CSS-variable utility | keep with reason | All foreground, surface and border colors use `text-*`, `bg-fill-*` and `border-border-*` tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                 | Value                             | Verdict          | Reason                                                                                                                                   | Suggested change |
| -------------------- | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 39–44, 153, 205, 261 | 12px / 14px Lucide icon API sizes | keep with reason | These match the 12px shared timeline row typography and its 20px icon container; no raw color literal or layout dimension is introduced. | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                                                                                  | Suggested change |
| ------- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 206–281 | Grouped-change disclosure | keep with reason | The visible actor, semantic change count, fields and timestamp form the accessible summary; native disclosure supplies focus and Enter/Space behavior, while the chevron is decorative. | —                |
| 117–141 | Comment avatar/header     | keep with reason | Actor and localized action remain visible text; the avatar is supplementary and the exact timestamp remains a semantic `<time>`.                                                        | —                |

## D5 — Visual Patterns Observed

- Work-item comments and events reuse `TimelineCard`, `TimelineCardHeader`, `TimelineEventCard`, `ConnectedTimelineItem` and `TimelineStack`; no parallel card language was introduced.
- Team Inbox derives its Discussion and Activity history projections with the shared `isDiscussionEntry` predicate before rendering; the default Work Item History keeps the same canonical entries unified.
- Delegation events are classified by stable actor id, so member-name resolution cannot turn system activity into a human comment; display-name matching remains only as a legacy fallback.
- Compact field chips follow the existing Project Manager count/badge treatment. This is one local use, below the abstraction threshold.
- To-Do-only bursts reuse the same grouped timeline renderer and substitute semantic copy derived from persisted snapshots; no checklist-specific card implementation was introduced.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
