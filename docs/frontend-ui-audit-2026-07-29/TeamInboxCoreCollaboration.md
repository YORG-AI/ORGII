# Frontend UI Audit — TeamInboxCoreCollaboration

**Files:**

- `src/modules/MainApp/TeamInbox/components/AssignedWorkItemDetail.tsx` (217 LOC)
- `src/modules/MainApp/TeamInbox/components/SessionHandoffComposer.tsx` (291 LOC)
- `src/modules/ProjectManager/WorkItems/components/WorkItemContent/HistoryTab.tsx`
- `src/modules/ProjectManager/WorkItems/components/WorkItemContent/WorkItemMentionPicker.tsx` (70 LOC)

**Date:** 2026-07-29
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                 | Element                                                               | Verdict          | Reason                                                                                                                                   | Suggested change |
| ------------------------------------ | --------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:97-117`  | Session handoff modal                                                 | keep with reason | Uses the canonical Modal scaffold, including its design-system buttons and submission state.                                             | —                |
| `SessionHandoffComposer.tsx:168-273` | Destination, title, assignee, status, priority, date, and note fields | keep with reason | Uses the existing `Select`, `Input`, `DatePicker`, and `Textarea` controls; labels remain semantic wrappers.                             | —                |
| `WorkItemMentionPicker.tsx:45-66`    | Work Item comment mention control                                     | keep with reason | A multi-select is the correct design-system primitive for explicit stable-id recipients and is shared by embedded and full-page threads. | —                |
| `AssignedWorkItemDetail.tsx:75-118`  | Editable Work Item content                                            | keep with reason | Reuses `WorkItemThreadSurface` and its property/content controls instead of duplicating a Team Inbox-specific editor.                    | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                 | Value                          | Verdict          | Reason                                                                                                               | Suggested change |
| ------------------------------------ | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `AssignedWorkItemDetail.tsx:64-68`   | warning/error semantic classes | keep with reason | All colors use existing semantic warning/danger tokens; no arbitrary CSS variable, hex, or RGB value was introduced. | —                |
| `SessionHandoffComposer.tsx:122-284` | surface/text/border classes    | keep with reason | The composer uses `bg-bg-*`, `text-text-*`, `border-border-*`, and `text-danger-*` design tokens only.               | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                     | Value                     | Verdict          | Reason                                                                                                                                                                      | Suggested change |
| ---------------------------------------- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:100`         | `width={640}`             | keep with reason | The modal scaffold requires a numeric desktop width; 640 px gives the three-property row adequate room while the body still collapses to one column at the `sm` breakpoint. | —                |
| `SessionHandoffComposer.tsx:128,135,156` | 12–13 px decorative icons | keep with reason | These are optical icon sizes below the spacing scale and align with the surrounding `text-xs` metadata.                                                                     | —                |
| `WorkItemMentionPicker.tsx:52`           | 13 px `@` icon            | keep with reason | This is a sub-scale optical alignment inside the design-system mini Select prefix.                                                                                          | —                |

## D4 — Accessibility

| Line                                 | Element               | Verdict          | Reason                                                                                                                           | Suggested change |
| ------------------------------------ | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:168-273` | Composer fields       | keep with reason | Every visible field is wrapped by a text label; Select search and keyboard behavior remain owned by the design-system component. | —                |
| `SessionHandoffComposer.tsx:280-284` | Submission error      | keep with reason | Uses `role="alert"` so a failed authoritative write is announced rather than represented by color alone.                         | —                |
| `WorkItemMentionPicker.tsx:46-66`    | Mention picker        | keep with reason | The localized placeholder supplies an accessible name; the `@` icon is decorative and hidden from assistive technology.          | —                |
| `AssignedWorkItemDetail.tsx:61-71`   | Degraded-state banner | keep with reason | Uses `role="status"` and semantic warning/error tokens while preserving the usable Work Item below it.                           | —                |

## D5 — Visual Patterns Observed

- The Team Inbox detail reuses the canonical Work Item thread for properties, To-Dos, comments, assignment, and handoff actions.
- The Session handoff modal owns one composable form for self-assignment and either handoff direction.
- `WorkItemMentionPicker` centralizes the explicit recipient pattern for both Work Item presentations; no second Team Inbox-only mention UI was introduced.
- No visual pattern reached the three-independent-implementation threshold.

## Summary

- 0 fixes recommended
- 14 kept with documented reason
- 0 abstract candidates
