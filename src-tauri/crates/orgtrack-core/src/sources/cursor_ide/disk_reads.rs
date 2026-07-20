//! Read-only reads from Cursor's `state.vscdb` for callers outside the importer.
//!
//! Relocated from the (deleted) `cursor-bridge-app` crate — these are the only
//! two disk-reads that outlived the "drive Cursor" feature:
//!   - [`cursor_model_names_from_disk`]: Cursor's available-model catalog, used
//!     by key-vault to enrich the Cursor **CLI** agent's model list.
//!   - [`cursor_composer_last_updated_at`]: a composer's freshness timestamp,
//!     used to reload an open read-only Cursor session when it changes.
//!
//! Both read the user's real Cursor DB (there is no CDP probe instance anymore)
//! and degrade to empty/`None` when Cursor isn't installed.

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

use super::io::cursor_db_path;

/// `ItemTable` key Cursor writes its application-user reactive blob under (holds
/// the available-model catalog).
const APPLICATION_USER_KEY: &str = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
/// Sentinel entry Cursor lists before it has flushed a real catalog.
const DEFAULT_MODEL_NAME: &str = "default";

fn open_cursor_db_read_only() -> Option<Connection> {
    let path = cursor_db_path()?;
    Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

#[derive(Debug, Default, Deserialize)]
struct ApplicationUserBlob {
    #[serde(default, rename = "availableDefaultModels2")]
    available_default_models2: Vec<RawModelName>,
}

#[derive(Debug, Deserialize)]
struct RawModelName {
    #[serde(default)]
    name: String,
}

/// Cursor's available model names from its on-disk catalog. Empty (not an error)
/// when Cursor isn't installed or hasn't flushed the catalog yet.
pub fn cursor_model_names_from_disk() -> Result<Vec<String>, String> {
    let Some(conn) = open_cursor_db_read_only() else {
        return Ok(Vec::new());
    };
    let blob: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [APPLICATION_USER_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let Some(json_text) = blob else {
        return Ok(Vec::new());
    };
    let parsed: ApplicationUserBlob = serde_json::from_str(&json_text)
        .map_err(|err| format!("parse Cursor applicationUser blob: {err}"))?;
    Ok(parsed
        .available_default_models2
        .into_iter()
        .map(|model| model.name)
        .filter(|name| !name.is_empty() && name != DEFAULT_MODEL_NAME)
        .collect())
}

#[derive(Debug, Deserialize)]
struct ComposerTimestamps {
    #[serde(default, rename = "lastUpdatedAt")]
    last_updated_at: Option<i64>,
    #[serde(default, rename = "conversationCheckpointLastUpdatedAt")]
    checkpoint_last_updated_at: Option<i64>,
}

/// Max of a composer's `lastUpdatedAt` / checkpoint timestamp — a cheap
/// freshness signal for reloading an open read-only Cursor session. `None` when
/// the composer row is absent or Cursor isn't installed.
pub fn cursor_composer_last_updated_at(composer_id: &str) -> Result<Option<i64>, String> {
    if composer_id.trim().is_empty() {
        return Ok(None);
    }
    let Some(conn) = open_cursor_db_read_only() else {
        return Ok(None);
    };
    let key = format!("composerData:{composer_id}");
    let blob: Option<String> = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [&key],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let Some(json_text) = blob else {
        return Ok(None);
    };
    let parsed: ComposerTimestamps = serde_json::from_str(&json_text)
        .map_err(|err| format!("parse Cursor {key} blob: {err}"))?;
    Ok(
        match (parsed.last_updated_at, parsed.checkpoint_last_updated_at) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_parse_and_drop_sentinel() {
        let blob = serde_json::json!({
            "availableDefaultModels2": [
                {"name": "claude-opus-4-8"},
                {"name": "default"},
                {"name": ""},
                {"name": "gpt-5.5"}
            ]
        })
        .to_string();
        let parsed: ApplicationUserBlob = serde_json::from_str(&blob).unwrap();
        let names: Vec<String> = parsed
            .available_default_models2
            .into_iter()
            .map(|m| m.name)
            .filter(|n| !n.is_empty() && n != DEFAULT_MODEL_NAME)
            .collect();
        assert_eq!(names, vec!["claude-opus-4-8", "gpt-5.5"]);
    }

    #[test]
    fn composer_timestamp_takes_max() {
        let mk = |raw: &str| -> Option<i64> {
            let p: ComposerTimestamps = serde_json::from_str(raw).unwrap();
            match (p.last_updated_at, p.checkpoint_last_updated_at) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            }
        };
        assert_eq!(
            mk(r#"{"lastUpdatedAt": 100, "conversationCheckpointLastUpdatedAt": 200}"#),
            Some(200)
        );
        assert_eq!(mk(r#"{"lastUpdatedAt": 300}"#), Some(300));
        assert_eq!(mk(r#"{}"#), None);
    }
}
