# Project organization selection

## Scope

Audited the project creator's organization default/override control and the existing-project organization move control.

## Findings

| Line                                                                             | Element                            | Verdict          | Reason                                                                                                                                                                                            | Suggested change                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/modules/ProjectManager/Projects/components/CreateProjectView/index.tsx:410` | Creator organization pill          | keep with reason | Uses the shared `Select` primitive and established pill treatment. Automatic sidebar following is state behavior, while the control remains an ordinary editable select after a manual choice.    | No change.                                                                                                   |
| `src/engines/ChatPanel/panels/ProjectPanelView.tsx:506`                          | Existing-project organization pill | keep with reason | Reuses the same design-system primitive and density as creation, exposes a stable test id and accessible name, and disables a cloud move when the source-org role cannot authorize its tombstone. | No change.                                                                                                   |
| `src/engines/ChatPanel/panels/ProjectPanelView.tsx:508`                          | Disabled permission explanation    | keep with reason | The wrapper title explains the owner/admin restriction without introducing a one-off tooltip component. The select itself remains disabled so keyboard and pointer behavior agree.                | If this permission explanation recurs elsewhere, move it to the shared tooltip pattern in a dedicated sweep. |
| `src/modules/ProjectManager/Projects/components/CreateProjectView/index.tsx:426` | Pill selector class override       | keep with reason | The values preserve the existing accepted compact creator treatment and the existing-project control intentionally matches it. This focused fix does not redefine select tokens globally.         | Consider a shared project-org select wrapper if a third consumer needs the exact treatment.                  |

## Summary

- Fix: 0
- Keep with reason: 4
- Abstract: 0
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the changed organization controls directly.
