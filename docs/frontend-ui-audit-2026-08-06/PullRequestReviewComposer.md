# Frontend UI Audit — Pull Request Review Composer

**File:** `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrConversationTab.tsx` (588 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                                                     | Verdict          | Reason                                                                                                                                                                                                | Suggested change |
| ------- | ----------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 484–580 | Review buttons, modal, decision controls, and comment input | keep with reason | The flow consistently uses the project `Button`, `Modal`, `Radio`, and `Textarea` components; the native `fieldset`, `legend`, and `label` provide semantics that the design system does not replace. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                                   | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 459–565 | Surface, border, focus, and text colors | keep with reason | All visual colors use project Tailwind tokens (`primary-6`, `border-2`, `text-1`, and `text-3`); no raw CSS-variable or color literals were introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line          | Value                        | Verdict          | Reason                                                                                                                                                           | Suggested change                                                                               |
| ------------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 469–470       | Editor heights `140` / `500` | keep with reason | These are behavioral editor bounds passed to the shared rich editor, not duplicated Tailwind layout values; they preserve the established issue-composer sizing. | —                                                                                              |
| 518           | Modal width `640`            | keep with reason | The shared modal accepts a numeric width, and 640px keeps the review textarea usable while fitting the workstation panel.                                        | —                                                                                              |
| 537, 545, 565 | `text-[13px]`                | abstract         | The same compact 13px label scale appears broadly across workstation UI; replacing only this flow would create inconsistency.                                    | Promote the established compact label scale to a shared typography token in a dedicated sweep. |

## D4 — Accessibility

| Line    | Element                       | Verdict          | Reason                                                                                                                                                                                                   | Suggested change |
| ------- | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 484–580 | Review trigger and modal form | keep with reason | The trigger has visible text, decisions are grouped by a named `fieldset`, the textarea has an associated label, and submit/cancel/close routes are disabled symmetrically while a review is submitting. | —                |

## D5 — Visual Patterns Observed

- Pattern: the comment composer reuses `ComposerShell` plus `RichMarkdownEditor`; the review-specific decision and draft live in a dedicated modal instead of duplicating another inline toolbar.
- Pattern: compact 13px form labels occur in many workstation surfaces and are a repository-wide typography-token candidate, not a PR-local fix.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 1 abstract candidate (>= 3 occurrences)
