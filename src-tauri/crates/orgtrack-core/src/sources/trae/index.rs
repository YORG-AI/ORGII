//! Trae session index (VS Code `state.vscdb` enrichment)
//!
//! Trae is a VS Code fork; alongside the plaintext memory summaries it keeps a
//! VS Code-style `state.vscdb` key/value store per workspace. Two keys there
//! carry data the memory JSONL lacks, keyed on the *same* session ids our file
//! discovery parses:
//!   - `icube_session_agent_map`         → `{ sessionId: agentId }` (e.g. `solo_agent`)
//!   - `memento/icube-ai-agent-storage`  → ordered session list + `currentSessionId`
//!
//! The verbatim messages live only in the sibling SQLCipher-encrypted
//! `database.db`, so this is index/metadata only. Every read is best-effort: a
//! missing file, absent key, locked db, or parse error simply contributes
//! nothing — it never turns into an import error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde::Serialize;

const AGENT_MAP_KEY: &str = "icube_session_agent_map";
const MEMENTO_KEY: &str = "memento/icube-ai-agent-storage";

/// Per-session enrichment recovered from Trae's `state.vscdb`, keyed by the
/// bare source session id (the 24-hex ObjectId, no `traeapp-` prefix).
#[derive(Debug, Clone, Default, Serialize)]
pub struct TraeIndexEntry {
    /// Agent id backing the session (e.g. `solo_agent`), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// True when Trae marks this as the current / open session.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_current: bool,
    /// Position in Trae's own session list (0 = top). `None` when not listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<usize>,
}

impl TraeIndexEntry {
    /// True once any field carries a signal worth persisting.
    pub fn is_meaningful(&self) -> bool {
        self.agent.is_some() || self.is_current || self.order.is_some()
    }
}

pub type TraeSessionIndex = HashMap<String, TraeIndexEntry>;

/// Load and merge the Trae session index across every discoverable
/// `state.vscdb`. Best-effort: returns whatever could be read.
pub fn load_trae_session_index() -> TraeSessionIndex {
    let mut index = TraeSessionIndex::new();
    for db in trae_state_vscdb_paths() {
        // A locked / missing / foreign db just contributes nothing.
        let _ = merge_vscdb_index(&db, &mut index);
    }
    index
}

/// Human-friendly label for a Trae agent id (`solo_agent` → `"Solo Agent"`).
pub fn agent_display_label(agent_id: &str) -> String {
    agent_id
        .split(['_', '-'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn merge_vscdb_index(db_path: &Path, index: &mut TraeSessionIndex) -> Result<(), String> {
    if !db_path.is_file() {
        return Ok(());
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| err.to_string())?;

    if let Some(raw) = read_item(&conn, AGENT_MAP_KEY) {
        for (session_id, agent) in parse_agent_map(&raw) {
            index.entry(session_id).or_default().agent = Some(agent);
        }
    }

    if let Some(raw) = read_item(&conn, MEMENTO_KEY) {
        let parsed = parse_memento(&raw);
        for (session_id, order, is_current) in parsed.entries {
            let entry = index.entry(session_id).or_default();
            entry.order = Some(order);
            if is_current {
                entry.is_current = true;
            }
        }
        if let Some(current) = parsed.current_session_id {
            index.entry(current).or_default().is_current = true;
        }
    }

    Ok(())
}

fn read_item(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM ItemTable WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

// --- pure parsers (unit-tested without SQLite) --------------------------------

/// Parse `{ sessionId: agentId }` into `(sessionId, agentId)` pairs, dropping
/// blank agents. Returns empty on any parse failure.
fn parse_agent_map(raw: &str) -> Vec<(String, String)> {
    serde_json::from_str::<HashMap<String, String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(session_id, agent)| {
            let agent = agent.trim();
            (!agent.is_empty()).then(|| (session_id, agent.to_string()))
        })
        .collect()
}

#[derive(Debug, Default)]
struct ParsedMemento {
    /// `(sessionId, order, isCurrent)` in list order.
    entries: Vec<(String, usize, bool)>,
    current_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MementoDoc {
    #[serde(default)]
    list: Vec<MementoEntry>,
    #[serde(default, rename = "currentSessionId")]
    current_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MementoEntry {
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default, rename = "isCurrent")]
    is_current: bool,
}

/// Parse the memento doc into ordered `(sessionId, order, isCurrent)` entries
/// plus the current session id. Returns empty on any parse failure.
fn parse_memento(raw: &str) -> ParsedMemento {
    let Ok(doc) = serde_json::from_str::<MementoDoc>(raw) else {
        return ParsedMemento::default();
    };
    let entries = doc
        .list
        .iter()
        .enumerate()
        .filter_map(|(order, item)| {
            item.session_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .map(|id| (id.to_string(), order, item.is_current))
        })
        .collect();
    let current_session_id = doc.current_session_id.filter(|id| !id.is_empty());
    ParsedMemento {
        entries,
        current_session_id,
    }
}

// --- disk discovery -----------------------------------------------------------

/// All candidate `state.vscdb` files across Trae CN / Trae (intl) installs:
/// every `User/workspaceStorage/<hash>/state.vscdb` plus
/// `User/globalStorage/state.vscdb`.
fn trae_state_vscdb_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for user_dir in trae_user_dirs() {
        out.push(user_dir.join("globalStorage").join("state.vscdb"));
        let workspace_storage = user_dir.join("workspaceStorage");
        if let Ok(entries) = std::fs::read_dir(&workspace_storage) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("state.vscdb");
                if candidate.is_file() {
                    out.push(candidate);
                }
            }
        }
    }
    out
}

/// `<data-dir>/Trae CN/User` and `<data-dir>/Trae/User`, where data-dir is the
/// platform app-support root (macOS `~/Library/Application Support`, Windows
/// `%APPDATA%\Roaming`, Linux `~/.local/share`).
fn trae_user_dirs() -> Vec<PathBuf> {
    let data_dir = app_paths::external_history_data_dir();
    ["Trae CN", "Trae"]
        .into_iter()
        .map(|name| data_dir.join(name).join("User"))
        .collect()
}

#[cfg(test)]
#[path = "index_tests.rs"]
mod tests;
