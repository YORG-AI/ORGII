# Frontend UI Audit — CliClientInlineExpandedCard

**Files:**

- `src/modules/MainApp/Integrations/KeyVault/CliClients/Table/CliClientInlineExpandedCard.tsx` (167 LOC)
- `src/modules/MainApp/Integrations/KeyVault/CliClients/Table/CliClientStatusContent.tsx` (98 LOC)
- `src/modules/MainApp/Integrations/KeyVault/CliClients/Table/CliClientSubscriptionsContent.tsx` (80 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                       | Element            | Verdict          | Reason                                                                                                                                                | Suggested change |
| -------------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| coordinator footer         | action buttons     | keep with reason | Rescan, documentation, and add-key actions use the shared `Button` component and existing inline-card footer primitive.                               | —                |
| status/subscription leaves | informational rows | keep with reason | Content uses shared `InfoRow`, `StatusDot`, breadcrumb, and inline-card layout primitives; raw spans/divs are non-interactive value and layout hosts. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                       | Value         | Verdict          | Reason                                                                                                                                                                                                 | Suggested change                                              |
| -------------------------- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| status/subscription leaves | `text-[12px]` | keep with reason | This is the established compact inline-card typography used by the adjacent CLI clients table and preserved from the original component; changing it in one extracted leaf would create inconsistency. | Consider only in a global inline-card typography token sweep. |

## D3 — Hardcoded Sizes / Colors

| Line               | Value             | Verdict          | Reason                                                                                                                              | Suggested change |
| ------------------ | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| coordinator footer | icon size `14`    | keep with reason | Existing compact Button icon sizing is preserved across all three footer actions.                                                   | —                |
| status leaf        | ACP status colors | keep with reason | All colors are semantic design-system classes (`success`, `warning`, `text-4`) and remain exhaustively mapped by ACP support state. | —                |

## D4 — Accessibility

| Line              | Element                 | Verdict          | Reason                                                                                                       | Suggested change |
| ----------------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| coordinator       | tabs and footer actions | keep with reason | Tab semantics remain owned by `InlineCardTabs`; footer actions are labeled shared Buttons with visible text. | —                |
| subscription rows | account summaries       | keep with reason | Rows are informational rather than clickable and delegate source labeling to `AccountSourceBreadcrumb`.      | —                |

## D5 — Visual Patterns Observed

- Status, subscription, client, and footer sections continue to use the shared inline-card primitives.
- The split introduces no new visual primitive or token family.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 immediate abstract candidates
