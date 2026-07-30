# Agent Org Red-Team Hardening Port — Architecture Audit

## Scope

- Target branch: `develop`
- Source: PR #424, commit `df158006ad76271a0cc60440dc4c611e54774f8a`
- Port strategy: preserve the current split Inbox, Plan Approval, Task Store,
  Session Message, Org Tasks, Watchdog, and Turn Executor modules. No deleted
  monolith is restored.
- Acceptance boundary: durable recovery semantics, run/member identity,
  dispatch revalidation, bounded resources, schema compatibility, and the
  corresponding frontend projections.

## Red-Team Finding Mapping

| #   | Finding / contract                                                      | Port verdict        | Implementation evidence                                                                                                                                     | Test evidence                                                                       |
| --- | ----------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Coordinator-only Inbox repair with `inspect`, `cancel`, and `supersede` | Ported              | `agent_org/inbox_repair.rs`; tool policy, assembly, metadata, and tool-name registration                                                                    | Inbox repair unit tests cover role rejection, inspection, cancel, and supersede     |
| 2   | Preserve original Inbox evidence while resolving delivery               | Ported              | `agent_inbox_delivery_resolutions` is append-only relative to Inbox rows; no synthetic `read_at` mutation                                                   | Inbox store tests assert unread evidence remains and resolution is returned         |
| 3   | Resolved delivery must not block unread wake/finality                   | Ported              | Inbox unread queries, wake selection, lifecycle resume, Run View, and finality exclude rows with a delivery resolution                                      | Inbox, run finality, wake, and group-chat settlement tests                          |
| 4   | Bind turn Intent to exactly one Run without guessing legacy ownership   | Ported              | Nullable `session_turn_intents.org_run_id`; ordinary turns remain `NULL`; one-time `NULL` binding is allowed; reassignment is rejected                      | Fresh-schema, upgrade-path, NULL backfill, and cross-Run rejection tests            |
| 5   | Use exact `member_id` plus Run identity instead of shared `agent_id`    | Ported              | Inbox recipient/sender member fields, task authorization, Run View, and wake/drain queries use `(org_run_id, member_id)`                                    | Shared-agent-id fixtures verify member isolation                                    |
| 6   | Revalidate dispatch-time ownership and eligibility                      | Ported              | Task assignment/requeue and continuation insertion re-read Run, member, task, and eligibility state inside the writer transaction                           | Task store and orchestration tool tests cover stale/invalid assignment              |
| 7   | Make Wake budget consumption atomic with recovery writes                | Ported              | Watchdog re-inspection, budget insertion, and recovery notice insertion share one SQLite writer transaction                                                 | Watchdog budget/fingerprint tests, including exhausted budget                       |
| 8   | Use stable, bounded recovery fingerprints                               | Ported              | Typed facts, sorted task/Inbox fingerprints, work revision, bounded reason and identifier previews                                                          | Watchdog fingerprint and recovery-plan tests                                        |
| 9   | Fail closed on corrupt historical task/Inbox data                       | Ported              | Operational task projection validates identifiers, timestamps, dependencies, metadata, and payloads; unread scans reject corrupt payloads                   | Corrupt task and historical Inbox integration tests                                 |
| 10  | Enforce input and projection resource limits                            | Ported              | Central Agent Org payload limits; task count, identifier, JSON, page-row, page-byte, and preview caps                                                       | Boundary tests for task payloads, listing, history, and Inbox snapshots             |
| 11  | Protect managed Plan paths and repair durable artifacts                 | Ported              | Component-wise lexical validation, canonical-root checks, race-bounded install, startup artifact reconciliation                                             | Plan artifact traversal/symlink/reconciliation tests                                |
| 12  | Bound Run View caching and reject stale async generations               | Ported              | Retention eviction, retired-generation tombstone, request ordering, shared polling, and bounded bootstrap join                                              | Run View store tests cover abandoned render, eviction, late IPC, and shared polling |
| 13  | Keep Plan Approval detail cache bounded                                 | Equivalent retained | Current `develop` already has both 64-entry and 8 MiB LRU bounds, stronger than the source entry-only bound                                                 | Existing detail-cache tests retained                                                |
| 14  | Preserve complete history and shared member activity semantics          | Ported              | Cursor pagination has bounded gap frontiers; delivery resolutions merge monotonically; both member selectors use the shared exact-unread activity predicate | History overlap/gap tests and shared member-activity tests                          |
| 15  | Deduplicate mention targets and fix WebKit inline `@` parsing           | Ported              | Shared target-key merge and `getInlineMentionQuery` normalize WebKit keydown/input ordering                                                                 | Mention option and inline mention query tests                                       |

