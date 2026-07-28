# Frontend UI Audit — AgentOrgs Dashboard

**Files:**

- `src/modules/MainApp/AgentOrgs/index.tsx` (336 LOC)
- `src/modules/MainApp/AgentOrgs/AgentOrgsTableContent.tsx` (90 LOC)
- `src/modules/MainApp/AgentOrgs/AgentOrgsWizardContent.tsx` (47 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                | Element               | Verdict          | Reason                                                                                                                                       | Suggested change |
| ------------------- | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| table/wizard leaves | page sections         | keep with reason | The extracted leaves only compose established `AgentsTable`, `OrgsTable`, `CliClientsTable`, wizard, disclaimer, and inline layout surfaces. | —                |
| coordinator shell   | header/content layout | keep with reason | The page continues to use shared `InternalHeader`, `TabPill`, `ScrollPreservation`, and detail-panel tokens.                                 | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line            | Value | Verdict          | Reason                                                                  | Suggested change |
| --------------- | ----- | ---------------- | ----------------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | No arbitrary color or CSS-variable utility was introduced by the split. | —                |

## D3 — Hardcoded Sizes / Colors

| Line            | Value | Verdict          | Reason                                                                                                                            | Suggested change |
| --------------- | ----- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | Extracted sections use standard spacing utilities and existing detail-panel tokens; no pixel-literal size or raw color was added. | —                |

## D4 — Accessibility

| Line                | Element            | Verdict          | Reason                                                                                                        | Suggested change |
| ------------------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| coordinator         | table tab switcher | keep with reason | Tab interaction remains delegated to the established `TabPill` component with translated labels.              | —                |
| wizard/table leaves | nested controls    | keep with reason | Interactive semantics stay owned by the existing table and wizard components; the leaves add no click target. | —                |

## D5 — Visual Patterns Observed

- The extracted table and wizard routers are composition-only leaves and introduce no new visual primitive.
- Existing full-page wizard takeover and scroll-preserved table layout remain unchanged.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 immediate abstract candidates
