# Frontend UI Audit — Unified Timeline Surfaces

**File:** `src/modules/shared/components/ActivityTimeline/index.tsx` (278 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line  | Element              | Verdict          | Reason                                                                                                                                                                | Suggested change |
| ----- | -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 20–51 | Timeline copy action | keep with reason | The icon-only interaction uses the shared `Button` through `ActivityHeaderActionButton`; remaining native elements are non-interactive semantic or layout containers. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line   | Value                   | Verdict          | Reason                                                                                                                                                                                                          | Suggested change |
| ------ | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 20–278 | Timeline surface colors | keep with reason | Cards, headers, connectors, actions, and skeletons consistently use project tokens (`chat-pane`, `primary-container`, `border-1`, `fill-2`, and `text-*`); no raw color or CSS-variable utility was introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line  | Value                           | Verdict          | Reason                                                                                                                                               | Suggested change                                                                       |
| ----- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 44–48 | 12px copy/status icons          | keep with reason | The icon size is a compact glyph measurement passed to Lucide and matches the shared mini icon-button geometry.                                      | —                                                                                      |
| 96    | `text-[12px]` header typography | abstract         | The 12px compact metadata scale is repeated broadly in timeline and workstation UI; changing only this component would fragment the current pattern. | Promote compact metadata typography to a shared token in a dedicated repository sweep. |

## D4 — Accessibility

| Line    | Element            | Verdict          | Reason                                                                                                                                               | Suggested change |
| ------- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 20–51   | Icon-only action   | keep with reason | The action supplies the same localized text to `title` and `aria-label`; the button remains keyboard accessible through the design-system primitive. | —                |
| 115–135 | Loading skeleton   | keep with reason | The skeleton exposes a localized status name, `aria-busy`, text-free decorative spans, and a reduced-motion animation override.                      | —                |
| 139–164 | Timeline connector | keep with reason | The visual rail is hidden from assistive technology while the owning item may expose a bounded semantic scroll-trail label.                          | —                |

## D5 — Visual Patterns Observed

- Pattern: work-item, issue, PR, and human-session activity now share `TimelineCard`, `TimelineCardHeader`, `TimelineEventCard`, and `ConnectedTimelineItem` instead of maintaining parallel card shells.
- Pattern: every `MarkdownContent` inside a `bg-chat-pane` timeline card passes `from-chat-pane`; the default remains `from-primary-container` for callers on the original surface.
- Caller sweep: `WorkItemActivityTimeline.tsx`, `WorkItemContent/index.tsx`, `IssueTimelineItems.tsx`, and `PrConversationTab.tsx` all follow the shared surface/fade contract.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 1 abstract candidate (>= 3 occurrences)
