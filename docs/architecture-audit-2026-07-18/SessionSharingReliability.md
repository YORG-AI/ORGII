# Cloud session sharing and fork reliability architecture audit

> **执行状态注记（2026-07-17 修复批次）**：本审计的 5 个 must-fix 与 2 个 should-fix 已全部落地，见对应提交：
>
> - selected-agent 转发 → `fix(chat): forward selected agent into external-history continuation`（含非默认定义的 payload 断言）
> - explicit-share double-pass → `fix(cloud): run one serialized pass for explicit share and level changes`（`resumeOrgAndWait` + `startedPassCount` 计数测试；CloudSyncLevelDialog 的两处 pair 一并迁移）
> - endpoint reset 漏 `org2CloudPushedMetadataAtom` → `fix(cloud): wipe pushed-metadata marker on endpoint switch`（含 wipe-set ⊇ prune-set 对齐测试）
> - scope-only + floor 隐式上传 → `fix(cloud): apply sharing floor only to admitted sessions`（floor 仅作用于 owned/tagged/fork/显式 intent 的会话）
> - guest capability 不可重启 → `fix(cloud): durable guest share capability registry`（zod 校验的 durable registry；`loadSessions` 全量替换后重物化 guest 行）
> - segment 内容校验 → `feat(collab): verify segment count and content hash before assembly`（typed `SegmentIntegrityError` + tamper 测试）
> - 全链路取消 → `feat(cloud): abortable share resolve, fetch, decode, and import`
> - 证据缺口 → `test(cloud): p_after_seq contract probe and rendered fork/guest evidence`（cloud-org 场景 M 契约探针；dual-instance C 非默认 agent 持久化断言、E guest 强制刷新存活断言）。凭据门控的 rendered E2E 仍需在配好 `E2E_CLOUD_*` 的环境实际执行。
> - 正交改动拆分 → logger、Rust prompt fixture、Brick 子树已各自独立提交。
>
> should-fix 中的 entitlement 双协调器（roster bootstrap 与 Realtime 各持一套 TTL/single-flight）仍未合并为单一 coordinator，保留为后续项。

Scope: the complete managed-cloud session-sharing change cluster on `fix/session-sharing-reliability`, including sync-level and org-floor policy, scope matching, endpoint/share-token provenance, cloud replay import, fork and parent navigation, local external-history continuation, comments/`@agent`/Address Comments, Realtime ownership, fork snapshot integrity, and the rendered cloud E2E evidence. Existing focused audits remain authoritative for the adjacent subsystems:

- `docs/architecture-audit-2026-07-18/SharedSessionPolling.md` — Realtime/polling fan-out and request ownership.
- `docs/architecture-audit-2026-07-17/ChatHistory.md` — chat-history rendering/projection.

This is an audit-only report. No production source was changed while writing it.

## Outcome

The branch closes most of the originally reported product gaps, but it is not ready to describe as architecturally complete. The critical paths are now present—explicit cloud level intent reaches the push engine, org-floor mirroring is consumed by sync, cloud forks use an explicit local execution picker, inherited events are retained, fork provenance survives ordinary list reloads through a durable relay registry, comment `@agent` tasks have distinct queued/active states, Address Comments targets the source thread, and custom share links carry endpoint provenance.

The remaining blockers are concentrated at boundaries rather than missing UI:

