# Rerank Phase 0 Gate — 2026-07-29

## Scope

Phase 0 only: config-driven Session Memory embedding + rerank, exact transport selection, visible failure semantics, canonical Memory editor, and discoverability. No Journey graph (P1), package, install, or live configuration changes are included.

## Capability matrix

| Capability | Phase 0 result | Evidence |
| --- | --- | --- |
| ZenMux rerank transport | `POST {base}/rerank`, Bearer auth, `{model,input:{query,documents},parameters:{top_n,return_documents:true}}` | `rerank.rs` wiremock exact URL/header/body/sorted-result test |
| Local rerank transport | Explicit `{base}/v1/rerank`, `{query,documents,top_n}`, no model/auth | `rerank.rs` local wiremock test |
| Exact provider selection | `zenmux_api`, `local`, `disabled`; unknown provider is an error | `ConfiguredReranker::from_config` |
| Credential selection | Enabled + `HealthStatus::Valid` + validated within 24h + non-empty API key; deterministic model match, newest validation, then key id | `select_validated_zenmux_key`; no secret is logged or returned |
| No transport fallback | ZenMux failure returns an error and never contacts local `/v1/rerank` | zero-call wiremock expectation |
| Cosine-only semantics | Only explicit `disabled` preserves cosine order | `ranking.rs`, `session_memory_search.rs` |
| Enabled failure semantics | HTTP, malformed, empty, invalid-index and configuration failures surface | search returns `Err`; worker prompt maps to `ToolError::ExecutionFailed` |
| Config round trip | `IntegrationsConfig.rerank` and patch preserve camelCase provider/model/base URL/timeout | Rust serde/patch tests |
| Canonical editor | Rules, Memory & Evolution → Memory renders Semantic Models above memory browser | `RulesMemoryEvolutionTable.tsx` |
| Models & Keys | Compact summary and deep link only; no second full editor | `AccountsTable.tsx` |
| URL/deep links | `rulesTab=memory`; Models `embedding` tab URL-backed; Spotlight points to canonical Memory | page state/constants/registry unit and rendered E2E coverage |
| Localization | New labels in en/zh; all other locales use repository `fallbackLng: en` convention | i18n resources |

## No-fallback contract

- `provider=disabled`: rerank is intentionally bypassed and cosine order is returned.
- `provider=zenmux_api`: only ZenMux is called. Missing/stale credential, request failure, non-2xx, malformed/empty result, invalid/duplicate index, or non-finite score is an error.
- `provider=local`: only the configured local `/v1/rerank` endpoint is called; the same response failures are errors.
- Unknown providers are configuration errors. Aliases such as `auto`, `off`, and `none` are not accepted by the backend.
- The worker creation path converts enabled-rerank failure into `ToolError::ExecutionFailed`, so worker creation fails visibly.
- Session-memory search returns an error and its slash-command caller renders `Session-memory search failed: ...`.

## Residual behavior intentionally retained

This narrow phase does not change wholly separate embedding/query absence behavior:

- Worker learnings retrieval still uses salience when the task query is blank, query embedding fails, cosine recall fails, or fewer than two semantic hits remain.
- Session-memory search still returns no hits when no compatible stored vectors exist; its query embedding failure is propagated.
- Re-embedding remains event-driven as eligible session updates occur; this phase does not add a bulk re-index command.

## UI readiness and Test Rerank follow-up

The canonical editor shows configured embedding/rerank provider and model plus ZenMux credential name/readiness, validation time (when stale), and last validation error. A UI “Test Rerank” button was not added because no existing production RPC invokes the configured rerank transport. Adding a fake frontend test would violate the E2E anti-false-prosperity rule. Typed follow-up: expose an agent-core command returning a non-secret `RerankProbeResult { provider, model, credential_id, validated_at, latency_ms, top_index }`, then wire the canonical panel to that production path. The exact wiremock tests are the P0 transport gate.

## Commands and results

