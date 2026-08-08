# Frontend UI Audit — Work Management Tables

## Scope

GitHub Issue and workspace Work Item table consistency, including the shared
assignee selector, column alignment, header filters, clickable-title feedback,
selection placement, and removal of the redundant embedded-detail tab action.

## Findings

| Line                                 | Element                        | Verdict          | Reason                                                                                                                                                                            | Suggested change                                                        |
| ------------------------------------ | ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `PropertyDropdownField.tsx:127`      | Icon + chevron trigger variant | abstract         | The avatar-only pill needs the existing property-dropdown positioning, focus, search, and portal behavior; a shared trigger variant avoids a table-local dropdown implementation. | Keep `iconChevron` as the reusable compact selector trigger.            |
| `WorkManagementAssigneeCell.tsx:44`  | Shared assignee cell           | abstract         | GitHub Issues and workspace Work Items now share avatar sizing, empty state, search, readonly behavior, and selection rendering while retaining source-specific adapters.         | Keep source mutation/loading logic outside this presentation component. |
| `GitHubWorkItemControls.tsx:98`      | GitHub assignee adapter        | keep with reason | GitHub supports multiple assignees and lazy-loads repository users, so a thin adapter remains necessary around the shared cell.                                                   | Keep only the GitHub data mapping and permission state here.            |
| `WorkManagementTable.tsx:109`        | ID column                      | keep with reason | Explicit left alignment and top-aligned content keep IDs stable when an optional leading selection column exists.                                                                 | Keep alignment owned by the shared table column.                        |
| `WorkManagementTable.tsx:138`        | Clickable-title hover scope    | fix              | Row-level hover styling made the title look active while the pointer was over unrelated columns.                                                                                  | Scope the link treatment to `group/title`.                              |
| `WorkManagementTable.tsx:195`        | Selection column               | fix              | Embedding checkboxes inside ID content coupled two independent columns and shifted identifier alignment.                                                                          | Keep selection as its own leading column.                               |
| `WorkManagementTable.tsx:211`        | Assignee column                | keep with reason | The shared column owns left alignment so source adapters cannot drift.                                                                                                            | Keep `align: "left"` and the start-justified cell wrapper.              |
| `ProjectWorkItemsTabContent.tsx:241` | Workspace assignee cell        | abstract         | Reusing the shared avatar-only selector makes Issue and Work Item rows visually and behaviorally consistent.                                                                      | Keep local mutation mapping in the workspace adapter.                   |
| `ProjectWorkItemsTabContent.tsx:418` | All / Local only filters       | fix              | The prior ghost presentation differed from the repository selector in the GitHub Issue header.                                                                                    | Keep both filters on the shared default select variant.                 |
| `WorkItemDetailHeader.tsx:230`       | Detail header actions          | fix              | Once list rows open dedicated tabs, a second open-in-new-tab icon is redundant and exposes the retired embedded-detail path.                                                      | Keep navigation, delete, and properties actions only.                   |
| `TeamInboxView.tsx:353`              | Pull-request selection         | fix              | Row selection should preserve the Inbox split-view context, while browser and dedicated-tab navigation remain explicit header actions.                                            | Keep the PR in the right pane and group the globe and new-tab actions.  |

## Verdict counts

- fix: 5
- keep with reason: 3
- abstract: 3

## Accessibility and visual-system notes

The compact assignee trigger remains a native button with an accessible label,
readonly state, and the established property-dropdown keyboard/focus behavior.
Selection stays a native checkbox in its own column. Existing design tokens and
shared `Button`, `Avatar`, `SettingsTable`, and property-field components are
used throughout. Inbox PR actions use the same grouped icon-button treatment;
no new arbitrary colors or duplicate interaction primitives were introduced.