1. **The local external-history continuation still ignores the selected agent.** The shared setup dialog returns `agentDefinitionId`, but `externalHistoryFork.ts` writes `BUILTIN_SDE_DEF_ID` into `SessionService.create`. Its test was updated to satisfy the new type but never asserts the field sent to production.
2. **Scope-matched imported history plus an admin floor can become an implicit upload grant.** The branch newly admits every scope-matchable imported session into the engine, then `resolveCloudPushAccess` raises `off` to the org floor. A display-only repo match can therefore upload metadata or full replay without a per-session tag/override.
3. **Guest import provenance is not authoritative across restart/list refresh.** `shareToken` and `shareEndpointUrl` are persisted inside the frontend session cache, but `loadSessions()` replaces that cache with backend/adapter rows. Guest cloud imports have no backend row, so the imported parent and its capability can disappear before a later fork or parent navigation.
4. **The explicit-share flow retains the old double-pass composition.** `resumeOrg()` starts a pass; the immediately following `runSyncPassAndWaitForDrain()` calls `runSyncPass()` again, sees the active pass, sets `passDirty`, and schedules another complete pass. The branch added `invalidateOrgInboundAndWait()` precisely to avoid this pattern but did not migrate the share call sites.
5. **Endpoint reset does not clear every backend-coupled marker.** `org2CloudPushedMetadataAtom` is persisted server-history state but is absent from `resetCloudStateForEndpointSwitch`.
6. **Fork validation proves structure and summary agreement, not payload content integrity.** Decoded segment lengths and recomputed hashes are never compared with wire `eventCount`/`segmentHash`; the strict tail check compares one unverified wire hash with another.
7. **Entitlement/floor reads still have more than one coordinator.** Roster bootstrap/refetch hydrates every org without sharing the Realtime coordinator’s per-org single-flight/TTL. The sync engine no longer owns a second entitlement poll, which is correct, but reconnect/bootstrap can still overlap two readers.

### Release disposition

| Disposition                                      |      Count | Summary                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Must fix before merge**                        |          5 | selected-agent loss; implicit floor upload for scope-only history; guest capability loss after refresh/restart; explicit-share double pass; endpoint marker reset gap                                                                                            |
| **Should fix or explicitly narrow the contract** |          3 | content-hash verification; shared entitlement coordinator; restart/non-default-agent E2E evidence                                                                                                                                                                |
| **Keep with reason**                             |         10 | explicit fork picker/backend registration; typed fork failures; strict list-summary reconciliation; endpoint snapshot within one import; comment task FSM labels; source-thread targeting; per-org delta invalidation; rendered production-side-effect E2E shape |
| **Split from this PR**                           | 3 clusters | logger runtime-marker fix; Rust prompt changes; SessionCore Brick subtree deletion                                                                                                                                                                               |

## Attribution: where each problem belongs

### A. Directly introduced by this branch

| Priority | Line / element                                                                                                                        | Verdict  | Reason                                                                                                                                                                                                                                                                                                                                                                              | Suggested change                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `src/features/Org2Cloud/org2CloudSyncEngine.ts:783-812, 881-928`; `org2CloudAccessSettings.ts:219-244` — scope-only admission + floor | fix      | `isScopeMatchableImportedSession` is newly accepted as ownership candidacy. `resolveCloudPushAccess` then raises effective `off` to the admin floor. For an imported CLI history that is merely displayed under a matching repo, the floor becomes the first actual share intent. A full-replay floor can upload the entire external history without a tag or per-session override. | Separate **candidate discovery** from **upload admission**. Require durable org ownership/tag/per-session share intent before any imported history can upload. Apply the floor only after admission, or create an explicit admin policy whose copy clearly states that matching external histories are mandatory uploads. |
| P1       | `src/features/TeamCollaboration/engine/collabSyncEngineHelpers.ts:250-295`; `org2CloudBackendAdapter.ts:85-110` — segment assembly    | fix      | Contiguity and total count are checked, but each decoded segment trusts wire `eventCount` and `segmentHash`. `decodeSegmentEvents` validates only “array”, and `forkSession` compares the summary tail hash to the unverified segment field. This is structural completeness, not content-hash proof.                                                                               | For every decoded segment, require `events.length === eventCount` and `computeSegmentHash(events) === segmentHash` before assembly. Return/throw a typed integrity error identifying seq/tail and mismatch kind. Add payload-tamper tests where counts still match but content/hash does not.                             |
| P1       | `src/features/Org2Cloud/useOrg2CloudRealtime.ts:158-199`; `org2CloudOrgsAtom.ts:280-313, 373-405` — floor hydration owners            | abstract | The branch correctly removes entitlement reads from the sync engine, but adds a Realtime-local TTL/single-flight map while roster bootstrap/refetch still performs independent all-org reads. Both write the same mirror and use different freshness/in-flight rules.                                                                                                               | Introduce one module-level/store-keyed `refreshOrgEntitlement(orgId, { force? })` coordinator with shared per-org TTL, in-flight promise and monotonic result generation. Roster bootstrap calls it per org; Realtime calls it for the affected org; no caller implements its own cache.                                  |
| P1       | `externalHistoryFork.test.ts:99-164`; `cloud-dual-instance-ui.spec.mjs:75-112, 1562-1605, 1802-1868` — agent evidence                 | fix      | Unit fixtures now include `agentDefinitionId`, but the assertion omits it. Rendered E2E only waits for the preselected agent/account/model labels and submits; it neither chooses a non-default agent nor inspects the persisted backend definition. A hardcoded SDE path passes both.                                                                                              | Unit-test a non-default definition end-to-end. In rendered E2E select a second runnable definition (or seed one), fork/send, inspect the persisted session row, and assert that exact id.                                                                                                                                 |
| P2       | `src/hooks/logger/useLogger.ts`; `src-tauri/.../section_builders.rs`; `src/engines/SessionCore/sync/brick/**`                         | split    | These changes have no data/control dependency on cloud sharing, sync floor, fork, comments, or share import. Type/Rust checks can pass while review causality remains impossible across unrelated prompt/Brick/logger changes.                                                                                                                                                      | Land as independent commits/PRs with their own acceptance criteria. The Tauri v2 logger marker fix is small and valid, but still orthogonal. Treat Brick deletion and prompt edits as separate architecture changes, not cleanup inside this PR.                                                                          |