Updated after TiyGate boundary completion and stash restore (`2026-07-29 ~21:40 CST`).

- `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` — **PASS** (host `~/.cargo`).
- Focused Vitest — **PASS**, 2 files / 6 tests:
  - `sessionMemoryEmbeddingConfig.test.ts`
  - `integrationsPageConstants.test.ts`
  Temporary `node_modules` symlink to `/mnt/panshuainan/org2-unified-20260724/node_modules` (removed/ignored; no package install).
- ESLint on all touched TS/TSX files — **PASS**.
- `node --check tests/e2e/specs/core/session-memory-ui.spec.mjs` — **PASS**.
- `git diff --check` — **PASS**.
- Host `cargo test -p agent_core ...` — **blocked by missing `gdk-3.0` / `libgtk-3-dev`** (unchanged environment constraint; no apt install performed).
- Docker `org2-build:22.04` focused tests:
  - `cargo test -p agent_core rerank --no-default-features -j 2` — first run **3 wiremock failures** due to missing rustls crypto provider bootstrap.
  - Fix: call `install_crypto_provider_for_tests()` in the three async wiremock tests in `rerank.rs` (repo convention for `rustls-no-provider` reqwest).
  - Rerun — **PASS 8/8** (config/patch serde + wiremock ZenMux/local/no-fallback + malformed).
- Docker `cargo check -p agent_core --all-targets -j 2` — **PASS**.
- Docker `cargo clippy -p agent_core --all-targets -j 2 -- -D warnings` — **FAIL on baseline deps** (`cursor_bridge_app` question_mark) before agent_core.
- Docker `cargo clippy -p agent_core --all-targets --no-deps -j 2 -- -D warnings` — **FAIL on pre-existing agent_core baseline** (workspace_memory prefetch/manifest, init test-module order, etc.). **Zero diagnostics in P0-touched files** (`rerank.rs`, `ranking.rs`, `session_memory_search.rs`, `system_prompt.rs`, `config.rs`, `patch.rs`, `prompt.rs`, `mod.rs`).
- `NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck` / `tsc --noEmit` — exit 2 on **pre-existing Journey/base errors only** (`useLocalKeys.ts`, `refreshAccountModels.ts`, `ProjectsTab.tsx`, `projectTree.tsx`). **Zero diagnostics in P0-touched frontend files**.
- Rendered E2E execution — **not run** (needs debug-built Tauri app + WebDriver; not part of this host gate without full GUI build).
- Static contract check — **PASS**: exact ZenMux body shape, disabled=>cosine only, enabled failures surface via `session-memory rerank failed` / `ToolError::ExecutionFailed`, no cross-transport fallback test expectation remains green.

## Residual known non-P0 blockers

- Full-repo typecheck/clippy green is not claimed; only P0 surfaces are gated green.
- No package/deb/install/`/usr/bin/org2` mutation.
- No live user config / credential mutation.

## Remaining runtime/package gate

On a provisioned CI/dev host with GTK 3 development metadata and project dependencies already installed, run:

```bash
cd src-tauri
cargo test -p agent_core rerank --no-default-features -j 2
cargo check -p agent_core --all-targets -j 2
cargo clippy -p agent_core --all-targets -j 2 -- -D warnings
cd ..
npm run typecheck
npx wdio tests/e2e/wdio.conf.mjs --spec tests/e2e/specs/core/session-memory-ui.spec.mjs
```

No release build, install, `/usr/bin/org2` update, live ORG2 mutation, or user credential/config mutation was performed.

## Evidence paths (2026-07-29 21:41)
- `/tmp/org2-p0-rerank-docker-test2.log` — 8/8 pass
- `/tmp/org2-p0-rerank-check.log` — cargo check PASS
- `/tmp/org2-p0-rerank-clippy.log` — baseline clippy fail; P0 files clean
- `/tmp/org2-p0-typecheck.log` — baseline typecheck fail; P0 files clean
