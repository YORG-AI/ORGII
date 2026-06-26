//! Low-level SQLite access against Cursor's `state.vscdb`.
//!
//! All functions are `pub(super)` — internal to `cursor_db_history` only.
//! The connection is opened read-only and dropped between calls so we never
//! block Cursor from writing.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rusqlite::{params_from_iter, Connection, OpenFlags};

use super::helpers::parse_iso_to_epoch_ms;

use super::models::{OrderedBubble, RawBubble, RawComposerForOrder, RawComposerHeader};

const SQLITE_IN_QUERY_CHUNK_SIZE: usize = 500;

/// Open Cursor's global `state.vscdb` read-only.
///
/// Returns `None` if the file does not exist (Cursor not installed / not yet
/// launched) or cannot be opened.
pub(super) fn open_cursor_db() -> Option<Connection> {
    let path = cursor_db_path()?;
    Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

pub(super) fn cursor_db_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;

    #[cfg(target_os = "macos")]
    let path = home
        .join("Library")
        .join("Application Support")
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");

    #[cfg(target_os = "linux")]
    let path = home
        .join(".config")
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");

    #[cfg(target_os = "windows")]
    let path = home
        .join("AppData")
        .join("Roaming")
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");

    if path.exists() {
        Some(path)
    } else {
        None
    }
}

pub(super) fn load_bubble_order(
    conn: &Connection,
    composer_id: &str,
) -> Result<Vec<RawComposerHeader>, String> {
    Ok(load_complete_bubble_order(
        conn,
        composer_id,
        &load_composer_for_order(conn, composer_id)?.full_conversation_headers_only,
    )?)
}

pub(super) fn load_complete_bubble_order(
    conn: &Connection,
    composer_id: &str,
    header_order: &[RawComposerHeader],
) -> Result<Vec<RawComposerHeader>, String> {
    let prefix = format!("bubbleId:{}:", composer_id);
    let upper_bound = format!("bubbleId:{};", composer_id);
    let header_index_by_id: HashMap<&str, usize> = header_order
        .iter()
        .enumerate()
        .map(|(index, header)| (header.bubble_id.as_str(), index))
        .collect();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut ordered_rows: Vec<(i64, usize, String, RawComposerHeader)> = Vec::new();

    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM cursorDiskKV
             WHERE key >= ?1 AND key < ?2
             ORDER BY key ASC",
        )
        .map_err(|err| format!("Failed to prepare Cursor bubble range query: {}", err))?;
    let rows = stmt
        .query_map([prefix.as_str(), upper_bound.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|err| format!("Failed to read Cursor bubble range: {}", err))?;

    for row in rows {
        let (key, Some(value)) =
            row.map_err(|err| format!("Failed to read Cursor bubble row: {}", err))?
        else {
            continue;
        };
        let bubble_id_from_key = key.rsplit(':').next().unwrap_or_default().to_string();
        if bubble_id_from_key.is_empty() || bubble_id_from_key == "undefined" {
            continue;
        }
        let raw = match serde_json::from_str::<RawBubble>(&value) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let bubble_id = if raw.bubble_id.trim().is_empty() {
            bubble_id_from_key
        } else {
            raw.bubble_id.clone()
        };
        if bubble_id.is_empty() || !seen_ids.insert(bubble_id.clone()) {
            continue;
        }
        let timestamp = parse_iso_to_epoch_ms(&raw.created_at);
        let tie_breaker = header_index_by_id
            .get(bubble_id.as_str())
            .copied()
            .unwrap_or(usize::MAX);
        ordered_rows.push((
            timestamp,
            tie_breaker,
            key,
            RawComposerHeader {
                bubble_id,
                bubble_type: raw.bubble_type,
            },
        ));
    }

    if ordered_rows.is_empty() {
        return Ok(header_order.to_vec());
    }

    ordered_rows.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    Ok(ordered_rows
        .into_iter()
        .map(|(_, _, _, header)| header)
        .collect())
}

