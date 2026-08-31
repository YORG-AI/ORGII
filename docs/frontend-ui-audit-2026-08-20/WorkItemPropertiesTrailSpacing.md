# Work Item properties trail spacing

## Scope

Audited the focused-chat Workstation environment trail and the floating Work Item properties trail for row height, horizontal inset, section rhythm, and compact schedule spacing.

## Findings

| Line                                                                                      | Element                                  | Verdict          | Reason                                                                                                                                                                | Suggested change                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/config/workstation/tokens.ts:26`                                                     | Workstation trail content geometry       | abstract         | Environment rows and entity-property rows need one source for the 28px row, 8px content inset, 4px row gap, and 12px section gap.                                     | Keep future floating trail content on `WORKSTATION_TRAIL_CONTENT`.                                       |
| `src/modules/shared/layouts/FocusedChatWorkstationRail.tsx:220`                           | Environment trail rows and sections      | abstract         | The reference Workstation trail now consumes the shared geometry instead of defining the same measurements locally.                                                   | Change trail spacing through the shared token only.                                                      |
| `src/components/PropertyField/PropertyFieldEditable.tsx:34`                               | Editable property rows                   | abstract         | A dedicated `workstation-trail` field variant applies the shared row geometry without changing normal property cards or pill fields.                                  | Use this variant only inside Workstation-style floating trails.                                          |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/index.tsx:400`        | Work Item property and assignment groups | fix              | The floating pane previously changed only its outer shell; its fields retained the generic 32px row padding and its group headings used independent vertical padding. | Apply the trail field variant and shared row/section spacing when `panelVariant` is `workstation-trail`. |
| `src/modules/ProjectManager/WorkItems/components/ScheduleEditor/index.tsx:291`            | Compact schedule group                   | fix              | Compact mode added an independent `p-2`, shifting and lengthening the final group relative to Workstation trail sections.                                             | Remove the nested panel padding and use the shared heading inset and section rhythm.                     |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/index.tsx:68`         | Full Project Manager property cards      | keep with reason | Full property cards use a larger, bordered composition and are not Workstation trails. Their existing 32px rows and card padding remain appropriate for that context. | Keep the new density scoped to the floating trail variant.                                               |
| `src/modules/shared/layouts/blocks/WorkstationTrailSurface.tsx:18`                        | Workstation trail width                  | abstract         | The expanded responsive track and floating entity rails need one authoritative 256px width.                                                                           | Keep responsive width classes and fixed floating rails on `WORKSTATION_TRAIL_WIDTH`.                     |
| `src/modules/ProjectManager/shared/components/PropertiesPanel/PropertiesRailFrame.tsx:32` | Floating properties width default        | abstract         | Floating properties frames previously required caller-specific dimensions even though their padding already followed the Workstation trail.                           | Default floating frames to the shared expanded trail width while preserving explicit caller overrides.   |
| `src/engines/ChatPanel/panels/WorkItemPanelView.tsx:512`                                  | Work Item properties width               | fix              | The Work Item rail explicitly requested a 300px width while the reference Workstation trail uses a 256px track.                                                       | Remove the local 300/280/320px override and consume the shared floating-frame default.                   |

## Summary

- Fix: 3
- Keep with reason: 1
- Abstract: 5
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the changed UI surfaces directly.
