# Integration category contract refactor review

This change addresses only the redundant integrations table dispatcher and universal prop contract. Each category retains its existing wizard/detail/list decision and concrete table implementation.

## Acceptance checklist

- The seven category views render their concrete tables directly
- Category contracts derive from the existing table component props; no replacement universal table/context object exists
- Each domain owns its pure table adapter; the page composes separate typed contracts
- Database selection/addition are required callbacks instead of optional generic no-op/fallback paths
- Existing production loading expressions, action destinations, selection keys, wrappers, and wizard/detail precedence remain unchanged
- No table implementation, data hook, API call, persistence payload, listener, timer, or cache is changed
- No remaining production reference to CategoryTableContent, useIntegrationsCategoryTableProps, or their dead category aliases

## Architecture layers

| Layer                           | Verdict and evidence                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — compilation                 | Full TypeScript check and changed-file lint are required independently of git hooks; exact outcomes are recorded in the PR verification                                                                                                                                                                                                    |
| 2 — dead code and deduplication | Removed the 314-line dispatcher and 158-line combined builder; swept all seven direct callers plus external skillsets/detail/page composition. Removed the dispatcher-only category aliases and constant after a full source reference check                                                                                               |
| 3 — naming                      | `AccountsCategoryTableProps`, `McpCategoryTableProps`, etc. name concrete contracts; each `get…CategoryTableProps` function is a pure category adapter, not a hook                                                                                                                                                                         |
| 4 — semantic overloading        | `category` continues to mean a navigation category in the detail router. The old mixed navigation/table category union is gone; nested MCP/skills tab routing remains explicit                                                                                                                                                             |
| 5 — defaults                    | Account URL-tab precedence, connection loading OR, rules loading OR, routine-only loading, selection nulls, and embedded chrome remain unchanged. Database generic fallbacks and MCP generic add fallback were unreachable in the only production builder, which supplied required values; the concrete contracts now require those values |
| 6 — domain boundaries           | No category view receives accounts, channels, databases, MCP, skills, rules, routines, and CLI state together. The composition root still owns its existing state lifetime, while each category adapter only constructs its own table props                                                                                                |
| 7 — readability                 | The category view shows its concrete table directly; it no longer passes a hardcoded category through another switch                                                                                                                                                                                                                       |
| 8 — wire protocol               | Not applicable to implementation: no request construction, serialization, public IPC, schema, or persistence format changes. Dead TypeScript category aliases were internal dispatcher scaffolding, not wire values                                                                                                                        |
| 9 — initialization parity       | The state hooks remain in useIntegrationsPage in the same order, with the same activation gates. The removed hook was a pure useMemo adapter. Existing table/wizard/detail mount branches and Suspense fallbacks remain the same                                                                                                           |
| 10 — resolver symmetry          | There is no changed multi-source resolver. The one relevant fallback, URL-selected models tab before extension state, is retained and tested                                                                                                                                                                                               |

## UX preservation evidence

`categoryTableRouting.test.ts` renders the real category views into mocked table/wizard/detail leaves. It verifies all seven narrow adapter boundaries, loading inputs, account/CLI data, scoped MCP actions, row keys, rules editor intent, skills import callback precedence, wizard/detail routing, database write-before-close ordering, and all three external-skillset tab routes. These are boundary tests, not full application E2E.

A separate one-off comparison compiled the original builder, dispatcher, and seven category views from the base commit, then compared their outputs against the refactor using the same fixtures. All seven list paths matched in rendered tree, defined leaf props, and callback destinations/arguments. Undefined absent props were treated equivalently because the unchanged concrete tables destructure those optional props with the same defaults.

Two skills callback fields (`onEditSkill` and `onCloseSkillPreview`) were accepted by the removed dispatcher but never forwarded to SkillsTable. They remain unforwarded, with regression assertions, to avoid adding behavior during this refactor. The category-view call contract still accepts the existing preview close prop for its callers.

No screenshots, live account login, backend database probing, MCP process actions, or real Tauri visual checks were run. Computer control was not authorized. The concrete table implementations and their existing loading/error/empty rendering are untouched, but mocked-leaf tests do not establish pixel-level parity or prove unrelated backend behavior.

## Performance guard

| Area               | Verdict | Evidence                                                                                                      | Change or reason kept                                                                                       | Verification                                                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Background work    | keep    | State hooks, their enabled gates, MCP timers, and account save debounce are unchanged                         | No new resource owner or cadence; category routing preserves mount conditions                               | Diff review and real category routing tests                                             |
| Memory             | keep    | New adapters construct render-local objects only; no global store, cache, map, or subscription added          | Removed pure aggregate memo; table-owned selections and state remain in unchanged table components          | Source ownership review                                                                 |
| Scope/isolation    | keep    | Existing account, category, repository, database, and extension identifiers/callbacks are forwarded unchanged | No identity or persistence boundary changed                                                                 | Callback, selection, repository-projection and persistence-order assertions             |
| Rendering/hot path | keep    | Concrete tables and wrappers are unchanged; no key or lazy-loading policy changes                             | Removed one stateless dispatcher layer; original dispatcher already recreated add-action closures on render | Seven-path before/after contract comparison; no runtime performance improvement claimed |

Lifecycle matrix: app start/active/idle/shutdown and category activation retain the same state-hook owners; document visibility/focus, network/retry, account/endpoint/org changes, sessions, source ingestion, and machine topology have no changed resource or key. Wizard/detail/table transitions retain existing mount conditions. Provider ingestion and cloud transport are outside this change. Runtime CPU/RSS measurements were not run because this is a structural contract refactor, not a performance optimization.

Performance verdict: **pass for the unchanged resource-ownership surface**. This verdict does not claim measured performance gains or validate unrelated existing timer behavior.
