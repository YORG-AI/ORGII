# Frontend UI Audit — Org2CloudSection

**File:** `src/features/Org2Cloud/Org2CloudSection.tsx` (account-control surface)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                                     | Verdict          | Reason                                                                                                                   | Suggested change |
| ------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 166     | Rename input                                | keep with reason | Uses the design-system `Input`.                                                                                          | —                |
| 178–249 | Rename, reconnect/switch, sign-out controls | keep with reason | Every action uses the design-system `Button`, including an accessible label for the icon-only rename action.             | —                |
| 258–261 | Signed-out Cloud boundary                   | keep with reason | Delegates the complete first-run and returning-user interaction to the shared, separately audited `CloudOnboardingGate`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                    | Verdict          | Reason                                                   | Suggested change |
| ---- | ------------------------ | ---------------- | -------------------------------------------------------- | ---------------- |
| —    | No arbitrary color value | keep with reason | The Account Center changes use existing semantic tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                           | Verdict          | Reason                                                                                                               | Suggested change |
| ---- | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 153  | `text-[11px]` recommended badge | keep with reason | Existing compact badge typography is below the 16px spacing-token threshold and was not introduced by this refactor. | —                |

## D4 — Accessibility

| Line    | Element         | Verdict          | Reason                                                                                                                                                   | Suggested change |
| ------- | --------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 214–249 | Account actions | keep with reason | Visible text names reconnect/switch and sign-out; the icon-only rename control has `aria-label`. Disabled/loading state is derived from the Broker flow. | —                |

## D5 — Visual Patterns Observed

- The semantic status-pill abstraction candidate is recorded in `IdentityAccountStatus.md`; no site-by-site abstraction was added here.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 1 shared abstract candidate
