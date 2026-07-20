# Architecture Audit — Repository Health

**Scope:** ORGII repository, with frontend/Rust quality gates and the session-dispatch architecture sampled end to end  
**Date:** 2026-07-15  
**Mode:** Audit only; no source code changed  
**Method:** `.orgii/skills/architecture-audit/SKILL.md` (all 10 layers)

## Executive verdict

The repository has strong local architecture in several critical areas (one session-identity resolver, a generation-aware turn FSM, provider-compatible tool schemas, and a large test suite), but the default development branch is currently not releasable. The main process defect is that CI runs only for pull requests targeting `release` or `master`, while the repository default branch is `develop`. As a result, `develop` currently carries failures in TypeScript, Vitest, Rust workspace compilation, and warnings-as-errors Clippy.

### Priority order

| Priority | Finding                                                                                                  | Impact                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| P0       | CI does not run for PRs into the default `develop` branch                                                | Broken code can merge without any required gate                              |
| P0       | Current frontend baseline fails typecheck and 2 unit tests                                               | Frontend CI would fail immediately                                           |
| P0       | `cargo check --workspace` fails in `e2e-test`                                                            | Rust CI would fail immediately                                               |
| P1       | Mode-switch resume sends outside the turn-lifecycle FSM                                                  | A queued message can observe `idle` and dispatch into an active resumed turn |
| P1       | `cargo check --workspace --all-targets` also fails a platform-gated `git-api` test import                | Cross-platform test coverage is not host-safe                                |
| P1       | Clippy warnings-as-errors fails (4 tracked findings plus 1 current Warp-worktree finding)                | Rust CI remains red after compilation is repaired                            |
| P2       | Three Rust session-status enums overlap with different variant sets and policies                         | Semantic drift and lossy conversions remain likely                           |
| P2       | Model-family logic still has explicitly allowlisted exceptions outside the canonical capability resolver | New models can receive inconsistent vision/tokenizer/cutoff behavior         |
| P2       | Dead-code and circular-dependency checks are not reproducible/actionable                                 | Architecture debt is measured noisily or not at all                          |
| P3       | Very large production modules remain common                                                              | Change blast radius and review cost are high                                 |

## Evidence-backed findings

### A1 — Default branch is outside CI protection (P0)

The remote default is `develop` (`origin/HEAD -> origin/develop`), but [ci.yml](/Users/junyu/github/ORGII/.github/workflows/ci.yml:11) triggers only for PRs targeting `release` and `master`. It has no `push` trigger and no `develop` target.

This is the systemic cause behind the red baseline below. Add `develop` to the PR branches (and preferably a push gate for protected branches), then make these checks required before merge.

### A2 — Frontend baseline is red (P0)

`pnpm typecheck` fails at [ContextInfoButton.tsx](/Users/junyu/github/ORGII/src/engines/ChatPanel/InputArea/components/ContextInfoButton.tsx:468): `useSessionId()` can yield `string | undefined`, but `ConfiguredMiniCpmCompactCard` requires `string`.

`pnpm exec vitest run --reporter=dot` completed 4,246 tests: **4,244 passed and 2 failed**.

| Test                                                                                                                                     | Failure                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [settingsUiParity.test.ts](/Users/junyu/github/ORGII/src/config/settingsSchema/__tests__/settingsUiParity.test.ts:5)                     | Eight `housekeeper.*` schema keys are absent from the UI manifest                                                                                                                                                                             |
| [editUtils.test.ts](/Users/junyu/github/ORGII/src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/__tests__/editUtils.test.ts:87) | `getEditStartLine` accepts a null event but calls `shouldTrustDiffStartLines` first; [fileConverter.ts](/Users/junyu/github/ORGII/src/modules/WorkStation/CodeEditor/SessionReplay/converters/fileConverter.ts:135) dereferences `event.args` |

ESLint passes (`pnpm exec eslint ... --quiet`, exit 0), so this is not a general lint collapse; the failures are specific contract regressions.

### A3 — Rust workspace baseline is red (P0/P1)

`cargo check` for the root application passes, but `cargo check --workspace` fails in [housekeeping.rs](/Users/junyu/github/ORGII/src-tauri/crates/e2e-test/src/housekeeping.rs:383): four calls refer to a missing `seed_aged_file` helper. This means the production root package can look healthy while the CI command is broken.

