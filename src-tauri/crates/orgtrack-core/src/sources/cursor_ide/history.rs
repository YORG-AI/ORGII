//! Cursor IDE chat history reader
//!
//! Reads `bubbleId:{composerId}:{bubbleId}` blobs from Cursor's `state.vscdb`
//! and converts individual bubbles into our canonical [`ActivityChunk`] shape.
//! Imported sessions reach this parser through the bounded SQLite/KV replay
//! driver; the renderer no longer owns a Cursor-specific full-refresh path.
//!
//! ## Read-only contract
//!
//! Cursor IDE owns its database. We open it with
//! [`OpenFlags::SQLITE_OPEN_READ_ONLY`] only, never start a transaction, and
//! drop the connection between calls so we never block Cursor from writing.
//!
//! ## Schema notes
//!
//! See `fixtures/SCHEMA.md` for the full reverse-engineered schema. Two
//! load-bearing facts:
//!
//! 1. `composerData.fullConversationHeadersOnly` is the canonical bubble
//!    order. We never sort by `createdAt` — multiple bubbles in one turn can
//!    share a timestamp.
//! 2. `bubble.toolFormerData.params` and `result` are **JSON strings**, not
//!    parsed objects. We re-parse them lazily.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use super::db as cursor_db;

use super::helpers::{
    bubbles_to_chunks, build_fallback_user_chunk, build_unloaded_turn_placeholder_chunk,
    cache_row_to_session_row, composer_source_updated_at, enforce_monotonic_created_at,
};
use super::io::{
    load_bubbles_by_id, load_complete_bubble_order, load_composer_for_order, open_cursor_db,
};
use super::models::{
    CursorComposerContext, OrderedBubble, RawBubble, RawComposerForOrder, RawComposerHeader,
};
use super::summaries::{
    build_cursor_ide_turn_summaries, cursor_ide_summary_source_fingerprint,
    load_cached_cursor_ide_turn_summaries, upsert_cursor_ide_turn_summaries,
};

pub use super::models::CursorIdeTurnSummary;

// Items brought into scope so the test module's `use super::*` can reach them.
#[cfg(test)]
use super::helpers::{
    assistant_text_bubble_to_chunk, assistant_tool_bubble_to_chunk, cursor_tool_name_to_canonical,
    normalize_created_at, parse_inner_json, parse_iso_to_epoch_ms, user_bubble_to_chunk,
};
#[cfg(test)]
use super::io::load_content_blob;
#[cfg(test)]
use super::models::{RawCursorSubagentInfo, RawToolFormerData};
#[cfg(test)]
use serde_json::{json, Value};

// ============================================================================
// Constants
// ============================================================================

pub(crate) const CURSOR_IDE_CATEGORY: &str = "cursor_ide";
const DEFAULT_INITIAL_RECENT_BUBBLE_LIMIT: usize = 100;

const CURSOR_BUBBLE_TYPE_USER: i64 = 1;

/// Frontend-side session id prefix for Cursor IDE history sessions.
/// Kept here (not in a shared `types` module) because every consumer either
/// crosses this module's API surface or works with bare composer UUIDs.
pub use super::CURSORIDE_SESSION_PREFIX;

/// Strip the `cursoride-` prefix to recover the bare composer UUID Cursor
/// stores. Returns the input unchanged if no prefix is present (defensive —
/// callers should always pass the prefixed form, but a missing prefix should
/// not silently surface as a "session not found" error in normal operation).
fn strip_session_prefix(session_id: &str) -> &str {
    session_id
        .strip_prefix(CURSORIDE_SESSION_PREFIX)
        .unwrap_or(session_id)
}

// ============================================================================
// Public types
// ============================================================================

/// One Cursor IDE composer surfaced as a frontend-ready session row.
///
/// Field naming mirrors `SessionAggregateRecord` so the frontend can merge
/// these rows directly into `sessionsAtom`. The `category` is always
/// `"cursor_ide"`; the `session_id` is always prefixed (`cursoride-{uuid}`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorIdeSessionRow {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub category: &'static str,
    /// Always `true` for Cursor IDE sessions — the frontend uses this to gate
    /// destructive UI (input, send, worktree controls).
    pub read_only: bool,
    pub model: Option<String>,
    pub total_tokens: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
    pub touched_files: Vec<String>,
    pub background: bool,
    pub is_active: bool,
    pub repo_path: Option<String>,
    pub repo_root_path: Option<String>,
    pub repo_remote_urls: Vec<String>,
    pub storage_path: Option<String>,
    pub repo_name: Option<String>,
    pub branch: Option<String>,
}