## Ten-Layer Audit

### Layer 1 — Compilation Correctness

The split modules compile as the production graph rather than as isolated test
copies. The delivery gate includes workspace Rust check/clippy, TypeScript
typecheck/lint/circular checks, and changed-file formatting. Final command
results are recorded in the Draft PR because they must describe the exact
pushed commit.

Verdict: **fix** — cherry-pick conflicts were resolved in the active modular
files; no parallel legacy file is needed for compilation.

### Layer 2 — Dead Code and Structural Deduplication

Production call chains were traced from:

1. `org_inbox_repair` registration → policy → tool assembly → executor → Inbox
   store.
2. Tauri message send/wake → turn Intent persistence → Turn Executor → Inbox
   drain.
3. lifecycle/watchdog tick → coherent inspection → recovery plan → transactional
   revalidation/write.
4. Run View/group-chat commands → bounded store projections → shared frontend
   caches and selectors.

The old monolithic Inbox, Plan Approval, Task Store, Session Message, and Org
Tasks files remain deleted. Recovery uses the batch assignment and transactional
writer paths; the redundant single-task recovery helper was removed.

Verdict: **fix**, with no unwired compatibility abstraction introduced.

### Layer 3 — Naming Consistency

| Term                  | Meaning in this port                                                                        | Verdict |
| --------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `delivery_resolution` | Durable `cancelled`/`superseded` disposition of an Inbox delivery; never equivalent to read | Keep    |
| `org_run_id`          | Durable ownership boundary for a turn Intent or Agent Org row                               | Keep    |
| `member_id`           | Materialized member identity inside one Run; not interchangeable with reusable `agent_id`   | Keep    |
| `work_revision`       | Monotonic task-board observation used for stale recovery/finality rejection                 | Keep    |
| `fingerprint`         | Stable bounded digest input for one recovery fact set                                       | Keep    |
| `corrupt`             | Explicit count/state that blocks operational projection and finality                        | Keep    |

Rust uses snake_case wire fields and TypeScript exposes the established
camelCase Tauri contract. Historical comments that implied `agent_id` was a
unique member identity were not copied into the modular implementation.

Verdict: **keep with reason**.

### Layer 4 — Semantic Overloading

The critical overloaded words were audited across Inbox, tasks, turns, and UI:

- `read` means a recipient consumed a delivery. `resolved` means a coordinator
  intentionally cancelled or replaced an undeliverable delivery. They remain
  distinct columns and behaviors.
- `session` is execution identity; `member` is Run roster identity; `agent` is a
  reusable definition identity. Authorization and delivery use the member
  dimension.
- `completed` applies independently to task, session turn, and Run. Run finality
  is derived from durable task/Inbox/session facts and does not reuse a UI
  session status.

Verdict: **fix** — the port restores the missing distinctions instead of
mapping them to existing overloaded fields.

### Layer 5 — Default Branch Analysis

- Unknown delivery-resolution strings return an error instead of falling
  through to `cancelled`.
- Unknown/corrupt task status, timestamp, identifiers, dependencies, and payload
  shapes fail closed instead of defaulting to pending/empty.
- A legacy turn Intent defaults to `org_run_id = NULL`; no Run is inferred.
- A missing or permanently unavailable Inbox recipient remains unresolved
  until an explicit coordinator action; it is not silently marked read.
- Future tool callers are denied `org_inbox_repair` unless the current context
  is the coordinator for the exact Run.

Verdict: **fix**.

### Layer 6 — Cross-Domain Concept Leakage

Persistence owns storage compatibility and typed records. Coordination modules
own Run/member/task/Inbox semantics. Tauri command modules only project those
facts, and frontend utilities only decide presentation behavior from typed
fields. Plan filesystem validation remains in the Plan Approval artifact
module, not in generic path helpers.

