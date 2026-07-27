# Frontend UI Audit — 2026-07-20

## Files audited

| File                                              |               D1 |         D2 |         D3 |         D4 |                   D5 | Source changes in audit |
| ------------------------------------------------- | ---------------: | ---------: | ---------: | ---------: | -------------------: | ----------------------: |
| `AgentEventBubbles.tsx`                           | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep |           0 abstract |                       0 |
| `TabBarPlusMenu.tsx` + `TabBarPlusMenuItems.tsx`  | 0 fixes / 2 keep | 0 / 2 keep | 0 / 2 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| Communication replay coordinator + leaf views     | 0 fixes / 3 keep | 0 / 2 keep | 0 / 1 keep | 0 / 2 keep |           0 abstract |                       0 |
| Settings page coordinator + main content          | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep |           0 abstract |                       0 |
| FindSkills coordinator + results table            | 0 fixes / 3 keep | 0 / 1 keep | 0 / 2 keep | 0 / 2 keep |           0 abstract |                       0 |
| WorkItemDetailPage data-source pages              | 0 fixes / 1 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep |           0 abstract |                       0 |
| DOMTreeContent coordinator + list                 | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep |           0 abstract |                       0 |
| WorkItemsPageHeader coordinator + action clusters | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| CLI client expanded card + leaf sections          | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| AgentOrgs coordinator + dashboard routers         | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| GitHub work items Phase 1 + create modal          | 0 fixes / 2 keep | 0 / 1 keep | 0 / 1 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| GitHub work items Phase 2 + item rows             | 0 fixes / 3 keep | 0 / 1 keep | 0 / 2 keep | 0 / 4 keep | 0 immediate abstract |                       0 |
| GitHub work items Phase 3 + list composition      | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 3 keep | 0 immediate abstract |                       0 |
| WorktreeSourceModal Phase 1 + row leaves          | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| WorktreeSourceModal Phase 2 + Branch tab          | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 3 keep | 0 immediate abstract |                       0 |
| WorktreeSourceModal Phase 3 + Name tab            | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 2 keep | 0 immediate abstract |                       0 |
| WorktreeSourceModal Phase 4 + Smart/GitHub tabs   | 0 fixes / 2 keep | 0 / 1 keep | 0 / 2 keep | 0 / 4 keep | 0 immediate abstract |                       0 |

## Scope

These reports audit the already-completed TypeScript component refactors for design-system consistency, Tailwind/token usage, hardcoded values, accessibility basics, and repeated visual patterns.

## What these reports do not do

- They do not modify source code; the structural refactor was implemented and verified before this audit pass.
- They do not change `tailwind.config.js` or workstation tokens.
- They do not mix architecture findings into UI verdicts; architecture boundaries and the residual large-file inventory live in `docs/architecture-audit-2026-07-20/TypeScriptLargeFiles.md`.

## Deferred sweep

`DROPDOWN_CLASSES.menuActionItem` with semantic raw `<button>` elements is an established repository-wide pattern. A typed dropdown action-row primitive may be evaluated in a dedicated global sweep, but no single-site replacement is recommended here.
