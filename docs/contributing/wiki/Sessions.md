# Sessions

A **session** is a single running agent conversation. ORGII manages multiple concurrent sessions across different agent types, each surfaced in the WorkStation.

## Session types (`DispatchCategory`)

Every session belongs to one of three dispatch categories:

| Category     | What it is                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_agent`  | An external CLI coding-agent process (Cursor, Claude Code, Codex, Antigravity, Copilot, Kiro, OpenCode, …) spawned and managed by ORGII |
| `rust_agent` | ORGII's built-in Rust-native agent — the SDE Agent or OS Agent                                                                          |
| `cursor_ide` | A read-only view of a Cursor IDE chat imported into ORGII (no ORGII-side process)                                                       |

## CLI agents

When you select `cli_agent`, ORGII spawns the chosen CLI tool as a subprocess, pipes your messages to its stdin, and parses its output into structured events. Each agent has its own parser:

| Agent          | Key           |
| -------------- | ------------- |
| Cursor         | `cursor_cli`  |
| Claude Code    | `claude_code` |
| Codex          | `codex`       |
| Antigravity    | `antigravity` |
| GitHub Copilot | `copilot`     |
| Kiro           | `kiro`        |
| OpenCode       | `opencode`    |

You supply your own key or subscription, stored locally in Key Vault.

## Rust agents (`rust_agent`)

Sub-types within `rust_agent`:

| Sub-type  | Description                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------- |
| `os`      | **OS Agent** — computer-use agent with screen capture (macOS), browser automation, shell access     |
| `sde`     | **SDE Agent** — software development agent optimized for coding tasks, code review, and refactoring |
| `gateway` | Routes to an external model/provider through ORGII's gateway                                        |
| `custom`  | User-defined agent built through the Agent Wizard with a custom soul and tool set                   |

## Execution modes (`AgentExecMode`)

Rust-native sessions can run in different modes that shape how the agent approaches a task:

| Mode          | Description                                             |
| ------------- | ------------------------------------------------------- |
| `build`       | Default — implement the requested feature or fix        |
| `investigate` | Explore and explain code without making changes         |
| `plan`        | Produce a detailed plan before coding                   |
| `debug`       | Diagnose and fix bugs systematically                    |
| `review`      | Review a PR or diff and provide structured feedback     |
| `wingman`     | Collaborative co-pilot mode: assists rather than drives |

The default mode is persisted per-user and can be overridden per-session.

## Key source

Sessions use your own API key or subscription stored in Key Vault.

## Creating a session

1. Press the **+** button (or the session creator shortcut).
2. Choose a session type (CLI Agent or Rust Agent).
3. For CLI agents: pick the agent type and model/plan.
4. For Rust agents: pick the sub-type and execution mode.
5. Optionally configure advanced settings (working directory, MCP servers, agent rules).
6. Type your task and press **Send**.

## Session lifecycle

```
Created → Running → (Paused) → Completed / Error
                ↑
            Resumed (continue from last turn)
```

Sessions are persisted. You can close ORGII and resume a session later. The full event history is stored in the local event store.

## Session list and management

The session list (left sidebar) shows all sessions grouped by status. You can:

- **Pin** sessions to keep them at the top.
- **Archive** completed sessions.
- **Resume** any past session from its last turn.
- **Export** a session's history.

## Cursor IDE sessions (`cursor_ide`)

ORGII can import chats from a locally running Cursor IDE and surface them as read-only sessions. This lets you view Cursor agent activity in the ORGII WorkStation without duplicate processes. These sessions are identified by their session ID prefix and are marked read-only throughout the UI.
