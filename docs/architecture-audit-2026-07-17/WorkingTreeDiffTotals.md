# Architecture Audit — Working-tree diff totals

**Scope:** shared working-tree additions/deletions data path
**Date:** 2026-07-17
**Auditor:** Codex
**Audited ref:** `origin/develop` at `5be17525bc38c56c27157de5f7e2f471bff45d42`
**Related UI audit:** `docs/frontend-ui-audit-2026-07-17/DiffStatsSurfaces.md`

## Outcome

The presentation and fetch implementation are reused by name, but the runtime
resource is not shared.

- All visual consumers render `DiffStatsBadge`.
- Four surfaces call `useWorkingTreeDiffTotals`.
- Every hook instance owns independent React state, initial fetch, debounce
  timer, and `repo:status_updated` listener.
- `getGitDiffNumstatCombined` has no in-flight deduplication or result cache.

In the normal WorkStation editor surface, the Start Page stays mounted while
hidden, the tab-bar plus menu is always mounted, and the editor status bar is
mounted. This creates at least three simultaneous instances for the same repo.
The focused-chat rail can add a fourth. A Source Control sidebar may separately
request the same raw `numstat-combined` payload for its per-file map.

Therefore one repo-status event can fan out into three or four equivalent
aggregate GETs, plus the Source Control per-file request when that surface is
active.

## Completion criteria for a refactor

- [ ] One canonical working-tree numstat resource per
      `(repoId, repoPath, fromRef, includeUntracked)` key.
- [ ] One active refresh subscription/controller per resource key.
- [ ] All aggregate UI consumers read the same snapshot.
- [ ] Concurrent identical HTTP reads share one in-flight promise.
- [ ] Source Control either derives its per-file map from the same raw snapshot
      or documents why it needs an independent resource.
- [ ] Active-repo matching is resolved by one helper rather than separately in
      the status bar and other surfaces.
- [ ] Tests prove that mounting three consumers causes one initial request and
      one request per status-update burst.

## Layer 1 — Compilation correctness

No implementation change was made, so compilation was not rerun against the
audited remote ref. Existing TypeScript is syntactically valid in the inspected
production paths; this audit does not claim a new compile gate result.

## Layer 2 — Dead code and structural deduplication

| Path                             | Role                                             | Result                                           |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `useWorkingTreeDiffTotals.ts`    | Aggregate fetch + local state + refresh listener | Shared source code, duplicated runtime instances |
| `StartPage/index.tsx`            | Review-row total                                 | Hook consumer; mounted even when visually hidden |
| `TabBarPlusMenu.tsx`             | Review-row total                                 | Hook consumer; menu component stays mounted      |
| `useEditorStatusBarGit.ts`       | Branch-button total                              | Hook consumer                                    |
| `FocusedChatWorkstationRail.tsx` | Review-row total                                 | Hook consumer in focused-chat layout             |
| `usePerRepoSourceControl.ts`     | Per-file numstat                                 | Separate state path over the same raw endpoint   |

No dead abstraction was found. The issue is duplicated ownership rather than
duplicated function bodies.

## Layer 3 — Naming consistency

`useWorkingTreeDiffTotals` accurately describes working-tree line totals.
`DiffStatsBadge` accurately describes presentation only. No rename is required.

The hook comment names only some consumers and should be updated if the resource
is refactored; consumer enumeration in comments is already stale-prone.

## Layer 4 — Semantic overloading

| Term                     | Meaning                                                          | Owner                        |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------- |
| working-tree diff totals | Added/deleted lines across staged, unstaged, and untracked files | `useWorkingTreeDiffTotals`   |
| branch ahead/behind      | Commit counts relative to upstream                               | `GitSyncStatusMenu`          |
| branch diff summary      | Committed branch delta versus a base ref                         | Source Control scope helpers |
| per-file numstat         | Added/deleted lines keyed by file path                           | `usePerRepoSourceControl`    |

These should remain distinct. The screenshot places working-tree totals beside
ahead/behind controls, but that visual proximity does not make them the same
domain value.

## Layer 5 — Default branch analysis

- Missing repo identity intentionally produces `{ additions: 0, deletions: 0 }`.
- A repo-key mismatch intentionally hides the previous repo's totals.
- The HTTP wrapper converts endpoint failures to `undefined`, which the hook
  maps to zero. This is acceptable for cosmetic data but makes failures
  indistinguishable from a clean tree.

No unsafe enum/default branch was found in this path.

## Layer 6 — Cross-domain concept leakage

The aggregate hook lives under `hooks/git`, which is the correct domain. UI
surfaces do not import transport details directly. The Source Control hook owns
per-file state separately; that semantic separation is valid, but sharing the
raw resource would avoid redundant transport work.

## Layer 7 — New developer confusion test

The current API looks shared because every consumer calls the same hook. A new
developer could reasonably assume this also shares the fetched result. It does
not: React custom hooks share implementation, not state.

This distinction should be made explicit by moving ownership to a keyed store
or controller and making the consumer hook read-only.

## Layer 8 — Wire protocol and transport

All aggregate instances issue the same request shape:

`GET /git/repos/{repoId}/diff/numstat-combined?path={repoPath}&from_ref=HEAD&include_untracked=true`

The request handler and `getGitDiffNumstatCombined` do not deduplicate in-flight
requests. This is unlike existing Git status/branches APIs, which already share
in-flight promises through request caches.

No payload-schema issue exists; the defect is request fan-out.

## Layer 9 — Init/subscription parity

All four aggregate consumers eventually use the same fetch and listener steps,
but they each initialize those steps independently. The initial-fetch matrix is
therefore complete but unnecessarily repeated.

| Consumer          | Resolve repo | Initial GET | Status listener | Local debounce/state |
| ----------------- | -----------: | ----------: | --------------: | -------------------: |
| Start Page        |          yes |         yes |             yes |                  yes |
| Plus menu         |          yes |         yes |             yes |                  yes |
| Editor status bar |          yes |         yes |             yes |                  yes |
| Focused-chat rail |          yes |         yes |             yes |                  yes |

## Layer 10 — Resolver symmetry

Start Page, plus menu, and focused-chat rail use `useActiveRepoRef`. The editor
status bar independently reconstructs the same selected-repo/path equality
gate inside `useEditorStatusBarGit`. The chains are equivalent today, but there
are two owners and future fallback changes can drift.

| Consumer group               | Workspace path | Selected repo path | Selected repo ID | Exact-path gate |
| ---------------------------- | -------------: | -----------------: | ---------------: | --------------: |
| `useActiveRepoRef` consumers |            yes |                yes |              yes |             yes |
| Editor status bar            |     yes (prop) |                yes |              yes |             yes |

The status bar should consume the canonical resolver or a shared lower-level
resolver function.

## Recommended ownership model

Introduce one repo-keyed numstat resource containing the raw combined response.
A single controller subscribes to repo-status changes and refreshes that
resource. Aggregate consumers derive totals; Source Control derives its per-file
map. Add in-flight deduplication at the API/resource boundary as a safety net,
not as the sole fix, because request deduplication alone would leave duplicate
listeners, timers, and state owners intact.

This is a bounded data-layer refactor. It does not require another visual
component or changes to `DiffStatsBadge`.
