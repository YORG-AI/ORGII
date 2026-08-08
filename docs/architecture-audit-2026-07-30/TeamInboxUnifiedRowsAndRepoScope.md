# Team Inbox Unified Rows and Repository Scope — Architecture Audit

## Acceptance checklist

- [x] PR and Work Item rows have one presentation primitive.
- [x] Both row adapters use the shared List Panel tokens.
- [x] Both item types use the same title and metadata overflow behavior; mention comments alone use the primitive's bounded two-line preview.
- [x] PRs show the optional GitHub author avatar with compact number, repository, and source-branch metadata.
- [x] Missing or failed PR avatars leave no broken image or placeholder layer.
- [x] An active Cloud Org loads PRs only from its persisted synced-repository scopes.
- [x] An active Cloud Org with no defined scopes loads and shows no PR repositories.
- [x] Switching Org scope synchronously excludes stale, previously loaded PR sources from the returned item list.
- [x] No polling, retry timer, unbounded cache, or new network entry point was added.

## Call-chain trace

`ConnectedTeamInboxView` → `useTeamInboxPullRequests` → active Cloud Org id +
`org2CloudRepoScopesAtom` → strict `repoMatchesOrgScopes` →
`useGitHubWorkItemsLoadLifecycle` → existing coalesced GitHub PR list command.

The selected repository list is applied before source resolution or network
loading. The final managed-item projection also checks selected repository ids,
which prevents a previous Org's lifecycle state from rendering during the
effect cleanup between scope renders.

## Ten-layer audit

| Layer                                   | Scope inspected                                                                          | Verdict                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation correctness              | New row primitive, Avatar option, Org-scoped PR hook, targeted tests                     | Pass: TypeScript typecheck, focused ESLint, and targeted Vitest pass.                                                                      |
| 2. Dead code and structural duplication | Team Inbox PR and Work Item row markup                                                   | Fixed: the separate `ConfigListItem` PR path and duplicated Work Item row shell converge on `TeamInboxListItem`.                           |
| 3. Naming consistency                   | `TeamInboxListItem`, `scopedRepos`, `orgScopes`, `scopedRepoIds`                         | Pass: names distinguish the UI row primitive, persisted Org repository scopes, and the selected repository set.                            |
| 4. Semantic overloading                 | “scope” across GitHub query kind and Org repository membership                           | Pass: `GITHUB_QUERY_SCOPE.PR` remains the request-kind boundary; `orgScopes` is used only for repository membership.                       |
| 5. Default branches                     | No active Org, active Org without scopes, unresolved local repo identity, missing avatar | Pass: local mode preserves existing behavior; active Org empty/unresolved scope is strict-empty; optional avatar is omitted.               |
| 6. Cross-domain leakage                 | Team Inbox, shared Org repository matcher, shared Avatar, Work Management lifecycle      | Pass: Org matching stays in the collaboration scope utility and GitHub loading stays in Work Management; Team Inbox composes them.         |
| 7. New-developer clarity                | Pure repository selection helper and row adapters                                        | Pass: selection is independently tested and presentation/domain responsibilities are explicit.                                             |
| 8. Wire protocol and serialization      | GitHub list command boundary                                                             | Not changed: the same PR command and payload run for fewer repository inputs.                                                              |
| 9. Init parity across entry points      | Team Inbox PR path versus general Work Management                                        | Pass: only Team Inbox adds Org membership selection; both still converge on the same lifecycle and GitHub command.                         |
| 10. Resolver symmetry                   | Checkout path / remote repository identity                                               | Pass: the strict canonical matcher keeps its existing `fs_uri` resolution with `repo_url` fallback and reacts to resolver version changes. |

## Default-branch analysis

| Condition                                       | Result                                                          | Reason                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| No active Cloud Org                             | Return the existing repository array                            | Preserves local/personal Team Inbox behavior.                             |
| Active Org has no scope entry or an empty entry | Return no repositories                                          | The Org surface must not broaden to every tracked checkout.               |
| Checkout identity is still resolving            | Do not match yet; resolver primes and version change recomputes | Strict visibility prevents temporary cross-scope results.                 |
| Avatar URL is null or the request errors        | Render no avatar                                                | A decorative failure must not create a broken-image or placeholder layer. |

## Performance and lifecycle verdict

| Area            | Verdict | Evidence                                                                                                      | Change or reason kept                                           | Verification                                                      |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Background work | Pass    | Scoped repositories are passed into the existing lifecycle before source resolution and GitHub calls.         | Reduced Org-mode request fan-out.                               | Repository-selection unit tests.                                  |
| Memory          | Pass    | Only a render-scoped `Set` of selected repository ids was added; no app-lifetime map or cache was introduced. | Existing bounded/coalesced caches are unchanged.                | Code inspection and typecheck.                                    |
| Scope isolation | Pass    | Empty scopes return `[]`; output projection also filters lifecycle sources by selected repo id.               | Prevents requests and stale-row visibility across Org switches. | Unit tests cover active, inactive, empty, and another-Org scopes. |
| Rendering       | Pass    | One shared row component replaces two presentation paths and uses existing List Panel tokens.                 | No duplicate row state or subscription.                         | Static render and jsdom avatar tests.                             |

Desktop Computer Use was not authorized, so rendered-app visual inspection was
not performed; source-token, static-render, jsdom interaction, lint, and
typecheck verification were used instead.
