# Qoder imported history

ORGII imports Qoder's local CLI/IDE transcripts as read-only external history. It does not launch Qoder, modify Qoder files, or attempt to fetch cloud-only sessions.

## Source contract

| Field                      | Value                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Source ID                  | `qoder`                                                                                              |
| ORGII session prefix       | `qoderapp-`                                                                                          |
| Store kind                 | JSONL                                                                                                |
| User data root             | `~/.qoder` or a custom `QODER_CONFIG_DIR` / `QODER_CLI_HOME`                                         |
| Primary transcript layouts | `projects/<project-id>/<session-id>.jsonl` and `projects/<project-id>/transcript/<session-id>.jsonl` |
| Subagent layout            | `projects/<project-id>/<session-id>/subagents/agent-<id>.jsonl`                                      |

Qoder CLI 1.0.45 writes the first primary layout. Current Qoder hook documentation shows the `transcript/` variant, so discovery accepts both without recursively importing unrelated JSONL files.

## Discovery

Candidates are tried in a stable order and deduplicated by source session ID:

| Platform/channel      | Candidate                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CLI override          | `${QODER_CONFIG_DIR}/projects` or `${QODER_CLI_HOME}/projects`                                                       |
| User CLI              | `~/.qoder/projects`                                                                                                  |
| macOS IDE companion   | `~/Library/Application Support/Qoder/User/globalStorage/{qoder.qoder-cli-vscode-ide-companion,qoder.qoder}/projects` |
| Linux IDE companion   | `~/.config/Qoder/User/globalStorage/{...}/projects` and `~/.local/share/Qoder/User/globalStorage/{...}/projects`     |
| Windows IDE companion | `%APPDATA%/Qoder/User/globalStorage/{...}/projects` and `%LOCALAPPDATA%/Qoder/User/globalStorage/{...}/projects`     |

The same candidate resolver feeds history import and Data Sources detection, preventing detect/import drift. Missing directories and malformed individual JSONL lines are ignored safely.

## Mapping into ORGII

| Qoder record/content                | ORGII projection                            |
| ----------------------------------- | ------------------------------------------- |
| `user` text                         | user message                                |
| `assistant` text                    | assistant message                           |
| `thinking` block                    | thinking                                    |
| `tool_use` + matching `tool_result` | one canonical tool chunk with paired output |
| `structuredPatch` on an edit result | unified diff plus touched-file/line impact  |

Known Qoder tools map to ORGII's canonical shell, file-read, file-edit, grep, and glob operations. Unknown tools retain their source name and JSON arguments. Tool results are paired by `tool_use_id`, including results carried by the top-level `toolUseResult` sidecar.

## Metadata fallbacks

| Field                | Resolution order                                                                        |
| -------------------- | --------------------------------------------------------------------------------------- |
| Title                | custom title → AI title → last prompt → summary → first user prompt → source session ID |
| Model                | assistant message model → runtime-config model                                          |
| Repository path      | latest non-empty `cwd`                                                                  |
| Branch               | latest non-empty `gitBranch`                                                            |
| Created/updated time | earliest/latest JSONL timestamp → file modification time                                |
| Parent               | sidechain `sessionId`, wrapped with `qoderapp-`                                         |

Token totals include normal, cache-read, and cache-creation input tokens. Subagent cache keys combine the parent and agent file stem so equal agent IDs in different parent sessions cannot collide.

## Cache, replay, and privacy

Qoder reuses the shared `imported_history_session_cache`. File path, modification time, size, and parser version drive incremental invalidation; unchanged transcripts are not reparsed. Update and clear+rescan are source-scoped, and Qoder participates in the existing sidebar pagination, source stats, recent paths, Spotlight, Kanban filter, and SessionCore read-only replay paths.

- All Qoder source reads are local and read-only.
- A disabled Qoder source is excluded from sidebar loading.
- ORGII only sees transcripts present on disk; remote-only history is out of scope.
- Qoder format changes should bump `QODER_METADATA_PARSER_VERSION` and add a fixture before changing fallback behavior.

## References

- [Qoder hooks and transcript location](https://docs.qoder.com/extensions/hooks)
- [Qoder download and CLI installation](https://qoder.com/download)
