# Rust Runtime E2E Policy

## Rust runtime E2E policy

`e2e-test` is a deterministic runtime contract suite, not a second UI suite and not a live-provider platform matrix. Keep it much smaller than the historical audit-era suite.

Keep:

- Backend/runtime invariants not covered by rendered UI E2E.
- Deterministic debug-endpoint coverage for memory, learning, permissions, worktree, session recovery, housekeeping, LSP, gateway/sync/MCP contracts, subagent dispatch, and tool execution invariants.
- Tool-policy and agent-definition contracts that are hard to observe from UI alone, especially positive/negative schema or policy assertions. Use the session-scoped effective-tools surface (`agent_list_effective_tools_for_session`, `/agent/test/effective-tools/:session_id`, or `__e2e.listEffectiveToolsForSession`) rather than global `list_all_tools` or registry-only `/agent/test/tool-schemas/:session_id` when asserting what a running agent can actually see in a mode-filtered prompt.
- Scenarios with stable setup, stable assertions, and explicit teardown/isolation.

Delete or move out:

- Historical phase/audit scenarios whose invariant is already covered by a canonical scenario.
- Long-running live-LLM scenarios that mainly duplicate UI/platform matrix behavior.
- Provider-specific smoke tests that are better covered by core UI matrix rows.
- Memory/learning tests that only prove the model can recall rendered text; keep state/DB/policy pins instead.
- Plan lifecycle tests that assert user-visible card/button behavior; keep only backend policy/snapshot invariants in Rust.
- Scenarios whose only assertion is `HTTP 200` or loose text without a stable invariant.
- Dead helper modules/functions not registered in `main.rs` and not called by a registered scenario.

When cleaning Rust E2E:

1. Inspect `src-tauri/crates/e2e-test/src/main.rs` scenario registry.
2. Count groups with `cargo run -p e2e-test -- --list` or a local registry parser.
3. Remove entries only when their invariant is duplicated, obsolete, flaky by design, or moved to UI E2E.
4. Delete the module/function after removing the registry entry.
5. Run `cargo check -p e2e-test` and `cargo fmt`.
