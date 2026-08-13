# Work management row pills

## Scope

Audited the idle surfaces of the assignee and status dropdown pills shared by
pull-request, issue, and work-item table rows.

## Findings

| Line                                                               | Element                         | Verdict          | Reason                                                                                                                                                                                      | Suggested change                                                                                      |
| ------------------------------------------------------------------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/components/PropertyField/PropertyDropdownField.tsx:57`        | Property dropdown state options | abstract         | Status and assignee triggers share dropdown behavior but use different trigger shapes, so semantic surface and focus options keep their presentation aligned without duplicating table CSS. | Keep the table treatments opt-in and preserve the established defaults for other property controls.   |
| `src/components/CompoundPill/config.ts:24`                         | Fill and field-state tokens     | abstract         | The existing pill-state helper already owns idle, hover, and active semantics; adding fill and field-focus modes keeps both trigger shapes consistent.                                      | Use `fill-1` idle, `fill-2` hover/open, `border-3` hover, and the shared input/select open ring.      |
| `src/modules/shared/components/WorkManagementTable.tsx:318`        | Status pill                     | fix              | Work-management status pills used the raised `bg-2` idle surface, which no longer fits the chat-pane table body.                                                                            | Opt status pills into `fill-1` at rest and `fill-2` while hovered or open.                            |
| `src/modules/shared/components/WorkManagementAssigneeCell.tsx:114` | Assignee pill                   | fix              | The avatar/empty-assignee trigger independently used `bg-2`, so it did not match the requested status-pill treatment.                                                                       | Opt the icon trigger into the same `fill-1` idle and `fill-2` hover/open ladder.                      |
| `src/modules/shared/components/WorkManagementTable.tsx:319`        | Table pill border states        | fix              | The table pills used the pill-specific solid primary accent while open and did not share the complete field focus treatment.                                                                | Match Input/Select with `border-3` on hover and a primary border plus 15% focus ring while open.      |
| `src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx:129`   | Completed issue status accent   | fix              | “Close as completed” shared the neutral closed-reason treatment with “not planned,” so the positive completion action had no distinct semantic accent.                                      | Use `purple-6` for the completed option and selected pill while leaving other closed reasons neutral. |
| `src/components/PropertyField/PropertyFieldEditable.tsx:95`        | Default property pills          | keep with reason | Other property panels and composer controls were not part of this table request and may sit on different host surfaces.                                                                     | Preserve `bg-2` as the default and require explicit fill opt-in.                                      |

## Summary

- Fix: 4
- Keep with reason: 1
- Abstract: 2
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the
referenced user-global and workspace locations. This report follows the
repository's documented audit table convention and covers the scoped row-pill
surface change directly.
