# Agent Org CLI Member UI Boundary Audit

- Date: 2026-07-12
- Scope: Agent Org settings, member selectors, and their rendered E2E coverage
- Method note: The `frontend-ui-audit` skill referenced by `AGENTS.md` is not present in the current environment. This report does not claim that the missing skill was executed; it applies the repository's established per-element audit table manually.

## Verdict summary

| Verdict          | Count |
| ---------------- | ----: |
| Fix, completed   |     4 |
| Keep with reason |     5 |
| Abstract later   |     1 |
| Open finding     |     0 |

## Audit table

| Line / surface                      | Element                       | Verdict          | Reason                                                                                                                                           | Suggested change                                                                                      |
| ----------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `SessionCreatorOrgMembersPanel.tsx` | Agent Org member picker       | fix              | The Session Creator reused a generic picker and exposed CLI members that the backend could not run in Agent Org.                                 | Pass `hideCliAgents` while preserving Rust built-in/custom options and the existing visual structure. |
| `AgentTeamWizard.tsx`               | Create/edit wizard options    | fix              | Settings explicitly fetched and injected installed CLI agents, presenting more capability than runtime supported.                                | Use Rust-native built-in/custom definitions only.                                                     |
| `OrgDetailView.tsx`                 | Historical Org edit options   | fix              | Detail editing must enforce the same runtime capability boundary as the wizard.                                                                  | Use the same Rust-only `buildAgentOptions`.                                                           |
| `AgentOrgs/index.tsx`               | CLI fetching state/effect     | fix              | The data existed only for the now-disabled Agent Org CLI picker and continued to create dead state and misleading refresh behavior.              | Remove CLI state, fetch/refresh effect, and prop plumbing from this surface.                          |
| `DispatchCategoryPalette`           | `hideCliAgents` prop          | keep with reason | Ordinary Sessions must still display CLI choices. An explicit capability flag limits the restriction to Agent Org without removing CLI globally. | Keep the default `false` and pass `true` only in Agent Org member selection.                          |
| `DispatchCategoryDropdown`          | Dropdown parity               | keep with reason | Dropdown and modal palette are existing responsive entry points; changing only one would create inconsistent options.                            | Keep prop forwarding and defaults aligned.                                                            |
| `useDispatchCategoryOptions`        | Option filtering              | keep with reason | Other pickers use the hook path, so CLI options and the CLI group header must be filtered consistently.                                          | Keep `hideCliAgents` applied to both options and group headers.                                       |
| `config.ts`                         | Rust-only `buildAgentOptions` | keep with reason | This builder is specific to Agent Org, not the global agent picker, so narrowing it does not affect ordinary CLI Sessions.                       | Keep the Rust-native scope explicit in comments.                                                      |
| `agentOrgUiDriver.mjs`              | Rendered negative assertion   | keep with reason | A backend save rejection is insufficient proof that UI capability is honest. The production picker must not render `cli-*` choices.              | Retain the rendered negative assertion.                                                               |
| Palette component + hook            | Duplicated option composition | abstract later   | Two existing composition paths must currently receive the flag for parity; more flags would increase drift risk.                                 | In a separate PR, extract a pure `buildDispatchCategoryGroups` selector used by modal and dropdown.   |

## UI behavior conclusion

- Agent Org create, edit, and Session Creator member overrides do not display CLI agents.
- Ordinary CLI Sessions and CLI-only pickers remain unchanged because `hideCliAgents` defaults to false.
- Historical CLI Agent Org definitions remain readable and deletable; save and launch return explicit unsupported validation.
- No arbitrary Tailwind value, visual token, interaction primitive, or accessibility pattern was introduced. The UI diff filters unsupported capability and removes dead data flow.
- TypeScript, ESLint, and rendered Settings E2E pass; the final rendered suite includes three Settings scenarios.