/// Paginated response for the sidebar's Cursor IDE history loader.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorIdeSessionPage {
    pub sessions: Vec<CursorIdeSessionRow>,
    /// `true` iff a follow-up call with `offset + sessions.len()` would
    /// return additional rows. Allows the sidebar to render the "Load more"
    /// row only when more is actually available.
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorIdeInitialWindow {
    pub chunks: Vec<ActivityChunk>,
    pub turns: Vec<CursorIdeTurnSummary>,
    pub total_bubble_count: usize,
    pub user_bubble_count: usize,
    pub recent_bubble_count: usize,
    pub recent_start_cursor: Option<String>,
    pub recent_end_cursor: Option<String>,
    pub has_unloaded_middle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorIdeTurnWindow {
    pub chunks: Vec<ActivityChunk>,
    pub user_bubble_id: String,
    pub next_user_bubble_id: Option<String>,
    pub loaded_bubble_count: usize,
}

// ============================================================================
// Public API
// ============================================================================

/// Paginated Cursor IDE history list, mapped from the cached metadata
/// produced by `cursor_db::list_for_sidebar`.
///
/// The cache is the source of truth here — `list_for_sidebar` does the
/// delta-sync + subagent filter + ordering for us. We just translate cache
/// rows into the frontend-ready `CursorIdeSessionRow` shape.
pub fn list_cursor_ide_sessions_paginated(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CursorIdeSessionPage, String> {
    // Listability is established once by the adapter's bounded delta sync and
    // persisted in the compact cache. Re-probing every visible session's
    // bubble range here made unchanged sidebar refreshes touch Cursor's large
    // database again.
    let (rows, has_more) = cursor_db::list_for_sidebar(cache_conn, limit, offset)?;
    let mut sessions = rows
        .into_iter()
        .map(cache_row_to_session_row)
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(feature = "git")]
    {
        use std::collections::HashSet;

        use crate::sources::imported_history::repo_identity::query_repo_identities_from_conn;

        let repo_paths = sessions
            .iter()
            .filter_map(|session| session.repo_path.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let identities = query_repo_identities_from_conn(cache_conn, &repo_paths)?;
        for session in &mut sessions {
            let Some(repo_path) = session.repo_path.as_deref() else {
                continue;
            };
            if let Some(identity) = identities.get(repo_path) {
                session.repo_root_path = identity.repo_root_path.clone();
                session.repo_remote_urls = identity.remote_urls.clone();
            }
        }
    }
    Ok(CursorIdeSessionPage { sessions, has_more })
}

/// Read all bubbles for a composer, in canonical order, normalized into
/// [`ActivityChunk`]s ready for the standard event pipeline.
///
/// `session_id` is the **prefixed** id we expose to the frontend
/// (`cursoride-{uuid}`); the prefix is stripped here before reading from
/// Cursor's DB.
///
/// Returns `Ok(vec![])` if Cursor's DB is missing or the composer is unknown
/// — read-only history is best-effort by definition; we don't synthesize
/// errors for missing data. Returns `Err` only on IO/SQL failures we cannot
/// recover from.
pub fn load_history_for_session(session_id: &str) -> Result<Vec<ActivityChunk>, String> {
    let composer_id = strip_session_prefix(session_id);

    let cursor_conn = match open_cursor_db() {
        Some(conn) => conn,
        None => return Ok(vec![]),
    };

    let composer = load_composer_for_order(&cursor_conn, composer_id)?;
    let composer_context = CursorComposerContext::from_composer(&composer);
    let order = load_complete_bubble_order(
        &cursor_conn,
        composer_id,
        &composer.full_conversation_headers_only,
    )?;
    if order.is_empty() {
        return Ok(vec![]);
    }

    let bubbles = load_bubbles_by_id(&cursor_conn, composer_id, &order)?;

    let mut chunks = bubbles_to_chunks(&cursor_conn, session_id, &bubbles, &composer_context);
    enforce_monotonic_created_at(&mut chunks);
    Ok(chunks)
}

/// Normalize a single Cursor KV bubble for bounded replay.
///
/// The replay driver owns ordering/diffing and calls this only for a new or
/// changed bubble, so this wrapper does not allocate a full bubble list.
pub(crate) fn replay_chunk_from_bubble_json(
    conn: &Connection,
    session_id: &str,
    bubble_id: &str,
    header_type: i64,
    raw_json: &str,
    composer_json: &str,
) -> Result<Option<ActivityChunk>, String> {
    let raw = serde_json::from_str::<RawBubble>(raw_json)
        .map_err(|err| format!("Failed to parse Cursor replay bubble {bubble_id}: {err}"))?;
    let composer = serde_json::from_str::<RawComposerForOrder>(composer_json)
        .map_err(|err| format!("Failed to parse Cursor replay composer: {err}"))?;
    let context = CursorComposerContext::from_composer(&composer);
    let bubble = OrderedBubble {
        bubble_id: bubble_id.to_string(),
        bubble_type: header_type,
        raw,
    };
    Ok(bubbles_to_chunks(conn, session_id, &[bubble], &context)
        .into_iter()
        .next())
}

pub fn load_initial_window_for_session(
    cache_conn: &mut Connection,
    session_id: &str,
    recent_limit: Option<usize>,
) -> Result<CursorIdeInitialWindow, String> {
    let composer_id = strip_session_prefix(session_id);

    let cursor_conn = match open_cursor_db() {
        Some(conn) => conn,
        None => {
            return Ok(CursorIdeInitialWindow {
                chunks: vec![],
                turns: vec![],
                total_bubble_count: 0,
                user_bubble_count: 0,
                recent_bubble_count: 0,
                recent_start_cursor: None,
                recent_end_cursor: None,
                has_unloaded_middle: false,
            })
        }
    };

    let composer = load_composer_for_order(&cursor_conn, composer_id)?;
    let composer_context = CursorComposerContext::from_composer(&composer);
    let order = load_complete_bubble_order(
        &cursor_conn,
        composer_id,
        &composer.full_conversation_headers_only,
    )?;
    let source_updated_at =
        composer_source_updated_at(&cursor_conn, composer_id, &composer, &order)?;
    if order.is_empty() {
        return Ok(CursorIdeInitialWindow {
            chunks: vec![],
            turns: vec![],
            total_bubble_count: 0,
            user_bubble_count: 0,
            recent_bubble_count: 0,
            recent_start_cursor: None,
            recent_end_cursor: None,
            has_unloaded_middle: false,
        });
    }

    let composer_created_at = composer.created_at;
    let composer_last_updated_at = composer.last_updated_at;
    let total_bubble_count = order.len();
    let source_fingerprint = cursor_ide_summary_source_fingerprint(
        composer_created_at,
        composer_last_updated_at,
        source_updated_at,
        &order,
    );
    let mut full_bubbles_by_id: Option<HashMap<String, OrderedBubble>> = None;
    let summaries = match load_cached_cursor_ide_turn_summaries(
        cache_conn,
        session_id,
        source_updated_at,
        total_bubble_count,
        &source_fingerprint,
    )? {
        Some(cached_summaries) => cached_summaries,
        None => {
            let all_bubbles = load_bubbles_by_id(&cursor_conn, composer_id, &order)?;
            let fresh_summaries = build_cursor_ide_turn_summaries(&order, &all_bubbles);
            full_bubbles_by_id = Some(
                all_bubbles
                    .into_iter()
                    .map(|bubble| (bubble.bubble_id.clone(), bubble))
                    .collect(),
            );
            upsert_cursor_ide_turn_summaries(
                cache_conn,
                session_id,
                composer_id,
                source_updated_at,
                total_bubble_count,
                &source_fingerprint,
                &fresh_summaries,
            )?;
            fresh_summaries
        }
    };
    let summaries_by_turn_id: HashMap<String, CursorIdeTurnSummary> = summaries
        .iter()
        .map(|summary| (summary.turn_id.clone(), summary.clone()))
        .collect();

    let limit = recent_limit
        .unwrap_or(DEFAULT_INITIAL_RECENT_BUBBLE_LIMIT)
        .max(1);
    let recent_start_index = total_bubble_count.saturating_sub(limit);
    let recent_headers = &order[recent_start_index..];
    let recent_ids: HashSet<&str> = recent_headers
        .iter()
        .map(|header| header.bubble_id.as_str())
        .collect();

    let selected_headers: Vec<RawComposerHeader> = order
        .iter()
        .enumerate()
        .filter(|(index, header)| {
            let is_turn_end = index + 1 == order.len()
                || order
                    .get(index + 1)
                    .is_some_and(|next| next.bubble_type == CURSOR_BUBBLE_TYPE_USER);
            header.bubble_type == CURSOR_BUBBLE_TYPE_USER
                || recent_ids.contains(header.bubble_id.as_str())
                || is_turn_end
        })
        .map(|(_, header)| header.clone())
        .collect();

    let bubbles_by_id: HashMap<String, OrderedBubble> =
        if let Some(full_bubbles) = full_bubbles_by_id {
            selected_headers
                .iter()
                .filter_map(|header| {
                    full_bubbles
                        .get(&header.bubble_id)
                        .cloned()
                        .map(|bubble| (bubble.bubble_id.clone(), bubble))
                })
                .collect()
        } else {
            load_bubbles_by_id(&cursor_conn, composer_id, &selected_headers)?
                .into_iter()
                .map(|bubble| (bubble.bubble_id.clone(), bubble))
                .collect()
        };
    let mut chunks = Vec::new();
    for (index, header) in order.iter().enumerate() {
        if header.bubble_type == CURSOR_BUBBLE_TYPE_USER
            || recent_ids.contains(header.bubble_id.as_str())
        {
            if let Some(bubble) = bubbles_by_id.get(&header.bubble_id) {
                chunks.extend(bubbles_to_chunks(
                    &cursor_conn,
                    session_id,
                    std::slice::from_ref(bubble),
                    &composer_context,
                ));
            } else if header.bubble_type == CURSOR_BUBBLE_TYPE_USER {
                chunks.push(build_fallback_user_chunk(
                    session_id,
                    &header.bubble_id,
                    super::helpers::fallback_turn_created_at(&order, &bubbles_by_id, index),
                ));
            }
        }
        if let Some(placeholder) = build_unloaded_turn_placeholder_chunk(
            session_id,
            &order,
            &recent_ids,
            &bubbles_by_id,
            &summaries_by_turn_id,
            index,
        ) {
            chunks.push(placeholder);
        }
    }
    let user_bubble_count = order
        .iter()
        .filter(|header| header.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .count();
    let recent_bubble_count = recent_headers.len();
    let recent_start_cursor = recent_headers
        .first()
        .map(|header| header.bubble_id.clone())
        .filter(|id| !id.is_empty());
    let recent_end_cursor = recent_headers
        .last()
        .map(|header| header.bubble_id.clone())
        .filter(|id| !id.is_empty());
    let has_unloaded_middle = selected_headers.len() < total_bubble_count;

    enforce_monotonic_created_at(&mut chunks);
    Ok(CursorIdeInitialWindow {
        chunks,
        turns: summaries,
        total_bubble_count,
        user_bubble_count,
        recent_bubble_count,
        recent_start_cursor,
        recent_end_cursor,
        has_unloaded_middle,
    })
}

pub fn load_turn_window_for_session(
    session_id: &str,
    user_bubble_id: &str,
) -> Result<CursorIdeTurnWindow, String> {
    let composer_id = strip_session_prefix(session_id);

    let cursor_conn = match open_cursor_db() {
        Some(conn) => conn,
        None => {
            return Ok(CursorIdeTurnWindow {
                chunks: vec![],
                user_bubble_id: user_bubble_id.to_string(),
                next_user_bubble_id: None,
                loaded_bubble_count: 0,
            })
        }
    };

    let composer = load_composer_for_order(&cursor_conn, composer_id)?;
    let composer_context = CursorComposerContext::from_composer(&composer);
    let order = load_complete_bubble_order(
        &cursor_conn,
        composer_id,
        &composer.full_conversation_headers_only,
    )?;
    let Some(start_index) = order
        .iter()
        .position(|header| header.bubble_id == user_bubble_id)
    else {
        return Ok(CursorIdeTurnWindow {
            chunks: vec![],
            user_bubble_id: user_bubble_id.to_string(),
            next_user_bubble_id: None,
            loaded_bubble_count: 0,
        });
    };

    let next_user_index = order
        .iter()
        .enumerate()
        .skip(start_index + 1)
        .find(|(_, header)| header.bubble_type == CURSOR_BUBBLE_TYPE_USER)
        .map(|(index, _)| index);
    let end_index = next_user_index.unwrap_or(order.len());
    let turn_headers = &order[start_index..end_index];
    let bubbles = load_bubbles_by_id(&cursor_conn, composer_id, turn_headers)?;
    let mut chunks = bubbles_to_chunks(&cursor_conn, session_id, &bubbles, &composer_context);
    enforce_monotonic_created_at(&mut chunks);
    let next_user_bubble_id = next_user_index
        .and_then(|index| order.get(index))
        .map(|header| header.bubble_id.clone())
        .filter(|id| !id.is_empty());

    Ok(CursorIdeTurnWindow {
        chunks,
        user_bubble_id: user_bubble_id.to_string(),
        next_user_bubble_id,
        loaded_bubble_count: turn_headers.len(),
    })
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
