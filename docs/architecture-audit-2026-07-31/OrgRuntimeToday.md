# Architecture Audit — Organization-aware Runtime

**Scope:** Runtime's Manage-Org-style `organization selector | tabs` header,
Personal versus cloud-organization ownership, organization Today analytics,
member breakdown/drill-down, and resource lifecycle across scope/tab changes.

## Acceptance criteria

- [x] Runtime owns an explicit Personal/cloud-organization selector in its
      primary header; the organization picker is not nested inside content.
- [x] The header layout and tab switch are shared with Manage Org rather than
      independently approximated.
- [x] Personal retains Usage, Profile, Quota, Scanning, Hooks, and Assets.
- [x] A cloud organization defaults to Today and exposes a separate Member
      breakdown tab.
- [x] Today can project usage and recent sessions to Everyone or one person.
- [x] Tokens, estimated cost, sessions, requests, cache hit rate, active
      members, current systems, average CPU, and average RAM are represented
      without a new telemetry payload.
- [x] The five latest explicitly shared sessions navigate through the existing
      Team Sessions reveal/replay path.
- [x] Stale machine samples are excluded from current CPU/RAM averages.
- [x] No polling loop, app-lifetime cache, persistence owner, or parallel
      session-sync path was added.

## 10-layer audit

| Layer | Coverage                             | Verdict        | Notes                                                                                                                                                                                                                                  |
| ----: | ------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness              | pass           | Focused Vitest, changed-file ESLint, TypeScript typecheck, locale parity, and `git diff --check` pass. No Rust boundary changed.                                                                                                       |
|     2 | Dead code / structural deduplication | pass           | `OrganizationScopeHeader` extracts the exact selector/separator/tab layout formerly owned only by Manage Org. Runtime and Manage Org now share that primitive and `OrganizationTabSwitch`; the obsolete nested org picker was removed. |
|     3 | Naming consistency                   | pass           | Personal and organization sections have distinct unions. `Today` consistently means the current UTC usage day, and `members` consistently owns cards/drill-down rather than duplicating them in Today.                                 |
|     4 | Semantic overloading                 | pass           | Runtime scope, Runtime tab, member-runtime telemetry, usage sessions, and explicitly shared session metadata remain separate dimensions. “Active member” is derived from today usage, not CPU or session status.                       |
|     5 | Default branches                     | pass           | Personal defaults to Usage; each valid cloud org defaults to Today. Signed-out, not-yet-loaded, removed-org, disabled, unsupported, empty, loading, and error states retain explicit behavior.                                         |
|     6 | Cross-domain leakage                 | pass           | Runtime owns selection/navigation, Org2Cloud hooks own authorized cloud reads, and presentation components receive typed rows/callbacks. Manage Org navigation remains owned by `OrganizationPanelHeader`.                             |
|     7 | New-developer clarity                | pass           | The shared header documents controlled ownership, the roster hook accepts Runtime's controlled org id, and the Today resource boundary explains why the remote-session consumer is mounted only on Today.                              |
|     8 | Wire protocol / serialization        | not applicable | No RPC, IPC, schema, payload, retention, or privacy contract changed. Titles/repos are not added to member-runtime telemetry; recent titles come only from already-shared Team Sessions metadata.                                      |
|     9 | Init / entry-point parity            | pass           | Opening Runtime from a cloud sidebar scope initializes that org; otherwise Personal is used. Picker changes, tab changes, explicit refresh, visibility return, and realtime invalidation all route through the existing coordinators.  |
|    10 | Resolver symmetry                    | pass           | Runtime and Manage Org use the same namespaced cloud selector values and canonical entry builder. Everyone/person views use the same usage rows, staleness policy, source fold, and recent-session projection.                         |

## Entry-point parity

| Entry point                                    | Selection owner                                        | Data owner                                                         | Result                                   |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------- |
| Open Runtime in Personal scope                 | Runtime local navigation state                         | Existing local Runtime panels                                      | Usage tab                                |
| Open Runtime while sidebar targets a cloud org | Runtime initializes from `sidebarActiveCloudOrgIdAtom` | Existing Org2Cloud roster/session coordinators                     | Selected org's Today tab                 |
| Pick another cloud org                         | Runtime header                                         | Roster generation guard + identity/org-keyed session coordinator   | Old member/person state clears           |
| Pick Personal                                  | Runtime header                                         | Organization panel unmounts                                        | Prior Personal tab is restored           |
| Select Today / Member breakdown                | Runtime header                                         | Roster remains mounted; Today alone mounts remote-session consumer | No duplicate fetch/cache owner           |
| Select a person                                | Today local projection                                 | No new request                                                     | Usage and recent sessions scope together |
| Click a recent session                         | Existing cloud-reference opener                        | Team Sessions admission/reveal                                     | Replay only when events exist            |
| Refresh / foreground return                    | Existing roster/session owners                         | Bounded, single-flight revalidation                                | No recurring poll                        |

## Systematic sweep

- Cloud selector values remain namespaced, so the personal sentinel cannot
  collide with a managed organization id.
- Member identity is sourced from `userId` on member-runtime and shared-session
  rows; agent/model identity remains presentation metadata.
- Usage day comparisons remain UTC string comparisons throughout Today,
  member cards, and drill-down ranges.
- No new `setInterval`, recursive timeout, listener owner, atom, module-global
  collection, localStorage key, RPC, or Tauri command was added.
- Session titles and repository metadata remain governed by Team Sessions
  sharing; member-runtime telemetry remains aggregate-only.
