# Architecture audit: Hermes lifecycle hook

## Acceptance criteria

- Use Hermes Agent's official plugin-hook mechanism for CLI/TUI lifecycle events.
- Support both ORGII-integrated terminals and Hermes launched from an external terminal while ORGII is running.
- Map Hermes work, user-boundary, approval, and teardown events onto `starting | running | waiting | blocked | done`.
- Notify once when a background Hermes terminal enters a prompted approval boundary; integrated notifications target their ORGII tab, while external notifications do not claim a tab target.
- Authenticate integrated callbacks per terminal and external callbacks with a per-process global token stored in a user-private descriptor. Forward only redacted, allowlisted activity metadata—never prompts, results, file contents, or complete argument objects.
- Preserve foreground-process detection as a fallback when plugin preparation or delivery fails.

## Ten-layer audit

| Layer                                     | Coverage                                                                                                   | Result                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Rust route/command/plugin installer; TypeScript terminal state, notification bridges, and WebSocket schema | Rust library compilation and 8 hook tests pass. Targeted ESLint and frontend tests pass, as do 7 Python privacy/endpoint tests. Full TypeScript checking reaches one unrelated existing error in `ContextInfoButton.tsx:468`; no Hermes-hook file reports an error.                 |
| 2. Dead code and structural deduplication | Integrated launch or global descriptor → Hermes plugin → HTTP route → WebSocket → scoped bridge            | Both entry points converge on one plugin payload and one authenticated route. Existing PTY env support, unified server, broadcaster, notification service, and process poller are reused.                                                                                           |
| 3. Naming consistency                     | `orgii-status`, `hermes_hook_prepare`, `initialize_global_hook`, `source`, `agent_session_id`              | `terminal_session_id` always means an ORGII-owned terminal; `agent_session_id` always means Hermes' own identity. `source` explicitly distinguishes `integrated` and `external` rather than overloading ID presence in frontend consumers.                                          |
| 4. Semantic overloading                   | “hook”, “waiting”, “blocked”, “session end”, terminal status source                                        | `waiting` means an idle/user-input boundary; `blocked` means a prompted approval decision is outstanding. Smart-mode automatic decisions remain `running`. Only `on_session_finalize` maps to `done`. `agentStatusSource` distinguishes process inference from hook truth.          |
| 5. Default branch analysis                | Unknown hook events, stale/missing descriptor, missing binary, smart approval, callback failures           | Unknown events are ignored with 204. Missing/stale global config and callback failures are no-ops in Hermes. Global setup failure is logged without stopping ORGII. Prepare failure preserves process fallback. Smart approvals do not notify. Invalid tokens return 401.           |
| 6. Cross-domain concept leakage           | Hermes event vocabulary versus shared terminal/notification types                                          | Hermes mapping and credential discovery stay in `api/hermes_hook`; the external notification bridge is headless and does not manufacture a terminal session. Shared WebSocket state gains only generic source/session identity fields. No Hermes branch was added to PTY internals. |
| 7. New-developer confusion                | Module docs, transition comments, presentation helpers, acceptance cases                                   | Status meaning, background-only notification deduplication, opaque click targeting, activity privacy limits, and UI acceptance/error/accessibility cases are documented beside their owners.                                                                                        |
| 8. Wire protocol and serialization        | Python callback JSON, auth header, Rust broadcast JSON, Zod validation                                     | Integrated payloads include `terminalSessionId`; external payloads deliberately omit it and carry Hermes `sessionId`. Both exclude raw prompts, results, file content, and full argument objects. Frontend validates source and five statuses.                                      |
| 9. Init parity                            | Chat-panel Hermes TUI, external Hermes, non-Hermes TUI, missing Hermes, prepare failure                    | Server startup installs/enables the plugin and publishes the global descriptor. Integrated launch additionally injects a per-terminal credential. Both paths hit the same route; missing Hermes only disables this optional integration and never stops the server.                 |
| 10. Resolver symmetry                     | Integrated environment versus external global descriptor                                                   | Resolver priority is explicit: use endpoint + token + terminal ID only when the complete integrated triple exists; otherwise read endpoint + token together from the global descriptor. Partial integrated configuration is never mixed with global values.                         |

## Event-to-status contract

