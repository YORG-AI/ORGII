# ORG2 Performance Guard — CLI Agent Discovery Hang

**Date:** 2026-07-27

**Scope:** CLI registry scanning, concurrent IPC, caches, process lookup, packaged Wry lifecycle

**Performance verdict: pass**

The former path had multiplicative work: each mounted consumer started a full registry scan, and
each missing CLI could start a login shell and wait up to three seconds. The repaired path has no
timer or polling loop, shares concurrent work on both sides of IPC, performs blocking filesystem
work on Tokio's blocking pool, and never launches a shell during registry inventory.

## Lifecycle matrix

| State                   | Trigger / cadence                | Work performed                                             | Retained state                                | Cleanup / bound                                              |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Cold visible mount      | consumer demand only             | one bounded registry scan                                  | one in-flight result plus backend cache entry | result notifies all waiters; in-flight slot clears           |
| Concurrent mounts       | same event burst                 | one frontend RPC and one backend blocking scan             | same Promise / refresh object                 | all consumers share completion                               |
| Warm request            | consumer demand only             | PATH/known-location fingerprints, then backend cache reuse | one 60-second value entry                     | replaced on key/PATH/binary change or TTL expiry             |
| Hidden / idle           | none                             | no scan, timer, retry, or polling                          | backend cache only                            | bounded to one registry result                               |
| Worker failure          | blocking task panic/cancellation | error returned; no automatic loop                          | completed error only for existing waiters     | in-flight slot clears; later demand may retry                |
| Component unmount       | React cleanup                    | no new work                                                | Rust refresh may finish for other consumers   | component ignores completion; shared request remains bounded |
| Repeated app close/open | process lifecycle                | at most one cold scan per process                          | process-local only                            | OS teardown releases Promise, refresh, and cache             |
| Multiple app instances  | demand per isolated process      | one bounded scan per process                               | one entry per process                         | no cross-process retained state or shared lock               |

## Resource ownership

| Resource                     | Owner                       | Maximum count / size     | Hot-path cost                          | Terminal behavior                     |
| ---------------------------- | --------------------------- | ------------------------ | -------------------------------------- | ------------------------------------- |
| Frontend in-flight Promise   | `availableAgents.ts` module | 1                        | one IPC for concurrent consumers       | cleared on resolve or reject          |
| Backend in-flight refresh    | key-vault process singleton | 1                        | one `spawn_blocking` task              | result delivered; active slot cleared |
| Backend value cache          | key-vault process singleton | 1 registry vector        | bounded PATH/metadata fingerprint pass | replaced/expired; process teardown    |
| Login-shell process          | launch-time resolver only   | 0 for registry inventory | none in this feature                   | not applicable                        |
| Timers/subscriptions/workers | none added                  | 0                        | none while idle/hidden                 | not applicable                        |

## Runtime evidence

- Targeted resolver suite: 9 tests pass in 0.44 seconds, including a fake-shell marker proving
  bounded inventory never launches the shell.
- Key-vault lifecycle suite: 3 tests pass in 0.04 seconds, including four simultaneous callers
  sharing one scan and recovery after a simulated blocking-worker panic.
- Frontend service suite: 3 tests pass, covering shared success, post-settlement refresh, and
  rejection followed by retry.
- A real optimized `dev-build` Tauri binary compiled successfully. Final `.app` signing failed only
  because `Developer ID Application: HOUYi HE (S4UG24G7HJ)` is not installed on this machine.
- The produced custom-protocol binary was launched twice with isolated `ORGII_HOME`, ports, and
  history roots. On the 20-second run, diagnostics recorded two successful
  `get_available_agents` calls and zero failures. On the 15-second debug run, the cold registry
  result was emitted by one blocking thread from `12:50:43.346594` through
  `12:50:43.347612`; the process then settled at 0.0% CPU and about 0.9% memory.
- A one-second macOS system sample after settling showed the main thread normally waiting in the
  AppKit event loop and Tokio workers waiting on condition variables. It did not reproduce the
  reported main-thread mutex / `WKURLSchemeTask` circular wait.

## Verification and limits

| Check                                   | Result                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm typecheck`                        | pass                                                                            |
| changed-file ESLint and Prettier        | pass                                                                            |
| production Webpack build                | pass                                                                            |
| targeted Rust and Vitest suites         | pass                                                                            |
| changed-crate Clippy with `-D warnings` | pass after command-line suppression of three unchanged key-vault baseline lints |
| full optimized Tauri binary compile     | pass                                                                            |
| macOS bundle signing                    | environment-blocked: configured Developer ID identity absent                    |
| packaged-surface launch / idle sample   | pass using the produced unsigned custom-protocol binary                         |

No unbounded CPU, RAM, I/O, retry, timer, cache-growth, or repeated-open/close path remains in the
changed lifecycle.
