# Frontend UI Audit — Team Inbox

**Files:** `src/modules/MainApp/TeamInbox/**/*.tsx`
**Date:** 2026-07-23
**Auditor:** ORGII implementation session

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `TeamInboxRow.tsx:42` | raw `<button>` listbox option | keep with reason | The row implements a multi-line `role="option"` with roving tab index and a forwarded focus ref. `Button` does not cover this listbox-row contract; visual state is sourced from `getListItemClasses`. | — |
| `TeamInboxList.tsx` | filter controls | fixed | The previous implementation manually mapped three DS Buttons into a segmented filter. | Replaced with shared `TabPill` inside `ListPanelTabPillRow`. |
| `TeamInboxList.tsx` | list header and refresh action | fixed | The previous implementation rebuilt the panel header and used a custom labelled refresh button. | Replaced with `PanelHeader`, `PANEL_HEADER_TOKENS.actionButton`, and `PanelRefreshButton`. |
| `AssignedWorkItemDetail.tsx`, `CommentMentionDetail.tsx` | duplicated detail shell | fixed | Both files rebuilt header, scroll area, width container, metadata, and bottom navigation independently. | Both now compose `TeamInboxDetailLayout`, which uses `DetailPanelContainer`, `PanelHeader`, `DETAIL_PANEL_TOKENS`, `InfoCard`, and `PanelFooter`. |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| All audited files | CSS-variable / raw-color arbitrary values | keep | No arbitrary CSS-variable, hex, rgb, or hsl Tailwind values remain. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `TeamInboxView.tsx` | split widths `320/240/420` | fixed | The Team Inbox had invented wider master/detail geometry instead of matching the existing Inbox surface. | Replaced with the established Inbox `200/160` geometry and `SplitViewLayout` defaults. |
| detail components | `p-5`, `max-w-3xl`, `gap-4`, bordered card shell | fixed | These duplicated spacing, width, and card decisions already encoded by detail-panel tokens. | Replaced with `DETAIL_PANEL_TOKENS`, `CARD_ROW_TOKENS`, and `InfoCard`. |
| compact icons | `size={14}` | keep with reason | 14px is the established compact list/action optical size and is also used by the shared Inbox/ListPanel patterns. Header action icons use `PANEL_HEADER_TOKENS`. | — |
| Team Inbox colors | semantic color classes | keep with reason | Remaining colors are semantic project tokens (`primary`, `success`, `text`, `border`) used to distinguish mention and assignment item kinds. No raw color values exist. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `TeamInboxList.tsx` | filter tabs | fixed | Shared `TabPill` now owns segmented-control semantics and interaction instead of a local button group. | — |
| `TeamInboxList.tsx` | listbox | keep with reason | The list has an accessible name, active descendant, and Arrow/Home/End keyboard navigation. | — |
| `TeamInboxRow.tsx` | option row | keep with reason | Each row has `role="option"`, `aria-selected`, an explicit read-state accessible name, and roving tab index. | — |
| header actions | icon-only controls | fixed | Refresh and mark-all now use shared header action components/tokens with explicit titles and accessible labels. | — |

## D5 — Visual Patterns Observed

- The duplicated Work Item / mention detail shell occurred twice, below the global three-site abstraction threshold, but was abstracted locally because both implementations were in the same feature and already shared an identical contract.
- The segmented filter, refresh action, panel header, detail scroll shell, metadata card, and footer are existing cross-repo patterns; Team Inbox now consumes those primitives rather than creating new variants.
- No new global design-system abstraction is required.

## Summary

- 7 fixes completed
- 4 kept with documented reason
- 0 remaining abstract candidates
