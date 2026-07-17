# Hermes Hooks Architecture Audit

Date: 2026-07-17
Scope: Hermes plugin installation, callback authentication, process/terminal lifecycle, WebSocket contract, and notification consumers.

## Outcome

The Hermes hook implementation is merge-ready within this scope. The audit found three architecture issues—unreleased terminal credentials, a single-process global descriptor, and duplicated TypeScript status literals—and the implementation now resolves all three. No remaining P0–P3 finding was identified in the audited path.

Repository-wide TypeScript and Clippy gates still report pre-existing failures outside this scope; they are recorded under Verification.

## Findings and decisions

| Line                                              | Element                  | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------------------------------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src-tauri/src/api/hermes_hook.rs:111`            | Terminal token registry  | keep with reason | Credentials now have two idempotent teardown paths: authenticated `on_session_finalize` and explicit terminal destruction.                              | None.            |
| `src-tauri/src/api/hermes_hook.rs:259`            | Global descriptor path   | keep with reason | Each ORGII process owns a distinct private descriptor, so one process cannot overwrite another process's discovery state.                               | None.            |
| `src-tauri/src/api/hermes_hook.rs:327`            | Plugin enable subprocess | keep with reason | The command is bounded by a timeout and stdout/stderr are drained concurrently, avoiding startup hangs and pipe-buffer deadlocks.                       | None.            |
| `src-tauri/src/api/hermes_hook.rs:442`            | Global initialization    | keep with reason | Installation is shared with integrated terminals, blocking work runs off the async executor, and descriptor publication is serialized against shutdown. | None.            |
| `src-tauri/src/api/hermes_hook/__init__.py:101`   | Descriptor discovery     | keep with reason | Integrated credentials take precedence; external callbacks inspect newest process descriptors and fall back when a newer endpoint is stale.             | None.            |
| `src-tauri/src/api/hermes_hook/__init__.py:183`   | Callback transport       | keep with reason | Payloads are allowlisted/redacted, Gateway events are excluded, attempts are time-bounded, and repeated total failure enters cooldown.                  | None.            |
| `src/types/terminalAgentStatus.ts:2`              | Terminal status contract | abstract         | One shared status definition now drives the Zod wire schema, runtime type guard, process fallback, and UI presentation types.                           | None.            |
| `src-tauri/src/api/hermes_hook/plugin.yaml:7`     | Hermes event declaration | keep with reason | Hermes requires both manifest declaration and runtime registration; a parity test now fails if the required duplication drifts.                         | None.            |
| `src/store/chatPanel/chatPanelTerminalAtom.ts:98` | Terminal destruction     | keep with reason | PTY shutdown is attempted before credential revocation so the final hook can arrive, with explicit revocation as the missing-finalize fallback.         | None.            |

## Ten-layer audit

1. Compilation correctness — Scoped Rust tests, Python tests, ESLint, formatting, and frontend tests pass. Full typecheck/Clippy failures are unchanged baseline issues outside the changed path.
2. Dead code and deduplication — Both entry points call one installer; both notification consumers share the status guard and presentation helpers; all new teardown and discovery helpers have production callers.
3. Naming consistency — `terminal_session_id`, `agent_session_id`, integrated/external source, prepare/release, and descriptor terminology remain dimensionally distinct.
4. Semantic overloading — “session” identifiers are explicitly qualified; “global” refers to external-process discovery rather than integrated terminal credentials.
5. Default branches — Unknown hook events fail closed, invalid statuses fail schema validation, invalid terminal IDs are rejected, and incomplete descriptors are ignored.
6. Cross-domain leakage — The canonical status contract lives in shared `src/types`; API schema and TerminalCore depend inward on it.
7. New-developer clarity — Module comments document the two credential scopes, best-effort callback semantics, descriptor ownership, and teardown behavior.
8. Wire protocol — Python tests inspect the serialized HTTP body and privacy filtering; Rust tests inspect the emitted WebSocket JSON; the frontend Zod schema validates the canonical status set.
9. Init parity — Global and integrated entry points share install/enable; global adds a process descriptor, integrated adds a terminal credential, and both have matching ownership-specific cleanup.
10. Resolver symmetry — Endpoint/token pairs are accepted or rejected together at every source. Integrated environment resolution is intentionally first; external descriptors use the same endpoint/token validation and ordered fallback chain.

## Verification

- `cargo test -p org2 api::hermes_hook::tests` — 11 passed.
- `python3 -m unittest test_hook_plugin.py` — 14 passed.
- Targeted Vitest suite — 12 passed.
- Targeted ESLint — passed.
- Python bytecode compilation, targeted Rustfmt/Prettier checks, and `git diff --check` — passed.
- `pnpm run typecheck` — blocked only by pre-existing `ContextInfoButton.tsx:468` (`string | undefined` assigned to `string`).
- `cargo clippy -p org2 --lib --no-deps -- -D warnings` — blocked by 13 pre-existing lints outside the Hermes files; no Hermes lint was reported.
- `cargo fmt --all -- --check` — blocked by pre-existing formatting differences in OrgTrack history files; the changed Hermes Rust file passes `rustfmt --check`.

An installed Hermes runtime was not launched as part of this audit; transport and lifecycle behavior are verified at the serialized contract and application integration boundaries.
