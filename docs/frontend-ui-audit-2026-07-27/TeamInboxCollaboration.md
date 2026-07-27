# Frontend UI Audit — Team Inbox Multi-User Collaboration

**Files:** `src/features/Org2Cloud/SessionComments/*.tsx`, `src/modules/MainApp/TeamInbox/**/*.tsx`, `src/modules/ProjectManager/WorkItems/components/WorkItemContent/*.tsx`
**Date:** 2026-07-27
**Auditor:** Codex implementation session

## D1 — Raw HTML vs Design System

| Line                         | Element                              | Verdict          | Reason                                                                                                                                            | Suggested change                                                                                                                |
| ---------------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `CommentThreadList.tsx`      | member mention picker                | fix              | A collaboration action needs the same keyboard/search/selection behavior as other menus.                                                          | Reused the shared `Dropdown` in multiple-selection mode and the shared tertiary `Button`; no bespoke popover was introduced.    |
| `CommentThreadList.tsx`      | selected and persisted mention chips | abstract         | Composer selections and rendered comments initially repeated the same identity pill styling and ID-to-name resolution.                            | Added one `resolveMentions` projection and one `MemberMentionChip` presentation primitive within the owning comment domain.     |
| `AssignedWorkItemDetail.tsx` | assignee/reviewer presentation       | fix              | Showing only a raw assignee UUID made team ownership ambiguous and omitted reviewer state.                                                        | Reused the Work Item property surface with the complete active roster so assignee and reviewer resolve to member display names. |
| `TeamInboxList.tsx`          | mark-all-read action                 | keep with reason | This is a standard labeled command, already implemented with the shared Button and now receives only a stable test hook.                          | —                                                                                                                               |
| `TeamInboxRow.tsx`           | unread row                           | keep with reason | The existing row owns selection, unread emphasis, and keyboard activation; the change adds semantic test/state attributes without duplicating it. | —                                                                                                                               |

## D2 — Arbitrary Tailwind Value vs Token

| Line                    | Value                          | Verdict          | Reason                                                                                                                                   | Suggested change                                                                                       |
| ----------------------- | ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CommentThreadList.tsx` | `max-w-[160px]`, `text-[10px]` | keep with reason | These match the established compact comment-meta density and bound long member names. The values are centralized in `MemberMentionChip`. | Promote a global identity-chip token only if a second product domain needs the same compact treatment. |
| changed files           | colors                         | keep with reason | All new color usage is expressed through semantic primary/background/text/border tokens. No raw color literals were added.               | —                                                                                                      |

## D3 — Hardcoded Sizes / Colors

| Line                    | Value                  | Verdict          | Reason                                                                                                                                    | Suggested change                                                       |
| ----------------------- | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CommentThreadList.tsx` | mention pill width cap | keep with reason | The cap prevents a single member name from consuming the composer action row while preserving the full identity in the searchable picker. | Add a tooltip only if real rosters show frequent ambiguous truncation. |
| `TeamInboxView.tsx`     | no new fixed geometry  | keep with reason | Optimistic state and authoritative counts change behavior only; the existing compact Inbox layout is preserved.                           | —                                                                      |

## D4 — Accessibility

| Line                    | Element               | Verdict          | Reason                                                                           | Suggested change                                                                                                       |
| ----------------------- | --------------------- | ---------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CommentThreadList.tsx` | mention member action | fix              | The action must be keyboard reachable and expose a visible label.                | Shared Button renders the translated “Mention” label; shared Dropdown provides search and selection keyboard behavior. |
| `TeamInboxList.tsx`     | mark all as read      | keep with reason | The action already has a translated visible label and native Button semantics.   | —                                                                                                                      |
| `TeamInboxRow.tsx`      | unread state          | fix              | Visual emphasis alone is insufficient for deterministic behavioral verification. | Added stable row identity and `data-unread` state; existing visible unread indicator remains unchanged.                |

## D5 — Visual Patterns Observed

- Member identity is selected from the authoritative active roster and persisted as UUIDs; display names are a rendering projection.
- Mention chips share one product-domain component across draft and persisted states.
- Team Inbox keeps the existing unified thread hierarchy; collaboration adds data and state, not a second detail layout.
- Reviewer and assignee reuse the canonical Work Item property UI instead of introducing Inbox-only badges.
- The picker is capability-gated, so older cloud deployments do not render a control whose RPC is unavailable.

## Summary

- 5 fixes completed
- 5 kept with documented reason
- 1 abstract candidate completed