| Hermes event                                                                                                                                     | ORGII status | Reason                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------- |
| `on_session_start`, `pre_llm_call`, `pre_tool_call`, `post_tool_call`, `pre_verify`, `subagent_start`, `subagent_stop`, `post_approval_response` | `running`    | Hermes is starting or continuing active work.                     |
| `post_llm_call`, `on_session_end`, `on_session_reset`                                                                                            | `waiting`    | The TUI is idle at an ordinary user/input boundary.               |
| `pre_approval_request` with `surface != smart`                                                                                                   | `blocked`    | A prompted CLI/TUI approval needs user attention.                 |
| `pre_approval_request` with `surface = smart`                                                                                                    | `running`    | Hermes is making an automatic decision; no user action is needed. |
| `on_session_finalize`                                                                                                                            | `done`       | Hermes is tearing down the session.                               |
| Unknown event                                                                                                                                    | unchanged    | Forward-compatible no-op; no unsafe default status.               |

## Entry-point parity matrix

| Entry point                   | Plugin preparation                                                     | Callback behavior                                                        | Status fallback                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| ORGII chat-panel Hermes TUI   | Global install/enable plus per-terminal endpoint/token/ID env          | Per-terminal-authenticated POST; terminal-scoped status and notification | Foreground process poller until the first hook event, and for the whole session if preparation fails |
| Hermes launched outside ORGII | Global install/enable plus `~/.orgii/hermes-hook.env` while ORGII runs | Process-token-authenticated POST; external approval notification         | No synthetic ORGII terminal or click target; Hermes remains owned by its launching terminal          |
| ORGII non-Hermes terminal     | Skipped                                                                | Plugin not involved                                                      | Existing process behavior                                                                            |
| Hermes absent at ORGII start  | Best-effort setup logs a warning                                       | No callback                                                              | The IDE server and all unrelated app behavior continue                                               |

## Wire payload

Hermes plugin to ORGII:

```json
{
  "terminalSessionId": "chatpanel-…",
  "payload": {
    "hookEventName": "pre_tool_call",
    "sessionId": "…",
    "toolName": "terminal",
    "toolInputPreview": "command=pnpm test",
    "model": "provider/model",
    "cwd": "/workspace/project",
    "durationMs": 1250,
    "approvalSurface": "cli"
  }
}
```

ORGII backend to frontend:

```json
{
  "type": "terminal_agent.status_changed",
  "terminal_session_id": "chatpanel-…",
  "cli_agent_type": "hermes",
  "agent_status": "running",
  "hook_event_name": "pre_tool_call",
  "tool_name": "terminal",
  "tool_input_preview": "command=pnpm test",
  "model": "provider/model",
  "cwd": "/workspace/project",
  "duration_ms": 1250,
  "approval_surface": "cli",
  "timestamp": 0
}
```

External Hermes omits `terminalSessionId` on the inbound payload and emits this identity shape:

```json
{
  "type": "terminal_agent.status_changed",
  "source": "external",
  "agent_session_id": "hermes-session-…",
  "cli_agent_type": "hermes",
  "agent_status": "blocked",
  "hook_event_name": "pre_approval_request",
  "timestamp": 0
}
```

## Deliberately skipped

| Area                                      | Reason                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creating ORGII tabs for external Hermes   | External processes are owned by another terminal. ORGII reports approval attention without inventing PTY ownership or a broken click target.            |
| Forwarding prompts/results/full arguments | Status UI uses only a redacted and truncated allowlist preview; complete content would add privacy and payload-size risk.                               |
| Replacing process polling globally        | Other CLI agents do not expose the same Hermes lifecycle contract; polling remains their supported fallback.                                            |
| Inline approval actions                   | Integrated notification clicks navigate to their Hermes TUI; external notifications have no synthetic click target. Approve/deny remains inside Hermes. |

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib api::hermes_hook::tests` — 8 passed, including the serialized external WebSocket shape.
- Targeted Vitest run — passed across status fallback, integrated/external wire schema, notification deduplication/targeting, and presentation.
- `python3 -m unittest discover -s src-tauri/src/api/hermes_hook -p 'test_*.py' -v` — 7 privacy/endpoint tests passed.
- Targeted ESLint — passed.
- `git diff --check` — passed before the final report write and repeated in the final verification pass.
- `pnpm typecheck` — one unrelated existing error at `src/engines/ChatPanel/InputArea/components/ContextInfoButton.tsx:468`; no changed hook file failed.
