# Frontend UI Audit — AgentEventBubbles

**File:** `src/modules/WorkStation/Chat/Communication/AgentEventBubbles.tsx` (193 LOC)
**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                  | Element                                                    | Verdict          | Reason                                                                                                                                  | Suggested change |
| --------------------- | ---------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 54–70                 | `ChatBubbleLayout`, `ChatBubbleAvatar`, `ChatBubbleHeader` | keep with reason | The refactor continues to use the canonical chat-bubble design-system primitives; no replacement raw interactive HTML was introduced.   | —                |
| 128–135, 167–171, 188 | shared chat-panel cards/adapters                           | keep with reason | `OrgSendMessageBlock`, `TaskListCard`, and `OrgTaskAdapter` remain the authoritative renderers, preventing simulator-only visual forks. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line  | Value                                               | Verdict          | Reason                                                                                                                     | Suggested change |
| ----- | --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 58–59 | `CHAT_BUBBLE_WIDTH_TOKENS.row`, `h-8 w-8 bg-fill-2` | keep with reason | Width and color use existing project tokens/scale classes; no arbitrary CSS-variable, hex, RGB, or HSL utility is present. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value     | Verdict          | Reason                                                                          | Suggested change |
| ---- | --------- | ---------------- | ------------------------------------------------------------------------------- | ---------------- |
| 59   | `h-8 w-8` | keep with reason | Uses the Tailwind spacing scale and preserves the established chat avatar size. | —                |

## D4 — Accessibility

| Line    | Element              | Verdict          | Reason                                                                                                                                                               | Suggested change |
| ------- | -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 54–70   | bubble frame         | keep with reason | Interaction semantics remain owned by `ChatBubbleLayout`; the extracted model did not add non-semantic click targets or remove the visible sender/timestamp content. | —                |
| 167–171 | task-list navigation | keep with reason | Navigation remains delegated to the existing `TaskListCard`, so its established accessible control is preserved.                                                     | —                |

## D5 — Visual Patterns Observed

- The event bubbles deliberately reuse the same `ChatBubble*` primitives and chat-panel adapters as the main chat surface.
- No new independent visual implementation appears three or more times; no abstraction candidate was created by this refactor.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
