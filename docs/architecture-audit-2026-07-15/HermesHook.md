# Architecture audit: Hermes lifecycle hook

## Acceptance criteria

- Use Hermes Agent's official plugin-hook mechanism for CLI/TUI lifecycle events.
- Keep the globally enabled plugin inert outside terminals launched by ORGII.
- Map Hermes work, user-boundary, approval, and teardown events onto `starting | running | waiting | blocked | done`.
- Notify once when a background Hermes terminal enters a prompted approval boundary, and focus the originating tab when the notification is clicked.
- Authenticate localhost callbacks per terminal and forward only redacted, allowlisted activity metadata—never prompts, results, file contents, or complete argument objects.
- Preserve foreground-process detection as a fallback when plugin preparation or delivery fails.

## Ten-layer audit

| Layer                                     | Coverage                                                                                                  | Result                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Rust route/command/plugin installer; TypeScript terminal state, notification bridge, and WebSocket schema | Rust library compilation and 4 hook tests pass. Targeted ESLint, 9 frontend tests, and 3 Python privacy tests pass. Full TypeScript checking reaches one unrelated existing error in `ContextInfoButton.tsx:468`; no Hermes-hook file reports an error.                    |
| 2. Dead code and structural deduplication | TUI launch → Tauri prepare → PTY env → Hermes plugin → HTTP route → WebSocket → terminal atom             | Every new entry point is connected to the production launch path. Existing `TerminalSession`, PTY env support, unified server, broadcaster, and process poller are reused rather than duplicated.                                                                          |
| 3. Naming consistency                     | `orgii-status`, `hermes_hook_prepare`, `terminal_agent.status_changed`, `ORGII_HERMES_HOOK_*`             | Names identify both the Hermes source and ORGII ownership. JSON uses camelCase from Python to Rust and the existing snake_case convention from Rust to the code-editor WebSocket.                                                                                          |
| 4. Semantic overloading                   | “hook”, “waiting”, “blocked”, “session end”, terminal status source                                       | `waiting` means an idle/user-input boundary; `blocked` means a prompted approval decision is outstanding. Smart-mode automatic decisions remain `running`. Only `on_session_finalize` maps to `done`. `agentStatusSource` distinguishes process inference from hook truth. |
| 5. Default branch analysis                | Unknown hook events, missing env/binary, smart approval, callback/notification failures                   | Unknown events are ignored with 204. Missing plugin env makes the plugin a no-op. Prepare failure preserves process fallback. Smart approvals do not notify. Invalid tokens return 401. Notification failures are logged and do not affect state delivery.                 |
| 6. Cross-domain concept leakage           | Hermes event vocabulary versus shared terminal/notification types                                         | Hermes mapping and payload construction stay in `api/hermes_hook`; shared terminal state gains only generic status/activity fields, and the notification service gains generic opaque `extra` metadata/action listening. No Hermes branch was added to PTY internals.      |
| 7. New-developer confusion                | Module docs, transition comments, presentation helpers, acceptance cases                                  | Status meaning, background-only notification deduplication, opaque click targeting, activity privacy limits, and UI acceptance/error/accessibility cases are documented beside their owners.                                                                               |
| 8. Wire protocol and serialization        | Python callback JSON, auth header, Rust broadcast JSON, Zod validation                                    | Callback sends terminal/event identity plus redacted, truncated values from a small argument-key allowlist, model/CWD/duration, and approval surface. Raw prompts, results, file content, and full argument objects are excluded. Frontend validates five status variants. |
| 9. Init parity                            | Chat-panel Hermes TUI, non-Hermes TUI, Hermes outside ORGII, prepare failure                              | The one ORGII chat-panel Hermes launch entry point prepares and injects all hook env fields. Non-Hermes terminals skip preparation. Globally enabled plugin sessions without ORGII env remain inert. Failure preserves the prior process-based behavior.                   |
| 10. Resolver symmetry                     | Callback endpoint, token, terminal ID                                                                     | All three required values are issued together by one Tauri command and injected into the same PTY environment. The plugin requires all three before sending; there is no partial fallback chain.                                                                           |

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

| Entry point                   | Plugin preparation                                                                                     | Callback behavior                                                  | Status fallback                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| ORGII chat-panel Hermes TUI   | Install/refresh `~/.hermes/plugins/orgii-status`, run official enable command, inject per-terminal env | Authenticated localhost POST, then terminal-scoped WebSocket event | Foreground process poller until the first valid hook event, and for the whole session if preparation fails |
| ORGII non-Hermes terminal     | Skipped                                                                                                | Plugin not involved                                                | Existing process behavior                                                                                  |
| Hermes launched outside ORGII | Plugin may be enabled globally, but ORGII env is absent                                                | No-op                                                              | Owned by the launching application                                                                         |

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

## Deliberately skipped

| Area                                      | Reason                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway-only Hermes sessions              | This change tracks ORGII integrated TUI terminals; gateway sessions do not own a chat-panel terminal ID.                                            |
| Forwarding prompts/results/full arguments | Status UI uses only a redacted and truncated allowlist preview; complete content would add privacy and payload-size risk.                           |
| Replacing process polling globally        | Other CLI agents do not expose the same Hermes lifecycle contract; polling remains their supported fallback.                                        |
| Inline approval actions                   | Notification click navigates to the existing Hermes TUI; approve/deny remains inside Hermes so ORGII does not duplicate its authorization boundary. |

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib api::hermes_hook::tests` — 4 passed.
- Targeted Vitest run — 9 passed across status fallback, wire schema, notification deduplication/targeting, and presentation.
- `python3 -m unittest discover -s src-tauri/src/api/hermes_hook -p 'test_*.py' -v` — 3 privacy tests passed.
- Targeted ESLint — passed.
- `git diff --check` — passed before the final report write and repeated in the final verification pass.
- `pnpm typecheck` — one unrelated existing error at `src/engines/ChatPanel/InputArea/components/ContextInfoButton.tsx:468`; no changed hook file failed.
