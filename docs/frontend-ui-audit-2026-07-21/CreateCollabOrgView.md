# Frontend UI Audit — Create Collaboration Org

**Scope:** Collaboration org source, setup mode, cloud sign-in guidance, and name/invite form containers.

The repository-referenced `frontend-ui-audit` skill was unavailable at both documented paths, so this report follows the fallback table convention in `AGENTS.md`.

| Line                                                                          | Element                          | Verdict          | Reason                                                                                                                                                                                                          | Suggested change                                        |
| ----------------------------------------------------------------------------- | -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx:270` | Org source container             | fix              | The bare shell bypassed the canonical bordered `bg-primary-container` settings surface and its standard horizontal padding.                                                                                     | Use the regular `SectionContainer`.                     |
| `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx:288` | Setup mode container             | fix              | The conditional mode controls should use the same settings-container treatment as the rest of the form.                                                                                                         | Use the regular `SectionContainer`.                     |
| `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx:306` | Cloud sign-in guidance container | fix              | The guidance belongs to the same settings form hierarchy and should retain the canonical outer surface around its semantic inner hint.                                                                          | Use the regular `SectionContainer`.                     |
| `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx:322` | Org name / invite container      | fix              | The required input was visually detached from the standard settings-container pattern.                                                                                                                          | Use the regular `SectionContainer`.                     |
| `src/modules/shared/layouts/SectionLayout/Container.tsx:20`                   | `bare` container prop            | fix              | Removing the four org-form overrides leaves this escape-hatch prop with no callers.                                                                                                                             | Remove the prop and its conditional class construction. |
| `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx:276` | Source and mode selection grids  | keep with reason | `SelectionGrid` and its subtle compact cards remain the canonical accessible single-select primitive for the two option groups, and the subtle card surface is appropriate inside a painted settings container. | None.                                                   |

## Verdict summary

- Fix: 5
- Keep with reason: 1
- Abstract: 0
- Multi-file sweep candidates: 0