### B. Exposed by interaction with PR #413 / current `develop`

| Priority | Line / element                                                                                                           | Verdict          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Suggested change                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `src/engines/ChatPanel/externalHistoryFork.ts:130-152` — shared setup result → existing `SessionService.create` fallback | fix              | `develop` already hardcodes `BUILTIN_SDE_DEF_ID`. This branch upgrades the shared setup contract to return `agentDefinitionId` and exposes that picker to local external-history continuations, but leaves the old fallback in production (only the test fixtures changed). The interaction turns a pre-existing default into false UI: the visible selection is ignored.                                                                                                                                                              | Set `agentDefinitionId: setup.execution.agentDefinitionId`; remove the builtin import; add a non-default-definition test that asserts the exact `SessionService.create` payload.                                                                                                                                                                    |
| P0       | `collabSyncEngineHelpers.ts:451-524`; `sessionAtom/atoms.ts:29-34`; `loaders.ts:298-363` — guest import durability       | fix              | The branch now records `shareToken` + issuing `shareEndpointUrl` and uses them for later guest fork. That works only while the imported frontend row survives. `sessionsAtom` hydrates localStorage, but the next `loadSessions()` does `store.set(sessionsAtom, fetched)`. A guest cloud import is not a native backend row and is not an external-adapter source row, so its capability/provenance can be erased. PR #413’s “one authoritative owner” principle makes the split between cache row and authoritative listing visible. | Move guest capability/provenance to a dedicated zod-validated durable registry keyed by local session id/source identity, analogous to `FORK_RELAY_STORAGE_KEY`, and merge registry-backed guest rows after authoritative loads; or register a durable backend session type that round-trips the provenance. Add cold-start + forced-refresh tests. |
| P0       | `SessionForkHeaderExtras.tsx:72-92`; `useForkImportedSession.ts:104-145`; `SessionForkedFrom`                            | fix              | Current-run parent navigation succeeds because the read-only imported parent is still in `sessionsAtom`. After the interaction above removes it, a guest fork has only `forkedFrom {orgId, sourceSessionId...}`—no token/endpoint—and `org2CloudRemoteSessionsAtom` requires membership. The parent chip cannot re-resolve the guest source.                                                                                                                                                                                           | Let the dedicated capability registry resolve the parent by source identity without copying secrets into general UI metadata. Parent navigation should materialize/open through the same endpoint-bound ticket client used by guest fork.                                                                                                           |
| P1       | `useOrg2CloudRealtime.ts:203-332`; `org2CloudOrgsAtom.ts:211-320` — reconnect overlap                                    | abstract         | PR #413 removes broad change-signal roster refreshes, but on initial subscribe/reconnect Slice A still calls `refetchOrgs()` (which hydrates all floors) while Slice B calls the independent per-org entitlement refresh. Shared atom output does not mean shared read ownership.                                                                                                                                                                                                                                                      | Use the single entitlement coordinator above and define explicit freshness semantics: roster membership refresh must not imply policy refresh unless membership changed; reconnect may force one per-org read, not two owners.                                                                                                                      |
| P1       | `CloudShareImportDialog.tsx:101-208`; `org2CloudShareEndpoint.ts:23-48`                                                  | keep with reason | Resolve and segment fetch share one immutable endpoint snapshot; official links work even when the receiver’s active endpoint is custom; custom links require the same configured deployment and never inject an anon key or mutate global auth. The missing piece is durable capability ownership, not the request-time endpoint resolver.                                                                                                                                                                                            | Keep the boundary. Add restart tests around the registry rather than weakening endpoint mismatch checks.                                                                                                                                                                                                                                            |