`cargo check --workspace --all-targets` additionally fails [extractors_tests.rs](/Users/junyu/github/ORGII/src-tauri/crates/git-api/src/tests/extractors_tests.rs:2): it imports `has_windows_users_prefix` on every host, but the function is compiled only under `#[cfg(windows)]` in [extractors.rs](/Users/junyu/github/ORGII/src-tauri/crates/git-api/src/extractors.rs:26). Gate the import/test or make the pure prefix predicate host-independent.

`cargo clippy -q -- -D warnings` also fails:

- tracked code: two derivable `Default` implementations, one non-minimal boolean, and one redundant closure;
- current uncommitted Warp work: one `field_reassign_with_default` finding in `sources/warp/history.rs`.

The Warp finding is explicitly separated because that file is user work in progress; the other four are present in tracked code.

### A4 — Mode-switch resume bypasses the authoritative turn FSM (P1)

[useModeSwitchActions.ts](/Users/junyu/github/ORGII/src/engines/ChatPanel/InputArea/ModeSwitchCard/useModeSwitchActions.ts:182) acknowledges that the path bypasses the normal dispatcher, but it updates only optimistic UI state and calls `SessionService.sendMessage`. It does not call `beginTurnDispatch`, does not capture a generation, and does not call `confirmTurnRunning` or a generation-scoped terminal on failure.

Meanwhile, [useQueueDispatch.ts](/Users/junyu/github/ORGII/src/engines/SessionCore/hooks/session/useQueueDispatch.ts:380) treats `getTurnPhase(sessionId) === "idle"` as the natural-drain gate. During a mode-switch rerun, the backend can be executing while the FSM still says `idle`; a queued follow-up can therefore pass the first gate. The later backend-status RPC reduces the window for natural messages but does not protect every session kind or explicit `now` messages.

The fix should not add another special flag. Route resume/mode-switch through the same dispatch entry point that reserves the FSM generation before the first await.

### A5 — Session-status semantics remain duplicated (P2)

There are three similarly named Rust enums:

- [agent-core application `SessionStatus`](/Users/junyu/github/ORGII/src-tauri/crates/agent-core/src/core/session/types/enums.rs:27): 12 variants;
- [persistence `AgentSessionStatus`](/Users/junyu/github/ORGII/src-tauri/crates/agent-core/src/foundation/persistence/db_helpers/mod.rs:209): 5 variants;
- [CLI `SessionStatus`](/Users/junyu/github/ORGII/src-tauri/src/agent_sessions/cli/types.rs:18): 6 variants.

The first enum documents that application code should map it to the persistence enum, but the canonical narrowing conversion is still not colocated with the types. The CLI enum also defines a separate `is_resumable` policy. Rename by domain (`ApplicationSessionStatus`, `PersistedSessionStatus`, `CliSessionStatus`) and centralize explicit conversions so adding a status cannot silently miss one subsystem.

### A6 — Model-family decisions are only partly centralized (P2)

`model_capabilities.rs` is the intended single source of truth and now has a useful enforcement test. However, the test explicitly allowlists remaining exceptions for tokenizer, vision and knowledge-cutoff logic. Current examples include:

- [screenshot.rs](/Users/junyu/github/ORGII/src-tauri/crates/agent-core/src/core/turn_executor/screenshot.rs:29) — independent vision-family substring checks;
- [tokenizer.rs](/Users/junyu/github/ORGII/src-tauri/crates/agent-core/src/core/model_context/tokenizer.rs:42) — independent tokenizer-family checks;
- [section_builders.rs](/Users/junyu/github/ORGII/src-tauri/crates/agent-core/src/core/session/prompt/section_builders.rs:816) — independent knowledge-cutoff checks.

The enforcement test prevents new unapproved sites, which is good, but the allowlist freezes known split ownership. Move these remaining dimensions into `ModelCapabilities` and shrink the exception list to zero.

### A7 — Architecture hygiene tools are not reliable gates (P2)

