# Frontend UI Audit — TeamInboxHandoffComposerFollowup

**Files:**

- `src/modules/MainApp/TeamInbox/components/SessionHandoffComposer.tsx`
- `src/components/Select/index.tsx`
- `src/components/Select/types.ts`

**Date:** 2026-07-30
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                 | Element                                 | Verdict          | Reason                                                                                                                                                                                               | Suggested change |
| ------------------------------------ | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:167-208` | Destination and recipient controls      | keep with reason | Both controls use the canonical `Select`; their options remain constrained to the authoritative handoff destination and roster, so the general Work Item assignee picker is not a valid replacement. | —                |
| `SessionHandoffComposer.tsx:220-228` | Status, priority, and due-date controls | keep with reason | The composer now delegates the complete pill UI and behavior to `WorkItemProperties`; the former parallel `Select` / date implementation is gone.                                                    | —                |
| `SessionHandoffComposer.tsx:187-243` | Title and handoff note                  | keep with reason | Existing design-system `Input` and `Textarea` components own disabled, limit, and editing behavior.                                                                                                  | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                 | Value                             | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------------------------------ | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:119-255` | Surface, border, and text classes | keep with reason | The composer uses semantic `bg-bg-*`, `border-border-*`, `text-text-*`, and `text-danger-*` tokens; no raw color value is introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                 | Value                   | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------------------------------------ | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SessionHandoffComposer.tsx:97`      | `width={640}`           | keep with reason | The modal scaffold clamps its content to the viewport, while the shared property strip uses wrapping layout below the available width. | —                |
| `SessionHandoffComposer.tsx:125-153` | 12–13 px metadata icons | keep with reason | These decorative icons are optically aligned with the existing `text-xs` metadata row and are hidden from assistive technology.        | —                |

## D4 — Accessibility

| Line                                                             | Element                                    | Verdict          | Reason                                                                                                                                                                                                                                | Suggested change                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionHandoffComposer.tsx:211-229`                             | Shared property fieldset                   | keep with reason | The screen-reader-only legend names the group, and native `fieldset[disabled]` locks its buttons during submission.                                                                                                                   | —                                                                                                                                                                     |
| `SessionHandoffComposer.tsx:165-209`; `Select/index.tsx:338-349` | Destination and recipient accessible names | abstract         | `Select` exposes a focusable `div`, but its public props do not accept an accessible name and wrapping that `div` in a native `label` does not associate the visible label. This affects every labeled `Select`, not only Team Inbox. | Add `aria-label` / `aria-labelledby` support and combobox semantics to the shared `Select`, then migrate labeled call sites as a component-level accessibility sweep. |
| `SessionHandoffComposer.tsx:107-110,251-260`                     | Client-side validation feedback            | fix              | The primary action becomes disabled for an invalid destination or recipient. The composer now renders the localized validation reason in the existing alert region, including stale-destination and stale-recipient states.           | Completed.                                                                                                                                                            |

## D5 — Visual Patterns Observed

- Status, priority, and due date have one canonical implementation through `WorkItemProperties`.
- Destination and recipient intentionally remain handoff-specific `Select` fields because their domain options differ from the general Work Item property model.
- The shared property strip uses `pillLayout="wrap"` and its dropdowns portal above the modal layer, so the reused controls retain the intended compact layout without introducing another responsive pattern.
- The repository dev bundle renders the Team Inbox sidebar entry. The separately installed `/Applications/ORG2.app` is an older build and must not be used as visual evidence for the current branch.

## Summary

- 1 fix recommended
- 7 kept with documented reason
- 1 abstract candidate