### C. Existing `develop` debt retained in the branch

| Priority | Line / element                                                                                               | Verdict  | Reason                                                                                                                                                                                                                                                                                                                                                                          | Suggested change                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `CloudSessionShareDialog/useCloudShareOrgSectionModel.ts:204-252`; `org2CloudSyncEngine.ts:483-519, 561-564` | fix      | The call sequence existed before the branch: `resumeOrg()` invokes `invalidateOrgInbound()`, which starts `runSyncPass()`. The following `runSyncPassAndWaitForDrain()` invokes it again; because the pass is active, line 487 sets `passDirty=true`, guaranteeing a second pass. This is the same “attach waiter by dirtying the pass” anti-pattern PR #413 removed elsewhere. | Replace each pair with one `invalidateOrgInboundAndWait(orgId, { full: true })` (or a purpose-named `resumeOrgAndWait`). The waiter attachment must not call `runSyncPass` when one was just started. Add a call-count test for prepare, rollback and failure rollback. |
| P1       | `src/features/Org2Cloud/org2CloudEndpointAtom.ts:60-83`; `org2CloudSyncAtoms.ts:108-121`                     | fix      | The reset contract says it drops every backend-coupled cursor/marker, but omits persisted `org2CloudPushedMetadataAtom`. A marker from endpoint A can make endpoint B appear to contain a prior upload and can trigger an erroneous retract if composite ids collide or a restored environment preserves ids.                                                                   | Import and clear `org2CloudPushedMetadataAtom`. Add a reset test enumerating the canonical backend-coupled atom set; make roster reconciliation reuse the same descriptor list rather than maintaining a second hand-written set.                                       |
| P1       | `org2CloudEndpointAtom.ts:13-18`; persisted access/floor/runner atoms                                        | fix      | The claim that UUID org ids “can never collide” across independent or restored endpoints is too strong. Access settings, sharing floor and runner account/model intent are endpoint-scoped even if privacy intent is worth preserving. A restored database can intentionally preserve UUIDs; unrelated deployments can theoretically collide.                                   | Namespace all backend-associated persisted maps by a stable endpoint id/normalized Supabase URL. Preserve them across switches inside their namespace instead of globally. Keep truly session-local tags only if their org reference is also endpoint-qualified.        |
| P1       | `sessionAtom/loaders.ts:298-363` — full replace                                                              | abstract | Frontend-only session types are initially persisted then unconditionally replaced by the aggregate listing. Fork relay already needed a separate registry to survive this. Guest imports reveal the same generic debt.                                                                                                                                                          | Define a canonical merge policy for backend-native, external-adapter, guest-cloud replay and synthetic child sessions. Avoid treating `sessionsAtom` persistence as authority when a later loader overwrites it wholesale.                                              |
| P2       | `runSyncPassAndWaitForDrain` name and semantics                                                              | fix      | The name sounds like “wait for current work,” but implementation always requests a run. New callers can accidentally duplicate work even without `resumeOrg`.                                                                                                                                                                                                                   | Split into `requestSyncPassAndWait()` and `waitForSyncDrain()`, or make one coordinator accept `{ request: boolean }`; document exact active-pass behavior and test it.                                                                                                 |