pub(super) fn load_composer_for_order(
    conn: &Connection,
    composer_id: &str,
) -> Result<RawComposerForOrder, String> {
    let key = format!("composerData:{}", composer_id);
    let json_str: Option<String> = match conn.query_row(
        "SELECT value FROM cursorDiskKV WHERE key = ?1",
        [&key],
        |row| row.get(0),
    ) {
        Ok(val) => val,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(RawComposerForOrder::default()),
        Err(err) => return Err(format!("Failed to read composer {}: {}", composer_id, err)),
    };
    let Some(json_str) = json_str else {
        return Ok(RawComposerForOrder::default());
    };

    serde_json::from_str(&json_str)
        .map_err(|err| format!("Failed to parse composer {}: {}", composer_id, err))
}

pub(super) fn load_bubbles_by_id(
    conn: &Connection,
    composer_id: &str,
    order: &[RawComposerHeader],
) -> Result<Vec<OrderedBubble>, String> {
    let keyed_headers: Vec<(&RawComposerHeader, String)> = order
        .iter()
        .filter(|header| !header.bubble_id.is_empty())
        .map(|header| {
            (
                header,
                format!("bubbleId:{}:{}", composer_id, header.bubble_id),
            )
        })
        .collect();
    if keyed_headers.is_empty() {
        return Ok(vec![]);
    }

    let mut values_by_key = HashMap::with_capacity(keyed_headers.len());
    for chunk in keyed_headers.chunks(SQLITE_IN_QUERY_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT key, value FROM cursorDiskKV WHERE key IN ({})",
            placeholders
        );
        let keys = chunk
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Failed to prepare bubble query: {}", err))?;
        let rows = stmt
            .query_map(params_from_iter(keys), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|err| format!("Failed to read bubbles: {}", err))?;

        for row in rows {
            let (key, Some(value)) =
                row.map_err(|err| format!("Failed to read bubble row: {}", err))?
            else {
                continue;
            };
            values_by_key.insert(key, value);
        }
    }

    let mut out = Vec::with_capacity(keyed_headers.len());
    for (header, key) in keyed_headers {
        let Some(json_str) = values_by_key.get(&key) else {
            continue;
        };

        match serde_json::from_str::<RawBubble>(json_str) {
            Ok(raw) => out.push(OrderedBubble {
                bubble_id: header.bubble_id.clone(),
                bubble_type: header.bubble_type,
                raw,
            }),
            // Lenient parsing: if Cursor changes a bubble's shape, skip that
            // single bubble rather than failing the whole session.
            Err(_) => continue,
        }
    }

    Ok(out)
}

/// Look up a `composer.content.{hash}` blob and return its raw text body,
/// or `None` if the key is missing. Cursor stores edit before/after file
/// content under these keys; the value is the file body as a plain string,
/// not JSON.
pub(super) fn load_content_blob(conn: &Connection, content_id: &str) -> Option<String> {
    if !content_id.starts_with("composer.content.") {
        return None;
    }
    conn.query_row(
        "SELECT value FROM cursorDiskKV WHERE key = ?1",
        [content_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute(
            "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .expect("create cursorDiskKV");
        conn
    }

    fn insert_bubble(
        conn: &Connection,
        composer_id: &str,
        bubble_id: &str,
        bubble_type: i64,
        created_at: &str,
    ) {
        let value = serde_json::json!({
            "bubbleId": bubble_id,
            "type": bubble_type,
            "createdAt": created_at,
            "text": "test"
        })
        .to_string();
        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            [format!("bubbleId:{}:{}", composer_id, bubble_id), value],
        )
        .expect("insert bubble");
    }

    #[test]
    fn complete_bubble_order_includes_rows_missing_from_headers() {
        let conn = test_db();
        let composer_id = "composer-1";
        insert_bubble(
            &conn,
            composer_id,
            "early-user",
            1,
            "2026-06-14T17:38:39.000Z",
        );
        insert_bubble(
            &conn,
            composer_id,
            "early-edit",
            2,
            "2026-06-14T17:53:51.000Z",
        );
        insert_bubble(
            &conn,
            composer_id,
            "header-user",
            1,
            "2026-06-15T08:40:00.000Z",
        );

        let header_order = vec![RawComposerHeader {
            bubble_id: "header-user".to_string(),
            bubble_type: 1,
        }];

        let order = load_complete_bubble_order(&conn, composer_id, &header_order)
            .expect("load complete order");
        let ids = order
            .iter()
            .map(|header| header.bubble_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["early-user", "early-edit", "header-user"]);
    }
}
