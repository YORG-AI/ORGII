# Architecture Audit — Source Control Repo Scope

**Date:** 2026-07-08
**Scope:** Source Control issue/PR workstation atoms, sidebar/main-pane readers, issue detail tabs, ADE context collection.

## Layers Covered

| Layer                           | Verdict              | Notes                                                                                                                                        |
| ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compilation correctness       | pending verification | `npm run typecheck` and targeted lint are run after this report is staged.                                                                   |
| 2 Dead code / structural dedupe | pass with fix        | Swept legacy global atom reads. Production readers now use `atomFamily`; legacy exports remain only as default-scope compatibility aliases.  |
| 3 Naming consistency            | pass                 | New `workstationRepoScopeKey` names the repo/path fallback explicitly.                                                                       |
| 4 Semantic overloading          | pass                 | "scope" is limited to workstation repo state, not UI filter scope.                                                                           |
| 5 Default branch analysis       | pass with note       | Fallback is `repo:<repoId>` -> `path:<repoPath>` -> `default`; API calls keep their existing `"default"` repo id fallback separately.        |
| 6 Cross-domain leakage          | pass                 | Repo-scoped state remains in workstation code-editor atoms; ADE collector only reads the active workspace scope.                             |
| 7 New developer confusion       | pass with fix        | Default-scope legacy exports now alias the corresponding family atom instead of being independent atoms.                                     |
| 8 Wire protocol                 | not applicable       | No serialized payload shape changed; repo id/path request arguments are preserved.                                                           |
| 9 Init parity                   | pass                 | Sidebar, main pane, issue detail tab, Manage Issues handoff, and ADE collector all derive a scope key before reading/writing issue/PR state. |
| 10 Resolver symmetry            | pass with fix        | Issue and PR state families use the same repo id/path fallback chain, and each family instance receives its own initial object.              |

## Sweeps

| Sweep                    | Result                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy global atom reads | No production reads remain outside compatibility exports and docs/test notes.                                                                                             |
| Scope key propagation    | `useWorkstationPr`, `useWorkstationIssues`, Source Control sidebar/main pane, issue detail tab, Manage Issues handoff, and ADE context collector all derive scoped atoms. |
| API repo id fallback     | Preserved existing `repoId ?? "default"` for backend calls while state scoping can still fall back to repo path.                                                          |

## Fixes Landed From Audit

- Converted legacy PR/issue callback/list exports to default-scope family aliases for consistent compatibility behavior.
- Cloned family initial objects/arrays per scope to avoid shared initial references.

## Residual Notes

- `workstationSelectedPrAtom` still has a TODO referencing future atom-family migration, but it is a separate selected-PR detail surface and not part of this issue/PR list-state split.
