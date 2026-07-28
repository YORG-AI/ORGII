//! Timestamp / text pure utilities.

use super::*;

// ============================================================================
// Timestamp / text pure utilities
// ============================================================================

pub(in crate::sources::cursor_ide) fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

pub(in crate::sources::cursor_ide) fn composer_source_updated_at(
    conn: &Connection,
    composer_id: &str,
    composer: &super::models::RawComposerForOrder,
    order: &[RawComposerHeader],
) -> Result<i64, String> {
    use rusqlite::OptionalExtension;

    let mut source_updated_at = composer.created_at.max(composer.last_updated_at);
    if let Some(last_header) = order.last().filter(|header| !header.bubble_id.is_empty()) {
        let key = format!("bubbleId:{}:{}", composer_id, last_header.bubble_id);
        let bubble_json: Option<String> = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                [key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| format!("Failed to read Cursor latest bubble timestamp: {}", err))?
            .flatten();
        if let Some(value) = bubble_json {
            if let Ok(raw) = serde_json::from_str::<RawBubble>(&value) {
                let bubble_updated_at = parse_iso_to_epoch_ms(&raw.created_at);
                if bubble_updated_at > 0 {
                    source_updated_at = source_updated_at.max(bubble_updated_at);
                }
            }
        }
    }
    Ok(source_updated_at)
}

pub(in crate::sources::cursor_ide) fn parse_iso_to_epoch_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

pub(in crate::sources::cursor_ide) fn duration_between_iso_ms(
    started_at: &str,
    ended_at: &str,
) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(ended_at).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

pub(in crate::sources::cursor_ide) fn preview_text(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 160;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(MAX_PREVIEW_CHARS).collect()
}

/// Cursor stores `createdAt` as ISO-8601. Pass through if it parses; otherwise
/// fall back to "now" so downstream code that orders by timestamp doesn't
/// crash. The canonical order is the composer header order, not timestamps,
/// so this fallback only affects display formatting.
pub(in crate::sources::cursor_ide) fn normalize_created_at(raw: &str) -> String {
    if !raw.is_empty() && chrono::DateTime::parse_from_rfc3339(raw).is_ok() {
        return raw.to_string();
    }
    chrono::Utc::now().to_rfc3339()
}

/// Cursor stamps every bubble in a turn with the **same** `createdAt`, so a
/// downstream sort by `(created_at, id)` reorders the turn — e.g. the user
/// message renders after the assistant's reply, because the tie falls to the id
/// and `cursoride-asst-…` sorts before `cursoride-user-…`. Our chunk order is
/// already canonical (composer header order), so rewrite tied/decreasing
/// timestamps to be strictly increasing, encoding the true order into the
/// timestamp itself. Bumps are ≤ (bubbles per turn) ms, far below the seconds
/// between real turns, so displayed timing is effectively unchanged.
pub(in crate::sources::cursor_ide) fn enforce_monotonic_created_at(chunks: &mut [ActivityChunk]) {
    let mut prev_ms: Option<i64> = None;
    for chunk in chunks.iter_mut() {
        let ms = parse_iso_to_epoch_ms(&chunk.created_at);
        let next = match prev_ms {
            Some(previous) if ms <= previous => previous + 1,
            _ => ms,
        };
        if next != ms {
            chunk.created_at = epoch_ms_to_iso(next);
        }
        prev_ms = Some(next);
    }
}
