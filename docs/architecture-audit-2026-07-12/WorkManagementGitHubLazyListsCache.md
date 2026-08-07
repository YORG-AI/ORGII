# Kanban GitHub lazy lists and cache — architecture audit

## Acceptance criteria

- Kanban fetches open pull requests on entry and fetches closed pull requests only when the Closed or Merged view is selected.
- Closed pull-request results include both closed-unmerged and merged pull requests.
- Issues, open PRs, and closed PRs reuse one shared global list cache rather than maintaining Workstation- and Ops-specific copies.
- Fresh cache entries suppress repeat list requests for 10 minutes; manual refresh bypasses the TTL for the visible state.
- Open and closed issue freshness are tracked independently so refreshing one state cannot extend the other state’s lifetime.
- Rapid unmount/remount cycles share an in-flight request, and completed/rejected promises are removed without timers or subscriptions.
- Cache hydration and writes are both LRU-bounded: four issue repositories, eight PR repo/state lists, and twenty PR details.
- Kanban retains only one active page/query snapshot per GitHub scope and evicts it on access after 10 minutes.
- Switching between Issues, PRs, and other Kanban sections restores the active page without retaining component trees.
- Targeted ESLint, TypeScript, cache tests, query-state tests, and pagination tests pass.

## Ten-layer audit

| Layer                                 | Coverage                                                    | Verdict | Evidence / reason                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | TypeScript and changed-file lint                            | pass    | `tsc --noEmit`, targeted ESLint, and nine focused tests pass. Rust is unchanged.                                                                                                                  |
| 2. Dead code / structural duplication | GitHub list-cache ownership                                 | pass    | The cache moved from a Workstation hook directory to `services/git`; My Station and Kanban now import the same live implementation.                                                               |
| 3. Naming consistency                 | Cache, state, and view terminology                          | pass    | `openPrs`, `closedPrs`, `openLoaded`, `closedLoaded`, and `OpsGitHubViewSnapshot` distinguish remote state, load lifecycle, and UI position.                                                      |
| 4. Semantic overloading               | “page”, “state”, “cache”, and “closed”                      | pass    | Page means the 25-row client page; PR state means GitHub open/closed request state; Closed UI intentionally includes GitHub `merged` results returned by the closed endpoint.                     |
| 5. Default branches                   | PR query-state resolution                                   | pass    | Open/null resolves only open, Closed/Merged resolves only closed, and explicit All resolves both; focused tests cover every branch.                                                               |
| 6. Cross-domain leakage               | Workstation ↔ Kanban                                        | pass    | Data caching is owned by the shared Git service. Ops-only query/page snapshots remain local to Kanban and do not leak UI concerns into the service.                                               |
| 7. New-developer clarity              | Cache lifetime and cleanup                                  | pass    | Constants document the exact 10-minute TTL and LRU bounds; in-flight request cleanup and read-time snapshot expiry explain why no background timer is needed.                                     |
| 8. Wire protocol / serialization      | GitHub PR list command and local persistence                | pass    | The existing `github_list_prs` payload remains `{ repoFullName, state, perPage }`; no Rust command or external schema changed. Bounded list caches continue using versioned localStorage keys.    |
| 9. Init parity                        | Open, Closed, Merged, All, refresh, and remount entry paths | pass    | Every PR list state follows repo resolution → cache seed → TTL decision → coalesced request → cache update. Closed differs only by deliberate lazy activation.                                    |
| 10. Resolver symmetry                 | Open/closed issue and PR cache/fetch chains                 | pass    | Issue sections have independent timestamps; both PR states use identical cache keying, staleness checks, request coalescing, network fallback, error fallback, loaded flags, and LRU persistence. |

## Cache bounds and lifecycle

| Cache           | Key                                 |                                            Bound | Expiry / cleanup                                   |
| --------------- | ----------------------------------- | -----------------------------------------------: | -------------------------------------------------- |
| Issues          | repository path                     | 4 repositories; 200 rows per open/closed section | 10-minute access check; LRU on hydration and write |
| PR lists        | repository path + open/closed state |                       8 lists; 100 rows per list | 10-minute access check; LRU on hydration and write |
| PR details      | repository + PR number              |                                       20 details | 10-minute access check; memory-only LRU            |
| Ops view        | issue/PR scope                      | exactly 2 snapshots; one current page/query each | 10-minute read-time eviction; memory-only          |
| In-flight lists | request kind + state + repository   |                             active requests only | deleted in `finally` after resolve or reject       |

## Scoped-out layers

No Rust, Tauri command signature, GitHub authentication, issue/PR mutation, database schema, session runtime, or queue lifecycle changed. The cache continues to treat GitHub as authoritative and is bypassed by explicit refresh.
