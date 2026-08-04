---
name: e2e-testing
description: ORGII rendered UI and Rust runtime end-to-end testing guidance. Use when adding, repairing, reviewing, or running WebDriverIO specs under tests/e2e, Rust HTTP runtime scenarios under src-tauri/crates/e2e-test, multi-repo workspace regressions, orchestration flows, file-change or diff behavior, queue/turn lifecycle tests, or CLI session reload coverage.
---

# ORGII E2E Testing

ORGII has two separate E2E surfaces:

1. Core UI E2E uses WebDriverIO against the debug-built Tauri app.
2. Rust runtime E2E uses an HTTP client against debug-only agent test endpoints.

Runtime evidence never substitutes for rendered UI evidence when a user-visible control or result is involved.

## Core workflow

1. Identify whether the claim is UI-visible, runtime-only, or cross-layer.
2. Read [commands.md](references/commands.md) for layer selection and supported commands.
3. Load only the policy matching the scenario:
   - Rendered interaction or visible recovery: [core-ui-policy.md](references/core-ui-policy.md)
   - Multi-repo, fixtures, or account/model matrices: [workspace-and-matrix.md](references/workspace-and-matrix.md)
   - Debug endpoint and runtime state: [rust-runtime-policy.md](references/rust-runtime-policy.md)
   - Agent-org orchestration, diffs, plans, rewind, or streaming: [orchestration-and-diff.md](references/orchestration-and-diff.md)
   - Queue, turn finality, or CLI reload: [lifecycle-and-reload.md](references/lifecycle-and-reload.md)
4. Extend the smallest existing stable scenario that proves the user outcome.
5. Capture positive end-state evidence and explicit anti-false-positive evidence.
6. Report product failures separately from provider, account, port, and environment blockers.

## Hard rules

- Never change product business semantics to make an E2E pass. E2E fixes should wire the existing backend/runtime path, assert the current UI contract, or expose a real product bug.
- Never run mutation-capable UI E2E against `yorg_frontend`.
- Never claim “E2E passed” after only running unit tests, focused module tests, `cargo check`, or Rust protocol/debug-endpoint scenarios. Name the exact surface that passed: unit, Rust runtime E2E, or Core UI E2E.
- Never add a rendered UI claim to Rust-only coverage.
- Never add a debug endpoint that tests only a helper when the bug is in the caller path.
- Never preserve an obsolete scenario just because it once caught a phase bug; keep the invariant, not the phase artifact.
