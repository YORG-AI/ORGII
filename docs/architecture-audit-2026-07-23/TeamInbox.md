# Architecture Audit — Team Inbox

**Scope:** Team Inbox TypeScript domain/UI/data source, managed-cloud mention RPC client, project-management SQLite projection, Tauri commands, Sidebar and Chat Panel tab integration.
**Date:** 2026-07-23

## Layer 1 — Compilation correctness

- TypeScript `tsc --noEmit`: passed.
- Tauri application `cargo check -p org2`: passed.
- Focused Rust Team Inbox tests: 7 passed.

## Layer 2 — Dead code and structural deduplication

- Production entry path is Sidebar row → singleton Team Inbox tab → connected view → shared cache/data source → local Tauri projection plus managed-cloud mention RPC.
- Sidebar badge and rendered page consume the same cache; no second unread query implementation remains.
- Local assignment reads remain in SQLite; the frontend does not rescan every project Work Item.
- Mention response mapping is centralized in the Team Inbox data source; sorting/filtering/deduplication remain pure domain selectors.

## Layer 3 — Naming consistency

- Wire `work_item_assigned` is mapped once to UI `assigned_work_item`; names are explicit at the boundary.
- `viewerMemberIds` is used consistently for the local viewer identity. The cloud RPC deliberately accepts no viewer ID because JWT identity is authoritative.
- Sidebar/menu/tab terms consistently use `team-inbox` / `Team Inbox`.

## Layer 4 — Semantic overloading

| Term         | Meaning in this change                                                                                          | Verdict                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| viewer       | Explicit local project member IDs, or managed-cloud JWT subject                                                 | Kept separate at transport boundaries; never inferred from an agent/session ID. |
| read receipt | SQLite viewer-scoped receipt for local assignment; endpoint+user+org scoped persisted receipt for cloud mention | Separate storage owners with one UI read state.                                 |
| projectId    | Project slug for project-store navigation; empty for standalone Work Items                                      | Boundary is explicit and standalone navigation uses the standalone API.         |

## Layer 5 — Default branch analysis

- Item-kind branching uses discriminated unions with explicit mention/assignment cases; unsupported wire combinations throw.
- Local mentions filter returns an explicit empty page rather than falling through to assignments.
- Cloud RPC failure degrades to local items only; it does not fabricate mention data or scan comment bodies.

## Layer 6 — Cross-domain concept leakage

- Project-management owns only local assigned Work Item projection and receipt DDL.
- Managed-cloud mention transport remains under `features/Org2Cloud`.
- Presentation consumes a transport-independent Team Inbox domain contract.

## Layer 7 — New developer confusion test

- `ConnectedTeamInboxView` identifies the production-wired surface; `TeamInboxView` remains injectable for tests/reuse.
- `useTeamInboxDataSource` names local/cloud composition and identity resolution explicitly.
- `useTeamInboxNavigation` separates Session comment navigation from project/standalone Work Item navigation.

## Layer 8 — Wire protocol and serialization

- Local DTOs use serde-tagged target/payload variants and camelCase fields, covered by Rust serialization tests.
- Cloud request body contains only `p_org_id`, `p_cursor`, and `p_limit`; tests assert no caller-supplied viewer/user ID.
- Cloud response is Zod-validated; malformed counts and pagination input are rejected.

## Layer 9 — Init parity

| Entry point   | Canonical schema init | Explicit viewer | Blocking DB isolation |
| ------------- | --------------------: | --------------: | --------------------: |
| list page     |                   yes |             yes |      `spawn_blocking` |
| unread count  |                   yes |             yes |      `spawn_blocking` |
| mark read     |                   yes |             yes |      `spawn_blocking` |
| mark all read |                   yes |             yes |      `spawn_blocking` |
| mark unread   |                   yes |             yes |      `spawn_blocking` |

All five commands (`team_inbox_list_page`, `team_inbox_unread_count`, `team_inbox_mark_read`, `team_inbox_mark_all_read`, `team_inbox_mark_unread`) are registered in the same Tauri handler list.

## Layer 10 — Resolver symmetry

- Local viewer identity uses the same current-user member resolver for list, single read, and bulk read.
- Cloud cache and persisted receipt keys use the same endpoint + authenticated user + org scope.
- Project and standalone navigation both resolve raw Work Item data through the same adapter chain before opening the canonical Chat Panel Work Item tab.

## Completion verdict

- Canonical DDL changed directly; no `ALTER TABLE` compatibility path was introduced.
- Local cursor ordering and viewer-scoped receipt idempotence are tested.
- Cloud receipt storage is bounded to 1,000 entries.
- No timer or polling loop was introduced; refresh is driven by initial demand, existing project-change signals, cloud comment signals, and mutations.

**Architecture verdict: pass for the audited Team Inbox scope.**
