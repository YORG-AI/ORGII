# Architecture Audit — CLI Agent Discovery Hang

**Scope:** `get_available_agents` discovery, resolver fallback behavior, frontend consumers, cache invalidation, and packaged-app execution

**Date:** 2026-07-27

**Verdict:** pass

## Root cause and lifecycle

The release hang report showed the main thread waiting on a mutex while several Tokio workers were
blocked delivering Wry custom-protocol responses to WebKit. At the same time, independently mounted
frontend consumers invoked `get_available_agents` concurrently. Each request synchronously searched
roughly thirty CLI definitions and, for every missing CLI, could launch a login shell with a
three-second timeout. This exhausted async worker capacity and created the packaged-app circular
wait; the HTTP development surface did not exercise the same Wry response path.

The repaired lifecycle is:

`frontend consumers → shared in-flight Promise → Tauri command → shared backend refresh → spawn_blocking → bounded PATH/known-location inventory → fingerprinted cache`

Concurrent callers receive the same result. A failed blocking worker clears the in-flight state so
the next caller can retry. No successful frontend result is retained beyond the in-flight request;
the backend remains authoritative for PATH, key, binary-fingerprint, and TTL invalidation.

## 10-layer audit

| Layer                      | Scope checked                                                               | Verdict | Evidence                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation             | Rust resolver/key-vault crates, Tauri binary, RPC/Zod, React consumers      | pass    | `pnpm typecheck`, production Webpack, targeted Rust tests, changed-file ESLint, and strict changed-crate Clippy pass. The full dev-build binary compiled; bundle signing alone failed because the configured Developer ID certificate is absent. |
| 2. Dead code / duplication | all production `get_available_agents` entry points                          | pass    | Five consumers use `loadAvailableAgents`; the unused `agentOrgs.availableCliAgents` alias and duplicate schema were removed. The direct E2E helper remains to test the command boundary.                                                         |
| 3. Naming                  | inventory resolution, installation snapshot, in-flight refresh              | pass    | `resolve_cli_binary_for_inventory` explicitly distinguishes bounded inventory from launch-time resolution; `CliInstallationSnapshot` owns one coherent observation.                                                                              |
| 4. Semantic overloading    | installed, resolved command, fingerprint, frontend cache                    | pass    | “Installed” means an executable exists on PATH or a known location. Frontend state means only “request in flight”; it does not imply freshness.                                                                                                  |
| 5. Default branches        | PATH hit/miss, known location, missing binary, poisoned mutex, worker panic | pass    | Missing binaries return the bare command without shell execution. Poisoned result locks recover. Worker failure is returned and subsequent retry is proven by test.                                                                              |
| 6. Cross-domain leakage    | CLI resolver, Key Vault registry, UI consumers                              | pass    | Resolver owns executable lookup policy; registry owns key/config enrichment and cache keys; UI owns presentation sorting without mutating the shared result.                                                                                     |
| 7. New-developer clarity   | cache ownership and concurrency contract                                    | pass    | Comments at the Rust command and frontend service state who owns freshness and why only in-flight work is shared.                                                                                                                                |
| 8. Wire protocol           | Tauri command name and `AvailableAgent` schema                              | pass    | `get_available_agents` and its output schema are unchanged; no serialized field or enum changed.                                                                                                                                                 |
| 9. Init parity             | cold start, concurrent mounts, cache hit, failure/retry, repeated launch    | pass    | Four concurrent backend callers execute one scan; concurrent frontend callers execute one RPC; two isolated packaged-surface launches completed and terminated normally.                                                                         |
| 10. Resolver symmetry      | PATH lookup, known-location fallback, returned command, cache signature     | pass    | One `CliInstallationSnapshot` supplies installed state, command, install method, and fingerprint, avoiding separate asymmetric probes. Launch-time callers retain login-shell fallback; bounded inventory intentionally does not.                |

## Entry-point sweep

| Entry point                 | Before                          | After                                    | Verdict                                               |
| --------------------------- | ------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Session discovery           | direct validation RPC           | shared service                           | fixed                                                 |
| Key Vault provider registry | local promise around direct RPC | local registry cache over shared service | fixed                                                 |
| CLI clients hook            | raw Tauri `invoke`              | shared service                           | fixed                                                 |
| Account compatibility       | direct validation RPC           | shared service                           | fixed                                                 |
| WorkStation CLI tab         | duplicate agent-org RPC alias   | shared service; copies before sorting    | fixed                                                 |
| E2E account helper          | direct validation RPC           | unchanged                                | keep with reason: exercises the real command boundary |

## Findings

| Line / element                                          | Verdict | Reason                                                                                                                                                             | Suggested change |
| ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `cli_binary_resolver.rs:374` bounded inventory resolver | keep    | Startup already augments PATH once; inventory remains bounded to PATH plus known locations and never starts per-agent login shells.                                | None.            |
| `commands.rs:149` in-flight coordinator                 | keep    | Per-process ownership is explicit, result storage is bounded to one active refresh, and waiters retain the exact refresh object even if a later generation begins. | None.            |
| `commands.rs:353` blocking inventory                    | keep    | Filesystem metadata and Key Vault reads run on Tokio's blocking pool, outside Wry response workers.                                                                | None.            |
| `availableAgents.ts:4` module-scoped Promise            | keep    | Exactly one Promise is retained only while pending; success and failure both clear it.                                                                             | None.            |
| Existing 60-second backend value cache                  | keep    | Cache keys include PATH, key signature, and resolved binary fingerprints; callers still detect binary appearance/replacement before reuse.                         | None.            |

No unresolved architecture finding remains in this scope.
