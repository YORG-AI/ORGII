# Frontend UI Audit — IdentityAccountStatus

**File:** `src/features/Identity/AccountCenter/IdentityAccountStatus.tsx` (61 LOC)  
**Date:** 2026-08-18  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| — | No raw interactive element | keep with reason | The component is read-only status text; actions remain design-system `Button` controls in the parent surface. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| — | No arbitrary color/token value | keep with reason | All state colors use existing `fill`, `text`, `success`, `warning`, and `danger` tokens. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| — | No pixel-literal size or raw color | keep with reason | Spacing and typography use the configured Tailwind scale. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| 41–58 | Account label, status, endpoint | keep with reason | These are non-interactive visible text; full identity and issuer remain available through `title` when truncated. | — |

## D5 — Visual Patterns Observed

- Abstract candidate: semantic status pills also appear in `GatewayAgentCard`, `KeySelectionModal`, and several workflow status surfaces. A generic semantic `StatusBadge` deserves a separate design-system sweep; introducing it only for Identity would create another partial convention.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 1 abstract candidate
