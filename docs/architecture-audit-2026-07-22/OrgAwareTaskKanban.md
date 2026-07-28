# Architecture Audit — Organization-aware Task Kanban

**Scope:** Shared sidebar organization selection, Task Kanban session projection, organization creator attribution, cloud metadata/import round-trip, Kanban/List presentation, and visibility-aware board time boundaries
**Date:** 2026-07-22
**Auditor:** Codex

## Acceptance criteria

- [x] Personal, local organization, and managed-cloud selections filter the Task Kanban data before view-specific rendering.
- [x] Kanban, List, and Diary consume the same scoped task array; Data Source remains independent.
- [x] Cloud-tagged/imported local sessions and authoritative remote cloud-org roster rows share one deduplicated projection.
- [x] Remote replayable rows use the existing cloud replay action; metadata-only rows remain visible but non-interactive.
- [x] Organization cards show creator avatar plus name; absent profile images produce deterministic initials.
- [x] List exposes the same identity in a conditional Created by column and Personal avoids an empty column.
- [x] Creator identity comes from import provenance/current authenticated profile, not agent or Agent-Team identifiers.

## 10-layer audit

### Layer 1 — Compilation correctness

- Targeted Vitest coverage passes for organization matching, Personal exclusion, creator resolution, avatar fallback, shared table mapping, cloud wire metadata, and timer lifecycle.
- Targeted ESLint passes without warnings; `pnpm typecheck` passes.
- `git diff --check` passes.

### Layer 2 — Dead code and structural deduplication

- `sidebarSelectedOrgIdAtom`, `buildSessionOrgFilterIds`, and `sessionMatchesOrgFilter` now have feature-level owners under `features/Organizations`; former scaffold paths are compatibility exports.
- Task scope is applied once in `useKanbanTasks`, before replay, time, Diary, List, and Kanban projections.
- `buildCloudRemoteKanbanProjection` is the single adapter for remote-row mapping, creator identity, own/imported dedupe, and action flags.
- Creator avatar/initial presentation has one shared `TaskCreator` component used by both card and table renderers.

### Layer 3 — Naming consistency

- `KanbanOrgScope` means the human/project organization selected in the sidebar.
- `KanbanTask.createdBy` means human creator identity.
- Existing `KanbanTask.orgName` remains explicitly Agent-Team display metadata and is not reused for cloud/local organization ownership.

### Layer 4 — Semantic overloading

| Term                | Meaning                                                                   | Verdict                                  |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| Organization scope  | Personal, local project org, or managed-cloud org selected in the sidebar | Keep                                     |
| Agent Team          | Runtime/coordinator definition identified by `agentOrgId`/`agentOrgName`  | Kept separate                            |
| Creator             | Human owner that created/published the organization session               | Keep; never inferred from agent metadata |
| Imported provenance | Persisted remote owner id/name/avatar tied to the copied session          | Canonical for teammate attribution       |

### Layer 5 — Default branch analysis

- Personal is explicit through `DEFAULT_SESSION_ORG_ID`; it is not the fallback for unknown non-Personal ownership.
- Cloud selector values accept both namespaced `cloud:<id>` and persisted bare ids at the shared resolver.
- Missing avatar URLs take the initials path; missing remote display names fall back to the persisted owner id.
- Disabling `followSidebarOrgScope` retains the prior unscoped behavior for future controlled embeds.

### Layer 6 — Cross-domain concept leakage

- Organization atoms and matching helpers live in `features/Organizations`, not Task Kanban or sidebar scaffolding.
- Task Kanban reads collaboration tags/repo scope only in its organization-scope adapter and reads the existing identity-keyed remote roster through its shared hook.
- Generic Kanban types receive a small human creator presentation record; they do not depend on cloud auth or session provenance.
- Generic cards expose only domain-neutral `canMove`/`canOpen` capabilities; cloud replay records remain in Task Kanban.

### Layer 7 — New-developer confusion test

- `useKanbanOrgScope` documents the exact sidebar parity boundary and keeps selection, inclusion, exclusion, and identity resolution together.
- `sessionToKanbanTask` remains a local-session-only projection; the remote adapter is separate and both are visibly merged in `useKanbanTasks`.
- Scope switches explicitly close stale task details.

### Layer 8 — Wire protocol and serialization

| Field              | Producer                                     | Consumer                                               | Compatibility                                       |
| ------------------ | -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `ownerAvatarUrl?`  | Signed-in cloud profile during metadata push | Remote metadata parser and imported-session provenance | Optional; old rows remain valid and render initials |
| `ownerDisplayName` | Existing cloud metadata owner                | Imported provenance and task creator                   | Existing required wire field                        |
| `ownerMemberId`    | Existing cloud metadata owner                | Stable creator id                                      | Existing required wire field                        |

Profile changes alter the stable metadata hash and therefore republish attribution; absent images are omitted rather than serialized as null.

### Layer 9 — Init and entry-point parity

| Entry point            | Scope owner                                              | Result                       |
| ---------------------- | -------------------------------------------------------- | ---------------------------- |
| Fixed sidebar          | Feature-level selected-org atom via compatibility export | Same selection               |
| Floating sidebar       | Same atom                                                | No hidden-instance overwrite |
| Work Management Kanban | `useKanbanTasks`                                         | Local + teammate cloud cards |
| Work Management List   | Same projected tasks                                     | Same rows + Created by       |
| Work Management Diary  | Same projected `allTasks`                                | Same scoped activity         |

### Layer 10 — Resolver symmetry

| Concern          | Write                                           | Read                                         |
| ---------------- | ----------------------------------------------- | -------------------------------------------- |
| Cloud org id     | Namespaced selector / bare persisted session id | Shared two-id resolver                       |
| Teammate creator | Remote owner id/name/avatar pushed in metadata  | Imported provenance projected to `createdBy` |
| Current creator  | Auth/profile and local profile settings         | Same creator record on owned org tasks       |
| Missing avatar   | Field omitted                                   | Shared initials fallback                     |
| Remote session   | Existing `cloud_list_org_sessions` roster       | Ephemeral Kanban task + cloud replay action  |
| Local replay     | Existing deterministic collaboration importer   | Wins dedupe over its matching remote row     |

## Systematic sweep

- Swept Task Kanban branches: Kanban, List, Diary, replay, file search, and detail selection.
- Swept fixed/floating sidebar ownership and preserved compatibility imports.
- Swept cloud metadata schema, producer, parser, remote roster cache, imported-session persistence, and old-row compatibility.
- Swept generic Kanban consumers so creator chrome remains opt-in through `createdBy`.
- Remote metadata-only sessions stay visible for roster parity but cannot open or drag; replayable rows import through the same action as Manage ORG.
