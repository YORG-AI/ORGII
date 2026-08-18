# Frontend UI Audit — JoinCloudOrgDialog Onboarding

**File:** `src/features/Org2Cloud/JoinCloudOrgDialog.tsx` (171 LOC)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                    | Verdict          | Reason                                                                                                           | Suggested change |
| ------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| 131–136 | Signed-out invite boundary | keep with reason | Uses the shared gate inside the existing design-system Modal; signed-in footer actions continue to use `Button`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line          | Value                        | Verdict            | Reason                                                                                                          | Suggested change                                         |
| ------------- | ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 121, 126, 141 | `text-[12px]`, `text-[13px]` | abstract candidate | Repository sweep found these legacy typography values in more than 190 TSX files; this change did not add them. | Handle as a typography-token sweep, not in this feature. |

## D3 — Hardcoded Sizes / Colors

| Line | Value             | Verdict          | Reason                                                                                     | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| 118  | Modal width `440` | keep with reason | Existing compact invite-dialog width; the gate stacks vertically and fits this constraint. | —                |

## D4 — Accessibility

| Line    | Element    | Verdict          | Reason                                                                                                    | Suggested change |
| ------- | ---------- | ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| 139–146 | Join error | keep with reason | The visible error now has `role="alert"`; the shared gate owns pending and sign-in failure announcements. | —                |

## D5 — Visual Patterns Observed

- The invite-specific sign-in button now reuses the same contextual Cloud auth boundary as other business intents.

## Summary

- 0 fixes recommended
- 3 kept with documented reason
- 1 typography sweep candidate