## Finding sweep

The tables below use the architecture-audit verdict vocabulary on the whole changed business cluster, including items that should remain unchanged.

| Priority | Line / element                                                           | Verdict          | Reason                                                                                                                                                                                                                                                                                                             | Suggested change                                                                                                                                   |
| -------- | ------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `forkSession.ts:487-542` — explicit execution + backend registration     | keep with reason | Headless calls must carry an explicit definition; `agentsession-*` has no implicit Rust prefix mapping; the selected id is persisted in `agent_sessions`; backend-save failure rolls local artifacts back. This is the correct source-of-truth boundary.                                                           | Keep. Extend rendered evidence to a non-default definition.                                                                                        |
| P0       | `forkSession.ts:92-220` — fork relay registry                            | keep with reason | It explicitly handles list-refresh loss of TS-only `forkedFrom` and one-shot handoff state. This is the durability pattern guest imports currently lack.                                                                                                                                                           | Keep; extract/reuse a small durable-provenance registry abstraction only if both registries can preserve distinct schemas and security boundaries. |
| P0       | `sessionCommentTarget.ts` — durable fork target                          | keep with reason | Comment/Address Comments target resolution reads `getSessionForkedFrom`, so list refresh does not redirect a fork’s comments to itself.                                                                                                                                                                            | Keep and cover cold restart in rendered or integration tests.                                                                                      |
| P0       | `commentAgentAffordances.ts`; `TurnCommentChrome.tsx`                    | keep with reason | Canonical `@agent` suggestion and queued/active labels no longer equate an open task with an actively running agent.                                                                                                                                                                                               | Keep. Status remains a projection of the task FSM, not an independent UI state.                                                                    |
| P0       | `addressCommentsRun.ts`; `commentTaskRunner.ts`                          | keep with reason | Authoritative finish events drive Address Comments finality; the 60-second check is a deadman fallback, not primary polling.                                                                                                                                                                                       | Keep; retain negative assertions for duplicate rounds and orphaned active runs.                                                                    |
| P0       | `org2CloudSyncEngine.ts:521-559, 944-1038`                               | keep with reason | Ordinary inbound invalidation is per-org and cursor-preserving; reconnect alone requests full state; Realtime-only project pulls skip the outbox drain. This matches PR #413.                                                                                                                                      | Keep. Migrate the explicit-share call sites to the provided wait-aware seam.                                                                       |
| P1       | `forkSession` summary reconciliation                                     | keep with reason | Failing closed when list summary promises more history than the seq-0 snapshot prevents the “last round only” fork. It correctly distinguishes replay unavailable from incomplete snapshot.                                                                                                                        | Keep and add content-hash verification below the summary layer.                                                                                    |
| P1       | `CloudShareImportDialog` attempt generation                              | keep with reason | `attemptId` plus retry cycle prevents same-token stale async state from being reused, and endpoint is captured for resolve → import.                                                                                                                                                                               | Keep. Persist capability outside the replaceable session row.                                                                                      |
| P1       | `cloud-dual-instance-ui.spec.mjs:1200-1279, 1496-1605, 1636-1892, 1895+` | keep with reason | Directed share, comment CRUD, `@agent` suggestion/badge, fork dialog, inherited history, parent chip, send interception, revoke and link import are driven through rendered controls and production clients. Debug helpers are used for seeding/inspection, not as the asserted mutation path for these behaviors. | Keep this shape. Do not describe it as executed in this audit without credentials.                                                                 |
| P1       | `cloudOrgUiDriver.mjs:829-879, 1248-1400`                                | keep with reason | Direct metadata and local event seeding create deterministic prerequisites. The rendered share button still performs the access promotion/full replay publication and grant RPC under assertion.                                                                                                                   | Keep fixture comments explicit. If asserting sync-engine publication itself, use a separate scenario that does not pre-seed the server row.        |
| P2       | `cloudPublishSeededSessionEvents` E2E helper                             | delete or wire   | The helper is exported/typed but no spec calls it. An unwired helper is not evidence and increases confusion over which side-effect path a scenario exercises.                                                                                                                                                     | Remove it, or use it only in a clearly named fixture setup where event publication is not the product behavior under assertion.                    |

