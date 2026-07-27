# Architecture Audit — Cloud Organization Sessions Navigation

**Scope:** Manage Org tab ownership, General-to-Kanban navigation, remote-session List actions, retention feedback, dead page removal, and rendered coverage
**Date:** 2026-07-22
**Auditor:** Codex

## Acceptance criteria

- [x] Manage Org exposes only General and Members.
- [x] General contains a localized Sessions row using the shared settings-row contract.
- [x] One click selects the managed cloud organization and opens the existing Work Management Kanban tab.
- [x] The duplicate Sessions page, private mapper, and page-only test are deleted with no remaining production callers.
- [x] Replayable teammate rows expose Take over in Kanban List; metadata-only rows do not.
- [x] Take over uses the existing cloud fork implementation and retention-expiry feedback has one owner.
- [x] Rendered E2E asserts the dead tab is absent and the scoped List/action is present.

## 10-layer audit

### Layer 1 — Compilation correctness

- Passed 18 focused component tests across five files.
- Passed targeted ESLint, the full TypeScript check, E2E spec syntax validation, and `git diff --check`.
- Passed the executable-source sweep for removed page, mapper, tab constant, and page-only selectors.

### Layer 2 — Dead code and structural deduplication

- Deleted `CloudSessionsSection`, `cloudSessionTableItem`, and its isolated mapper test.
- Removed the `sessions` management-tab union member and constant.
- Removed the now-unread `retentionExpiredRowId` hook state after retention feedback moved into the canonical action hook.
- The surviving sidebar Team sessions section remains distinct: it is navigation/thread chrome, not a second management page.

### Layer 3 — Naming consistency

- `Sessions row` means navigation to the organization-scoped Work Management surface.
- `Take over` is the List presentation of the existing fork-and-continue action; implementation names remain `forkSession` because they describe the underlying operation.
- No stale `CloudSessionsSection` or management-tab state remains.

### Layer 4 — Semantic overloading

| Term          | Meaning                                                           | Verdict                            |
| ------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Sessions      | Organization-filtered agent sessions projected by Work Management | One destination: Kanban/List/Diary |
| Take over     | User-facing continuation of a teammate session                    | Presented in List only             |
| Fork          | Canonical engine operation that creates the local continuation    | Kept as the implementation term    |
| Team sessions | Sidebar navigation/thread grouping                                | Kept; not a management page        |

### Layer 5 — Default branch analysis

- Management tabs use an explicit two-value union; no catch-all can route a removed `sessions` value.
- Take over renders only when a remote row exists and `eventsEpoch` proves replay data is available.
- Local and metadata-only tasks fall through to no action rather than an unsafe default.

### Layer 6 — Cross-domain concept leakage

- `CloudOrgPanelView` coordinates navigation only; it does not fetch or render session roster data.
- `TaskKanban` owns remote-task lookup and cloud actions; generic `ListView` and `SessionTable` receive only an optional React row action.
- The generic table remains unaware of cloud auth, remote metadata, and fork semantics.

### Layer 7 — New-developer confusion test

- The only Manage Org destinations are visible in one typed constant.
- `handleOpenSessions` makes the two navigation effects explicit: set scope, then open Kanban.
- `renderListRowAction` makes the List-only placement and replayability guard visible next to the canonical fork call.

### Layer 8 — Wire protocol and serialization

- No request, response, persistence, or serialized metadata shape changed.
- Take over reuses `forkTeammateSession` through `useCloudSessionActions`; no UI-side fork payload was introduced.

### Layer 9 — Init and entry-point parity

| Entry point            | Scope selection        | Destination                  | Action owner             |
| ---------------------- | ---------------------- | ---------------------------- | ------------------------ |
| General Sessions row   | Writes `cloud:<orgId>` | Work Management Kanban       | `useCloudSessionActions` |
| Kanban header selector | Existing shared atom   | Current Work Management view | `useCloudSessionActions` |
| Sidebar Team session   | Existing shared atom   | Replay/session tab           | `useCloudSessionActions` |

### Layer 10 — Resolver symmetry

- General navigation uses `buildCloudOrgSelectorValue`, the same namespace consumed by `useKanbanOrgScope`.
- Kanban, List, and Diary continue to receive the same cloud-org projection; only List supplies the trailing action renderer.
- Replay and Take over both resolve the remote row from the same `remoteSessionsByTaskId` map and use the same action hook.

## Systematic sweep

- Swept management-tab type, header, panel branch, tests, E2E selectors, page component, and private mapper.
- Swept remote-session action consumers in Manage Org, sidebar, header extras, and Task Kanban.
- Centralized retention-expiry notification in `useCloudSessionActions` so sidebar replay/fork and List Take over cannot diverge.
- Confirmed shared sidebar empty/error/retention translations are still live and retained them.
