# Frontend UI Audit — Idle Scroll Chrome Sweep

**File:** `src/engines/ChatPanel/ChatHistory/components/ConversationMinimap.tsx` (421 LOC) and semantic peers
**Date:** 2026-07-22
**Auditor:** ORGII coding session

## D1 — Raw HTML vs Design System

| Line                          | Element                        | Verdict          | Reason                                                                                                                                                                     | Suggested change |
| ----------------------------- | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ConversationMinimap.tsx:288` | `<nav>` conversation navigator | keep with reason | Semantic navigation landmark is appropriate; no design-system component covers this scroll-position rail.                                                                  | —                |
| `ConversationMinimap.tsx:358` | Raw marker `<button>`          | keep with reason | The buttons are custom 8–20px minimap hit areas with `aria-label`, focus styling, and `aria-current`; standard Button/IconButton geometry does not cover this interaction. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                          | Value                                          | Verdict          | Reason                                                                                                                                                                                       | Suggested change |
| ----------------------------- | ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ConversationMinimap.tsx:293` | `@[640px]/chatbody:*` container-query variants | keep with reason | These are layout breakpoints rather than project-owned color-token escapes. The display override was the defect; the remaining width/alignment variants are intentional responsive geometry. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                          | Value      | Verdict          | Reason                                                                                    | Suggested change |
| ----------------------------- | ---------- | ---------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| `ConversationMinimap.tsx:293` | `w-[38px]` | keep with reason | The 38px rail aligns marker hit areas and hover controls; no color literal is introduced. | —                |
| `ConversationMinimap.tsx:379` | `h-[3px]`  | keep with reason | Sub-spacing-scale marker thickness is an optical micro-size.                              | —                |

## D4 — Accessibility

| Line                              | Element             | Verdict          | Reason                                                                                        | Suggested change |
| --------------------------------- | ------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| `ConversationMinimap.tsx:288-306` | Navigator landmark  | keep with reason | It has an accessible navigation label and clears preview state when focus leaves the control. | —                |
| `ConversationMinimap.tsx:358-385` | Turn marker buttons | keep with reason | Every marker has an accessible name, keyboard focus support, and current-position semantics.  | —                |

## D5 — Visual Patterns Observed

- **Confirmed fixed pattern:** `ConversationMinimap.tsx:293` combined state-driven `hidden` with `@[640px]/chatbody:flex`; the responsive display utility overrode the idle state on wide chat panes. The forced responsive display utility was removed.
- **No additional occurrence:** a repository-wide sweep found no other scroll/minimap component combining conditional idle hiding with a responsive display override.
- **Intentional persistent rail:** `src/modules/shared/layouts/FocusedChatWorkstationRail.tsx:350-356` is a user-operated workstation shortcut panel shown only for maximized session chat at `xl`; it is not a scroll-position indicator and has no idle visibility contract.
- **Intentional editor scroll chrome:** `src/components/CustomScrollbar/index.tsx` is shared by CodeMirror editor/diff/conflict surfaces. It starts transparent, appears during scroll or editor hover, and hides with bounded timers that are cleared on unmount.
- **Intentional chat code-block behavior:** `src/engines/ChatPanel/blocks/CodeBlock/index.scss:8-38,71-105` hides horizontal scrollbars by default and reveals them only on hover or while `data-scrolling` is set.
- **Intentional native scroll surfaces:** `.scrollbar-overlay`, `.dropdown-options-scrollbar`, and `.select-options-overlay` are explicit visible-scrollbar policies for detail panels, long option lists, previews, and editors. They do not use the defective conditional-hidden/responsive-display pattern.
- **Already hidden surfaces:** chat history list, turn-page list, settings surfaces, sidebars, tab strips, and work-item detail containers use `scrollbar-hide` or scoped `scrollbar-width: none`.

## Summary

- 1 fix confirmed (the reported conversation minimap responsive override)
- 8 kept with documented reason / intentional semantic peers
- 0 additional same-class defects
- 0 abstract candidates
