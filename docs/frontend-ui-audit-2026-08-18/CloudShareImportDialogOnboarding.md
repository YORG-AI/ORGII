# Frontend UI Audit — CloudShareImportDialog Onboarding

**File:** `src/features/Org2Cloud/CloudShareImportDialog.tsx` (475 LOC)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                   | Verdict          | Reason                                                                                                        | Suggested change |
| ------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| 359–364 | Signed-out share boundary | keep with reason | Delegates the business-intent block to `CloudOnboardingGate`; signed-in actions remain design-system Buttons. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                                       | Verdict            | Reason                                                                                                          | Suggested change                               |
| ------- | ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 369–417 | `text-[11px]`, `text-[12px]`, `text-[13px]` | abstract candidate | Repository sweep found each legacy typography value in 190+ TSX files; none was introduced by this integration. | Handle as a repository typography-token sweep. |

## D3 — Hardcoded Sizes / Colors

| Line | Value                       | Verdict          | Reason                                                                  | Suggested change |
| ---- | --------------------------- | ---------------- | ----------------------------------------------------------------------- | ---------------- |
| —    | No new hardcoded size/color | keep with reason | The onboarding integration contributes no local size or color override. | —                |

## D4 — Accessibility

| Line    | Element              | Verdict          | Reason                                                                                                                            | Suggested change |
| ------- | -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 367–385 | Resolve status/error | keep with reason | Existing resolve progress uses polite status semantics and error uses `role="alert"`; the gate provides equivalent auth feedback. | —                |

## D5 — Visual Patterns Observed

- The share-import prompt now reuses the contextual Cloud auth boundary and preserves the one-shot share intent while the browser flow runs.

## Summary

- 0 fixes recommended
- 3 kept with documented reason
- 1 typography sweep candidate
