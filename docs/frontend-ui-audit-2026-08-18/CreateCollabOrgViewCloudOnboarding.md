# Frontend UI Audit — CreateCollabOrgView Cloud Onboarding

**File:** `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx` (400 LOC)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                                | Verdict          | Reason                                                                                             | Suggested change |
| ------- | -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| 315–322 | Signed-out Cloud organization boundary | keep with reason | Uses `SectionRow` and the shared `CloudOnboardingGate`; no raw interactive element was introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                  | Verdict          | Reason                                                                           | Suggested change |
| ------- | ---------------------- | ---------------- | -------------------------------------------------------------------------------- | ---------------- |
| 315–322 | No new arbitrary value | keep with reason | The integration adds no styling and inherits the section-layout and gate tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value | Verdict          | Reason                                          | Suggested change |
| ------- | ----- | ---------------- | ----------------------------------------------- | ---------------- |
| 315–322 | None  | keep with reason | No size or color is defined by the integration. | —                |

## D4 — Accessibility

| Line    | Element         | Verdict          | Reason                                                                                                                                  | Suggested change |
| ------- | --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 317–321 | Contextual gate | keep with reason | The shared gate supplies named buttons, loading state, and alert/status semantics; returning locally selects the existing local source. | —                |

## D5 — Visual Patterns Observed

- The previous one-off sign-in hint was replaced by the shared Cloud auth-boundary pattern.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 1 abstract candidate, resolved by reuse
