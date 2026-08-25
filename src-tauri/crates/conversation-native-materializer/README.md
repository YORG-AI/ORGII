# conversation-native-materializer

This leaf crate materializes a continuation-capable
`conversation_portability::PortableConversation` into a **new**, account-
scoped native Codex CLI or Claude Code transcript. It does not read a source
transcript and never reads or copies credentials, provider configuration, or
session indexes.

## Lifecycle

1. `prepare_native_materialization` requires explicit runtime, normalized CLI
   version, account id, model, executable, target profile, target workspace,
   recovery root, creation time, and a caller-generated target UUID. Codex's
   model is carried in the resume plan for the managed launcher; the writer
   does not invent a `turn_context` record.
2. The provider writer creates structured native history. An independent
   provider reader reparses both the staged bytes and the published file and
   must reproduce the ordered portable role/content/tool/compaction semantics,
   including native source-record grouping such as Claude
   `text/tool_use/text` blocks in one assistant message.
3. Publication uses a private same-directory temporary file, `fsync`, and an
   atomic no-replace rename. The returned session is only a candidate.
4. The caller gives the returned `NativeResumePlan` plus the first real user
   task to its managed CLI runner. The materializer never inserts a synthetic
   public user turn and never invokes an account itself.
5. `accept_native_resume` activates only after the same native file preserves
   its verified prefix and appends that exact real user turn. A failed attempt
   can be moved out of the provider's active store with
   `reject_native_materialization`.

## Frozen support matrix

| Target | Exact versions | Preserved native semantics | Fail-closed boundaries |
| --- | --- | --- | --- |
| Codex CLI | 0.144.4, 0.144.5 | user, assistant, system, developer, grouped message blocks, tool calls/results, compaction summaries, user images | compaction boundaries; error-state tool results; arbitrary JSON blocks; privileged/assistant images |
| Claude Code | 2.1.209, 2.1.226 | grouped user/assistant blocks, tool calls/results including `is_error`, paired compaction boundary/summary graph, user images | summary without boundary; non-text boundary content; system/developer messages; non-object tool input; arbitrary JSON blocks; privileged/assistant images |

Unknown versions and unknown native records/content blocks are rejected. The
materializer never substitutes a flattened prompt for structured history.

## Platform and filesystem boundary

The current publisher is intentionally Linux/macOS-only. It uses `O_NOFOLLOW`,
mode `0600` files, current-euid-owned and non-group/world-writable target
directories, file identity checks, file/directory `fsync`, path containment,
candidate-scoped stale-temp reconciliation, and an atomic no-replace rename
(`renameat2(RENAME_NOREPLACE)` or `renamex_np(RENAME_EXCL)`).
Rejected candidates reconcile an already-published identical recovery file so
a crash between recovery publication and active-file unlink is retry-safe.
Other platforms return `UnsupportedPlatform` until equivalent safe primitives
are implemented and fixture-tested.

Compatibility research and adapted fixture provenance are recorded in the
repository `THIRD_PARTY_NOTICES.md`.
