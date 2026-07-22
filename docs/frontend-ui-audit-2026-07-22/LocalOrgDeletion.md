# Frontend UI Audit — Local Organization Deletion

**Scope:** local/personal organization settings, member-section removal, destructive confirmation, and deleted-org surface cleanup.

The repository-referenced `frontend-ui-audit` skill was unavailable at both documented paths, so this report follows the fallback table convention in `AGENTS.md`.

| Line                                                                                        | Element                       | Verdict          | Reason                                                                                                                        | Suggested change                                                                                                 |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSettingsPane.tsx:165` | Local org Danger Zone         | abstract         | Cloud org deletion already established a `SectionContainer` + exact-name input + danger button pattern.                       | Use the same SectionLayout, Input, and Button primitives for local orgs.                                         |
| `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSettingsPane.tsx:173` | Deletion eligibility          | keep with reason | The disabled state must be visible for Personal Org and must also avoid offering local deletion for aliased rows.             | Keep eligibility in the shared predicate and retain backend enforcement independently.                           |
| `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSettingsPane.tsx:206` | Confirmation input            | keep with reason | Exact-name confirmation is the existing cloud pattern and prevents accidental irreversible deletion.                          | Keep the input enabled only for deletable local orgs and accept Enter after exact confirmation.                  |
| `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSettingsPane.tsx:220` | Destructive action button     | keep with reason | The design-system danger variant communicates destructive semantics and retains standard focus/loading behavior.              | Keep `variant="danger"`, loading state, and a stable test id.                                                    |
| `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSettingsPane.tsx:280` | Settings sections             | fix              | Local orgs displayed a Members section even though membership is project-owned and the org view only aggregated project rows. | Remove the Members section and member-loading/update fan-out; keep Labels and Sync Methods.                      |
| `src/engines/ChatPanel/panels/ProjectOrgPanelView.tsx:156`                                  | Post-delete navigation        | fix              | Deleting the currently managed org could otherwise leave stale tabs and a missing-org surface.                                | Close all Chat Panel surfaces for the deleted org, then retarget the singleton org tab to Personal Org settings. |
| `src/store/workstation/tabRegistry/atoms.ts:93`                                             | WorkStation stale-tab cleanup | abstract         | Both WorkStation org renderers need identical cleanup after the shared settings pane deletes an org.                          | Centralize cleanup in one org-scoped tab atom and use it from both renderers.                                    |
| `src/i18n/locales/*/projects.json:163`                                                      | Destructive copy              | keep with reason | Exact confirmation and permanent-deletion consequences must remain understandable in every shipped locale.                    | Keep all locale files key-aligned, including the Personal Org protection explanation.                            |

## Verdict summary

- Fix: 2
- Keep with reason: 4
- Abstract: 2
- Multi-file sweep candidates: 0

Accessibility check: the Danger Zone uses existing keyboard-focusable design-system controls; protected controls expose native disabled state; confirmation is not color-only; Enter is supported after exact confirmation; loading prevents duplicate submissions; the persistent Personal Org explanation makes the disabled action understandable.
