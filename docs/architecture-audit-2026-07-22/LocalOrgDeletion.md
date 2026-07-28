# Local organization deletion — architecture audit

## Acceptance criteria

- Local/personal project-org settings no longer imply that organizations own a member catalog; project-level member settings remain unchanged.
- Every local-org settings entry point exposes the same Danger Zone interaction and requires the exact org name before deletion.
- The default `personal-org` remains visible in settings but cannot be deleted.
- Only non-default, local-truth org rows can use the local delete command; collab/cloud aliases are rejected in both TypeScript eligibility and Rust authority checks.
- A successful deletion atomically removes the org, its projects, project and standalone work items, cascading children, adapter metadata, conflicts, and queued sync rows.
- Deleted-org Chat Panel and WorkStation surfaces close, and Chat Panel management returns to Personal Org.
- The frontend cache is invalidated and the backend emits the project-data-changed event after a successful commit.
- TypeScript, targeted ESLint, focused Vitest, Rust formatting, focused Rust tests, JSON parsing, and whitespace validation pass.

## Ten-layer audit

| Layer | Coverage                           | Verdict | Evidence / reason                                                                                                                                                                             |
| ----: | ---------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness            | pass    | Full `tsc --noEmit`, targeted ESLint, project-management rustfmt, 44 focused Vitest assertions, and 8 focused Rust org tests pass.                                                            |
|     2 | Dead code / structural duplication | pass    | Org-level member aggregation, project member reads, update fan-out, props, and Members section were removed together. Project-level member management remains at its real ownership boundary. |
|     3 | Naming consistency                 | pass    | `deleteOrg` / `project_delete_org` / `delete_project_org` follow the existing frontend-command-IO naming chain; `canDeleteLocalProjectOrg` names the policy rather than a UI state.           |
|     4 | Semantic overloading               | pass    | Local deletion is not inferred from the presence of a SQLite row: source, provider, external id, and canonical personal id are validated explicitly.                                          |
|     5 | Default branches                   | pass    | Empty IDs, missing orgs, personal org, and cloud/collab aliases all return explicit errors; no unknown org kind falls through to deletion.                                                    |
|     6 | Cross-domain leakage               | pass    | Local truth is deleted only by the local command. Cloud membership/deletion remains in cloud settings, and project members remain project-owned.                                              |
|     7 | New-developer clarity              | pass    | The UI predicate documents discoverability, while the Rust transaction is the authority boundary and explains why cloud-backed rows are rejected.                                             |
|     8 | Wire protocol / serialization      | pass    | One additive Tauri command accepts the established camelCase `{ orgId }` payload and maps to Rust `org_id`; no stored row format or migration changed.                                        |
|     9 | Entry-point parity                 | pass    | Shared hub settings serves Chat Panel and both WorkStation org renderers; all call the same deletion hook and perform surface cleanup appropriate to their host.                              |
|    10 | Resolver symmetry                  | pass    | Frontend eligibility and backend validation both protect personal, non-local, collab-provider, and externally aliased rows. The backend remains authoritative if UI checks are bypassed.      |

## Call path

`OrgDangerZone` → `useProjectOrgCatalogData.handleDeleteOrg` → `projectApi.deleteOrg` → Tauri `project_delete_org` → transactional `delete_project_org` → cache/event refresh → host-specific deleted-org tab cleanup.

## Data ownership sweep

| Owned data                                               | Delete behavior                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `project_orgs`                                           | Deletes the selected non-default local row last.                                             |
| `projects`                                               | Deletes every row for the org; labels, milestones, and project members cascade.              |
| `workitems`                                              | Deletes project and standalone rows by `org_id`; extras and label joins cascade.             |
| `webhook_secrets`, `import_progress`, `outbox_conflicts` | Deletes rows for project slugs before project rows disappear.                                |
| `outbox_entries`                                         | Deletes project-slug rows and any explicitly org-tagged rows.                                |
| Routines / routine fires                                 | Kept: these are global automation/provenance records rather than org-owned catalogs.         |
| Asset blobs                                              | Kept, matching existing user-confirmed project deletion semantics for later export/recovery. |

## Entry-point parity matrix

| Surface                                   | Confirmation                         | Success behavior                                                              |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Shared Chat Panel local-org settings      | Exact org name                       | Closes all Chat Panel surfaces for the org and opens Personal Org settings.   |
| WorkStation project-org hub               | Exact org name                       | Closes every WorkStation tab whose payload belongs to the org.                |
| WorkStation project-org settings renderer | Exact org name                       | Uses the same shared hub and WorkStation cleanup atom.                        |
| Default Personal Org                      | Controls remain visible but disabled | No command is sent; Rust independently rejects the canonical id.              |
| Cloud/collab alias                        | Not eligible for local deletion      | Rust rejects direct calls and directs lifecycle management to cloud settings. |

## Scoped-out layers

Cloud organization deletion, membership roles, project-level member editing, asset blob cleanup, schema migrations, and remote tombstone protocols were intentionally unchanged.
