# Warp imported history

ORGII imports Warp's locally stored Agent conversations as read-only external history. It does not launch Warp, mutate Warp data, or attempt to download cloud-only conversations.

## Source contract

| Field                 | Value                             |
| --------------------- | --------------------------------- |
| Source ID             | `warp`                            |
| ORGII session prefix  | `warpapp-`                        |
| Store kind            | SQLite                            |
| Database              | `warp.sqlite`                     |
| Conversation metadata | `agent_conversations`             |
| Transcript payload    | `agent_tasks.task` protobuf blobs |
| Protobuf message      | `warp.multi_agent.v1.Task`        |

The importer uses Warp's published descriptor at revision [`2d0e8dd`](https://github.com/warpdotdev/warp-proto-apis/tree/2d0e8ddf5a946a663f7e0952144ccbced0068a81) through `warp_multi_agent_api`. Dynamic protobuf decoding avoids a parallel hand-maintained schema and preserves compatibility with fields the importer does not yet interpret.

## Database discovery

Candidates are tried in a stable order and deduplicated. The first existing database is opened with SQLite read-only flags.

| Platform/channel | Candidate                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| macOS Stable     | `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`  |
| macOS Preview    | `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Preview/warp.sqlite` |
| macOS legacy     | `~/Library/Application Support/dev.warp.Warp-{Stable,Preview}/warp.sqlite`                                     |
| Linux            | `${XDG_STATE_HOME:-~/.local/state}/warp-terminal/warp.sqlite`                                                  |
| Windows          | `%LOCALAPPDATA%/warp/Warp/data/warp.sqlite`                                                                    |

The same candidate function is shared by import and Data Sources detection so discovery cannot drift.

Executable detection recognizes the current `oz`/`oz-preview` names, the deprecated `warp-cli` name, and Linux's `warp-terminal` desktop launcher. This only improves the Data Sources inventory; it does not add a live CLI runner.

## Mapping into ORGII

| Warp event                             | ORGII replay chunk                     |
| -------------------------------------- | -------------------------------------- |
| `userQuery`                            | user message                           |
| `agentReasoning`                       | thinking                               |
| `agentOutput`                          | assistant message                      |
| `modelUsed`                            | session model metadata                 |
| `toolCall` + matching `toolCallResult` | one tool-call chunk with paired output |

Known tools map to ORGII's canonical shell, file-read, file-edit, code-search, and glob operations. Unknown tools retain a snake-case name and their complete JSON payload rather than being discarded. `applyFileDiffs` also contributes touched-file and line-impact statistics.

Messages from every task in a conversation are merged by protobuf timestamp, then task/message position. Missing timestamps fall back to the conversation's `last_modified_at`.

## Metadata fallbacks

| Field                | Resolution order                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Title                | summary title → root-task description → summary initial query → first user query → agent name → `Warp conversation` |
| Model                | latest `modelUsed` event → latest non-empty usage model                                                             |
| Repository path      | summary initial working directory                                                                                   |
| Created/updated time | earliest/latest message timestamp → conversation `last_modified_at`                                                 |
| Parent               | `parent_conversation_id`, wrapped with `warpapp-`                                                                   |

Remote child conversations and unlisted automatic code-diff conversations are retained in the cache input set but are not listed as primary sessions. Conversations with no decodable replay chunks are also hidden.

## Cache and compatibility

The shared imported-history cache fingerprints conversation JSON, optional summary JSON, modification time, task count/bytes, and SQLite WAL/SHM sidecars. Parser version changes can invalidate cached rows. Databases that predate the optional `summary` column are supported; missing tables and malformed protobuf records degrade to an empty result instead of crashing the source scan.

## Privacy and limitations

- Reads are local and read-only.
- ORGII only sees conversations present in the local `warp.sqlite` database.
- Warp can store/sync some data remotely depending on user settings; cloud-only history is outside this importer.
- This implements issue #366 (history import), not the separate Warp CLI/TUI integration tracked by #331.

## References

- [Warp: interacting with agents](https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents)
- [Warp: session restoration and database locations](https://docs.warp.dev/terminal/sessions/session-restoration)
- [Warp repository migration code](https://github.com/warpdotdev/Warp/blob/main/warp-repository/src/migration.rs)
- [Warp protobuf APIs](https://github.com/warpdotdev/warp-proto-apis)