## Ten-layer audit

### Layer 1 — compilation correctness

- `npx tsc --noEmit -p tsconfig.json`: **passed**.
- Targeted Vitest: **8 files / 160 tests passed**.
- `cargo check --manifest-path src-tauri/crates/agent-core/Cargo.toml`: **passed**; Cargo reported only the existing future-incompatibility notice for dependency `block v0.1.6`.
- `git diff --check`: **passed**.
- Cloud E2E JavaScript `node --check`: **passed** for both specs and the shared driver.
- Full rendered cloud E2E was **not run**: all of `E2E_CLOUD_SUPABASE_URL`, `E2E_CLOUD_ANON_KEY`, `E2E_CLOUD_SERVICE_KEY`, `E2E_CLOUD_EMAIL`, and `E2E_CLOUD_PASSWORD` were absent.

Compilation is green, but it does not detect selected-agent loss, double-pass scheduling, implicit floor admission, or provenance replacement.

### Layer 2 — dead code and structural deduplication

- Duplicate entitlement coordinators remain: roster hydration and Realtime hydration.
- `cloudPublishSeededSessionEvents` is definition/export-only within E2E and has no scenario caller.
- The sync engine is correctly no longer a third entitlement owner.
- Fork/import assembly is shared through `fetchAndAssembleSegments`; do not fork a second codec to add integrity checks.
- The deleted `SessionCore/sync/brick` subtree is orthogonal to this domain and should be reviewed separately rather than treated as cloud cleanup.

### Layer 3 — naming consistency

The primary naming defect is not spelling but implied semantics:

- `runSyncPassAndWaitForDrain` means “request a pass and wait,” not “wait for the active pass.”
- “sync level,” “access mode,” “share level,” and “sharing floor” are related but distinct; UI and code should not abbreviate all of them to “level.”
- `importedFrom` means read-only cursor/capability provenance; `forkedFrom` means writable lineage; `parentSessionId` is local navigation/history ancestry. They must not substitute for one another.
- “current endpoint” and “issuing endpoint” are different concepts and are now correctly named in the share resolver.

### Layer 4 — semantic-overloading table

| Term     | Meaning 1                                                   | Meaning 2                                                   | Risk / verdict                                                                                         |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| level    | session upload access (`off`/`metadata_only`/`full_replay`) | grant level (`metadata`/`replay`)                           | Keep separate typed constants; never pass bare strings between them.                                   |
| floor    | admin minimum for allowed/effective access                  | implicit upload admission in current resolver composition   | Fix: a floor should constrain an admitted session, not silently define admission for external history. |
| share    | publish a session row/events                                | create a directed/link capability grant                     | `prepareReplayShare` correctly separates publish-before-grant, but the wait seam is wrong.             |
| import   | materialize read-only cloud replay                          | list external CLI history from local adapters               | Different authorities and restart behavior; loader merge policy must encode both.                      |
| parent   | source cloud session (`forkedFrom`)                         | local `parentSessionId` used by normal history continuation | Parent navigation must resolve through the provenance appropriate to the source.                       |
| endpoint | globally active cloud deployment                            | immutable deployment that issued a share token              | Current-run resolver is correct; durability is incomplete.                                             |
| agent    | source session’s display/definition hint                    | local runnable definition selected for continuation         | Source is hint only; selected local id must be the persisted authority.                                |

### Layer 5 — default-branch analysis

