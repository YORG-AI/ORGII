//! Trae (ByteDance) imported history reader.
//!
//! Trae stores a per-session "memory" record locally at
//! `~/.trae-cn/memory/projects/<slug>/<YYYYMMDD>/session_memory_<id>.jsonl`.
//! Each JSONL line is a turn summary — `{intent, actions, outcome, learned,
//! message_summary_time}` — and a sibling `topics.md` holds a readable
//! per-session summary used as the title.
//!
//! The full verbatim transcript is *not* in these summaries: it lives in Trae's
//! SQLCipher-encrypted `ModularData/ai-agent/database.db` (and server-side),
//! which ORGII does not decrypt, so we import the plaintext summaries instead.
//! That encrypted-DB format and its in-process key-extraction technique are
//! documented by the trae-db-decrypt project (MIT), which informed this reader's
//! understanding of Trae's storage: <https://github.com/bigmanBass666/trae-db-decrypt>
pub mod history;
pub mod index;
