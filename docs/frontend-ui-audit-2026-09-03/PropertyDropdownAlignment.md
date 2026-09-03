# PropertyDropdownAlignment UI audit

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/components/PropertyField/PropertyFieldEditable.tsx:182` | `getPropertyDropdownAlign` | keep with reason | This is the shared seam for pill-field placement; its right-edge policy prevents each consumer from choosing a transient alignment. | None. |
| `src/components/PropertyField/PropertyFieldEditable.tsx:189` | Auto-alignment measurement | keep with reason | Auto placement remains supported for callers that require viewport-aware fallback, but the panel stays non-interactive and invisible until its measured side is resolved. | None. |
| `src/components/PropertyField/PropertyFieldEditable.tsx:249` | Inline dropdown surface | keep with reason | The custom relative surface is the shared primitive for field rows; it now uses the standard positioned-overlay visibility helper. | None. |
| `src/components/PropertyField/PropertyFieldEditable.tsx:367` | Portaled searchable dropdown surface | keep with reason | The portal is necessary to escape overflow-clipping property panels and now shares the positioned-overlay visibility contract. | None. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/LabelsSection.tsx:102` | Labels picker | keep with reason | Delegates pill/right versus row/left placement to the shared helper instead of reimplementing the policy. | None. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/DateQuickAssignDropdown.tsx:153` | Date picker | keep with reason | Delegates placement to the shared helper; row behavior remains left-aligned. | None. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/PlanningSection.tsx:175` | Milestone picker | keep with reason | Delegates placement to the shared helper; no local popup shell is introduced. | None. |
| `src/modules/ProjectManager/shared/components/PropertiesPanel/PropertyFieldSections/PeopleTeamsLabelsFields.tsx:114` | People, teams, labels, and repos pickers | keep with reason | Five consumers use the same shared policy, preventing a future per-picker drift. | None. |
| `src/modules/ProjectManager/shared/components/PropertiesPanel/PropertyFieldSections/StatusHealthPriorityFields.tsx:88` | Status, health, and priority pickers | keep with reason | Three consumers use the same shared policy, preventing a future per-picker drift. | None. |

Verdict totals: **0 fix**, **9 keep with reason**, **0 abstract**.
