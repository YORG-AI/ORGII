# Work Item thread action alignment

## Scope

Audited the custom-properties and sub-item thread cards for add-action consistency and shared horizontal axes between card headers and nested rows.

## Findings

| Line                                                                                              | Element                            | Verdict          | Reason                                                                                                                                                       | Suggested change                                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/modules/ProjectManager/WorkItems/components/WorkItemThread/tokens.ts:6`                      | Thread-card alignment tokens       | abstract         | Card bodies already own the 12px inset, so nested rows need zero additional horizontal padding plus stable 20px leading and 24px trailing slots.             | Keep future thread-card rows on these shared alignment tokens.                           |
| `src/modules/ProjectManager/WorkItems/components/WorkItemThread/index.tsx:150`                    | Section-header icon slot           | abstract         | Header icons previously rendered at their intrinsic width while child status and checkbox icons used wider wrappers, producing different horizontal centers. | Wrap every section icon in the shared leading slot.                                      |
| `src/modules/ProjectManager/WorkItems/components/WorkItemContent/CustomPropertiesSection.tsx:321` | Custom-properties actions and rows | fix              | The add/cancel header control retained text, while property and empty rows added an independent 8px inset inside the padded body.                            | Use the canonical icon-only action and remove nested horizontal padding.                 |
| `src/modules/ProjectManager/WorkItems/components/WorkItemSubItems.tsx:425`                        | Sub-item actions and rows          | fix              | Header and empty-state add controls used different button structures; child state icons and chevrons were offset by nested row padding and unequal slots.    | Use icon-only actions plus shared leading/trailing slots and row padding.                |
| `src/modules/shared/components/ActivityTimeline/index.tsx:37`                                     | Canonical header action primitive  | keep with reason | The existing primitive already provides a 24px icon-only target, accessible label/title, and shared hover treatment.                                         | Reuse it instead of introducing another Work Item-specific icon button.                  |

## Summary

- Fix: 2
- Keep with reason: 1
- Abstract: 2
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the changed UI surfaces directly.
