# Frontend UI audit: Gemini CLI removal

The repository-routed `frontend-ui-audit` skill was unavailable in both the workspace and user-global skill locations, so this report applies the repository's required output convention as a manual fallback.

| Line                                                                             | Element                                                     | Verdict | Reason                                                                                 | Suggested change                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/scaffold/WizardSystem/variants/KeyVault/components/AgentSetupRouter.tsx:22` | Gemini setup import and router branch                       | fix     | A removed CLI provider must not remain reachable from the shared account setup router. | Deleted the import, session type, OAuth mapping, and router case.           |
| deleted files                                                                    | `GeminiSetup`, `GeminiSessionSetup`, and OAuth capture hook | fix     | These components existed solely for Gemini CLI/Code Assist OAuth setup.                | Deleted the components and their exports instead of hiding them.            |
| `src/components/ModelIcon/config.ts:333`                                         | model-type icon mapping                                     | fix     | The removed `gemini_cli` type cannot remain in the exhaustive model map.               | Removed the mapping while retaining the Gemini API brand mapping.           |
| `src/components/SoftwareIcon/config.ts:68`                                       | software type/name/icon mappings                            | fix     | The software catalog otherwise advertises a CLI integration that no longer exists.     | Removed the CLI software type and aliases.                                  |
| account tables, provider regions, Kanban filters, managed-config cards           | Gemini CLI conditional UI                                   | fix     | These conditionals exposed stale labels, filters, and configuration controls.          | Removed only the CLI conditionals; generic Gemini API presentation remains. |
| locale setup and storage strings                                                 | Gemini CLI setup, detection, profile, and disk labels       | fix     | Dead translations would imply setup and local-profile support.                         | Removed the keys in every locale and updated CLI-key descriptions.          |

## Verdict counts

| Verdict          | Count |
| ---------------- | ----: |
| fix              |     6 |
| keep with reason |     0 |
| abstract         |     0 |

No cross-file design-system sweep candidate was found. The changes remove obsolete UI branches and do not introduce new components, arbitrary Tailwind values, or interaction patterns.
