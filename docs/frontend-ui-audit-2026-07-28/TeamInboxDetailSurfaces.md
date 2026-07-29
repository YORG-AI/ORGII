# Frontend UI Audit — Team Inbox Detail Surfaces

**Files:**

- `src/modules/MainApp/TeamInbox/components/TeamInboxDetailLayout.tsx` (143 LOC)
- `src/modules/MainApp/TeamInbox/components/AssignedWorkItemDetail.tsx` (223 LOC)
- `src/modules/MainApp/TeamInbox/components/CommentMentionDetail.tsx` (91 LOC)

**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                | Element                   | Verdict          | Reason                                                                                                                               | Suggested change                                                                |
| ------------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| DetailLayout 91–129 | detail shell              | keep with reason | It composes shared `DetailPanelContainer`, `PanelHeader`, `InfoCard` and `PanelFooter`; raw wrappers only own flex/overflow layout.  | —                                                                               |
| Assigned 88–100     | retained-content status   | keep with reason | It preserves the loaded Work Item and differentiates degraded context from a failed update using tokenized warning/error treatments. | Consider a shared inline status-banner primitive if a third occurrence appears. |
| Comment 69–90       | mention body card wrapper | keep with reason | The wrapper uses shared `CARD_ROW_TOKENS` and the canonical Markdown renderer.                                                       | —                                                                               |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                                         | Suggested change |
| ---- | ----- | ------- | ------------------------------------------------------------------------------ | ---------------- |
| —    | —     | —       | No arbitrary raw colors or CSS-variable Tailwind values appear in these files. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                          | Value                    | Verdict          | Reason                                                          | Suggested change |
| --------------------------------------------- | ------------------------ | ---------------- | --------------------------------------------------------------- | ---------------- |
| DetailLayout 60, 71; assigned 160; comment 35 | `size={14}` action icons | keep with reason | All are compact mini-button icons and use one consistent scale. | —                |

## D4 — Accessibility

| Line               | Element           | Verdict          | Reason                                                                                                                       | Suggested change |
| ------------------ | ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| DetailLayout 54–86 | read/open actions | keep with reason | Shared Buttons have visible names; icons are decorative.                                                                     | —                |
| Comment 50–59      | metadata rows     | keep with reason | Only user-facing Session title and comment count remain. Raw thread/comment ids were removed from the normal detail surface. | —                |

## D5 — Visual Patterns Observed

- Work Item detail correctly reuses `WorkItemContent`, `WorkItemProperties`, `WorkItemThreadLayout` and the shared thread card system.
- Mention and Work Item detail share one shell; no third parallel detail layout was found.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