`pnpm check:unused-exports` exits non-zero and reports **952 modules** with unused exports. That number contains barrel/public-surface false positives alongside plausible dead code, so it is too noisy to serve as a decision gate. Baseline and categorize it, or replace it with a tool/configuration that understands intended package entry points.

`pnpm check:circular` runs `npx madge`, but `madge` is not declared in `package.json`/`pnpm-lock.yaml`. In an offline or restricted environment the command tries to fetch from npm and fails before analyzing the graph. Add a pinned dev dependency and invoke it through `pnpm exec madge`. The same unpinned `npx madge` pattern exists in `scripts/git/commit-stats-background.mjs`.

### A8 — Module size remains a structural risk (P3)

There are **78 non-test TypeScript files at or above 600 LOC**. The largest is [GitHubWorkItemsSurface.tsx](/Users/junyu/github/ORGII/src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx:1) at 2,356 LOC; other major hotspots include `ChatHistory/index.tsx` (1,373), `RoutineWizard/index.tsx` (1,150), and Session Creator's ChatPanel variant (1,115).

Rust has similarly large orchestration/test surfaces, including `agent_org.rs` files above 2,700 LOC and production session/tool modules above 1,000 LOC. Size alone is not a bug, but these files combine state, effects, transport, and rendering, making localized changes difficult to review and test.

## Ten-layer coverage

| Layer                                   | Result                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | **Fail** — frontend typecheck, Rust workspace check, tests, and Clippy are red; root `cargo check` and ESLint pass                                               |
| 2. Dead code & structural deduplication | **Partial fail** — unused-export tool reports 952 noisy candidates; large dispatch/status structures remain duplicated                                           |
| 3. Naming consistency                   | **Fail** — three status enums and stale/misleading queue atom naming obscure ownership                                                                           |
| 4. Semantic overloading                 | **Fail** — `SessionStatus` means different state spaces in application and CLI domains                                                                           |
| 5. Default branch analysis              | **Pass with caution** — terminal normalization is guarded by terminal predicates at callers; no new unguarded enum catch-all bug confirmed                       |
| 6. Cross-domain leakage                 | **Fail** — model-family decisions remain in screenshot/tokenizer/prompt modules outside the capability owner                                                     |
| 7. New-developer confusion              | **Fail** — green root build vs red workspace, duplicated statuses, and a mode-switch transport bypass are non-obvious                                            |
| 8. Wire protocol & serialization        | **Pass (static)** — Draft 7, no meta-schema, inline subschemas, and nullable normalization are centralized in `params_schema`; no live provider call was made    |
| 9. Init parity                          | **Pass (static sample)** — production and test entry points route through the unified init path and explicitly register sessions; no missing init step confirmed |
| 10. Resolver symmetry                   | **Pass** — `resolve_session_identity` checks overrides/runtime/DB for model, account, workspace, and native harness under one `needs_db` gate                    |

## Recommended execution plan

1. Add `develop` to CI protection, then freeze merges until the baseline is green.
2. Repair the three frontend failures (typecheck plus two tests).
3. Restore `seed_aged_file`, host-gate the Windows test, and clear tracked Clippy findings.
4. Route mode-switch resume through the generation-aware dispatch path and add a queue concurrency test.
5. Consolidate status types/conversions and finish the model-capability migration.
6. Pin architecture-analysis tools and establish a reviewed unused-export baseline.
7. Split the largest production modules in bounded, independently testable refactors.

## Verification commands run

| Command                                                 | Result                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`                                        | Fail — 1 error                                                  |
| `pnpm exec eslint src/ --ext .ts,.tsx,.js,.jsx --quiet` | Pass                                                            |
| `pnpm exec vitest run --reporter=dot`                   | Fail — 2/4,246 tests                                            |
| `pnpm check:unused-exports`                             | Fail — 952 modules reported                                     |
| `pnpm check:circular`                                   | Not executed — undeclared `madge` triggered a blocked npm fetch |
| `cargo check`                                           | Pass                                                            |
| `cargo check --workspace`                               | Fail — `e2e-test`                                               |
| `cargo check --workspace --all-targets`                 | Fail — `e2e-test` + host-incompatible `git-api` test import     |
| `cargo clippy -q -- -D warnings`                        | Fail — 5 findings (1 in uncommitted Warp work)                  |