Verdict: **keep with reason** — Agent Org-specific concepts cross a shared
boundary only through explicit fields (`org_run_id`, member ids, `corrupt`,
`delivery_resolution`).

### Layer 7 — New Developer Confusion Test

The new names state their postconditions: `ResolveInboxDeliveryParams`,
`delivery_resolution_for_inbox`, `list_operational`,
`ensure_task_rows_safe_for_operational_projection`,
`coordinator_repair_*_fingerprint`, `isAgentOrgMemberEmpty`, and
`getInlineMentionQuery`. Comments explain why durable unread and bounded recent
activity are both required.

Verdict: **keep with reason**.

### Layer 8 — Wire Protocol and Serialization

| Boundary                  | Added/changed fields                               | Safety check                                                                                |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Tool schema               | `org_inbox_repair` action and replacement evidence | Explicit enum-like actions; coordinator/run validation occurs before storage                |
| Turn Intent SQLite record | nullable `org_run_id`                              | Existing rows and ordinary turns serialize as `NULL`; conflicting non-NULL ownership errors |
| Run View Tauri payload    | task `corrupt`; Inbox `deliveryResolution`         | Rust snake_case is projected through the existing camelCase TypeScript wrapper              |
| Group-chat history        | `deliveryResolution`                               | Merge is monotonic so a refresh cannot erase a known resolution                             |
| Recovery notice           | bounded typed facts/fingerprints                   | No unbounded task payload is copied into the wake reason                                    |

No external provider request schema is changed by this port. Tool UI metadata
and tool-name tests pin registration symmetry.

Verdict: **fix**.

### Layer 9 — Initialization Parity

| Entry point                  |   Inbox resolution schema |               turn Intent upgrade |        Plan artifact repair | expired intervention cleanup |          watchdog recovery |
| ---------------------------- | ------------------------: | --------------------------------: | --------------------------: | ---------------------------: | -------------------------: |
| Production app startup       |                       Yes |                               Yes |                         Yes |                          Yes |                        Yes |
| Fresh test database          |                       Yes |                               Yes | Exercised by artifact tests |                    Exercised |                  Exercised |
| Existing-schema upgrade test |  Existing Inbox init path | Yes, nullable and non-inferential |                         N/A |                          N/A |                        N/A |
| Rust runtime E2E             | Production initialization |         Production initialization |      Production launch path |       Production launch path | Production wake/drain path |
| Rendered Tauri E2E           | Production initialization |              Production send path |      Production launch path |    Production lifecycle path | Production wake/drain path |

Verdict: **fix** — startup repair and cleanup are wired into lifecycle
initialization, not a test-only helper.

### Layer 10 — Resolver Symmetry

| Resolved fact             |                              Run |                              Member |                              Task / Inbox row |                      Durable fallback | Default                                 |
| ------------------------- | -------------------------------: | ----------------------------------: | --------------------------------------------: | ------------------------------------: | --------------------------------------- |
| Inbox delivery authority  |                         Required | Required for materialized recipient |                                Exact Inbox id |                            SQLite row | None                                    |
| task assignment authority |                         Required |      Required owner/eligible member |                                 Exact task id | SQLite snapshot in writer transaction | None                                    |
| turn Intent ownership     | Required only for Agent Org turn |        Derived from runtime context |                               Exact Intent id |        Existing non-NULL `org_run_id` | `NULL`, never guessed                   |
| watchdog recovery target  |                         Required |            Exact member/coordinator |                     Task + Inbox fingerprints |   Re-inspection in writer transaction | Abort stale action                      |
| Run View member activity  |                         Required |                        Exact member | task counts + bounded activity + exact unread |                        Tauri Run View | Empty only when every dimension is zero |

Verdict: **fix** — every mutating resolver uses the same Run/member/row
dimensions; stale or asymmetric evidence aborts rather than falling back to
`agent_id`.

## Audit Result

- Fix: 7 layers
- Keep with reason: 3 layers
- Abstract/defer: 0 layers
- Open architecture findings: 0

The acceptance test report in the Draft PR remains the authority for final
PASS/BLOCKED status on the exact pushed commit.
