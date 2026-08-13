# Frontend UI Audit — Composer Bottom-Dock Spacing

**Files:** `src/config/composerStackTokens.ts`, `src/engines/ChatPanel/ChatFloatingComposer.tsx`, `src/engines/ChatPanel/ChatViewPostHistoryOverlays.tsx`, `src/features/DiscussionChannels/ChannelPanelView/ChannelComposer.tsx`, `src/features/HumanSession/HumanSessionView.tsx`, `src/modules/ProjectManager/WorkItems/components/WorkItemContent/HistoryTab.tsx`, `src/modules/ProjectManager/WorkItems/components/WorkItemThread/index.tsx`, `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrConversationTab.tsx`, and `src/modules/shared/layouts/blocks/CreatorContentLayout.tsx`
**Date:** 2026-08-09

## D1 — Raw HTML vs Design System

| Line                                                                                                                                    | Element                   | Verdict  | Reason                                                                                                                                                                                         | Suggested change                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `composerStackTokens.ts:16`                                                                                                             | Bottom-dock edge spacing  | abstract | Bottom-docked inputs are one repeated layout pattern across chat, channel, PR, human-session, work-item, and creator surfaces. A generic token prevents surface-specific padding drift.        | Use `COMPOSER_BOTTOM_DOCK_PADDING_CLASS` for every bottom-docked input or composer. |
| `ChannelComposer.tsx:65`                                                                                                                | Channel input dock        | fixed    | The channel composer hard-coded `pb-2`, leaving it 4px closer to the edge than the established chat and creator docks.                                                                         | Consume the shared `pb-3` token.                                                    |
| `HumanSessionView.tsx:266`                                                                                                              | Human-session input dock  | fixed    | The human-session composer duplicated the channel’s tighter `pb-2` footer geometry.                                                                                                            | Consume the shared `pb-3` token.                                                    |
| `PrConversationTab.tsx:435`                                                                                                             | Pull-request comment dock | fixed    | The PR comment/review input also hard-coded `pb-2`, so its edge spacing differed from work-item and chat composers.                                                                            | Consume the shared `pb-3` token.                                                    |
| `ChatFloatingComposer.tsx`, `ChatViewPostHistoryOverlays.tsx`, `WorkItemThread/index.tsx`, `HistoryTab.tsx`, `CreatorContentLayout.tsx` | Existing composer docks   | fixed    | These surfaces already resolved to `pb-3` through a chat-specific token name. Migrating them to the generic token makes the shared ownership explicit without changing their rendered spacing. | Keep all future dock spacing changes at the generic token boundary.                 |

## D2 — Arbitrary Tailwind Value vs Token

| Line                        | Value  | Verdict          | Reason                                                                                                                             | Suggested change                                            |
| --------------------------- | ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `composerStackTokens.ts:16` | `pb-3` | keep with reason | `pb-3` is the design-system utility for the requested 12px distance between a bottom-docked input and its containing surface edge. | Keep the value centralized; do not repeat it at call sites. |

## D4 — Accessibility

| Line               | Element                               | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ------------------ | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| All migrated docks | Composer semantics and focus behavior | keep with reason | The migration changes only outer layout padding. Native input/button semantics, labels, focus handling, disabled states, and keyboard behavior are unchanged. | —                |

## Summary

- 4 fixes applied
- 2 kept with documented reason
- 1 abstraction candidate implemented