| Default / fallback                                                       | Verdict                      | Reason                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agentDefinitionId: BUILTIN_SDE_DEF_ID` in external-history continuation | unsafe                       | Overrides explicit user choice and future agent variants.                                                        |
| unknown local sharing floor → `off`                                      | keep                         | Privacy-safe locally; server remains authoritative.                                                              |
| floor raises `off` for scope-only imported history                       | unsafe composition           | Safe mode fallback becomes unsafe admission when candidate and grant are conflated.                              |
| missing persisted share endpoint → current endpoint                      | keep only for legacy records | New links carry endpoint provenance. A missing field on a new record should be observable in tests, not routine. |
| custom share endpoint mismatch → fail closed                             | keep                         | Prevents silent credential/endpoint mutation and wrong-backend reads.                                            |
| fork snapshot mismatch → typed `snapshot_incomplete`                     | keep                         | Correct fail-closed behavior.                                                                                    |
| session list refresh → replace all frontend rows                         | unsafe generic default       | Erases valid frontend-only session categories/provenance.                                                        |

### Layer 6 — cross-domain leakage

- The managed-cloud-specific wire client stays in `Org2Cloud`; backend-agnostic import/fork assembly stays in `TeamCollaboration`. Keep this boundary.
- Explicit local agent selection belongs in fork setup and backend session registration, not in cloud metadata. Current cloud fork follows that rule; external-history continuation does not.
- Share-token endpoint capability should not leak into generic `forkedFrom` UI provenance. Use a dedicated capability registry/resolver.
- Logger runtime detection, Rust prompt sections and Brick history synchronization do not belong in the session-sharing change cluster.

### Layer 7 — new-developer confusion test

A new developer reading the current code would reasonably make three incorrect assumptions:

1. `resetCloudStateForEndpointSwitch` clears **all** backend state because its doc says so; it does not clear `org2CloudPushedMetadataAtom`.
2. `runSyncPassAndWaitForDrain` can safely follow `resumeOrg`; it actually marks the active pass dirty.
3. Persisting `shareEndpointUrl` in `Session.importedFrom` makes it restart-safe; `loadSessions()` later replaces that row.

These are architecture defects because comments and names point to stronger guarantees than execution provides.

### Layer 8 — wire protocol and serialization

- Share links carry only token + non-secret endpoint provenance; custom endpoint imports require locally configured publishable coordinates. Keep.
- Resolve and segment fetch use one endpoint snapshot, preventing mid-flow endpoint switching. Keep.
- Fork summary reconciliation checks epoch/frozen seq/count/tail hash against the list row. Keep.
- Segment payload bytes are gzip-decoded, but decoded content is not verified against `eventCount`/`segmentHash`. Fix.
- `agentDefinitionId` is not a cloud wire field; it is correctly persisted to the local backend session record. The external-history entry point must follow the same boundary.

### Layer 9 — entry-point parity matrix

| Entry point                                  |                            Workspace picker | Explicit local agent |                    Account/model |      Authoritative backend row |             Source replay integrity |    Restart-safe source capability |
| -------------------------------------------- | ------------------------------------------: | -------------------: | -------------------------------: | -----------------------------: | ----------------------------------: | --------------------------------: |
| Cloud remote row → fork                      |                                         yes |                  yes |                              yes |                            yes |                   summary/structure | membership JWT; yes after re-auth |
| Imported member replay header → fork         |                                         yes |                  yes |                              yes |                            yes |                   summary/structure |               org membership; yes |
| Guest share import → later fork              |              import workspace + fork picker |                  yes |                              yes | fork: yes; imported parent: no |                   summary/structure |    **no after full list replace** |
| Imported replay composer send → fork         |                                         yes |                  yes |                              yes |                            yes |                   summary/structure |         same gap for guest parent |
| Local Codex/Claude/Cursor history → continue |                                         yes |   **picker ignored** |                              yes |    created by `SessionService` | bounded handoff, not segment replay |              local adapter source |
| Comment-task/Address Comments fork           | explicit runner settings/headless execution |             explicit | explicit/default runner settings |                            yes |                    shared fork path |                    membership JWT |

Parity fails on the selected agent for local external history and on guest capability durability.

### Layer 10 — resolver symmetry

#### Execution selection fallback matrix

| Field            |             Source hint | User selection |               Local validation |           Persisted authority |
| ---------------- | ----------------------: | -------------: | -----------------------------: | ----------------------------: |
| workspace        |    repo scope/path hint |            yes |                scope-key match |           backend `repo_path` |
| agent definition |    display/id hint only |            yes |      local definition registry | backend `agent_definition_id` |
| account          | none/source not trusted |            yes |          local key/account set |          backend `account_id` |
| model            |  source preference hint |            yes | runnable with selected account |               backend `model` |

Cloud forks implement this matrix. `externalHistoryFork.ts` breaks symmetry only for agent definition by replacing the selected value after validation.

#### Guest provenance fallback matrix

| Field            | In-memory imported row | session localStorage |            authoritative list refresh | fork relay / dedicated registry |        parent navigation |
| ---------------- | ---------------------: | -------------------: | ------------------------------------: | ------------------------------: | -----------------------: |
| org/source ids   |                    yes |                  yes |                     no guaranteed row |               fork lineage only |        current run works |
| share token      |                    yes |                  yes |                                  lost |        absent from fork lineage |  fails after parent loss |
| issuing endpoint |                    yes |                  yes |                                  lost |        absent from fork lineage |  fails after parent loss |
| imported events  |             EventStore |     EventStore/cache | events may survive but row can vanish |    no parent capability mapping | orphaned replay possible |

The fallback chain is asymmetric: events and fork lineage can survive while the capability required to re-open/re-fork the source does not.

## Acceptance criteria before merge

- [ ] A non-default agent selected in every continuation/fork entry point is the exact `agent_definition_id` persisted in the created session.
- [ ] Scope match alone never uploads local external history unless the product explicitly defines and communicates a mandatory admin-upload policy.
- [ ] `resumeOrg`/explicit-share preparation causes one serialized pass, not a guaranteed dirty follow-up.
- [ ] Endpoint switch clears or namespaces every backend-derived cursor, marker, policy mirror and runner setting.
- [ ] Guest imported replay, token, issuing endpoint and parent navigation survive cold restart plus forced `loadSessions()` refresh.
- [ ] Every decoded segment verifies count and content hash before fork/import assembly.
- [ ] Entitlement reads use one per-store/per-org coordinator and one shared TTL/single-flight rule.
- [ ] Rendered E2E selects a non-default agent and inspects persisted authority.
- [ ] Rendered E2E includes restart/refresh coverage for guest import → fork → parent navigation.
- [ ] Live dual-instance E2E is run with valid credentials; skip output, syntax checks and unit tests are not reported as rendered success.
- [ ] Orthogonal logger/prompt/Brick changes are split or explicitly reviewed as separate deliverables.

## Verification evidence from this audit

| Command / evidence                                                      | Result                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `git diff --check`                                                      | passed                                         |
| `npx tsc --noEmit -p tsconfig.json`                                     | passed                                         |
| targeted Vitest for sync/fork/share endpoint/import/comment affordances | 8 files, 160 tests passed                      |
| `cargo check --manifest-path crates/agent-core/Cargo.toml`              | passed; dependency future-incompat notice only |
| `node --check` cloud dual-instance spec, cloud-org spec and driver      | passed                                         |
| cloud E2E credential availability                                       | all required `E2E_CLOUD_*` variables missing   |
| rendered dual-instance E2E                                              | not run; no rendered-pass claim                |

## Recommended merge order

1. Fix selected-agent forwarding and its tests.
2. Resolve scope-only imported-history admission before any floor/full-replay policy can ship.
3. Replace the explicit-share double-pass composition with one wait-aware invalidation.
4. Add endpoint-state reset/namespace coverage.
5. Introduce durable guest capability ownership and restart-safe parent resolution.
6. Add segment hash/count verification.
7. Centralize entitlement hydration.
8. Run the credentialed rendered E2E, including non-default agent and cold-restart scenarios.
9. Split logger, Rust prompt and Brick changes from the cloud-sharing review surface.
