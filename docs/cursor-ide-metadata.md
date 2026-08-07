# Cursor IDE session metadata

Reference for the metadata ORGII imports from Cursor's local store, what each
field is, and where it comes from. Verified against a real Cursor install
(2026‑07).

## Where Cursor keeps things

Modern Cursor uses a three‑tier layout under
`~/Library/Application Support/Cursor/User/globalStorage/`
(`%APPDATA%\Roaming\Cursor\...` on Windows, `~/.config/Cursor/...` on Linux):

| Store                                  | What it holds                                                                                                                                                      | ORGII uses it for                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `conversation-search.db`               | Lightweight **index**: one indexed row per conversation (`id`, `title`, `updated_at`, `is_archived`, `root_fingerprint`), `conversations_recency` index.           | **Discovery + change detection.** A cheap indexed read, no blob parsing.                           |
| `state.vscdb`                          | The **content**: `cursorDiskKV` key/value table with `composerData:<id>` (session metadata) and `bubbleId:<composerId>:<bubbleId>` (messages). Can be multiple GB. | Point‑lookup `composerData:<id>` for changed sessions; lazy bubble reads when a session is opened. |
| `~/.cursor/chats/<ws>/<uuid>/store.db` | Newer per‑session blob store (agent‑mode subset only).                                                                                                             | Not used — the main history is in `state.vscdb`.                                                   |

The `conversation-search.db` `id` **is** the composerId, so
`composerData:<id>` is a fast primary‑key lookup.

## The pipeline (`sources/cursor_ide`)

```
conversation-search.db  ──►  discover_from_index()      (indexed SELECT, ~14 ms for 1656 rows)
        │  updated_at + root_fingerprint = change signature
        ▼
changed_records_from_conn()  ──►  only genuinely-changed sessions
        │
        ▼
state.vscdb: composerData:<id>  ──►  cache_input_from_raw()   (parse the changed few)
        ▼
imported_history_session_cache  ──►  CursorIdeSessionRow  ──►  SessionAggregateRecord  ──►  frontend Session
```

This is the **same incremental model the file‑based sources use** (claude_code,
codex, cline, trae…): discovery is cheap, and only changed sessions are
re‑parsed. There is no per‑restart full scan of `state.vscdb`, and no separate
on‑hover fetch — every field below rides in the session row.

## `composerData` fields

### Captured today (surfaced on the session)

| Field in `composerData`                                                        | Session field                       | Notes                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| `name`                                                                         | `name`                              | Session title.                                                 |
| `createdAt`                                                                    | `created_at`                        |                                                                |
| last bubble `createdAt` / `lastUpdatedAt`; index `updated_at` wins for recency | `updated_at`                        | Sort key.                                                      |
| `status`                                                                       | `status`                            | `completed` / `aborted` / …                                    |
| `unifiedMode`                                                                  | (metadata)                          | `agent` / `edit` / `ask`.                                      |
| `isAgentic`                                                                    | (metadata)                          |                                                                |
| `modelConfig.modelName`                                                        | `model`                             | e.g. `claude-opus-4-8`, `gpt-5.5`.                             |
| `contextTokensUsed`                                                            | `input_tokens`                      | Cursor records a single total (no in/out split).               |
| `totalLinesAdded` / `totalLinesRemoved`                                        | `lines_added` / `lines_removed`     |                                                                |
| `filesChangedCount`                                                            | `files_changed`                     |                                                                |
| `originalFileStates` (keys with an edit marker) + newly‑created                | `touched_files`                     | Files the session edited.                                      |
| `trackedGitRepos[0].repoPath` (fallback `workspaceIdentifier.uri.fsPath`)      | `repo_path` (+ derived `repo_name`) | The repo the chat ran in. Populated ~66/80 of recent sessions. |
| `trackedGitRepos[0].branches[0].branchName`                                    | `branch`                            | Branch at the time.                                            |
| parent `subagentComposerIds` + child `subagentInfo.parentComposerId`           | `parent_session_id` / `listable`    | Child is nested under its parent in the sidebar.               |

### Present but not captured

- **`subtitle`** — Cursor's one‑line change summary (e.g. "Edited index.tsx,
  index.tsx"). Redundant with `touched_files`; threading it through the shared
  `SessionAggregateRecord` (no `Default`, ~24 constructors) wasn't worth it.
- **`context.selectedCommits` / `context.selectedPullRequests` /
  `context.gitPRDiffSelections`** — commits/PRs a user _attached to the chat as
  context_. First‑class fields, but empty in practice (0/80 sampled). These are
  inputs, not outputs — Cursor does not record commits the session produced.
- `promptTokenBreakdown` (per‑category token usage), `fullConversationHeadersOnly`
  (bubble list — read lazily for replay), and ~25 UI/worktree state booleans.

## What is _not_ available anywhere in Cursor's store

- **Commits produced by the session** — not recorded. `trackedGitRepos` tracks
  repo + branch, not a commit list.
- **Linked pull requests** — only the (usually empty) attach‑as‑context slots.

Correlating a session to the commits/PRs it produced would require joining by
repo + time window against `git log` / the GitHub API — a separate concern from
this importer.
