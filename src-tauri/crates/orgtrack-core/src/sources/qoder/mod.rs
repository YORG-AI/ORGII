//! Qoder (Alibaba's agentic IDE, VS Code family) imported history reader.
//!
//! Each agent ("quest") session transcript is a JSONL file under
//! `~/.qoder/cache/projects/<workspace-basename>-<hash>/conversation-history/<task>/<task>.jsonl`,
//! where `<task>` is a truncated prefix of the full quest task id. Each line is
//! `{role, message:{content:[…]}}` with Anthropic-style content blocks.
//!
//! Session metadata (title, timestamps, workspace path) lives in the app's
//! global `state.vscdb` under the `aicoding.questTaskListSnapshot` key and is
//! matched to a transcript by task-id prefix + workspace basename; the snapshot
//! is enrichment only — discovery works from the JSONL store alone.
pub mod history;
pub(crate) mod log_enrichment;
